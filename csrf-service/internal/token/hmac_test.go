package token

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func testKeyRing(t *testing.T) *KeyRing {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	kr, err := NewKeyRing(base64.StdEncoding.EncodeToString(key), 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return kr
}

func TestGenerate(t *testing.T) {
	gen := NewGenerator(testKeyRing(t), 10*time.Minute)

	tok, payload, err := gen.Generate("user-123", "https://myecom.net:30000")
	if err != nil {
		t.Fatal(err)
	}
	if tok == "" {
		t.Fatal("expected non-empty token")
	}
	if payload.Sub != "user-123" {
		t.Fatalf("expected sub=user-123, got %s", payload.Sub)
	}
	if payload.Org != "https://myecom.net:30000" {
		t.Fatalf("expected org, got %s", payload.Org)
	}
	if payload.Iat == 0 {
		t.Fatal("expected non-zero iat")
	}

	// JTI should be non-zero
	allZero := true
	for _, b := range payload.Jti {
		if b != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		t.Fatal("expected non-zero JTI")
	}
}

func TestGenerateUniqueJTI(t *testing.T) {
	gen := NewGenerator(testKeyRing(t), 10*time.Minute)
	tok1, _, _ := gen.Generate("user-1", "")
	tok2, _, _ := gen.Generate("user-1", "")
	if tok1 == tok2 {
		t.Fatal("consecutive tokens should differ (unique JTI)")
	}
}

func TestVerifyValid(t *testing.T) {
	gen := NewGenerator(testKeyRing(t), 10*time.Minute)
	tok, _, err := gen.Generate("user-1", "https://origin.com")
	if err != nil {
		t.Fatal(err)
	}

	payload, err := gen.Verify(tok)
	if err != nil {
		t.Fatalf("expected valid, got error: %v", err)
	}
	if payload.Sub != "user-1" {
		t.Fatalf("sub mismatch: %s", payload.Sub)
	}
	if payload.Org != "https://origin.com" {
		t.Fatalf("org mismatch: %s", payload.Org)
	}
}

func TestVerifyTampered(t *testing.T) {
	gen := NewGenerator(testKeyRing(t), 10*time.Minute)
	tok, _, _ := gen.Generate("user-1", "")

	// Tamper: change a character in the middle
	chars := []byte(tok)
	if chars[len(chars)/2] == 'A' {
		chars[len(chars)/2] = 'B'
	} else {
		chars[len(chars)/2] = 'A'
	}
	tampered := string(chars)

	_, err := gen.Verify(tampered)
	if err == nil {
		t.Fatal("expected error for tampered token")
	}
}

func TestVerifyTruncated(t *testing.T) {
	gen := NewGenerator(testKeyRing(t), 10*time.Minute)
	tok, _, _ := gen.Generate("user-1", "")

	_, err := gen.Verify(tok[:len(tok)/2])
	if err == nil {
		t.Fatal("expected error for truncated token")
	}
}

func TestVerifyEmpty(t *testing.T) {
	gen := NewGenerator(testKeyRing(t), 10*time.Minute)
	_, err := gen.Verify("")
	if err == nil {
		t.Fatal("expected error for empty token")
	}
}

func TestVerifyGarbage(t *testing.T) {
	gen := NewGenerator(testKeyRing(t), 10*time.Minute)
	_, err := gen.Verify("not-a-valid-token!!!")
	if err == nil {
		t.Fatal("expected error for garbage token")
	}
}

func TestVerifyExpired(t *testing.T) {
	gen := NewGenerator(testKeyRing(t), 1*time.Second)
	tok, _, _ := gen.Generate("user-1", "")

	// Directly create a token with old iat
	kr := testKeyRing(&testing.T{})
	p := Payload{Sub: "user-1", Iat: time.Now().Add(-2 * time.Minute).Unix()}
	data := encodePayload(p)
	mac := kr.Sign(data)
	raw := append(data, mac...)
	expiredTok := base64.RawURLEncoding.EncodeToString(raw)

	_ = tok // suppress unused

	gen2 := NewGenerator(kr, 1*time.Minute)
	_, err := gen2.Verify(expiredTok)
	if err != ErrExpiredToken {
		t.Fatalf("expected ErrExpiredToken, got %v", err)
	}
}

func TestVerifyWrongKey(t *testing.T) {
	kr1 := testKeyRing(t)
	kr2, _ := NewKeyRing("", 10*time.Minute) // random key

	gen1 := NewGenerator(kr1, 10*time.Minute)
	gen2 := NewGenerator(kr2, 10*time.Minute)

	tok, _, _ := gen1.Generate("user-1", "")
	_, err := gen2.Verify(tok)
	if err != ErrTamperedToken {
		t.Fatalf("expected ErrTamperedToken, got %v", err)
	}
}

func TestVerifyEmptyOrigin(t *testing.T) {
	gen := NewGenerator(testKeyRing(t), 10*time.Minute)
	tok, _, _ := gen.Generate("user-1", "")

	p, err := gen.Verify(tok)
	if err != nil {
		t.Fatal(err)
	}
	if p.Org != "" {
		t.Fatalf("expected empty origin, got %s", p.Org)
	}
}

func TestPayloadRoundTrip(t *testing.T) {
	p := Payload{
		Sub: "uuid-1234-5678",
		Org: "https://myecom.net:30000",
		Iat: time.Now().Unix(),
		Jti: [16]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
	}
	data := encodePayload(p)
	decoded, err := decodePayload(data)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Sub != p.Sub {
		t.Fatalf("sub: %s != %s", decoded.Sub, p.Sub)
	}
	if decoded.Org != p.Org {
		t.Fatalf("org: %s != %s", decoded.Org, p.Org)
	}
	if decoded.Iat != p.Iat {
		t.Fatalf("iat: %d != %d", decoded.Iat, p.Iat)
	}
	if decoded.Jti != p.Jti {
		t.Fatalf("jti mismatch")
	}
}

func TestLongSubjectAndOrigin(t *testing.T) {
	gen := NewGenerator(testKeyRing(t), 10*time.Minute)
	longSub := strings.Repeat("a", 500)
	longOrg := strings.Repeat("b", 500)
	tok, _, err := gen.Generate(longSub, longOrg)
	if err != nil {
		t.Fatal(err)
	}
	p, err := gen.Verify(tok)
	if err != nil {
		t.Fatal(err)
	}
	if p.Sub != longSub || p.Org != longOrg {
		t.Fatal("long sub/org mismatch")
	}
}
