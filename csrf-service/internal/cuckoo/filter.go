// Package cuckoo provides a Cuckoo filter wrapper for single-use CSRF token enforcement.
// Cuckoo filters support Insert, Lookup, and Delete — unlike Bloom filters which
// cannot delete entries. This allows expired JTIs to be removed, keeping memory bounded.
package cuckoo

import (
	"sync"

	cuckoo "github.com/seiflotfy/cuckoofilter"
)

// Filter wraps a Cuckoo filter with thread-safe operations.
type Filter struct {
	cf *cuckoo.Filter
	mu sync.RWMutex
}

// NewFilter creates a Cuckoo filter with the given capacity.
// The capacity determines the maximum number of items before the filter is full.
// False positive rate is approximately 0.01% (controlled by fingerprint size).
func NewFilter(capacity uint) *Filter {
	return &Filter{
		cf: cuckoo.NewFilter(capacity),
	}
}

// Insert adds a JTI to the consumed set.
// Returns true if inserted, false if the filter is full.
func (f *Filter) Insert(jti []byte) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cf.Insert(jti)
}

// Lookup checks if a JTI has been consumed.
// Returns true if the JTI was previously inserted (consumed).
func (f *Filter) Lookup(jti []byte) bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.cf.Lookup(jti)
}

// Delete removes a JTI from the consumed set.
// Returns true if the JTI was found and removed.
func (f *Filter) Delete(jti []byte) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cf.Delete(jti)
}

// Count returns the number of items in the filter.
func (f *Filter) Count() uint {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.cf.Count()
}

// Reset clears all entries from the filter.
func (f *Filter) Reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cf.Reset()
}
