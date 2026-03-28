package cuckoo

import (
	"crypto/rand"
	"fmt"
	"sync"
	"testing"
)

func randomJTI() []byte {
	jti := make([]byte, 16)
	rand.Read(jti)
	return jti
}

func TestInsertAndLookup(t *testing.T) {
	f := NewFilter(1000)
	jti := randomJTI()

	if f.Lookup(jti) {
		t.Fatal("expected not found before insert")
	}
	if !f.Insert(jti) {
		t.Fatal("expected insert to succeed")
	}
	if !f.Lookup(jti) {
		t.Fatal("expected found after insert")
	}
}

func TestDelete(t *testing.T) {
	f := NewFilter(1000)
	jti := randomJTI()

	f.Insert(jti)
	if !f.Delete(jti) {
		t.Fatal("expected delete to succeed")
	}
	if f.Lookup(jti) {
		t.Fatal("expected not found after delete")
	}
}

func TestDeleteNonExistent(t *testing.T) {
	f := NewFilter(1000)
	jti := randomJTI()
	if f.Delete(jti) {
		t.Fatal("expected delete of non-existent to return false")
	}
}

func TestCount(t *testing.T) {
	f := NewFilter(1000)
	for i := 0; i < 100; i++ {
		f.Insert(randomJTI())
	}
	if f.Count() != 100 {
		t.Fatalf("expected count 100, got %d", f.Count())
	}
}

func TestReset(t *testing.T) {
	f := NewFilter(1000)
	for i := 0; i < 50; i++ {
		f.Insert(randomJTI())
	}
	f.Reset()
	if f.Count() != 0 {
		t.Fatalf("expected count 0 after reset, got %d", f.Count())
	}
}

func TestFalsePositiveRate(t *testing.T) {
	capacity := uint(100000)
	f := NewFilter(capacity)

	// Insert 10K items
	inserted := make([][]byte, 10000)
	for i := range inserted {
		inserted[i] = randomJTI()
		f.Insert(inserted[i])
	}

	// Check 100K non-inserted items for false positives
	falsePositives := 0
	checks := 100000
	for i := 0; i < checks; i++ {
		jti := randomJTI()
		if f.Lookup(jti) {
			falsePositives++
		}
	}

	fpRate := float64(falsePositives) / float64(checks)
	t.Logf("False positive rate: %.4f%% (%d/%d)", fpRate*100, falsePositives, checks)

	// Cuckoo filter should be well under 1%
	if fpRate > 0.01 {
		t.Fatalf("false positive rate too high: %.4f%%", fpRate*100)
	}
}

func TestConcurrentInsertLookup(t *testing.T) {
	f := NewFilter(10000)
	var wg sync.WaitGroup

	for i := 0; i < 100; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			f.Insert(randomJTI())
		}()
		go func() {
			defer wg.Done()
			f.Lookup(randomJTI())
		}()
	}
	wg.Wait()

	if f.Count() != 100 {
		t.Fatalf("expected 100, got %d", f.Count())
	}
}

func TestDuplicateInsert(t *testing.T) {
	f := NewFilter(1000)
	jti := randomJTI()
	f.Insert(jti)
	// Second insert of same item — implementation-specific behavior
	// But lookup should still return true
	f.Insert(jti)
	if !f.Lookup(jti) {
		t.Fatal("expected found after duplicate insert")
	}
}

func TestManyItems(t *testing.T) {
	f := NewFilter(50000)
	jtis := make([][]byte, 10000)
	for i := range jtis {
		jtis[i] = []byte(fmt.Sprintf("jti-%d", i))
		f.Insert(jtis[i])
	}

	// All inserted items should be found
	for i, jti := range jtis {
		if !f.Lookup(jti) {
			t.Fatalf("item %d not found", i)
		}
	}
}
