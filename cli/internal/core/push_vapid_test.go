package core

import (
	"testing"
)

func TestEnsureServerVAPIDKeysGeneratesAndKeepsOnePair(t *testing.T) {
	core, _ := newTestCore(t)
	ctx := testContext(t)

	publicKey, privateKey, err := core.EnsureServerVAPIDKeys(ctx)
	if err != nil {
		t.Fatalf("EnsureServerVAPIDKeys() failed: %v", err)
	}
	if publicKey == "" || privateKey == "" {
		t.Fatalf("generated key pair is incomplete: public=%q private=%q", publicKey, privateKey)
	}
	if publicKey == privateKey {
		t.Fatal("generated public and private keys must differ")
	}

	// A later call must return the stored pair. Browser subscriptions are bound
	// to the public key that created them, so a new pair would break them all.
	secondPublicKey, secondPrivateKey, err := core.EnsureServerVAPIDKeys(ctx)
	if err != nil {
		t.Fatalf("second EnsureServerVAPIDKeys() failed: %v", err)
	}
	if secondPublicKey != publicKey || secondPrivateKey != privateKey {
		t.Fatalf("key pair changed between calls: %q/%q then %q/%q",
			publicKey, privateKey, secondPublicKey, secondPrivateKey)
	}
}

func TestEnsureServerVAPIDKeysSettlesOnePairForConcurrentCallers(t *testing.T) {
	core, _ := newTestCore(t)
	ctx := testContext(t)

	const callers = 8
	type result struct {
		publicKey  string
		privateKey string
		err        error
	}
	results := make(chan result, callers)
	for range callers {
		go func() {
			publicKey, privateKey, err := core.EnsureServerVAPIDKeys(ctx)
			results <- result{publicKey: publicKey, privateKey: privateKey, err: err}
		}()
	}

	var first result
	for i := range callers {
		got := <-results
		if got.err != nil {
			t.Fatalf("concurrent EnsureServerVAPIDKeys() failed: %v", got.err)
		}
		if i == 0 {
			first = got
			continue
		}
		if got.publicKey != first.publicKey || got.privateKey != first.privateKey {
			t.Fatalf("concurrent callers settled on different key pairs: %q/%q and %q/%q",
				first.publicKey, first.privateKey, got.publicKey, got.privateKey)
		}
	}
}
