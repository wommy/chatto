package push

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/charmbracelet/log"

	"hmans.de/chatto/internal/config"
)

// The VAPID subject travels to every push service as the `sub` claim of a
// signed JWT. RFC 8292 allows only an `https:` or a `mailto:` URI there. The
// push library prefixes `mailto:` to anything that does not start with
// `https:`, so a subject that looks acceptable in the configuration can still
// reach a push service as garbage such as `mailto:http://chat.example`. These
// tests read the claim off the wire, because that is the only place where the
// complete chain — configuration default, normalization, and signing — is
// visible.
func TestSendSignsValidVAPIDSubject(t *testing.T) {
	tests := []struct {
		name         string
		webserverURL string
		ownerEmails  []string
		subject      string
		wantSubject  string
	}{
		{
			name:         "derives the subject from an https server URL",
			webserverURL: "https://chat.example",
			wantSubject:  "https://chat.example",
		},
		{
			name:         "keeps the https scheme of a server URL in upper case",
			webserverURL: "HTTPS://chat.example/",
			wantSubject:  "https://chat.example",
		},
		{
			name:         "keeps an operator mailto subject",
			webserverURL: "https://chat.example",
			subject:      "mailto:admin@example.com",
			wantSubject:  "mailto:admin@example.com",
		},
		{
			name:        "keeps an operator mailto subject without a server URL",
			subject:     "admin@example.com",
			wantSubject: "mailto:admin@example.com",
		},
		{
			name:         "falls back to the owner address for an http server URL",
			webserverURL: "http://localhost:4000",
			ownerEmails:  []string{"owner@example.com"},
			wantSubject:  "mailto:owner@example.com",
		},
		{
			name:         "prefers an https server URL over the owner address",
			webserverURL: "https://chat.example",
			ownerEmails:  []string{"owner@example.com"},
			wantSubject:  "https://chat.example",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := configWithResolvedPush(t, tt.webserverURL, tt.subject, tt.ownerEmails...)

			var authorization string
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				authorization = r.Header.Get("Authorization")
				w.WriteHeader(http.StatusCreated)
			}))
			defer server.Close()

			sender := NewSender(cfg.Push, log.New(nil))
			if sender == nil {
				t.Fatal("expected a configured sender")
			}
			sender.httpClient = server.Client()
			sender.validateEndpoint = func(string) error { return nil }

			result := sender.Send(context.Background(), newTestPushSubscription(t, server.URL), &Payload{Title: "Test"})
			if result.Error != nil {
				t.Fatalf("Send error: %v", result.Error)
			}

			subject := vapidSubjectClaim(t, authorization)
			if subject != tt.wantSubject {
				t.Fatalf("signed VAPID subject = %q, want %q", subject, tt.wantSubject)
			}
			if !strings.HasPrefix(subject, "https:") && !strings.HasPrefix(subject, "mailto:") {
				t.Fatalf("signed VAPID subject %q is neither an https: nor a mailto: URI (RFC 8292)", subject)
			}
		})
	}
}

// A server URL that a VAPID subject cannot be made from, together with no
// owner address to fall back to, must leave push unconfigured. Deriving a
// subject from the URL would sign every push with an invalid contact URI
// instead.
func TestSendIsUnavailableWithoutAValidSubject(t *testing.T) {
	cfg := configWithResolvedPush(t, "http://localhost:5173", "")
	if cfg.Push.VAPIDSubject != "" {
		t.Fatalf("derived VAPID subject = %q, want none for an http: server URL without owner addresses", cfg.Push.VAPIDSubject)
	}
	if sender := NewSender(cfg.Push, log.New(nil)); sender != nil {
		t.Fatal("expected no sender when no contact URI is available")
	}
}

// configWithResolvedPush mirrors the production boot order: the configuration
// defaults first, then the key pair that the server generates and stores in
// runtime state.
func configWithResolvedPush(t *testing.T, webserverURL, subject string, ownerEmails ...string) config.ChattoConfig {
	t.Helper()

	cfg := config.ChattoConfig{}
	cfg.Webserver.URL = webserverURL
	cfg.Owners.Emails = ownerEmails
	cfg.Push.VAPIDSubject = subject
	cfg.ApplyDefaults()

	privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatalf("GenerateVAPIDKeys: %v", err)
	}
	cfg.Push.VAPIDPublicKey = publicKey
	cfg.Push.VAPIDPrivateKey = privateKey
	return cfg
}

// vapidSubjectClaim reads the `sub` claim out of the signed VAPID token in an
// Authorization header of the form `vapid t=<jwt>, k=<public key>`.
func vapidSubjectClaim(t *testing.T, authorization string) string {
	t.Helper()

	if authorization == "" {
		t.Fatal("push request has no Authorization header")
	}
	var token string
	for _, part := range strings.Split(strings.TrimPrefix(authorization, "vapid "), ",") {
		part = strings.TrimSpace(part)
		if after, found := strings.CutPrefix(part, "t="); found {
			token = after
		}
	}
	if token == "" {
		t.Fatalf("Authorization header %q has no VAPID token", authorization)
	}

	segments := strings.Split(token, ".")
	if len(segments) != 3 {
		t.Fatalf("VAPID token %q is not a JWT", token)
	}
	claimsJSON, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		t.Fatalf("decode VAPID claims: %v", err)
	}
	var claims struct {
		Subject string `json:"sub"`
	}
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		t.Fatalf("unmarshal VAPID claims: %v", err)
	}
	return claims.Subject
}
