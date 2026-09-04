package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"hmans.de/chatto/internal/jetstreamutil"
)

// serverVAPIDKeysKey is the RUNTIME_STATE key that holds the server's Web Push
// application-server key pair. The record lives in RUNTIME_STATE, not in
// ENCRYPTION_KEYS, so a normal backup keeps the key pair together with the
// browser subscriptions it authenticates.
const serverVAPIDKeysKey = "push_vapid_keys"

// serverVAPIDKeysMaxAttempts bounds the read-generate-create loop that settles
// one key pair when several replicas start at the same time.
const serverVAPIDKeysMaxAttempts = 3

// serverVAPIDKeys is the stored representation of a generated VAPID key pair.
// Both keys are base64url-encoded, in the format that browsers and push
// services expect for the application-server key.
type serverVAPIDKeys struct {
	PublicKey  string    `json:"public_key"`
	PrivateKey string    `json:"private_key"`
	CreatedAt  time.Time `json:"created_at"`
}

// EnsureServerVAPIDKeys returns the server's Web Push VAPID key pair. It
// generates and stores one on first use, so operators do not have to supply
// keys to make Web Push available.
//
// The key pair is stable for the life of the server's runtime state: browser
// subscriptions are bound to the public key that created them, so a new pair
// would invalidate every existing subscription. Concurrent replicas settle on
// exactly one pair because the record is created, never overwritten; a replica
// that loses the race reads the winner's pair instead.
//
// Operator-supplied keys take precedence and are never written here.
func (c *ChattoCore) EnsureServerVAPIDKeys(ctx context.Context) (publicKey string, privateKey string, err error) {
	for range serverVAPIDKeysMaxAttempts {
		entry, getErr := c.storage.runtimeStateKV.Get(ctx, serverVAPIDKeysKey)
		switch {
		case getErr == nil:
			var stored serverVAPIDKeys
			if err := json.Unmarshal(entry.Value(), &stored); err != nil {
				return "", "", fmt.Errorf("failed to unmarshal stored Web Push VAPID keys: %w", err)
			}
			if stored.PublicKey == "" || stored.PrivateKey == "" {
				return "", "", errors.New("stored Web Push VAPID key record is incomplete")
			}
			return stored.PublicKey, stored.PrivateKey, nil
		case !isPushRuntimeStateKeyAbsent(getErr):
			return "", "", fmt.Errorf("failed to read stored Web Push VAPID keys: %w", getErr)
		}

		generatedPrivate, generatedPublic, generateErr := webpush.GenerateVAPIDKeys()
		if generateErr != nil {
			return "", "", fmt.Errorf("failed to generate Web Push VAPID keys: %w", generateErr)
		}
		value, marshalErr := json.Marshal(serverVAPIDKeys{
			PublicKey:  generatedPublic,
			PrivateKey: generatedPrivate,
			CreatedAt:  time.Now().UTC(),
		})
		if marshalErr != nil {
			return "", "", fmt.Errorf("failed to marshal Web Push VAPID keys: %w", marshalErr)
		}

		_, createErr := c.storage.runtimeStateKV.Create(ctx, serverVAPIDKeysKey, value)
		if createErr == nil {
			return generatedPublic, generatedPrivate, nil
		}
		if !jetstreamutil.IsSequenceConflict(createErr) {
			return "", "", fmt.Errorf("failed to store generated Web Push VAPID keys: %w", createErr)
		}
		// Another replica stored its pair first. Read that pair back.
	}
	return "", "", errors.New("failed to settle the server Web Push VAPID key pair")
}
