package dashboard

import (
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// CertificatesTotal tracks the total number of certificates being monitored.
	CertificatesTotal = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: "cert_dashboard",
		Name:      "certificates_total",
		Help:      "Total number of certificates being monitored",
	})

	// CertificateDaysRemaining tracks days remaining per certificate.
	CertificateDaysRemaining = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "cert_dashboard",
		Name:      "certificate_days_remaining",
		Help:      "Days remaining until certificate expiry",
	}, []string{"name", "namespace"})

	// CertificateReady tracks certificate readiness.
	CertificateReady = prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: "cert_dashboard",
		Name:      "certificate_ready",
		Help:      "Whether the certificate is ready (1) or not (0)",
	}, []string{"name", "namespace"})

	// RenewalsTotal tracks the total number of renewal operations triggered.
	RenewalsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: "cert_dashboard",
		Name:      "renewals_total",
		Help:      "Total number of certificate renewals triggered",
	})

	// RenewalErrors tracks the total number of failed renewal operations.
	RenewalErrors = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: "cert_dashboard",
		Name:      "renewal_errors_total",
		Help:      "Total number of failed certificate renewals",
	})
)

func init() {
	prometheus.MustRegister(
		CertificatesTotal,
		CertificateDaysRemaining,
		CertificateReady,
		RenewalsTotal,
		RenewalErrors,
	)
}

// MetricsHandler returns an HTTP handler for Prometheus metrics.
func MetricsHandler() http.Handler {
	return promhttp.Handler()
}

// UpdateCertMetrics updates Prometheus metrics from a list of certificates.
func UpdateCertMetrics(certs []CertInfo) {
	CertificatesTotal.Set(float64(len(certs)))
	for _, c := range certs {
		CertificateDaysRemaining.WithLabelValues(c.Name, c.Namespace).Set(float64(c.DaysRemain))
		readyVal := 0.0
		if c.Ready {
			readyVal = 1.0
		}
		CertificateReady.WithLabelValues(c.Name, c.Namespace).Set(readyVal)
	}
}
