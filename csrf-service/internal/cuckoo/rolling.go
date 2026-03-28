package cuckoo

import (
	"log/slog"
	"sync"
	"time"
)

// RollingFilter manages two Cuckoo filters with automatic rotation.
// The "current" filter receives new inserts. The "previous" filter is checked
// on lookups (for tokens consumed just before rotation). On rotation, previous
// is discarded, current becomes previous, and a new empty current is created.
type RollingFilter struct {
	current  *Filter
	previous *Filter
	capacity uint
	mu       sync.RWMutex
}

// NewRollingFilter creates a rolling Cuckoo filter pair with the given capacity per filter.
func NewRollingFilter(capacity uint) *RollingFilter {
	return &RollingFilter{
		current:  NewFilter(capacity),
		previous: NewFilter(capacity),
		capacity: capacity,
	}
}

// Insert marks a JTI as consumed in the current filter.
func (rf *RollingFilter) Insert(jti []byte) bool {
	rf.mu.RLock()
	defer rf.mu.RUnlock()
	return rf.current.Insert(jti)
}

// Lookup checks if a JTI was consumed in either current or previous filter.
func (rf *RollingFilter) Lookup(jti []byte) bool {
	rf.mu.RLock()
	defer rf.mu.RUnlock()
	return rf.current.Lookup(jti) || rf.previous.Lookup(jti)
}

// Rotate discards previous, moves current to previous, creates new current.
func (rf *RollingFilter) Rotate() {
	rf.mu.Lock()
	defer rf.mu.Unlock()
	rf.previous = rf.current
	rf.current = NewFilter(rf.capacity)
	slog.Info("Cuckoo filter rotated", "previousCount", rf.previous.Count())
}

// Count returns total items across both filters.
func (rf *RollingFilter) Count() uint {
	rf.mu.RLock()
	defer rf.mu.RUnlock()
	return rf.current.Count() + rf.previous.Count()
}

// StartAutoRotation begins periodic filter rotation.
// Returns a stop function. Rotation interval should match token TTL.
func (rf *RollingFilter) StartAutoRotation(interval time.Duration) func() {
	ticker := time.NewTicker(interval)
	done := make(chan struct{})

	go func() {
		for {
			select {
			case <-ticker.C:
				rf.Rotate()
			case <-done:
				ticker.Stop()
				return
			}
		}
	}()

	return func() { close(done) }
}
