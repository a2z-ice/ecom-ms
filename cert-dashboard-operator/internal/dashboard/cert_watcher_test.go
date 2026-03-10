package dashboard

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestParseCertificate_NilSpec(t *testing.T) {
	w := &CertWatcher{}
	obj := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"metadata": map[string]interface{}{
				"name":      "test-cert",
				"namespace": "default",
			},
			// No "spec" field
		},
	}

	info := w.parseCertificate(context.Background(), obj)
	if info.Name != "test-cert" {
		t.Errorf("expected name test-cert, got %s", info.Name)
	}
	if info.Status != "red" {
		t.Errorf("expected red status for missing spec, got %s", info.Status)
	}
}

func TestParseCertificate_InvalidSpecType(t *testing.T) {
	w := &CertWatcher{}
	obj := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"metadata": map[string]interface{}{
				"name":      "test-cert",
				"namespace": "default",
			},
			"spec": "invalid-string-type",
		},
	}

	info := w.parseCertificate(context.Background(), obj)
	if info.Name != "test-cert" {
		t.Errorf("expected name test-cert, got %s", info.Name)
	}
	if info.Status != "red" {
		t.Errorf("expected red status for invalid spec type, got %s", info.Status)
	}
}

func TestParseCertificate_FullSpec(t *testing.T) {
	w := &CertWatcher{}
	obj := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"metadata": map[string]interface{}{
				"name":      "gateway-cert",
				"namespace": "infra",
			},
			"spec": map[string]interface{}{
				"issuerRef": map[string]interface{}{
					"name": "bookstore-ca-issuer",
					"kind": "ClusterIssuer",
				},
				"dnsNames":    []interface{}{"myecom.net", "api.service.net"},
				"ipAddresses": []interface{}{"127.0.0.1"},
				"secretName":  "bookstore-gateway-tls",
				"duration":    "720h",
				"renewBefore": "168h",
				"isCA":        false,
				"privateKey": map[string]interface{}{
					"algorithm": "ECDSA",
					"size":      float64(256),
				},
			},
			"status": map[string]interface{}{
				"conditions": []interface{}{
					map[string]interface{}{
						"type":   "Ready",
						"status": "True",
					},
				},
				"revision":    float64(3),
				"renewalTime": "2026-04-01T00:00:00Z",
				"notBefore":   "2026-03-01T00:00:00Z",
				"notAfter":    "2026-03-31T00:00:00Z",
			},
		},
	}

	info := w.parseCertificate(context.Background(), obj)

	if info.Name != "gateway-cert" {
		t.Errorf("expected name gateway-cert, got %s", info.Name)
	}
	if info.Namespace != "infra" {
		t.Errorf("expected namespace infra, got %s", info.Namespace)
	}
	if info.Issuer != "bookstore-ca-issuer" {
		t.Errorf("expected issuer bookstore-ca-issuer, got %s", info.Issuer)
	}
	if info.IssuerKind != "ClusterIssuer" {
		t.Errorf("expected issuerKind ClusterIssuer, got %s", info.IssuerKind)
	}
	if len(info.DNSNames) != 2 {
		t.Errorf("expected 2 DNS names, got %d", len(info.DNSNames))
	}
	if len(info.IPAddresses) != 1 || info.IPAddresses[0] != "127.0.0.1" {
		t.Errorf("unexpected IP addresses: %v", info.IPAddresses)
	}
	if info.SecretName != "bookstore-gateway-tls" {
		t.Errorf("expected secretName bookstore-gateway-tls, got %s", info.SecretName)
	}
	if info.Duration != "720h" {
		t.Errorf("expected duration 720h, got %s", info.Duration)
	}
	if info.RenewBefore != "168h" {
		t.Errorf("expected renewBefore 168h, got %s", info.RenewBefore)
	}
	if !info.Ready {
		t.Error("expected Ready=true")
	}
	if info.Revision != 3 {
		t.Errorf("expected revision 3, got %d", info.Revision)
	}
	if info.Algorithm != "ECDSA P-256" {
		t.Errorf("expected algorithm ECDSA P-256, got %s", info.Algorithm)
	}
}

func TestParseCertificate_MinimalSpec(t *testing.T) {
	w := &CertWatcher{}
	obj := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"metadata": map[string]interface{}{
				"name":      "minimal",
				"namespace": "default",
			},
			"spec": map[string]interface{}{
				"secretName": "minimal-tls",
			},
		},
	}

	info := w.parseCertificate(context.Background(), obj)

	if info.Name != "minimal" {
		t.Errorf("expected name minimal, got %s", info.Name)
	}
	if info.SecretName != "minimal-tls" {
		t.Errorf("expected secretName minimal-tls, got %s", info.SecretName)
	}
	if info.Ready {
		t.Error("expected Ready=false for missing status")
	}
	if info.Issuer != "" {
		t.Errorf("expected empty issuer, got %s", info.Issuer)
	}
	// Status should default to green (0 days remaining → red actually)
	// Since DaysRemain is 0 (no notAfter), status is "red" from the hardcoded threshold
	if info.Status != "red" {
		t.Errorf("expected red for 0 days remaining, got %s", info.Status)
	}
}

func TestParseCertificate_RevisionAsInt64(t *testing.T) {
	w := &CertWatcher{}
	obj := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"metadata": map[string]interface{}{
				"name":      "test",
				"namespace": "default",
			},
			"spec": map[string]interface{}{},
			"status": map[string]interface{}{
				"revision": int64(5),
			},
		},
	}

	info := w.parseCertificate(context.Background(), obj)
	if info.Revision != 5 {
		t.Errorf("expected revision 5, got %d", info.Revision)
	}
}

func TestParseCertificate_NotReadyStatus(t *testing.T) {
	w := &CertWatcher{}
	obj := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"metadata": map[string]interface{}{
				"name":      "test",
				"namespace": "default",
			},
			"spec": map[string]interface{}{},
			"status": map[string]interface{}{
				"conditions": []interface{}{
					map[string]interface{}{
						"type":   "Ready",
						"status": "False",
					},
				},
			},
		},
	}

	info := w.parseCertificate(context.Background(), obj)
	if info.Ready {
		t.Error("expected Ready=false")
	}
}

func TestParseCertificate_IsCA(t *testing.T) {
	w := &CertWatcher{}
	obj := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"metadata": map[string]interface{}{
				"name":      "ca-cert",
				"namespace": "cert-manager",
			},
			"spec": map[string]interface{}{
				"isCA": true,
			},
		},
	}

	info := w.parseCertificate(context.Background(), obj)
	if !info.IsCA {
		t.Error("expected IsCA=true")
	}
}
