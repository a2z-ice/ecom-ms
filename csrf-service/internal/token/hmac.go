// Package token provides HMAC-SHA256 based CSRF token generation and verification.
// Tokens are self-contained (carry user, origin, expiry, and unique ID) and can be
// verified without any external state — no Redis required.
package token

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"time"
)

var (
	ErrInvalidToken  = errors.New("invalid token")
	ErrExpiredToken  = errors.New("expired token")
	ErrTamperedToken = errors.New("tampered token")
)

const (
	jtiSize  = 16 // 128-bit unique ID
	macSize  = 32 // SHA-256 output
	iatSize  = 8  // int64 unix timestamp
	lenSize  = 2  // uint16 length prefix for variable fields
)

// Payload holds the decoded CSRF token claims.
type Payload struct {
	Sub string   // JWT subject (user binding)
	Org string   // Request origin (origin binding)
	Iat int64    // Issued-at Unix timestamp
	Jti [jtiSize]byte // Unique token ID (for single-use enforcement)
}

// Generator creates and verifies HMAC-SHA256 CSRF tokens.
type Generator struct {
	keyRing *KeyRing
	ttl     time.Duration
}

// NewGenerator creates a token generator with the given key ring and TTL.
func NewGenerator(kr *KeyRing, ttl time.Duration) *Generator {
	return &Generator{keyRing: kr, ttl: ttl}
}

// Generate creates a new HMAC-signed CSRF token for the given user and origin.
// Returns the raw Base64URL-encoded token. No external I/O.
func (g *Generator) Generate(userID, origin string) (string, Payload, error) {
	var jti [jtiSize]byte
	if _, err := rand.Read(jti[:]); err != nil {
		return "", Payload{}, err
	}

	p := Payload{
		Sub: userID,
		Org: origin,
		Iat: time.Now().Unix(),
		Jti: jti,
	}

	data := encodePayload(p)
	mac := g.keyRing.Sign(data)
	raw := append(data, mac...)

	return base64.RawURLEncoding.EncodeToString(raw), p, nil
}

// Verify decodes and verifies an HMAC token. Returns the payload if valid.
// Checks: signature integrity, TTL expiry. Does NOT check user/origin binding
// (caller must do that for flexibility).
func (g *Generator) Verify(token string) (Payload, error) {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return Payload{}, ErrInvalidToken
	}

	if len(raw) < macSize+iatSize+jtiSize+2*lenSize {
		return Payload{}, ErrInvalidToken
	}

	data := raw[:len(raw)-macSize]
	mac := raw[len(raw)-macSize:]

	if !g.keyRing.Verify(data, mac) {
		return Payload{}, ErrTamperedToken
	}

	p, err := decodePayload(data)
	if err != nil {
		return Payload{}, ErrInvalidToken
	}

	elapsed := time.Now().Unix() - p.Iat
	if elapsed < 0 || elapsed > int64(g.ttl.Seconds()) {
		return Payload{}, ErrExpiredToken
	}

	return p, nil
}

// encodePayload serializes a Payload to compact binary format:
// [2-byte sub length][sub bytes][2-byte org length][org bytes][8-byte iat][16-byte jti]
func encodePayload(p Payload) []byte {
	subBytes := []byte(p.Sub)
	orgBytes := []byte(p.Org)
	size := lenSize + len(subBytes) + lenSize + len(orgBytes) + iatSize + jtiSize
	buf := make([]byte, size)

	offset := 0
	binary.BigEndian.PutUint16(buf[offset:], uint16(len(subBytes)))
	offset += lenSize
	copy(buf[offset:], subBytes)
	offset += len(subBytes)

	binary.BigEndian.PutUint16(buf[offset:], uint16(len(orgBytes)))
	offset += lenSize
	copy(buf[offset:], orgBytes)
	offset += len(orgBytes)

	binary.BigEndian.PutUint64(buf[offset:], uint64(p.Iat))
	offset += iatSize

	copy(buf[offset:], p.Jti[:])

	return buf
}

// decodePayload deserializes binary data back to a Payload.
func decodePayload(data []byte) (Payload, error) {
	if len(data) < 2*lenSize+iatSize+jtiSize {
		return Payload{}, ErrInvalidToken
	}

	var p Payload
	offset := 0

	subLen := int(binary.BigEndian.Uint16(data[offset:]))
	offset += lenSize
	if offset+subLen > len(data) {
		return Payload{}, ErrInvalidToken
	}
	p.Sub = string(data[offset : offset+subLen])
	offset += subLen

	if offset+lenSize > len(data) {
		return Payload{}, ErrInvalidToken
	}
	orgLen := int(binary.BigEndian.Uint16(data[offset:]))
	offset += lenSize
	if offset+orgLen > len(data) {
		return Payload{}, ErrInvalidToken
	}
	p.Org = string(data[offset : offset+orgLen])
	offset += orgLen

	if offset+iatSize+jtiSize > len(data) {
		return Payload{}, ErrInvalidToken
	}
	p.Iat = int64(binary.BigEndian.Uint64(data[offset:]))
	offset += iatSize

	copy(p.Jti[:], data[offset:offset+jtiSize])

	return p, nil
}

// sign computes HMAC-SHA256.
func sign(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}
