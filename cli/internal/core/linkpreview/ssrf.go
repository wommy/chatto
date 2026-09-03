package linkpreview

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

// privateIPBlocks contains CIDR ranges for private/reserved IP addresses.
var privateIPBlocks []*net.IPNet

func init() {
	// Initialize private IP blocks
	// These CIDR ranges cover IANA special-use addresses and private networks.
	// Must match the ranges in cli/internal/pushendpoint/endpoint.go specialUsePrefixes.
	cidrs := []string{
		// IPv4 special-use ranges
		"0.0.0.0/8",        // "This network" (RFC1122) - routes to localhost on Linux
		"10.0.0.0/8",       // RFC1918 private
		"100.64.0.0/10",    // RFC6598 CGNAT (also Tailscale default tailnet range)
		"127.0.0.0/8",      // IPv4 loopback
		"169.254.0.0/16",   // RFC3927 link-local
		"172.16.0.0/12",    // RFC1918 private
		"192.0.0.0/24",     // TEST-NET-1 (documentation/examples)
		"192.0.2.0/24",     // TEST-NET-2 (documentation/examples)
		"192.31.196.0/24",  // AS112-v4
		"192.52.193.0/24",  // AMT
		"192.88.99.0/24",   // IPv4 6to4 relay anycast
		"192.168.0.0/16",   // RFC1918 private
		"192.175.48.0/24",  // DIRECT (Direct Dispatch)
		"198.18.0.0/15",    // Benchmarking
		"198.51.100.0/24",  // TEST-NET-3 (documentation/examples)
		"203.0.113.0/24",   // TEST-NET-4 (documentation/examples)
		"240.0.0.0/4",      // Reserved for future use
		// IPv6 special-use ranges
		"::1/128",          // IPv6 loopback
		"64:ff9b::/96",     // IPv4/IPv6 translation (RFC6052)
		"64:ff9b:1::/48",   // IPv4/IPv6 translation (RFC8215)
		"100::/64",         // Discard prefix (RFC6666)
		"2001::/23",        // IETF protocol assignments (RFC2928)
		"2001:db8::/32",    // Documentation (RFC3849)
		"2001:20::/28",     // ORCHIDv2 (RFC7343)
		"2002::/16",        // 6to4 (RFC3056)
		"2620:4f:8000::/48", // TEST
		"3fff::/20",        // Deprecated
		"5f00::/16",        // Deprecated
		"fc00::/7",         // IPv6 unique local
		"fe80::/10",        // IPv6 link-local
	}

	for _, cidr := range cidrs {
		_, block, err := net.ParseCIDR(cidr)
		if err != nil {
			panic(fmt.Sprintf("failed to parse CIDR %s: %v", cidr, err))
		}
		privateIPBlocks = append(privateIPBlocks, block)
	}
}

// allowLocalhost can be set to true to permit loopback addresses (e.g. for e2e tests
// that use a local mock HTTP server). This is set via init() in ssrf_testing.go when
// built with the test_endpoints build tag.
var allowLocalhost bool

type ipResolver interface {
	LookupIP(context.Context, string, string) ([]net.IP, error)
}

// isPrivateIP checks if an IP address is in a private/reserved range.
func isPrivateIP(ip net.IP) bool {
	if ip.IsLoopback() {
		return !allowLocalhost
	}
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return true
	}

	for _, block := range privateIPBlocks {
		if block.Contains(ip) {
			return true
		}
	}
	return false
}

// ssrfSafeDialContext returns a DialContext function that validates resolved IPs
// against the private IP blocklist before establishing a connection.
// This prevents DNS rebinding attacks by checking the IP at connection time
// (not in a separate pre-check that could be subject to TOCTOU races).
func ssrfSafeDialContext(timeout time.Duration) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return ssrfSafeDialContextWithResolver(timeout, net.DefaultResolver)
}

func ssrfSafeDialContextWithResolver(timeout time.Duration, resolver ipResolver) func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, fmt.Errorf("ssrf: invalid address %s: %w", addr, err)
		}

		if host == "" {
			return nil, fmt.Errorf("ssrf: empty hostname")
		}

		// Resolve hostname to IP addresses
		resolveCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		ips, err := resolver.LookupIP(resolveCtx, "ip", host)
		if err != nil {
			return nil, fmt.Errorf("ssrf: failed to resolve hostname %s: %w", host, err)
		}
		if len(ips) == 0 {
			return nil, fmt.Errorf("ssrf: hostname %s resolved to no addresses", host)
		}

		// Check all resolved IPs against the blocklist
		for _, ip := range ips {
			if isPrivateIP(ip) {
				return nil, fmt.Errorf("ssrf: blocked request to %s (resolves to private IP %s)", host, ip)
			}
		}

		// Connect to the already-validated addresses directly, preventing a second
		// DNS lookup while still falling back when the first family is unreachable
		// (for example, an IPv6-first result on an IPv4-only host).
		attemptTimeout := timeout
		if len(ips) > 1 {
			attemptTimeout = min(timeout/2, 2*time.Second)
		}
		var dialErrors []error
		for _, ip := range ips {
			dialer := &net.Dialer{
				Timeout:   attemptTimeout,
				KeepAlive: 30 * time.Second,
			}
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return conn, nil
			}
			dialErrors = append(dialErrors, fmt.Errorf("%s: %w", ip, err))
		}
		return nil, fmt.Errorf("ssrf: failed to connect to %s: %w", host, errors.Join(dialErrors...))
	}
}

// NewSSRFSafeClient creates an HTTP client with SSRF protection.
// IP validation happens at connection time in DialContext, preventing DNS rebinding attacks.
func NewSSRFSafeClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext:           ssrfSafeDialContext(10 * time.Second),
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 10 * time.Second,
			MaxIdleConns:          10,
			IdleConnTimeout:       30 * time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("ssrf: too many redirects (max 5)")
			}
			return nil
		},
	}
}
