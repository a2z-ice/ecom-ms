package introspect

import "context"

// NoopIntrospector always returns active. Used when introspection is disabled.
type NoopIntrospector struct{}

func (n *NoopIntrospector) IsActive(_ context.Context, _ string) (bool, error) {
	return true, nil
}
