package token

import (
	"encoding/base64"
	"testing"
	"time"
)

func TestNewKeyRingFromBase64(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 100)
	}
	kr, err := NewKeyRing(base64.StdEncoding.EncodeToString(key), 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(kr.current) != keySize {
		t.Fatalf("expected key size %d, got %d", keySize, len(kr.current))
	}
}

func TestNewKeyRingRandomGenerated(t *testing.T) {
	kr, err := NewKeyRing("", 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(kr.current) != keySize {
		t.Fatalf("expected key size %d, got %d", keySize, len(kr.current))
	}
}

func TestNewKeyRingShortKey(t *testing.T) {
	shortKey := base64.StdEncoding.EncodeToString([]byte("tooshort"))
	_, err := NewKeyRing(shortKey, 10*time.Minute)
	if err == nil {
		t.Fatal("expected error for short key")
	}
}

func TestNewKeyRingInvalidBase64(t *testing.T) {
	_, err := NewKeyRing("not-valid-base64!!!", 10*time.Minute)
	if err == nil {
		t.Fatal("expected error for invalid base64")
	}
}

func TestKeyRingSignVerify(t *testing.T) {
	kr, _ := NewKeyRing("", 10*time.Minute)
	data := []byte("test-data-to-sign")
	mac := kr.Sign(data)
	if !kr.Verify(data, mac) {
		t.Fatal("expected signature to verify")
	}
}

func TestKeyRingVerifyTampered(t *testing.T) {
	kr, _ := NewKeyRing("", 10*time.Minute)
	data := []byte("test-data")
	mac := kr.Sign(data)
	mac[0] ^= 0xFF // flip bits
	if kr.Verify(data, mac) {
		t.Fatal("expected tampered signature to fail")
	}
}

func TestKeyRingRotation(t *testing.T) {
	kr, _ := NewKeyRing("", 10*time.Minute)
	data := []byte("test-data")

	// Sign with current key
	mac := kr.Sign(data)

	// Rotate
	kr.Rotate()

	// Old signature should still verify (previous key)
	if !kr.Verify(data, mac) {
		t.Fatal("expected old signature to verify after rotation (grace period)")
	}

	// New signature should also verify
	newMac := kr.Sign(data)
	if !kr.Verify(data, newMac) {
		t.Fatal("expected new signature to verify")
	}

	// Old and new signatures should differ
	if string(mac) == string(newMac) {
		t.Fatal("expected different signatures after rotation")
	}
}

func TestKeyRingDoubleRotation(t *testing.T) {
	kr, _ := NewKeyRing("", 10*time.Minute)
	data := []byte("test-data")

	mac := kr.Sign(data)
	kr.Rotate()
	kr.Rotate() // Second rotation — original key is now gone

	if kr.Verify(data, mac) {
		t.Fatal("expected original signature to fail after two rotations")
	}
}

func TestKeyRingConcurrentAccess(t *testing.T) {
	kr, _ := NewKeyRing("", 10*time.Minute)
	data := []byte("concurrent-test")

	done := make(chan bool, 100)
	for i := 0; i < 50; i++ {
		go func() {
			mac := kr.Sign(data)
			kr.Verify(data, mac)
			done <- true
		}()
		go func() {
			kr.Rotate()
			done <- true
		}()
	}
	for i := 0; i < 100; i++ {
		<-done
	}
}
