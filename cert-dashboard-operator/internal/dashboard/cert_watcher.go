package dashboard

import (
	"context"
	"crypto/ecdsa"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"log"
	"math"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// CertInfo holds certificate information for the dashboard.
type CertInfo struct {
	Name         string   `json:"name"`
	Namespace    string   `json:"namespace"`
	Issuer       string   `json:"issuer"`
	IssuerKind   string   `json:"issuerKind"`
	DNSNames     []string `json:"dnsNames"`
	IPAddresses  []string `json:"ipAddresses"`
	Algorithm    string   `json:"algorithm"`
	SerialNumber string   `json:"serialNumber"`
	NotBefore    string   `json:"notBefore"`
	NotAfter     string   `json:"notAfter"`
	RenewalTime  string   `json:"renewalTime"`
	Duration     string   `json:"duration"`
	RenewBefore  string   `json:"renewBefore"`
	Revision     int64    `json:"revision"`
	Ready        bool     `json:"ready"`
	DaysTotal    int      `json:"daysTotal"`
	DaysElapsed  int      `json:"daysElapsed"`
	DaysRemain   int      `json:"daysRemaining"`
	Status       string   `json:"status"` // "green", "yellow", "red"
	SecretName   string   `json:"secretName"`
	IsCA         bool     `json:"isCA"`
}

var certGVR = schema.GroupVersionResource{
	Group:    "cert-manager.io",
	Version:  "v1",
	Resource: "certificates",
}

// CertWatcher watches cert-manager Certificate resources.
type CertWatcher struct {
	dynClient  dynamic.Interface
	coreClient kubernetes.Interface
	namespaces []string
	mu         sync.RWMutex
	certs      []CertInfo
}

// NewCertWatcher creates a new watcher for cert-manager certificates.
func NewCertWatcher(namespaces []string) (*CertWatcher, error) {
	config, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("getting in-cluster config: %w", err)
	}

	dynClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("creating dynamic client: %w", err)
	}

	coreClient, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("creating core client: %w", err)
	}

	return &CertWatcher{
		dynClient:  dynClient,
		coreClient: coreClient,
		namespaces: namespaces,
	}, nil
}

// Start begins polling certificates. Call in a goroutine.
func (w *CertWatcher) Start(ctx context.Context) {
	w.refresh(ctx)
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.refresh(ctx)
		}
	}
}

// GetCerts returns the current list of certificates.
func (w *CertWatcher) GetCerts() []CertInfo {
	w.mu.RLock()
	defer w.mu.RUnlock()
	result := make([]CertInfo, len(w.certs))
	copy(result, w.certs)
	return result
}

func (w *CertWatcher) refresh(ctx context.Context) {
	var allCerts []CertInfo
	namespaces := w.namespaces
	if len(namespaces) == 0 {
		namespaces = []string{""}
	}

	for _, ns := range namespaces {
		var list *unstructured.UnstructuredList
		var err error
		if ns == "" {
			list, err = w.dynClient.Resource(certGVR).List(ctx, metav1.ListOptions{})
		} else {
			list, err = w.dynClient.Resource(certGVR).Namespace(ns).List(ctx, metav1.ListOptions{})
		}
		if err != nil {
			log.Printf("Error listing certificates in namespace %q: %v", ns, err)
			continue
		}

		for _, item := range list.Items {
			info := w.parseCertificate(ctx, &item)
			allCerts = append(allCerts, info)
		}
	}

	w.mu.Lock()
	w.certs = allCerts
	w.mu.Unlock()
}

func (w *CertWatcher) parseCertificate(ctx context.Context, obj *unstructured.Unstructured) CertInfo {
	spec := obj.Object["spec"].(map[string]interface{})
	status, _ := obj.Object["status"].(map[string]interface{})

	info := CertInfo{
		Name:      obj.GetName(),
		Namespace: obj.GetNamespace(),
	}

	// Issuer
	if issuerRef, ok := spec["issuerRef"].(map[string]interface{}); ok {
		info.Issuer, _ = issuerRef["name"].(string)
		info.IssuerKind, _ = issuerRef["kind"].(string)
	}

	// DNS names
	if dns, ok := spec["dnsNames"].([]interface{}); ok {
		for _, d := range dns {
			if s, ok := d.(string); ok {
				info.DNSNames = append(info.DNSNames, s)
			}
		}
	}

	// IP addresses
	if ips, ok := spec["ipAddresses"].([]interface{}); ok {
		for _, ip := range ips {
			if s, ok := ip.(string); ok {
				info.IPAddresses = append(info.IPAddresses, s)
			}
		}
	}

	// Secret name
	info.SecretName, _ = spec["secretName"].(string)

	// Duration and renewBefore
	info.Duration, _ = spec["duration"].(string)
	info.RenewBefore, _ = spec["renewBefore"].(string)

	// IsCA
	info.IsCA, _ = spec["isCA"].(bool)

	// Algorithm
	if pk, ok := spec["privateKey"].(map[string]interface{}); ok {
		algo, _ := pk["algorithm"].(string)
		size, _ := pk["size"].(float64)
		if algo != "" {
			info.Algorithm = fmt.Sprintf("%s P-%d", algo, int(size))
		}
	}

	// Status fields
	if status != nil {
		// Ready
		if conditions, ok := status["conditions"].([]interface{}); ok {
			for _, c := range conditions {
				if cond, ok := c.(map[string]interface{}); ok {
					if cond["type"] == "Ready" && cond["status"] == "True" {
						info.Ready = true
					}
				}
			}
		}
		// Revision — Kubernetes unstructured may store as int64 or float64
		switch rev := status["revision"].(type) {
		case int64:
			info.Revision = rev
		case float64:
			info.Revision = int64(rev)
		}
		// Renewal time
		info.RenewalTime, _ = status["renewalTime"].(string)
		// notBefore / notAfter
		info.NotBefore, _ = status["notBefore"].(string)
		info.NotAfter, _ = status["notAfter"].(string)
	}

	// Try to get actual cert details from the secret
	if info.SecretName != "" {
		w.enrichFromSecret(ctx, &info)
	}

	// Calculate days remaining
	if info.NotAfter != "" {
		if expiry, err := time.Parse(time.RFC3339, info.NotAfter); err == nil {
			info.DaysRemain = int(math.Ceil(time.Until(expiry).Hours() / 24))
			if info.DaysRemain < 0 {
				info.DaysRemain = 0
			}
		}
	}
	if info.NotBefore != "" && info.NotAfter != "" {
		start, err1 := time.Parse(time.RFC3339, info.NotBefore)
		end, err2 := time.Parse(time.RFC3339, info.NotAfter)
		if err1 == nil && err2 == nil {
			info.DaysTotal = int(math.Ceil(end.Sub(start).Hours() / 24))
			info.DaysElapsed = info.DaysTotal - info.DaysRemain
		}
	}

	// Status color
	switch {
	case info.DaysRemain <= 5:
		info.Status = "red"
	case info.DaysRemain <= 10:
		info.Status = "yellow"
	default:
		info.Status = "green"
	}

	return info
}

func (w *CertWatcher) enrichFromSecret(ctx context.Context, info *CertInfo) {
	secret, err := w.coreClient.CoreV1().Secrets(info.Namespace).Get(ctx, info.SecretName, metav1.GetOptions{})
	if err != nil {
		return
	}

	certPEM, ok := secret.Data["tls.crt"]
	if !ok {
		return
	}

	block, _ := pem.Decode(certPEM)
	if block == nil {
		return
	}

	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return
	}

	info.SerialNumber = fmt.Sprintf("%X", cert.SerialNumber)
	info.NotBefore = cert.NotBefore.UTC().Format(time.RFC3339)
	info.NotAfter = cert.NotAfter.UTC().Format(time.RFC3339)

	switch key := cert.PublicKey.(type) {
	case *ecdsa.PublicKey:
		info.Algorithm = fmt.Sprintf("ECDSA P-%d", key.Params().BitSize)
	case *rsa.PublicKey:
		info.Algorithm = fmt.Sprintf("RSA %d", key.N.BitLen())
	default:
		info.Algorithm = cert.PublicKeyAlgorithm.String()
	}
}

// DeleteSecret deletes a certificate's TLS secret to trigger renewal.
func (w *CertWatcher) DeleteSecret(ctx context.Context, namespace, secretName string) error {
	return w.coreClient.CoreV1().Secrets(namespace).Delete(ctx, secretName, metav1.DeleteOptions{})
}

// WaitForReady polls a Certificate until it becomes Ready or timeout.
func (w *CertWatcher) WaitForReady(ctx context.Context, name, namespace string, timeout time.Duration) error {
	deadline := time.After(timeout)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline:
			return fmt.Errorf("timeout waiting for certificate %s/%s to become Ready", namespace, name)
		case <-ticker.C:
			obj, err := w.dynClient.Resource(certGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
			if err != nil {
				continue
			}
			status, _ := obj.Object["status"].(map[string]interface{})
			if status == nil {
				continue
			}
			conditions, _ := status["conditions"].([]interface{})
			for _, c := range conditions {
				cond, _ := c.(map[string]interface{})
				if cond["type"] == "Ready" && cond["status"] == "True" {
					return nil
				}
			}
		}
	}
}

// GetRevision gets the current revision of a Certificate.
func (w *CertWatcher) GetRevision(ctx context.Context, name, namespace string) (int64, error) {
	obj, err := w.dynClient.Resource(certGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return 0, err
	}
	status, _ := obj.Object["status"].(map[string]interface{})
	if status == nil {
		return 0, nil
	}
	switch rev := status["revision"].(type) {
	case int64:
		return rev, nil
	case float64:
		return int64(rev), nil
	}
	return 0, nil
}
