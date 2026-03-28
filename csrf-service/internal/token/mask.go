package token

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
)

// Mask applies XOR BREACH protection to a token.
// Output: Base64URL(random || (tokenBytes XOR random))
// Every call produces a different output for the same input.
func Mask(token string) (string, error) {
	tokenBytes := []byte(token)
	random := make([]byte, len(tokenBytes))
	if _, err := rand.Read(random); err != nil {
		return "", err
	}

	xored := make([]byte, len(tokenBytes))
	for i := range tokenBytes {
		xored[i] = tokenBytes[i] ^ random[i]
	}

	combined := append(random, xored...)
	return base64.RawURLEncoding.EncodeToString(combined), nil
}

// Unmask reverses XOR BREACH masking to recover the original token.
// Input must be Base64URL(random || xored) where len(random) == len(xored).
func Unmask(masked string) (string, error) {
	combined, err := base64.RawURLEncoding.DecodeString(masked)
	if err != nil {
		return "", errors.New("invalid masked token encoding")
	}

	if len(combined)%2 != 0 {
		return "", errors.New("invalid masked token length")
	}
	if len(combined) == 0 {
		return "", nil
	}

	half := len(combined) / 2
	random := combined[:half]
	xored := combined[half:]

	original := make([]byte, half)
	for i := range xored {
		original[i] = xored[i] ^ random[i]
	}

	return string(original), nil
}
