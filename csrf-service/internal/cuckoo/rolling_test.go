package cuckoo

import (
	"sync"
	"testing"
	"time"
)

func TestRollingInsertAndLookup(t *testing.T) {
	rf := NewRollingFilter(1000)
	jti := randomJTI()

	rf.Insert(jti)
	if !rf.Lookup(jti) {
		t.Fatal("expected found after insert")
	}
}

func TestRollingRotation(t *testing.T) {
	rf := NewRollingFilter(1000)
	jti1 := randomJTI()
	rf.Insert(jti1)

	// After rotation, jti1 moves to previous — still findable
	rf.Rotate()
	if !rf.Lookup(jti1) {
		t.Fatal("expected found in previous after one rotation")
	}

	// Insert new jti in current
	jti2 := randomJTI()
	rf.Insert(jti2)
	if !rf.Lookup(jti2) {
		t.Fatal("expected found in current after rotation")
	}
}

func TestRollingDoubleRotation(t *testing.T) {
	rf := NewRollingFilter(1000)
	jti := randomJTI()
	rf.Insert(jti)

	rf.Rotate()
	rf.Rotate() // jti is now gone (was in previous, which was discarded)

	if rf.Lookup(jti) {
		t.Fatal("expected NOT found after two rotations")
	}
}

func TestRollingCount(t *testing.T) {
	rf := NewRollingFilter(1000)
	for i := 0; i < 10; i++ {
		rf.Insert(randomJTI())
	}
	if rf.Count() != 10 {
		t.Fatalf("expected 10, got %d", rf.Count())
	}

	rf.Rotate()
	for i := 0; i < 5; i++ {
		rf.Insert(randomJTI())
	}
	if rf.Count() != 15 {
		t.Fatalf("expected 15, got %d", rf.Count())
	}

	rf.Rotate()
	// Previous had 10 items, now current has 5 items → previous is 5, current is 0
	// Wait, after second rotate: previous = filter with 5 items, current = new empty
	if rf.Count() != 5 {
		t.Fatalf("expected 5 after second rotation, got %d", rf.Count())
	}
}

func TestRollingConcurrent(t *testing.T) {
	rf := NewRollingFilter(10000)
	var wg sync.WaitGroup

	for i := 0; i < 50; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			rf.Insert(randomJTI())
		}()
		go func() {
			defer wg.Done()
			rf.Lookup(randomJTI())
		}()
		go func() {
			defer wg.Done()
			rf.Rotate()
		}()
	}
	wg.Wait()
}

func TestRollingAutoRotation(t *testing.T) {
	rf := NewRollingFilter(1000)
	jti := randomJTI()
	rf.Insert(jti)

	stop := rf.StartAutoRotation(50 * time.Millisecond)
	defer stop()

	// After ~120ms, at least 2 rotations should have happened → jti gone
	time.Sleep(120 * time.Millisecond)

	if rf.Lookup(jti) {
		t.Fatal("expected NOT found after auto-rotation expired the entry")
	}
}

func TestRollingNewInsertAfterRotation(t *testing.T) {
	rf := NewRollingFilter(1000)
	rf.Rotate()
	jti := randomJTI()
	rf.Insert(jti)
	if !rf.Lookup(jti) {
		t.Fatal("expected found in current after rotation")
	}
}
