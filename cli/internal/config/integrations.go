package config

import (
	"strings"

	"github.com/c2h5oh/datasize"
)

// SMTPTLSPolicy controls how the SMTP client encrypts the transport.
type SMTPTLSPolicy string

const (
	SMTPTLSMandatory     SMTPTLSPolicy = "mandatory"
	SMTPTLSOpportunistic SMTPTLSPolicy = "opportunistic"
	SMTPTLSImplicit      SMTPTLSPolicy = "implicit"
)

// TLSPolicyOrDefault returns the configured SMTP TLS policy, defaulting to
// mandatory STARTTLS so transactional email tokens are not sent in plaintext.
// Port 465 is the standard implicit TLS/SMTPS submission port, so treat the
// default/mandatory policy as implicit TLS there for operator compatibility.
func (c *SMTPConfig) TLSPolicyOrDefault() SMTPTLSPolicy {
	policy := SMTPTLSPolicy(strings.ToLower(strings.TrimSpace(string(c.TLS))))
	if policy == "" {
		if c.Port == 465 {
			return SMTPTLSImplicit
		}
		return SMTPTLSMandatory
	}
	if policy == SMTPTLSMandatory && c.Port == 465 {
		return SMTPTLSImplicit
	}
	return policy
}

// SMTPConfig contains settings for sending transactional emails.
type SMTPConfig struct {
	Enabled       bool          `toml:"enabled" env:"CHATTO_SMTP_ENABLED" comment:"Enable SMTP for sending transactional emails (verification, password reset, etc.)."`
	Host          string        `toml:"host" env:"CHATTO_SMTP_HOST" comment:"SMTP server hostname. Example: smtp.example.com"`
	Port          int           `toml:"port" env:"CHATTO_SMTP_PORT" comment:"SMTP server port. Common value: 587 (STARTTLS)."`
	TLS           SMTPTLSPolicy `toml:"tls" env:"CHATTO_SMTP_TLS" comment:"SMTP TLS policy: mandatory STARTTLS (default), implicit TLS/SMTPS, or opportunistic. Opportunistic allows plaintext fallback and should only be used when explicitly required."`
	TLSServerName string        `toml:"tls_server_name,commented" env:"CHATTO_SMTP_TLS_SERVER_NAME" comment:"SMTP TLS server name for certificate verification and SNI. Use when smtp.host is an IP address or internal alias but the certificate is issued for a DNS name."`
	TLSSkipVerify bool          `toml:"tls_skip_verify,commented" env:"CHATTO_SMTP_TLS_SKIP_VERIFY" comment:"Disable SMTP TLS certificate verification. Insecure; use only for trusted internal SMTP servers with self-signed or mismatched certificates."`
	Username      string        `toml:"username" env:"CHATTO_SMTP_USERNAME" comment:"SMTP authentication username."`
	Password      string        `toml:"password" env:"CHATTO_SMTP_PASSWORD" comment:"SMTP authentication password. NEVER SHARE THIS!"`
	From          string        `toml:"from" env:"CHATTO_SMTP_FROM" comment:"From address for outgoing emails. Example: noreply@example.com"`
}

// EmailTransport identifies the configured transactional email submission transport.
type EmailTransport string

const (
	// EmailTransportSMTP submits transactional email through SMTP.
	EmailTransportSMTP EmailTransport = "smtp"
	// EmailTransportJMAP submits transactional email through JMAP.
	EmailTransportJMAP EmailTransport = "jmap"
)

// JMAPConfig contains settings for transactional email submitted through JMAP.
type JMAPConfig struct {
	SessionURL     string `toml:"session_url,commented" env:"CHATTO_EMAIL_JMAP_SESSION_URL" comment:"JMAP session resource URL. Must use HTTPS."`
	AccessToken    string `toml:"access_token,commented" env:"CHATTO_EMAIL_JMAP_ACCESS_TOKEN" comment:"Bearer access token for the JMAP account. NEVER SHARE THIS!"`
	From           string `toml:"from,commented" env:"CHATTO_EMAIL_JMAP_FROM" comment:"From address for outgoing emails. It must match a JMAP identity. Example: noreply@example.com"`
	AccountID      string `toml:"account_id,commented" env:"CHATTO_EMAIL_JMAP_ACCOUNT_ID" comment:"Optional JMAP account ID. Defaults to the session's primary submission account."`
	IdentityID     string `toml:"identity_id,commented" env:"CHATTO_EMAIL_JMAP_IDENTITY_ID" comment:"Optional JMAP identity ID. Defaults to the identity matching jmap.from."`
	DraftMailboxID string `toml:"draft_mailbox_id,commented" env:"CHATTO_EMAIL_JMAP_DRAFT_MAILBOX_ID" comment:"Optional JMAP Drafts mailbox ID. Defaults to the mailbox with role 'drafts'."`
}

// EmailConfig contains transactional email transport settings. SMTP remains the
// default so existing configurations continue to work without changes.
type EmailConfig struct {
	Transport EmailTransport `toml:"transport" env:"CHATTO_EMAIL_TRANSPORT" comment:"Transactional email transport: smtp (default) or jmap."`
	JMAP      JMAPConfig     `toml:"jmap,commented" comment:"JMAP transactional email configuration. Used only when email.transport = 'jmap'."`
}

// TransportOrDefault returns the selected transport, defaulting to SMTP for
// backward compatibility with existing SMTP-only configurations.
func (c EmailConfig) TransportOrDefault() EmailTransport {
	transport := EmailTransport(strings.ToLower(strings.TrimSpace(string(c.Transport))))
	if transport == "" {
		return EmailTransportSMTP
	}
	return transport
}

// PushConfig contains settings for Web Push notifications.
// Push notifications allow messages to be delivered even when the browser is closed.
//
// Web Push needs no configuration. When the operator supplies no VAPID key
// pair, the server generates one on first start and keeps it in runtime state.
// The server contacts a browser push service only after a member grants
// notification permission on a device.
//
// ChattoConfig.ApplyDefaults fills VAPIDSubject when the operator left it
// empty: first from an https webserver.url, then from mailto: plus the first
// usable owners.emails address. The server URL comes first so a public https
// server does not disclose an operator address to third-party push services.
type PushConfig struct {
	Enabled         *bool  `toml:"enabled" env:"CHATTO_PUSH_ENABLED" comment:"Enable Web Push notifications. Default: true. The server generates a VAPID key pair when none is configured."`
	VAPIDPublicKey  string `toml:"vapid_public_key" env:"CHATTO_PUSH_VAPID_PUBLIC_KEY" comment:"VAPID public key (base64url-encoded). Optional. Set it with vapid_private_key to use your own key pair instead of the generated one."`
	VAPIDPrivateKey string `toml:"vapid_private_key" env:"CHATTO_PUSH_VAPID_PRIVATE_KEY" comment:"VAPID private key (base64url-encoded). Optional, but required with vapid_public_key. NEVER SHARE THIS!"`
	VAPIDSubject    string `toml:"vapid_subject" env:"CHATTO_PUSH_VAPID_SUBJECT" comment:"VAPID subject (operator email, optional mailto: prefix, or https: URL). Used by push services to contact the operator. Defaults to webserver.url when that is an https URL, and then to mailto: plus the first owners.emails address."`
}

// EnabledOrDefault reports whether Web Push is enabled. Push is on by default;
// set enabled = false to keep the feature and its UI hidden.
func (c *PushConfig) EnabledOrDefault() bool {
	if c.Enabled == nil {
		return true
	}
	return *c.Enabled
}

// HasOperatorVAPIDKeys reports whether the operator supplied a complete VAPID
// key pair. An incomplete pair is a configuration error, not a request for a
// generated pair, so Validate rejects it.
func (c *PushConfig) HasOperatorVAPIDKeys() bool {
	return c.VAPIDPublicKey != "" && c.VAPIDPrivateKey != ""
}

// IsConfigured returns true if push notifications are enabled and every VAPID
// field is present. Generated keys are resolved into this config during server
// startup, so this stays false until that resolution has run.
func (c *PushConfig) IsConfigured() bool {
	return c.EnabledOrDefault() && c.HasOperatorVAPIDKeys() && c.VAPIDSubject != ""
}

// VideoConfig controls whether video uploads are accepted and their upload limit.
type VideoConfig struct {
	Enabled       bool              `toml:"enabled" env:"CHATTO_VIDEO_ENABLED" comment:"Allow video uploads and enqueue derivative processing. Requires at least one asset-processing worker."`
	MaxUploadSize datasize.ByteSize `toml:"max_upload_size,commented" env:"CHATTO_VIDEO_MAX_UPLOAD_SIZE" comment:"Maximum size for video uploads. Supports human-readable formats like '100 MB'. Default: 100 MB."`
}

// AssetProcessingConfig controls the durable asset-processing worker. Enabled
// determines whether chatto run embeds the worker; the standalone chatto
// asset-processing command runs explicitly but uses the remaining settings.
type AssetProcessingConfig struct {
	Enabled           bool   `toml:"enabled" env:"CHATTO_ASSET_PROCESSING_ENABLED" comment:"Start the built-in asset-processing worker inside chatto run."`
	FFmpegPath        string `toml:"ffmpeg_path,commented" env:"CHATTO_ASSET_PROCESSING_FFMPEG_PATH" comment:"Path to ffmpeg binary. Auto-detected from PATH if empty."`
	FFprobePath       string `toml:"ffprobe_path,commented" env:"CHATTO_ASSET_PROCESSING_FFPROBE_PATH" comment:"Path to ffprobe binary. Auto-detected from PATH if empty."`
	MaxConcurrentJobs int    `toml:"max_concurrent_jobs,commented" env:"CHATTO_ASSET_PROCESSING_MAX_CONCURRENT_JOBS" comment:"Maximum number of asset-processing jobs to run simultaneously in this process. Default: 2."`
	TempDir           string `toml:"temp_dir,commented" env:"CHATTO_ASSET_PROCESSING_TEMP_DIR" comment:"Temporary directory for asset processing. Default: system temp directory."`
}

// DefaultVideoMaxUploadSize is the default maximum size for video uploads (100 MB).
const DefaultVideoMaxUploadSize datasize.ByteSize = 100 * datasize.MB

// MaxConcurrentJobsOrDefault returns the maximum concurrent jobs for one
// asset-processing worker process, defaulting to 2.
func (c *AssetProcessingConfig) MaxConcurrentJobsOrDefault() int {
	if c.MaxConcurrentJobs <= 0 {
		return 2
	}
	return c.MaxConcurrentJobs
}

// MaxUploadSizeOrDefault returns the max video upload size, defaulting to 100 MB.
func (c *VideoConfig) MaxUploadSizeOrDefault() datasize.ByteSize {
	if c.MaxUploadSize == 0 {
		return DefaultVideoMaxUploadSize
	}
	return c.MaxUploadSize
}

// LiveKitConfig contains settings for LiveKit voice call integration.
// LiveKit is an external media server that handles WebRTC voice/video connections.
type LiveKitConfig struct {
	Enabled          bool   `toml:"enabled" env:"CHATTO_LIVEKIT_ENABLED" comment:"Enable LiveKit voice call support. Requires a running LiveKit server."`
	URL              string `toml:"url" env:"CHATTO_LIVEKIT_URL" comment:"LiveKit server WebSocket URL. Example: ws://localhost:7880 (dev) or wss://livekit.example.com (prod)."`
	APIKey           string `toml:"api_key" env:"CHATTO_LIVEKIT_API_KEY" comment:"LiveKit API key."`
	APISecret        string `toml:"api_secret" env:"CHATTO_LIVEKIT_API_SECRET" comment:"LiveKit API secret. NEVER SHARE THIS!"`
	WebhookURL       string `toml:"webhook_url" env:"CHATTO_LIVEKIT_WEBHOOK_URL" comment:"URL where LiveKit sends webhook events. Defaults to {webserver.url}/webhooks/livekit."`
	ServerID         string `toml:"server_id,commented" env:"CHATTO_LIVEKIT_SERVER_ID" comment:"Unique identifier for this server, prefixed to LiveKit room names. Required when multiple Chatto servers share the same LiveKit cluster."`
	InstanceID       string `toml:"instance_id,commented" env:"CHATTO_LIVEKIT_INSTANCE_ID" comment:"Deprecated alias for server_id. Prefer server_id / CHATTO_LIVEKIT_SERVER_ID."`
	WebhookAPIKey    string `toml:"webhook_api_key,commented" env:"CHATTO_LIVEKIT_WEBHOOK_API_KEY" comment:"API key LiveKit uses to sign webhooks. Falls back to api_key if not set. Required when the webhook signing key differs from the per-server API key."`
	WebhookAPISecret string `toml:"webhook_api_secret,commented" env:"CHATTO_LIVEKIT_WEBHOOK_API_SECRET" comment:"API secret for webhook signature validation. Falls back to api_secret if not set."`
}

// WebhookKeyPair returns the key/secret used to validate incoming LiveKit webhooks.
// In shared deployments, LiveKit signs webhooks with a dedicated webhook key that
// differs from the per-tenant API key. Falls back to the tenant API key/secret
// when webhook-specific credentials are not configured.
func (c *LiveKitConfig) WebhookKeyPair() (key, secret string) {
	if c.WebhookAPIKey != "" && c.WebhookAPISecret != "" {
		return c.WebhookAPIKey, c.WebhookAPISecret
	}
	return c.APIKey, c.APISecret
}

// IsConfigured returns true if LiveKit is enabled and all required fields are set.
func (c *LiveKitConfig) IsConfigured() bool {
	return c.Enabled && c.URL != "" && c.APIKey != "" && c.APISecret != ""
}
