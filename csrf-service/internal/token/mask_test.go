package token

import (
	"testing"
)

func TestMaskUnmaskRoundTrip(t *testing.T) {
	original := "test-token-value-12345"
	masked, err := Mask(original)
	if err != nil {
		t.Fatal(err)
	}

	recovered, err := Unmask(masked)
	if err != nil {
		t.Fatal(err)
	}
	if recovered != original {
		t.Fatalf("round-trip failed: got %q, want %q", recovered, original)
	}
}

func TestMaskProducesDifferentOutput(t *testing.T) {
	original := "same-token"
	masked1, _ := Mask(original)
	masked2, _ := Mask(original)

	if masked1 == masked2 {
		t.Fatal("expected different masked outputs for same input (random XOR)")
	}

	// But both should unmask to the same value
	r1, _ := Unmask(masked1)
	r2, _ := Unmask(masked2)
	if r1 != original || r2 != original {
		t.Fatal("both masked values should unmask to the original")
	}
}

func TestMaskEmptyToken(t *testing.T) {
	masked, err := Mask("")
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := Unmask(masked)
	if err != nil {
		t.Fatal(err)
	}
	if recovered != "" {
		t.Fatalf("expected empty, got %q", recovered)
	}
}

func TestUnmaskInvalidBase64(t *testing.T) {
	_, err := Unmask("not-valid!!!")
	if err == nil {
		t.Fatal("expected error for invalid base64")
	}
}

func TestUnmaskOddLength(t *testing.T) {
	// Single byte base64 — odd length after decode
	_, err := Unmask("QQ") // decodes to 1 byte "A"
	if err == nil {
		t.Fatal("expected error for odd-length decoded data")
	}
}

func TestMaskLongToken(t *testing.T) {
	long := make([]byte, 1000)
	for i := range long {
		long[i] = byte(i % 256)
	}
	original := string(long)
	masked, err := Mask(original)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := Unmask(masked)
	if err != nil {
		t.Fatal(err)
	}
	if recovered != original {
		t.Fatal("long token round-trip failed")
	}
}

func TestMask10ConsecutiveDiffer(t *testing.T) {
	token := "csrf-token-abc"
	seen := make(map[string]bool)
	for i := 0; i < 10; i++ {
		masked, err := Mask(token)
		if err != nil {
			t.Fatal(err)
		}
		if seen[masked] {
			t.Fatalf("duplicate masked output on iteration %d", i)
		}
		seen[masked] = true
	}
}
