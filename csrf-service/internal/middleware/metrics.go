// Package middleware provides Prometheus metrics for the CSRF service.
package middleware

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Metrics holds all Prometheus collectors for the CSRF service.
type Metrics struct {
	RequestsTotal     *prometheus.CounterVec
	RedisErrorsTotal  prometheus.Counter
	RequestDuration   *prometheus.HistogramVec
	AnomalyTotal      *prometheus.CounterVec
	OriginChecksTotal *prometheus.CounterVec
	RateLimitTotal    *prometheus.CounterVec
}

// NewMetrics creates and registers Prometheus metrics with the default registry.
func NewMetrics() *Metrics {
	return NewMetricsWithRegisterer(prometheus.DefaultRegisterer)
}

// NewMetricsWithRegisterer creates metrics registered with a custom registerer.
// Use prometheus.NewRegistry() in tests to avoid duplicate registration panics.
func NewMetricsWithRegisterer(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		RequestsTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "csrf_requests_total",
			Help: "Total CSRF service requests by method and result",
		}, []string{"method", "result"}),

		RedisErrorsTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "csrf_redis_errors_total",
			Help: "Total Redis errors (connection, timeout, etc.)",
		}),

		RequestDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "csrf_request_duration_seconds",
			Help:    "Request duration in seconds",
			Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0},
		}, []string{"handler"}),

		AnomalyTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "csrf_anomaly_total",
			Help: "Anomalous CSRF events by type",
		}, []string{"type"}),

		OriginChecksTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "csrf_origin_checks_total",
			Help: "Origin header validation results",
		}, []string{"result"}),

		RateLimitTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "csrf_rate_limit_total",
			Help: "Rate limit check results for token generation",
		}, []string{"result"}),
	}
	reg.MustRegister(m.RequestsTotal, m.RedisErrorsTotal, m.RequestDuration,
		m.AnomalyTotal, m.OriginChecksTotal, m.RateLimitTotal)
	return m
}

// ObserveDuration records the duration for a handler.
func (m *Metrics) ObserveDuration(handler string, start time.Time) {
	m.RequestDuration.WithLabelValues(handler).Observe(time.Since(start).Seconds())
}
