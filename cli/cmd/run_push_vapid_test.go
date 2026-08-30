package cmd

import (
	"context"
	"testing"
	"time"

	"hmans.de/chatto/internal/config"
	"hmans.de/chatto/internal/core"
	"hmans.de/chatto/internal/testutil"
)

func boolPtr(v bool) *bool { return &v }

// A nil core proves that these paths never reach key generation: the call
// panics instead of quietly creating a key pair the server does not need.
func TestResolvePushVAPIDKeysSkipsGeneration(t *testing.T) {
	tests := []struct {
		name string
		push config.PushConfig
	}{
		{
			name: "push is disabled",
			push: config.PushConfig{Enabled: boolPtr(false), VAPIDSubject: "https://chat.example"},
		},
		{
			name: "no contact URI is available",
			push: config.PushConfig{},
		},
		{
			name: "the operator configured a key pair",
			push: config.PushConfig{
				VAPIDSubject:    "https://chat.example",
				VAPIDPublicKey:  "operator-public-key",
				VAPIDPrivateKey: "operator-private-key",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg := config.ChattoConfig{Push: tt.push}
			if err := resolvePushVAPIDKeys(context.Background(), nil, &cfg); err != nil {
				t.Fatalf("resolvePushVAPIDKeys() failed: %v", err)
			}
			if cfg.Push != tt.push {
				t.Fatalf("push configuration changed: got %+v, want %+v", cfg.Push, tt.push)
			}
		})
	}
}

// Startup must put the generated pair into the configuration that the push
// sender and the client-facing server state read later in the boot sequence.
func TestResolvePushVAPIDKeysFillsGeneratedPair(t *testing.T) {
	_, nc := testutil.StartNATS(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)

	chattoCore, err := core.NewChattoCore(ctx, nc, config.CoreConfig{
		SecretKey: "run-push-vapid-test-secret",
		Assets:    config.AssetsConfig{SigningSecret: "run-push-vapid-test-assets"},
	})
	if err != nil {
		t.Fatalf("NewChattoCore() failed: %v", err)
	}

	cfg := config.ChattoConfig{Push: config.PushConfig{VAPIDSubject: "https://chat.example"}}
	if err := resolvePushVAPIDKeys(ctx, chattoCore, &cfg); err != nil {
		t.Fatalf("resolvePushVAPIDKeys() failed: %v", err)
	}
	if cfg.Push.VAPIDPublicKey == "" || cfg.Push.VAPIDPrivateKey == "" {
		t.Fatalf("resolved key pair is incomplete: public=%q private=%q",
			cfg.Push.VAPIDPublicKey, cfg.Push.VAPIDPrivateKey)
	}
	if !cfg.Push.IsConfigured() {
		t.Fatal("push must be configured after the key pair is resolved")
	}

	// A restart must reuse the stored pair; a new one would invalidate every
	// browser subscription made with the old public key.
	restarted := config.ChattoConfig{Push: config.PushConfig{VAPIDSubject: "https://chat.example"}}
	if err := resolvePushVAPIDKeys(ctx, chattoCore, &restarted); err != nil {
		t.Fatalf("second resolvePushVAPIDKeys() failed: %v", err)
	}
	if restarted.Push != cfg.Push {
		t.Fatalf("key pair changed across restart: got %+v, want %+v", restarted.Push, cfg.Push)
	}
}
