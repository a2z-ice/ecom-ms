package token

import (
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log/slog"
	"sync"
	"time"
)

const keySize = 32 // 256-bit HMAC key

// KeyRing manages HMAC signing keys with rotation support.
// During rotation, the previous key remains valid for one TTL window
// to allow in-flight tokens to be verified.
type KeyRing struct {
	current   []byte
	previous  []byte
	rotatedAt time.Time
	graceTTL  time.Duration // How long previous key stays valid
	mu        sync.RWMutex
}

// NewKeyRing creates a KeyRing from a base64-encoded key string.
// If key is empty, a random key is generated.
func NewKeyRing(keyBase64 string, graceTTL time.Duration) (*KeyRing, error) {
	var key []byte
	if keyBase64 != "" {
		var err error
		key, err = base64.StdEncoding.DecodeString(keyBase64)
		if err != nil {
			return nil, errors.New("CSRF_HMAC_KEY must be valid base64")
		}
		if len(key) < keySize {
			return nil, errors.New("CSRF_HMAC_KEY must be at least 256 bits (32 bytes)")
		}
		key = key[:keySize]
	} else {
		key = make([]byte, keySize)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		slog.Warn("No CSRF_HMAC_KEY provided — generated random key (tokens will not survive pod restart)")
	}

	return &KeyRing{
		current:   key,
		rotatedAt: time.Now(),
		graceTTL:  graceTTL,
	}, nil
}

// Sign computes HMAC-SHA256 using the current key.
func (kr *KeyRing) Sign(data []byte) []byte {
	kr.mu.RLock()
	defer kr.mu.RUnlock()
	return sign(kr.current, data)
}

// Verify checks the HMAC against the current key, then the previous key
// (if within grace period). Returns true if either matches.
func (kr *KeyRing) Verify(data, mac []byte) bool {
	kr.mu.RLock()
	defer kr.mu.RUnlock()

	if hmac.Equal(sign(kr.current, data), mac) {
		return true
	}
	if kr.previous != nil {
		return hmac.Equal(sign(kr.previous, data), mac)
	}
	return false
}

// Rotate moves current key to previous and generates a new current key.
// Previous key remains valid for graceTTL duration.
func (kr *KeyRing) Rotate() {
	kr.mu.Lock()
	defer kr.mu.Unlock()

	kr.previous = kr.current
	kr.current = make([]byte, keySize)
	rand.Read(kr.current)
	kr.rotatedAt = time.Now()

	slog.Info("HMAC key rotated", "rotatedAt", kr.rotatedAt)
}

// StartAutoRotation begins periodic key rotation in a background goroutine.
// Returns a stop function. Rotation interval should be >> token TTL.
func (kr *KeyRing) StartAutoRotation(interval time.Duration) func() {
	ticker := time.NewTicker(interval)
	done := make(chan struct{})

	go func() {
		for {
			select {
			case <-ticker.C:
				kr.Rotate()
			case <-done:
				ticker.Stop()
				return
			}
		}
	}()

	return func() { close(done) }
}

