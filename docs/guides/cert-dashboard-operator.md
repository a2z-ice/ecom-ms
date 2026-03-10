# Cert Dashboard Operator — Development & Deployment Guide

A comprehensive guide to building, deploying, and testing the cert-dashboard-operator: a Go-based Kubernetes operator that deploys a web dashboard for monitoring and renewing cert-manager certificates.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [Project Scaffolding](#4-project-scaffolding)
5. [Implementing the CRD](#5-implementing-the-crd)
6. [Implementing the Controller](#6-implementing-the-controller)
7. [Building the Dashboard Server](#7-building-the-dashboard-server)
8. [Certificate Watcher](#8-certificate-watcher)
9. [HTTP Handlers & SSE](#9-http-handlers--sse)
10. [Frontend (HTML/CSS/JS)](#10-frontend-htmlcssjs)
11. [Docker Image](#11-docker-image)
12. [Deploying to kind](#12-deploying-to-kind)
13. [Deploying to kubeadm (Bare-Metal / VM)](#13-deploying-to-kubeadm-bare-metal--vm)
14. [Deploying to EKS](#14-deploying-to-eks)
15. [Deploying to AKS](#15-deploying-to-aks)
16. [Deploying to GKE](#16-deploying-to-gke)
17. [OLM (Operator Lifecycle Manager)](#17-olm-operator-lifecycle-manager)
18. [Manual Testing Guide](#18-manual-testing-guide)
19. [Automated Tests](#19-automated-tests)
20. [Security](#20-security)
21. [Metrics](#21-metrics)
22. [Troubleshooting](#22-troubleshooting)
23. [Key Lessons & Gotchas](#23-key-lessons--gotchas)

---

## 1. Overview

The cert-dashboard-operator watches for `CertDashboard` custom resources and deploys a web dashboard that:

- Displays all cert-manager `Certificate` resources with full metadata
- Shows certificate lifetime as a progress bar (green > 10d, yellow <= 10d, red <= 5d)
- Provides a "Renew Certificate" button with a confirmation modal
- Streams the renewal process live via Server-Sent Events (SSE)
- Auto-refreshes certificate data every 30 seconds

**Key Design Decisions:**
- Single Docker image with two binaries (`/manager` for operator, `/dashboard` for web server)
- Certificate renewal via secret deletion (proven cert-manager pattern)
- SSE over WebSocket (simpler, unidirectional, sufficient for status streaming)
- OLM-compatible for production-grade operator lifecycle management
- Go `embed` package for baking HTML/CSS/JS into the dashboard binary
- Kubernetes TokenReview for POST endpoint authentication
- CertProvider interface for dependency injection and testability
- Prometheus custom metrics for operational observability
- Validation webhook for CRD field validation
- Rate limiting to prevent renewal abuse

---

## 2. Architecture

```
                    ┌──────────────────────────────────────────┐
                    │         cert-dashboard namespace          │
                    │                                           │
  kubectl apply     │  ┌──────────────────────┐                │
  CertDashboard CR ─┼─>│  Operator (manager)  │                │
                    │  │  controller-runtime   │                │
                    │  │  + Validation Webhook │                │
                    │  └──────────┬───────────┘                │
                    │             │ reconcile                   │
                    │             ▼                             │
                    │  ┌──────────────────────┐                │
                    │  │ Creates:              │                │
                    │  │  - ServiceAccount     │                │
                    │  │  - ClusterRole/Binding│                │
                    │  │  - Deployment         │                │
                    │  │  - Service (NodePort) │                │
                    │  └──────────┬───────────┘                │
                    │             │                             │
                    │             ▼                             │
                    │  ┌──────────────────────┐                │
  Browser ──────────┼─>│  Dashboard (port 8080)│                │
  http://host:32600 │  │  /api/certs           │                │
                    │  │  /api/renew ──[Auth]──│──┬────────────┼──> K8s TokenReview API
                    │  │  /api/sse/{id}        │  │            │
                    │  │  /healthz             │  ├────────────┼──> cert-manager Certificates
                    │  │  /metrics             │  └────────────┼──> K8s Secrets (TLS)
                    │  └──────────────────────┘                │
                    │                          ▲                │
                    │              Prometheus ──┘ (scrape)      │
                    └──────────────────────────────────────────┘
```

**Renewal Flow:**
```
User clicks "Renew" → Modal confirmation → POST /api/renew
  → Delete TLS secret → cert-manager detects missing secret
  → cert-manager requests new certificate → Issuer signs it
  → cert-manager stores new cert in secret → Certificate Ready
  → SSE streams each phase to browser in real-time
```

---

## 3. Prerequisites

### Tools Required

| Tool | Version | Purpose | Required For |
|------|---------|---------|--------------|
| Go | >= 1.24 | Build operator and dashboard | Build only |
| Docker | >= 24.x | Container image build | Build only |
| kubectl | >= 1.28 | Kubernetes CLI | All environments |
| operator-sdk | v1.42.0 | Scaffold operator, generate CRD, OLM bundle | Build + OLM deploy |
| kind | >= 0.20 | Local Kubernetes cluster | Development only |
| kubeadm | >= 1.28 | Bare-metal / VM cluster bootstrap | kubeadm clusters only |
| Helm | >= 3.14 | Package manager (optional, for cert-manager install) | Optional |

### Kubernetes Cluster Prerequisites

Before deploying the operator, the target cluster **must** have:

1. **cert-manager** (>= v1.14) — the operator reads `Certificate` CRs and triggers renewals
2. **At least one Certificate resource** — the dashboard displays cert-manager Certificates; without any, the dashboard shows an empty state
3. **RBAC enabled** — the operator creates ClusterRole/ClusterRoleBinding for the dashboard pod
4. **Network access** — the dashboard pod needs access to the Kubernetes API server (in-cluster config)

Optional but recommended:
- **Istio / service mesh** — if running Istio Ambient, a `PeerAuthentication` is needed for NodePort access
- **OLM** (Operator Lifecycle Manager) — for production-grade operator lifecycle (install, upgrade, uninstall)
- **Container registry** — for non-kind deployments (ECR, ACR, GAR, Docker Hub, or private registry)

### Install operator-sdk

```bash
# macOS (Apple Silicon)
brew install operator-sdk

# macOS (Intel) / Linux
export ARCH=$(case $(uname -m) in x86_64) echo -n amd64 ;; aarch64) echo -n arm64 ;; esac)
export OS=$(uname | awk '{print tolower($0)}')
curl -LO "https://github.com/operator-framework/operator-sdk/releases/download/v1.42.0/operator-sdk_${OS}_${ARCH}"
chmod +x operator-sdk_${OS}_${ARCH}
sudo mv operator-sdk_${OS}_${ARCH} /usr/local/bin/operator-sdk
```

### Install cert-manager (all environments)

```bash
# Option 1: kubectl apply (simplest)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.2/cert-manager.yaml
kubectl wait --for=condition=available deploy/cert-manager -n cert-manager --timeout=120s
kubectl wait --for=condition=available deploy/cert-manager-webhook -n cert-manager --timeout=120s
kubectl wait --for=condition=available deploy/cert-manager-cainjector -n cert-manager --timeout=120s

# Option 2: Helm (recommended for production)
helm repo add jetstack https://charts.jetstack.io --force-update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --version v1.17.2 \
  --set crds.enabled=true

# Verify installation
kubectl get pods -n cert-manager
# All 3 pods (cert-manager, webhook, cainjector) must be Running
```

### Create a CA Issuer Chain (required for the dashboard to have certificates to display)

The dashboard monitors cert-manager `Certificate` resources. You need at least one issuer and certificate:

```bash
# 1. Bootstrap self-signed ClusterIssuer
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned-bootstrap
spec:
  selfSigned: {}
EOF

# 2. Create a CA certificate (long-lived, 10 years)
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: bookstore-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: "BookStore CA"
  secretName: bookstore-ca-secret
  duration: 87600h    # 10 years
  renewBefore: 8760h  # 1 year
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: selfsigned-bootstrap
    kind: ClusterIssuer
    group: cert-manager.io
EOF

# 3. Create a CA ClusterIssuer that signs leaf certificates
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: bookstore-ca-issuer
spec:
  ca:
    secretName: bookstore-ca-secret
EOF

# 4. Create a leaf certificate (example: gateway cert, 30-day rotation)
kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: bookstore-gateway-cert
  namespace: infra
spec:
  secretName: bookstore-gateway-tls
  duration: 720h      # 30 days
  renewBefore: 168h   # 7 days before expiry
  privateKey:
    algorithm: ECDSA
    size: 256
  dnsNames:
    - myecom.net
    - api.service.net
    - idp.keycloak.net
    - localhost
  ipAddresses:
    - "127.0.0.1"
  issuerRef:
    name: bookstore-ca-issuer
    kind: ClusterIssuer
    group: cert-manager.io
EOF

# 5. Verify certificates are Ready
kubectl get certificate -A
# NAME                       READY   SECRET                   AGE
# bookstore-ca               True    bookstore-ca-secret      30s
# bookstore-gateway-cert     True    bookstore-gateway-tls    10s
```

---

## 4. Project Scaffolding

### Step 1: Initialize the operator project

```bash
mkdir cert-dashboard-operator && cd cert-dashboard-operator

operator-sdk init \
  --domain bookstore.io \
  --repo github.com/bookstore/cert-dashboard-operator \
  --skip-go-version-check
```

This creates the standard operator-sdk project structure:
```
cert-dashboard-operator/
├── cmd/main.go                    # Operator entrypoint
├── config/                        # Kustomize manifests
│   ├── crd/                       # CRD definitions
│   ├── manager/                   # Operator deployment
│   ├── rbac/                      # RBAC rules
│   └── samples/                   # Sample CRs
├── hack/                          # Build utilities
├── go.mod
├── go.sum
├── Dockerfile
├── Makefile
└── PROJECT                        # operator-sdk metadata
```

### Step 2: Create the API (CRD + Controller)

```bash
operator-sdk create api \
  --group certs \
  --version v1alpha1 \
  --kind CertDashboard \
  --resource --controller
```

This generates:
- `api/v1alpha1/certdashboard_types.go` — CRD type definitions
- `internal/controller/certdashboard_controller.go` — Reconciler skeleton

### Step 3: Create the dashboard package

```bash
mkdir -p internal/dashboard/templates
mkdir -p cmd/dashboard
```

### Step 4: Add dependencies

```bash
go get github.com/google/uuid
```

---

## 5. Implementing the CRD

Edit `api/v1alpha1/certdashboard_types.go`:

```go
package v1alpha1

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// CertDashboardSpec defines the desired state of CertDashboard.
type CertDashboardSpec struct {
    // Namespaces to monitor for Certificate resources. Empty means all.
    // +optional
    Namespaces []string `json:"namespaces,omitempty"`

    // NodePort to expose the dashboard (default: 32600).
    // +kubebuilder:default=32600
    // +kubebuilder:validation:Minimum=30000
    // +kubebuilder:validation:Maximum=32767
    // +optional
    NodePort int32 `json:"nodePort,omitempty"`

    // YellowThresholdDays — progress bar turns yellow at this many days.
    // +kubebuilder:default=10
    // +optional
    YellowThresholdDays int `json:"yellowThresholdDays,omitempty"`

    // RedThresholdDays — progress bar turns red at this many days.
    // +kubebuilder:default=5
    // +optional
    RedThresholdDays int `json:"redThresholdDays,omitempty"`

    // Replicas for the dashboard deployment.
    // +kubebuilder:default=1
    // +optional
    Replicas int32 `json:"replicas,omitempty"`

    // Image is the container image for the dashboard.
    // +kubebuilder:default="bookstore/cert-dashboard:latest"
    // +optional
    Image string `json:"image,omitempty"`
}

// CertDashboardStatus defines the observed state of CertDashboard.
type CertDashboardStatus struct {
    Ready      bool               `json:"ready,omitempty"`
    URL        string             `json:"url,omitempty"`
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Ready",type="boolean",JSONPath=".status.ready"
// +kubebuilder:printcolumn:name="URL",type="string",JSONPath=".status.url"
// +kubebuilder:printcolumn:name="Age",type="date",JSONPath=".metadata.creationTimestamp"

type CertDashboard struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec              CertDashboardSpec   `json:"spec,omitempty"`
    Status            CertDashboardStatus `json:"status,omitempty"`
}
```

After editing, regenerate the CRD manifests:

```bash
make manifests    # Generates config/crd/bases/certs.bookstore.io_certdashboards.yaml
make generate     # Generates deepcopy methods (zz_generated.deepcopy.go)
```

---

## 6. Implementing the Controller

The controller reconciles `CertDashboard` CRs by creating the dashboard's child resources.

Edit `internal/controller/certdashboard_controller.go`. The reconciler must:

### 6.1 Set Defaults

```go
func (r *CertDashboardReconciler) setDefaults(owner *certsv1alpha1.CertDashboard) {
    if owner.Spec.NodePort == 0 {
        owner.Spec.NodePort = 32600
    }
    if owner.Spec.Replicas == 0 {
        owner.Spec.Replicas = 1
    }
    if owner.Spec.YellowThresholdDays == 0 {
        owner.Spec.YellowThresholdDays = 10
    }
    if owner.Spec.RedThresholdDays == 0 {
        owner.Spec.RedThresholdDays = 5
    }
    if owner.Spec.Image == "" {
        owner.Spec.Image = "bookstore/cert-dashboard:latest"
    }
}
```

### 6.2 Reconcile Child Resources

Use `controllerutil.CreateOrUpdate` for idempotent resource management:

```go
func (r *CertDashboardReconciler) reconcileDeployment(ctx context.Context,
    owner *certsv1alpha1.CertDashboard) error {

    deploy := &appsv1.Deployment{
        ObjectMeta: metav1.ObjectMeta{
            Name:      owner.Name,
            Namespace: owner.Namespace,
        },
    }

    _, err := controllerutil.CreateOrUpdate(ctx, r.Client, deploy, func() error {
        // Set owner reference for garbage collection
        if err := ctrl.SetControllerReference(owner, deploy, r.Scheme); err != nil {
            return err
        }
        // Configure the deployment spec...
        deploy.Spec = appsv1.DeploymentSpec{
            Replicas: &owner.Spec.Replicas,
            Selector: &metav1.LabelSelector{
                MatchLabels: map[string]string{"app": "cert-dashboard"},
            },
            Template: corev1.PodTemplateSpec{
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{{
                        Name:            "dashboard",
                        Image:           owner.Spec.Image,
                        ImagePullPolicy: corev1.PullIfNotPresent,  // CRITICAL for kind
                        Command:         []string{"/dashboard"},
                        Ports: []corev1.ContainerPort{
                            {Name: "http", ContainerPort: 8080},
                        },
                        Env: []corev1.EnvVar{
                            {Name: "DASHBOARD_PORT", Value: "8080"},
                            {Name: "NAMESPACES", Value: strings.Join(owner.Spec.Namespaces, ",")},
                            {Name: "YELLOW_THRESHOLD_DAYS", Value: fmt.Sprintf("%d", owner.Spec.YellowThresholdDays)},
                            {Name: "RED_THRESHOLD_DAYS", Value: fmt.Sprintf("%d", owner.Spec.RedThresholdDays)},
                        },
                        // Security context - non-root, read-only filesystem
                        SecurityContext: &corev1.SecurityContext{
                            RunAsNonRoot:             ptr(true),
                            RunAsUser:                ptr(int64(1000)),
                            ReadOnlyRootFilesystem:   ptr(true),
                            AllowPrivilegeEscalation: ptr(false),
                        },
                    }},
                },
            },
        }
        return nil
    })
    return err
}
```

### 6.3 Create ClusterRole for Dashboard

The dashboard pod needs permissions to read certificates and delete secrets:

```go
rules := []rbacv1.PolicyRule{
    {
        APIGroups: []string{"cert-manager.io"},
        Resources: []string{"certificates", "certificaterequests", "clusterissuers", "issuers"},
        Verbs:     []string{"get", "list", "watch"},
    },
    {
        APIGroups: []string{""},
        Resources: []string{"secrets"},
        Verbs:     []string{"get", "list", "watch", "delete"},  // delete triggers renewal
    },
}
```

### 6.4 Handle Finalizers

ClusterRole and ClusterRoleBinding are cluster-scoped, so they won't be garbage-collected with the namespace-scoped CR. Use a finalizer:

```go
const finalizerName = "certs.bookstore.io/cleanup"

// In Reconcile:
if owner.DeletionTimestamp != nil {
    if controllerutil.ContainsFinalizer(owner, finalizerName) {
        // Delete cluster-scoped resources
        r.Client.Delete(ctx, &rbacv1.ClusterRole{...})
        r.Client.Delete(ctx, &rbacv1.ClusterRoleBinding{...})
        controllerutil.RemoveFinalizer(owner, finalizerName)
        r.Client.Update(ctx, owner)
    }
    return ctrl.Result{}, nil
}

// Add finalizer if not present
if !controllerutil.ContainsFinalizer(owner, finalizerName) {
    controllerutil.AddFinalizer(owner, finalizerName)
    r.Client.Update(ctx, owner)
}
```

### 6.5 Update Status

```go
func (r *CertDashboardReconciler) updateStatus(ctx context.Context,
    owner *certsv1alpha1.CertDashboard) error {

    deploy := &appsv1.Deployment{}
    err := r.Client.Get(ctx, types.NamespacedName{
        Name: owner.Name, Namespace: owner.Namespace,
    }, deploy)

    if err == nil && deploy.Status.AvailableReplicas > 0 {
        owner.Status.Ready = true
        owner.Status.URL = fmt.Sprintf("http://localhost:%d", owner.Spec.NodePort)
    } else {
        owner.Status.Ready = false
    }
    return r.Client.Status().Update(ctx, owner)
}
```

---

## 7. Building the Dashboard Server

Create `internal/dashboard/server.go`:

```go
package dashboard

import (
    "context"
    "embed"
    "fmt"
    "log"
    "net/http"
    "os"
    "strconv"
    "strings"
    "time"
)

//go:embed templates/*
var templateFS embed.FS

type Config struct {
    Port               int
    Namespaces         []string
    YellowThresholdDays int
    RedThresholdDays    int
}

func ConfigFromEnv() Config {
    cfg := Config{
        Port:                8080,
        YellowThresholdDays: 10,
        RedThresholdDays:    5,
    }
    if p, err := strconv.Atoi(os.Getenv("DASHBOARD_PORT")); err == nil {
        cfg.Port = p
    }
    if ns := os.Getenv("NAMESPACES"); ns != "" {
        cfg.Namespaces = strings.Split(ns, ",")
    }
    if y, err := strconv.Atoi(os.Getenv("YELLOW_THRESHOLD_DAYS")); err == nil {
        cfg.YellowThresholdDays = y
    }
    if r, err := strconv.Atoi(os.Getenv("RED_THRESHOLD_DAYS")); err == nil {
        cfg.RedThresholdDays = r
    }
    return cfg
}

type Server struct {
    config  Config
    watcher *CertWatcher
    mux     *http.ServeMux
}

func NewServer(cfg Config) (*Server, error) {
    watcher, err := NewCertWatcher(cfg.Namespaces)
    if err != nil {
        return nil, err
    }

    s := &Server{config: cfg, watcher: watcher, mux: http.NewServeMux()}

    // Static files (embedded)
    s.mux.HandleFunc("GET /", s.serveFile("templates/index.html", "text/html"))
    s.mux.HandleFunc("GET /style.css", s.serveFile("templates/style.css", "text/css"))
    s.mux.HandleFunc("GET /app.js", s.serveFile("templates/app.js", "application/javascript"))

    // API endpoints
    s.mux.HandleFunc("GET /api/certs", s.handleGetCerts)
    s.mux.HandleFunc("POST /api/renew", s.authMiddleware(s.handleRenew))
    s.mux.HandleFunc("GET /api/sse/{streamId}", s.handleSSE)
    s.mux.HandleFunc("GET /metrics", s.handleMetrics)
    s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        w.Write([]byte(`{"status":"ok"}`))
    })

    return s, nil
}

func (s *Server) serveFile(path, contentType string) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        data, err := templateFS.ReadFile(path)
        if err != nil {
            http.Error(w, "not found", 404)
            return
        }
        w.Header().Set("Content-Type", contentType)
        w.Write(data)
    }
}

func (s *Server) Run(ctx context.Context) error {
    go s.watcher.Start(ctx)

    srv := &http.Server{Addr: fmt.Sprintf(":%d", s.config.Port), Handler: s.mux}
    go func() {
        <-ctx.Done()
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
        defer cancel()
        srv.Shutdown(shutdownCtx)
    }()

    log.Printf("Dashboard listening on :%d", s.config.Port)
    return srv.ListenAndServe()
}
```

**Key points:**
- `//go:embed templates/*` bakes all files in `templates/` into the binary
- Routes use Go 1.22+ `http.ServeMux` pattern matching (`GET /api/sse/{streamId}`)
- `POST /api/renew` is wrapped with `authMiddleware` (Kubernetes TokenReview authentication)
- `GET /metrics` exposes Prometheus-format metrics
- Watcher starts in a goroutine for background certificate polling
- Graceful shutdown on context cancellation

---

## 8. Certificate Watcher

Create `internal/dashboard/cert_watcher.go`. This component:

1. Uses the Kubernetes **dynamic client** to list cert-manager `Certificate` resources
2. Uses the **core client** to read TLS secrets and parse X.509 certificates
3. Polls every 15 seconds
4. Provides thread-safe access via `sync.RWMutex`

### Key Implementation Details

**CertInfo struct** — 20+ fields covering everything from the Certificate resource and the actual X.509 data:

```go
type CertInfo struct {
    Name, Namespace, Issuer, IssuerKind string
    DNSNames, IPAddresses               []string
    Algorithm, SerialNumber              string
    NotBefore, NotAfter, RenewalTime     string
    Duration, RenewBefore                string
    Revision                             int64
    Ready                                bool
    DaysTotal, DaysElapsed, DaysRemain   int
    Status                               string  // "green", "yellow", "red"
    SecretName                           string
    IsCA                                 bool
}
```

**Enrichment from TLS secret** — parses the actual X.509 certificate to get serial number, algorithm, and exact dates:

```go
func (w *CertWatcher) enrichFromSecret(ctx context.Context, info *CertInfo) {
    secret, err := w.coreClient.CoreV1().Secrets(info.Namespace).Get(ctx, info.SecretName, metav1.GetOptions{})
    if err != nil { return }

    block, _ := pem.Decode(secret.Data["tls.crt"])
    if block == nil { return }

    cert, err := x509.ParseCertificate(block.Bytes)
    if err != nil { return }

    info.SerialNumber = fmt.Sprintf("%X", cert.SerialNumber)
    info.NotBefore = cert.NotBefore.UTC().Format(time.RFC3339)
    info.NotAfter = cert.NotAfter.UTC().Format(time.RFC3339)

    switch key := cert.PublicKey.(type) {
    case *ecdsa.PublicKey:
        info.Algorithm = fmt.Sprintf("ECDSA P-%d", key.Params().BitSize)
    case *rsa.PublicKey:
        info.Algorithm = fmt.Sprintf("RSA %d", key.N.BitLen())
    }
}
```

**Revision type handling** — Kubernetes unstructured objects store integers as `int64`, not `float64`:

```go
// WRONG: rev, _ := status["revision"].(float64)
// RIGHT:
switch rev := status["revision"].(type) {
case int64:
    info.Revision = rev
case float64:
    info.Revision = int64(rev)
}
```

---

## 9. HTTP Handlers & SSE

Create `internal/dashboard/handlers.go`:

### Renewal Flow

```
POST /api/renew {name, namespace}
  │
  ├─ Validate request
  ├─ Find certificate's secretName
  ├─ Create SSE channel (buffered, size 20)
  ├─ Store in global streams map
  ├─ Start performRenewal() goroutine  ← uses context.Background(), NOT r.Context()
  └─ Return {streamId}

GET /api/sse/{streamId}
  │
  ├─ Look up channel from streams map
  ├─ Set Content-Type: text/event-stream
  ├─ Send keepalive comment
  └─ Loop: read from channel, write SSE events
       event: status\n
       data: {"phase":"deleting-secret","message":"..."}\n\n
```

**CRITICAL:** The `performRenewal` goroutine must use `context.Background()`, not `r.Context()`. The POST request returns immediately with the `streamId`, which cancels `r.Context()`. Using the request context would kill the renewal goroutine before it starts.

### SSE Event Phases

| Phase | Message | Color |
|-------|---------|-------|
| `deleting-secret` | Deleting TLS secret 'X' to trigger renewal... | Yellow |
| `waiting-issuing` | Secret deleted. Waiting for cert-manager... | Blue |
| `issued` | New certificate issued by cert-manager. | Green |
| `ready` | Certificate is Ready. Revision: N -> M | Green (bold) |
| `complete` | Renewal complete | Green (bold) |
| `error` | (error message) | Red |

---

## 10. Frontend (HTML/CSS/JS)

### Templates Directory Structure

```
internal/dashboard/templates/
├── index.html    # Page structure, modal dialog
├── style.css     # Dark theme, progress bars, animations
└── app.js        # Fetch/render logic, SSE client
```

### Progress Bar Colors

```css
.progress-fill.green  { background: linear-gradient(90deg, #15803d, #22c55e); }
.progress-fill.yellow { background: linear-gradient(90deg, #a16207, #eab308); }
.progress-fill.red    { background: linear-gradient(90deg, #991b1b, #ef4444); }
```

Width calculation: `(daysRemaining / daysTotal) * 100%`

### SSE Client

```javascript
const source = new EventSource(`/api/sse/${streamId}`);

source.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    const phaseClass = data.phase ? `phase-${data.phase}` : '';
    panel.innerHTML += `<div class="sse-message ${phaseClass}">${data.message}</div>`;
});

source.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    panel.innerHTML += `<div class="sse-message phase-ready">${data.message}</div>`;
    source.close();
    // Re-fetch certificates after 10s
    setTimeout(() => { fetchCerts().then(renderCerts); }, 10000);
});
```

### XSS Prevention

All user-facing values are escaped:

```javascript
function esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
```

---

## 11. Docker Image

### Dockerfile (Multi-Stage Build)

```dockerfile
# ── Build Stage ────────────────────────────────────────────
FROM golang:1.24 AS build
WORKDIR /workspace

# Cache dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY cmd/ cmd/
COPY api/ api/
COPY internal/ internal/
COPY hack/ hack/

# Build BOTH binaries
RUN CGO_ENABLED=0 GOOS=linux go build -a -o manager ./cmd/main.go
RUN CGO_ENABLED=0 GOOS=linux go build -a -o dashboard ./cmd/dashboard/main.go

# ── Runtime Stage ──────────────────────────────────────────
FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY --from=build /workspace/manager .
COPY --from=build /workspace/dashboard .
USER 65532:65532
ENTRYPOINT ["/manager"]
```

### Building the Image

```bash
cd cert-dashboard-operator

# Build the image
docker build -t bookstore/cert-dashboard-operator:latest .

# Tag for dashboard (same image, different name for clarity)
docker tag bookstore/cert-dashboard-operator:latest bookstore/cert-dashboard:latest
```

### Image Architecture

The single image contains two binaries:
- `/manager` — the operator (controller-runtime), default `ENTRYPOINT`
- `/dashboard` — the web server, invoked via `command: ["/dashboard"]` in the Deployment created by the controller

---

## 12. Deploying to kind

### Step 1: Ensure kind cluster has port 32600 mapped

In `cluster.yaml` under `extraPortMappings`:

```yaml
- containerPort: 32600
  hostPort: 32600
  protocol: TCP
```

If adding a new port, you must recreate the cluster (`up.sh --fresh`).

### Step 2: Load images into kind

```bash
kind load docker-image bookstore/cert-dashboard-operator:latest --name bookstore
kind load docker-image bookstore/cert-dashboard:latest --name bookstore
```

### Step 3: Install OLM (optional but recommended)

```bash
operator-sdk olm install
kubectl wait --for=condition=available deploy/olm-operator -n olm --timeout=120s
```

### Step 4: Install the CRD

```bash
kubectl apply -f config/crd/bases/
```

### Step 5: Create namespace and deploy operator

```bash
# Create namespace
kubectl create namespace cert-dashboard
kubectl label namespace cert-dashboard istio.io/dataplane-mode=ambient

# Apply RBAC + Deployment (see scripts/cert-dashboard-up.sh for full manifests)
kubectl apply -f <operator-rbac-and-deployment-yaml>
kubectl rollout status deploy/cert-dashboard-operator -n cert-dashboard --timeout=120s
```

### Step 6: Apply PeerAuthentication (for Istio)

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: cert-dashboard-nodeport-permissive
  namespace: cert-dashboard
spec:
  selector:
    matchLabels:
      app: cert-dashboard
  mtls:
    mode: STRICT
  portLevelMtls:
    "8080":
      mode: PERMISSIVE
```

### Step 7: Create the CertDashboard CR

```yaml
apiVersion: certs.bookstore.io/v1alpha1
kind: CertDashboard
metadata:
  name: bookstore-certs
  namespace: cert-dashboard
spec:
  namespaces:
    - cert-manager
    - infra
  nodePort: 32600
  yellowThresholdDays: 10
  redThresholdDays: 5
  replicas: 1
  image: bookstore/cert-dashboard:latest
```

```bash
kubectl apply -f infra/cert-dashboard/certdashboard-cr.yaml
```

### Step 8: Verify

```bash
kubectl get certdashboard -n cert-dashboard
# NAME              READY   URL                      AGE
# bookstore-certs   true    http://localhost:32600    30s

curl http://localhost:32600/healthz
# {"status":"ok"}

curl http://localhost:32600/api/certs | python3 -m json.tool
```

### Automated Deployment

Use the provided script for all-in-one deployment:

```bash
bash scripts/cert-dashboard-up.sh
```

---

## 13. Deploying to kubeadm (Bare-Metal / VM)

This section covers deploying the cert-dashboard-operator to a production kubeadm cluster — bare-metal servers or VMs (Ubuntu/RHEL/Debian).

### 13.1 kubeadm Cluster Prerequisites

Before deploying the operator, ensure your kubeadm cluster meets these requirements:

| Requirement | Minimum | Recommended | How to Verify |
|-------------|---------|-------------|---------------|
| Kubernetes | v1.28+ | v1.31+ | `kubectl version` |
| Nodes | 1 control-plane + 1 worker | 1 CP + 3 workers | `kubectl get nodes` |
| CNI plugin | Any (Calico, Flannel, Cilium) | Calico or Cilium | `kubectl get pods -n kube-system -l k8s-app=calico-node` |
| Container runtime | containerd 1.7+ or CRI-O 1.28+ | containerd 1.7+ | `crictl version` |
| cert-manager | v1.14+ | v1.17+ | `kubectl get pods -n cert-manager` |
| OS | Ubuntu 22.04 / RHEL 8+ / Debian 12+ | Ubuntu 24.04 LTS | `cat /etc/os-release` |
| CPU/RAM per worker | 2 vCPU / 4 GB | 4 vCPU / 8 GB | `nproc && free -h` |

### 13.2 Setting Up a kubeadm Cluster (from scratch)

If you don't have a kubeadm cluster yet, here's a quick setup guide:

**On all nodes (control-plane + workers):**

```bash
# 1. Disable swap (required by kubelet)
sudo swapoff -a
sudo sed -i '/swap/d' /etc/fstab

# 2. Load kernel modules
cat <<'EOF' | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
sudo modprobe overlay
sudo modprobe br_netfilter

# 3. Set sysctl params
cat <<'EOF' | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
EOF
sudo sysctl --system

# 4. Install containerd
sudo apt-get update && sudo apt-get install -y containerd
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml
# Enable SystemdCgroup (required for kubeadm)
sudo sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
sudo systemctl restart containerd

# 5. Install kubeadm, kubelet, kubectl
sudo apt-get install -y apt-transport-https ca-certificates curl gpg
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key | \
  sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' | \
  sudo tee /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl
```

**On the control-plane node:**

```bash
# Initialize the cluster
sudo kubeadm init \
  --pod-network-cidr=10.244.0.0/16 \
  --apiserver-advertise-address=<CONTROL_PLANE_IP>

# Set up kubeconfig
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config

# Install a CNI (Calico example)
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.0/manifests/calico.yaml

# Get the join command for workers
kubeadm token create --print-join-command
```

**On each worker node:**

```bash
# Join the cluster (paste the command from the control-plane output)
sudo kubeadm join <CONTROL_PLANE_IP>:6443 --token <TOKEN> --discovery-token-ca-cert-hash sha256:<HASH>
```

**Verify the cluster:**

```bash
kubectl get nodes
# NAME          STATUS   ROLES           AGE   VERSION
# cp-1          Ready    control-plane   5m    v1.31.0
# worker-1      Ready    <none>          3m    v1.31.0
# worker-2      Ready    <none>          3m    v1.31.0
```

### 13.3 Install cert-manager on kubeadm

```bash
# Install cert-manager (Helm recommended for production)
helm repo add jetstack https://charts.jetstack.io --force-update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --version v1.17.2 \
  --set crds.enabled=true

# Verify
kubectl get pods -n cert-manager
# cert-manager-xxxx                 1/1   Running
# cert-manager-webhook-xxxx         1/1   Running
# cert-manager-cainjector-xxxx      1/1   Running
```

Then create the CA issuer chain and at least one Certificate (see [Section 3: Prerequisites](#3-prerequisites) for the full manifests).

### 13.4 Set Up a Private Container Registry

kubeadm clusters need a container registry to pull images. Options:

**Option A: Docker Hub (simplest)**

```bash
# Build and push
docker build -t <dockerhub-user>/cert-dashboard-operator:v0.0.1 cert-dashboard-operator/
docker tag <dockerhub-user>/cert-dashboard-operator:v0.0.1 <dockerhub-user>/cert-dashboard:v0.0.1
docker push <dockerhub-user>/cert-dashboard-operator:v0.0.1
docker push <dockerhub-user>/cert-dashboard:v0.0.1

# Create pull secret on cluster (if private repo)
kubectl create secret docker-registry regcred \
  --docker-server=https://index.docker.io/v1/ \
  --docker-username=<user> \
  --docker-password=<token> \
  --docker-email=<email> \
  -n cert-dashboard
```

**Option B: Local registry (air-gapped / no internet)**

```bash
# Run a local registry on the control-plane node
docker run -d -p 5000:5000 --restart=always --name registry registry:2

# Build, tag, push to local registry
docker build -t localhost:5000/cert-dashboard-operator:v0.0.1 cert-dashboard-operator/
docker tag localhost:5000/cert-dashboard-operator:v0.0.1 localhost:5000/cert-dashboard:v0.0.1
docker push localhost:5000/cert-dashboard-operator:v0.0.1
docker push localhost:5000/cert-dashboard:v0.0.1

# Configure containerd on ALL nodes to trust the insecure registry
# Add to /etc/containerd/config.toml on each node:
#   [plugins."io.containerd.grpc.v1.cri".registry.mirrors."<CP_IP>:5000"]
#     endpoint = ["http://<CP_IP>:5000"]
# Then restart containerd: sudo systemctl restart containerd
```

**Option C: Harbor (enterprise-grade)**

```bash
# Install Harbor via Helm (requires a PV provisioner)
helm repo add harbor https://helm.goharbor.io
helm install harbor harbor/harbor \
  --namespace harbor --create-namespace \
  --set expose.type=nodePort \
  --set expose.tls.enabled=false \
  --set externalURL=http://<CP_IP>:30003

# Push images to Harbor
docker tag bookstore/cert-dashboard-operator:latest <CP_IP>:30003/library/cert-dashboard-operator:v0.0.1
docker push <CP_IP>:30003/library/cert-dashboard-operator:v0.0.1
```

### 13.5 Deploy the Operator

```bash
# 1. Create namespace
kubectl create namespace cert-dashboard

# 2. Create imagePullSecrets (if using private registry)
# Skip this if using a public registry or local registry with insecure config
kubectl create secret docker-registry regcred \
  --docker-server=<REGISTRY_URL> \
  --docker-username=<user> \
  --docker-password=<password> \
  -n cert-dashboard

# 3. Install the CRD
kubectl apply -f cert-dashboard-operator/config/crd/bases/

# 4. Apply operator RBAC + Deployment
REGISTRY="<REGISTRY_URL>"  # e.g., docker.io/myuser, 192.168.1.100:5000, myacr.azurecr.io
IMAGE_TAG="v0.0.1"

kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: cert-dashboard-operator
  namespace: cert-dashboard
imagePullSecrets:
  - name: regcred    # Remove this block if using public registry
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cert-dashboard-operator
rules:
  - apiGroups: ["certs.bookstore.io"]
    resources: ["certdashboards", "certdashboards/status", "certdashboards/finalizers"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["services", "serviceaccounts"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["clusterroles", "clusterrolebindings"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["cert-manager.io"]
    resources: ["certificates", "certificaterequests", "clusterissuers", "issuers"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "watch", "delete"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cert-dashboard-operator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cert-dashboard-operator
subjects:
  - kind: ServiceAccount
    name: cert-dashboard-operator
    namespace: cert-dashboard
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: cert-dashboard-operator
  namespace: cert-dashboard
  labels:
    app: cert-dashboard-operator
spec:
  replicas: 1
  selector:
    matchLabels:
      app: cert-dashboard-operator
  template:
    metadata:
      labels:
        app: cert-dashboard-operator
    spec:
      serviceAccountName: cert-dashboard-operator
      containers:
        - name: manager
          image: ${REGISTRY}/cert-dashboard-operator:${IMAGE_TAG}
          imagePullPolicy: IfNotPresent
          command: ["/manager"]
          args:
            - --leader-elect=false
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
          securityContext:
            runAsNonRoot: true
            runAsUser: 65532
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
EOF

# 5. Wait for operator
kubectl rollout status deploy/cert-dashboard-operator -n cert-dashboard --timeout=120s
```

### 13.6 Create the CertDashboard CR

```bash
REGISTRY="<REGISTRY_URL>"
IMAGE_TAG="v0.0.1"

kubectl apply -f - <<EOF
apiVersion: certs.bookstore.io/v1alpha1
kind: CertDashboard
metadata:
  name: bookstore-certs
  namespace: cert-dashboard
spec:
  namespaces:
    - cert-manager
    - infra
  nodePort: 32600
  yellowThresholdDays: 10
  redThresholdDays: 5
  replicas: 1
  image: ${REGISTRY}/cert-dashboard:${IMAGE_TAG}
EOF
```

### 13.7 Expose the Dashboard

On a kubeadm cluster, you have several options:

**Option A: NodePort (default — simplest)**

The operator creates a NodePort service automatically. Access via any worker node IP:

```bash
# Find node IPs
kubectl get nodes -o wide
# NAME       STATUS   ROLES           INTERNAL-IP     EXTERNAL-IP
# worker-1   Ready    <none>          192.168.1.101   <none>

# Access dashboard
curl http://192.168.1.101:32600/healthz
# {"status":"ok"}

# Or from browser
# http://192.168.1.101:32600
```

**Option B: Ingress Controller (NGINX)**

```bash
# Install NGINX Ingress Controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.0/deploy/static/provider/baremetal/deploy.yaml

# Create Ingress resource
kubectl apply -f - <<'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: cert-dashboard
  namespace: cert-dashboard
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
    - host: certs.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: bookstore-certs
                port:
                  number: 8080
EOF
```

**Option C: MetalLB + LoadBalancer (bare-metal LB)**

```bash
# Install MetalLB
kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.14.9/config/manifests/metallb-native.yaml
kubectl wait --for=condition=available deploy/controller -n metallb-system --timeout=120s

# Configure IP pool (adjust range to your network)
kubectl apply -f - <<'EOF'
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: default
  namespace: metallb-system
spec:
  addresses:
    - 192.168.1.200-192.168.1.210
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: default
  namespace: metallb-system
EOF

# Change the dashboard service to LoadBalancer
kubectl patch svc bookstore-certs -n cert-dashboard -p '{"spec":{"type":"LoadBalancer"}}'

# Get external IP
kubectl get svc bookstore-certs -n cert-dashboard
# NAME              TYPE           CLUSTER-IP    EXTERNAL-IP     PORT(S)
# bookstore-certs   LoadBalancer   10.96.x.x    192.168.1.200   8080:32600/TCP
```

### 13.8 Firewall Configuration

On bare-metal / VM nodes, ensure the NodePort is accessible:

```bash
# UFW (Ubuntu)
sudo ufw allow 32600/tcp comment "cert-dashboard NodePort"

# firewalld (RHEL/CentOS)
sudo firewall-cmd --permanent --add-port=32600/tcp
sudo firewall-cmd --reload

# iptables (direct)
sudo iptables -A INPUT -p tcp --dport 32600 -j ACCEPT
```

### 13.9 Istio on kubeadm (optional)

If running Istio on your kubeadm cluster:

```bash
# Install Istio (ambient mode)
istioctl install --set profile=ambient -y

# Label the namespace for ambient mesh
kubectl label namespace cert-dashboard istio.io/dataplane-mode=ambient

# Apply PeerAuthentication for NodePort access
kubectl apply -f - <<'EOF'
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: cert-dashboard-nodeport-permissive
  namespace: cert-dashboard
spec:
  selector:
    matchLabels:
      app: cert-dashboard
  mtls:
    mode: STRICT
  portLevelMtls:
    "8080":
      mode: PERMISSIVE
EOF
```

### 13.10 Verify Deployment

```bash
# 1. Check all pods
kubectl get pods -n cert-dashboard
# NAME                                       READY   STATUS    RESTARTS   AGE
# cert-dashboard-operator-xxxxx              1/1     Running   0          2m
# bookstore-certs-xxxxx                      1/1     Running   0          1m

# 2. Check CR status
kubectl get certdashboard -n cert-dashboard
# NAME              READY   URL                      AGE
# bookstore-certs   true    http://localhost:32600    1m

# 3. Health check (from any node)
curl http://<NODE_IP>:32600/healthz
# {"status":"ok"}

# 4. API check
curl -s http://<NODE_IP>:32600/api/certs | python3 -m json.tool

# 5. Open in browser
echo "Dashboard URL: http://<NODE_IP>:32600"
```

### 13.11 Production Hardening for kubeadm

| Concern | Recommendation |
|---------|----------------|
| **High availability** | Set `replicas: 2` in CertDashboard CR; enable `--leader-elect=true` on operator |
| **Resource limits** | Adjust CPU/memory limits based on certificate count (100 certs: 100m/128Mi) |
| **Network policies** | Restrict ingress to dashboard port 8080 only; restrict egress to API server |
| **Pod disruption budget** | Add PDB with `minAvailable: 1` for the dashboard Deployment |
| **Node affinity** | Schedule operator on control-plane; dashboard on workers |
| **TLS for dashboard** | Use cert-manager to issue a cert for the dashboard itself; terminate TLS at Ingress |
| **Monitoring** | Add Prometheus ServiceMonitor for `/healthz` endpoint scraping |
| **Backup** | CRD + CR manifests stored in Git; no persistent state to back up |

---

## 14. Deploying to EKS

### Step 1: Push images to ECR

```bash
# Create ECR repositories
aws ecr create-repository --repository-name cert-dashboard-operator
aws ecr create-repository --repository-name cert-dashboard

# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

# Tag and push
ECR=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

docker tag bookstore/cert-dashboard-operator:latest $ECR/cert-dashboard-operator:v0.0.1
docker push $ECR/cert-dashboard-operator:v0.0.1

docker tag bookstore/cert-dashboard:latest $ECR/cert-dashboard:v0.0.1
docker push $ECR/cert-dashboard:v0.0.1
```

### Step 2: Update image references

In the operator Deployment manifest:
```yaml
image: <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cert-dashboard-operator:v0.0.1
```

In the CertDashboard CR:
```yaml
spec:
  image: <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/cert-dashboard:v0.0.1
```

### Step 3: Install cert-manager on EKS

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.2/cert-manager.yaml
```

### Step 4: Change Service type to LoadBalancer (instead of NodePort)

Modify the controller to create a LoadBalancer service on EKS, or use an `Ingress`/`Gateway` resource:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: bookstore-certs
  namespace: cert-dashboard
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
spec:
  type: LoadBalancer
  ports:
    - port: 80
      targetPort: 8080
  selector:
    app: cert-dashboard
```

Alternatively, keep NodePort and expose via an AWS ALB Ingress:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: cert-dashboard
  namespace: cert-dashboard
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
spec:
  rules:
    - host: certs.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: bookstore-certs
                port:
                  number: 8080
```

### Step 5: RBAC for ECR pull

EKS nodes need ECR pull permissions. If using IRSA (IAM Roles for Service Accounts):

```bash
eksctl create iamserviceaccount \
  --name cert-dashboard-operator \
  --namespace cert-dashboard \
  --cluster <cluster-name> \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly \
  --approve
```

### Step 6: Deploy

```bash
kubectl apply -f config/crd/bases/
kubectl apply -f <operator-deployment-for-eks>.yaml
kubectl apply -f <certdashboard-cr>.yaml
```

### Step 7: Get endpoint

```bash
kubectl get svc bookstore-certs -n cert-dashboard
# Note the EXTERNAL-IP from the LoadBalancer
```

---

## 15. Deploying to AKS

### Step 1: Push images to ACR

```bash
# Create ACR
az acr create --resource-group myRG --name myacr --sku Basic

# Login
az acr login --name myacr

# Tag and push
ACR=myacr.azurecr.io

docker tag bookstore/cert-dashboard-operator:latest $ACR/cert-dashboard-operator:v0.0.1
docker push $ACR/cert-dashboard-operator:v0.0.1

docker tag bookstore/cert-dashboard:latest $ACR/cert-dashboard:v0.0.1
docker push $ACR/cert-dashboard:v0.0.1
```

### Step 2: Attach ACR to AKS

```bash
az aks update -n myAKSCluster -g myRG --attach-acr myacr
```

### Step 3: Install cert-manager

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.2/cert-manager.yaml
```

### Step 4: Deploy with LoadBalancer or Application Gateway Ingress

For an internal LoadBalancer:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: bookstore-certs
  namespace: cert-dashboard
  annotations:
    service.beta.kubernetes.io/azure-load-balancer-internal: "true"
spec:
  type: LoadBalancer
  ports:
    - port: 80
      targetPort: 8080
  selector:
    app: cert-dashboard
```

For Application Gateway Ingress Controller (AGIC):
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: cert-dashboard
  namespace: cert-dashboard
  annotations:
    kubernetes.io/ingress.class: azure/application-gateway
spec:
  rules:
    - host: certs.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: bookstore-certs
                port:
                  number: 8080
```

### Step 5: Deploy

```bash
kubectl apply -f config/crd/bases/
kubectl apply -f <operator-deployment-for-aks>.yaml
kubectl apply -f <certdashboard-cr>.yaml
```

---

## 16. Deploying to GKE

### Step 1: Push images to Artifact Registry

```bash
# Create repository
gcloud artifacts repositories create cert-dashboard \
  --repository-format=docker \
  --location=us-central1

# Configure Docker auth
gcloud auth configure-docker us-central1-docker.pkg.dev

# Tag and push
GAR=us-central1-docker.pkg.dev/<PROJECT_ID>/cert-dashboard

docker tag bookstore/cert-dashboard-operator:latest $GAR/operator:v0.0.1
docker push $GAR/operator:v0.0.1

docker tag bookstore/cert-dashboard:latest $GAR/dashboard:v0.0.1
docker push $GAR/dashboard:v0.0.1
```

### Step 2: Install cert-manager

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.2/cert-manager.yaml
```

### Step 3: Expose via GKE Ingress or LoadBalancer

For GKE's built-in Ingress:
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: cert-dashboard
  namespace: cert-dashboard
  annotations:
    kubernetes.io/ingress.class: gce
spec:
  rules:
    - host: certs.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: bookstore-certs
                port:
                  number: 8080
```

### Step 4: Deploy

```bash
kubectl apply -f config/crd/bases/
kubectl apply -f <operator-deployment-for-gke>.yaml
kubectl apply -f <certdashboard-cr>.yaml
```

### Step 5: Get endpoint

```bash
kubectl get ingress cert-dashboard -n cert-dashboard
```

---

## 17. OLM (Operator Lifecycle Manager)

### What is OLM?

OLM provides a declarative way to install, manage, and upgrade operators on a Kubernetes cluster. It handles:
- Operator installation from catalogs
- Dependency resolution
- Operator upgrades
- RBAC management

### Installing OLM

```bash
operator-sdk olm install
```

### Generating OLM Bundle

```bash
# Generate bundle manifests
operator-sdk generate kustomize manifests --interactive=false
make bundle IMG=bookstore/cert-dashboard-operator:latest

# Build and push bundle image
make bundle-build bundle-push BUNDLE_IMG=bookstore/cert-dashboard-operator-bundle:v0.0.1
```

### Installing via OLM

```bash
# Create a CatalogSource pointing to your bundle
operator-sdk run bundle bookstore/cert-dashboard-operator-bundle:v0.0.1

# This creates:
# - CatalogSource
# - Subscription
# - InstallPlan
# - ClusterServiceVersion (CSV)
```

### OLM on Managed Kubernetes

On EKS/AKS/GKE, install OLM first:

```bash
operator-sdk olm install
```

Then deploy via catalog:

```bash
operator-sdk run bundle <ECR/ACR/GAR>/cert-dashboard-operator-bundle:v0.0.1
```

---

## 18. Manual Testing Guide

### Prerequisites

- Cluster running with cert-manager installed
- At least one `Certificate` resource exists and is Ready
- Dashboard deployed and accessible

### Test 1: Dashboard Loads

```
1. Open browser: http://localhost:32600
2. VERIFY: Page title is "Certificate Dashboard"
3. VERIFY: Header shows "cert-manager Certificate Monitoring & Renewal"
4. VERIFY: Footer shows "BookStore Platform · cert-manager Operator Dashboard · Auto-refresh every 30s"
```

### Test 2: Certificate Cards Display

```
1. Open http://localhost:32600
2. VERIFY: At least 2 certificate cards are visible
3. VERIFY: Each card shows:
   - Certificate name (bold, top-left)
   - Namespace badge (blue pill)
   - Ready status indicator (green dot + "Ready" text, top-right)
   - Detail grid: Issuer, DNS Names, IP Addresses, Algorithm, Serial Number,
     Duration/Renew Before, Not Before, Not After, Renewal Time, Revision
   - Progress bar with days remaining
   - "Renew Certificate" button
```

### Test 3: CA Certificate Badge

```
1. Find the "bookstore-ca" card
2. VERIFY: Purple "CA" badge appears next to the namespace
3. VERIFY: Issuer shows "selfsigned-bootstrap (ClusterIssuer)"
4. VERIFY: Duration shows "87600h / 8760h" (10 years / 1 year)
```

### Test 4: Gateway Certificate Details

```
1. Find the "bookstore-gateway-cert" card
2. VERIFY: Namespace badge shows "infra"
3. VERIFY: DNS Names include: myecom.net, api.service.net, idp.keycloak.net, localhost
4. VERIFY: IP Addresses shows: 127.0.0.1
5. VERIFY: Algorithm shows: ECDSA P-256
6. VERIFY: Duration shows: 720h / 168h (30 days / 7 days)
7. VERIFY: Serial Number is a hex string (e.g., "999A5CD56B64C9B2E7D92943B054BA73")
```

### Test 5: Progress Bar (Green)

```
1. Find the gateway cert card
2. VERIFY: Progress bar is GREEN (fully filled for a fresh 30-day cert)
3. VERIFY: Text shows "30 days remaining" (approximately)
4. VERIFY: "Certificate Lifetime" label appears above the bar
```

### Test 6: Health Endpoint

```bash
curl -s http://localhost:32600/healthz
```

```
VERIFY: Response is {"status":"ok"}
VERIFY: HTTP status code is 200
```

### Test 7: API Certs Endpoint

```bash
curl -s http://localhost:32600/api/certs | python3 -m json.tool
```

```
VERIFY: Response is a JSON array
VERIFY: Each object has: name, namespace, issuer, issuerKind, algorithm,
        serialNumber, notBefore, notAfter, daysRemaining, status, ready, revision
VERIFY: bookstore-ca has isCA: true
VERIFY: bookstore-gateway-cert has dnsNames array with 4 entries
VERIFY: status field is "green" for fresh certificates
```

### Test 8: Renew Modal — Open

```
1. Click "Renew Certificate" on the gateway cert card
2. VERIFY: Modal dialog appears with dark backdrop
3. VERIFY: Title shows "Confirm Certificate Renewal"
4. VERIFY: Text shows "Are you sure you want to renew the certificate
   bookstore-gateway-cert in namespace infra?"
5. VERIFY: Yellow warning box says "This will delete the TLS secret and trigger
   cert-manager to issue a new certificate. There may be a brief interruption
   to HTTPS traffic."
6. VERIFY: Two buttons: "Cancel" (gray) and "Renew Certificate" (red)
```

### Test 9: Renew Modal — Cancel

```
1. Click "Renew Certificate" button
2. Modal appears
3. Click "Cancel"
4. VERIFY: Modal closes
5. VERIFY: No renewal is triggered
6. VERIFY: Certificate revision is unchanged
```

### Test 10: Renew Modal — Confirm

```
1. Note the current revision from the gateway cert card
2. Click "Renew Certificate" button
3. Modal appears
4. Click "Renew Certificate" (red button)
5. VERIFY: Modal closes immediately
6. VERIFY: "Renew Certificate" button becomes disabled (grayed out)
7. VERIFY: SSE panel appears below the button with status messages
```

### Test 11: SSE Renewal Streaming

```
After confirming renewal in Test 10:

1. VERIFY: SSE panel shows "Starting renewal..." (gray, with spinner)
2. VERIFY: "Deleting TLS secret 'bookstore-gateway-tls' to trigger renewal..."
   appears in yellow with spinner
3. VERIFY: "Secret deleted. Waiting for cert-manager to issue new certificate..."
   appears in blue with spinner
4. VERIFY: "New certificate issued by cert-manager." appears in green with spinner
5. VERIFY: "Certificate is Ready. Revision: N → M" appears in green (bold, no spinner)
   where M = N + 1
6. VERIFY: "Renewal complete" appears in green (bold)
7. VERIFY: After ~10 seconds, the page auto-refreshes with updated certificate data
8. VERIFY: Revision number in the card is incremented
9. VERIFY: Serial number has changed (new certificate)
10. VERIFY: Not Before / Not After dates are updated
```

### Test 12: HTTPS Still Works After Renewal

```bash
# Verify the gateway certificate renewal didn't break HTTPS
curl -sk https://api.service.net:30000/ecom/books | head -c 100
```

```
VERIFY: Response is 200 with JSON book data
VERIFY: No TLS errors
```

### Test 13: API Renew Endpoint (Direct)

```bash
# Trigger renewal via API
curl -s -X POST http://localhost:32600/api/renew \
  -H 'Content-Type: application/json' \
  -d '{"name":"bookstore-gateway-cert","namespace":"infra"}'
```

```
VERIFY: Response contains {"streamId":"<uuid>"}
VERIFY: streamId is a valid UUID (36 characters with dashes)
```

### Test 14: API Renew — Invalid Request

```bash
curl -s -X POST http://localhost:32600/api/renew \
  -H 'Content-Type: application/json' \
  -d '{"name":"","namespace":""}'
```

```
VERIFY: HTTP status code is 400
VERIFY: Response contains {"error":"name and namespace required"}
```

### Test 15: SSE Endpoint (Direct)

```bash
# First get a stream ID
STREAM_ID=$(curl -s -X POST http://localhost:32600/api/renew \
  -H 'Content-Type: application/json' \
  -d '{"name":"bookstore-gateway-cert","namespace":"infra"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['streamId'])")

# Connect to SSE stream
curl -sN --max-time 90 http://localhost:32600/api/sse/$STREAM_ID
```

```
VERIFY: Content-Type header is text/event-stream
VERIFY: First line is ": keepalive"
VERIFY: Events follow SSE format: "event: status\ndata: {...}\n\n"
VERIFY: Phases appear in order: deleting-secret → waiting-issuing → issued → ready
VERIFY: Final event is "event: complete\ndata: {...\"done\":true}\n\n"
```

### Test 16: Operator Kubernetes Resources

```bash
# CRD exists
kubectl get crd certdashboards.certs.bookstore.io

# Operator pod is running
kubectl get pods -n cert-dashboard -l app=cert-dashboard-operator

# Dashboard pod is running
kubectl get pods -n cert-dashboard -l app=cert-dashboard

# CR status
kubectl get certdashboard -n cert-dashboard

# Service has NodePort 32600
kubectl get svc bookstore-certs -n cert-dashboard -o jsonpath='{.spec.ports[0].nodePort}'
```

```
VERIFY: CRD exists with the correct name
VERIFY: Operator pod is 1/1 Running
VERIFY: Dashboard pod is 1/1 Running
VERIFY: CR shows Ready=true and URL=http://localhost:32600
VERIFY: Service NodePort is 32600
```

### Test 17: Auto-Refresh

```
1. Open http://localhost:32600
2. Wait 30 seconds without interacting
3. VERIFY: Certificate data refreshes automatically (check browser Network tab)
4. VERIFY: No page flicker or full reload — just the data updates
```

### Test 18: OLM Verification

```bash
# OLM operator is running
kubectl get pods -n olm -l app=olm-operator

# Catalog operator is running
kubectl get pods -n olm -l app=catalog-operator
```

```
VERIFY: olm-operator pod is Running
VERIFY: catalog-operator pod is Running
```

---

## 19. Automated Tests

The operator and dashboard have 35 automated tests across 4 packages.

### Controller Tests (8 tests, envtest)

Package: `internal/controller/`

| Test | Description |
|------|-------------|
| Reconcile | Creates all child resources (SA, ClusterRole, ClusterRoleBinding, Deployment, Service) |
| Defaults | Applies default values for replicas, image, nodePort, thresholds when not specified |
| Finalizer | Adds finalizer on first reconcile; cleans up cluster-scoped resources on deletion |
| ObservedGeneration | Sets `status.observedGeneration` to match `metadata.generation` |
| RequeueAfter | Returns a requeue duration for periodic reconciliation |
| Non-existent resource | Returns no error and does not requeue for deleted/missing CRs |
| Update | Updates existing child resources when CR spec changes |
| Deletion cleanup | Removes ClusterRole and ClusterRoleBinding when CR is deleted (finalizer logic) |

### Handler Tests (11 tests)

Package: `internal/dashboard/`

| Test | Description |
|------|-------------|
| GetCerts returns | Returns JSON array of certificate data from CertProvider |
| GetCerts nil | Returns empty array `[]` when provider returns nil |
| GetCerts threshold | Applies yellow/red threshold to status field |
| Renew invalid JSON | Returns 400 for malformed request body |
| Renew missing fields | Returns 400 when name or namespace is empty |
| Renew not found | Returns 404 when certificate does not exist |
| Renew success | Returns 200 with streamId for valid renewal request |
| Renew name too long | Returns 400 when name exceeds 253 characters |
| Healthz | Returns `{"status":"ok"}` with 200 |
| SSE unknown | Returns 404 for non-existent stream ID |
| SSE missing | Returns 404 when stream ID is absent |
| Index root | Serves index.html for `GET /` |
| Index non-root | Returns 404 for unknown paths |

### CertWatcher Tests (7 tests)

Package: `internal/dashboard/`

| Test | Description |
|------|-------------|
| NilSpec | Handles Certificate with nil spec gracefully |
| InvalidSpecType | Handles unexpected spec type without crashing |
| FullSpec | Parses all fields (DNS names, IP addresses, duration, renewBefore, algorithm) |
| MinimalSpec | Parses Certificate with only required fields |
| RevisionAsInt64 | Correctly reads revision from status as int64 (Kubernetes unstructured API) |
| NotReadyStatus | Sets ready=false and appropriate status when Certificate is not Ready |
| IsCA | Detects `isCA: true` in spec and sets the isCA field |

### Webhook Tests (9 tests)

Package: `api/v1alpha1/`

| Test | Description |
|------|-------------|
| ValidCR | Accepts a well-formed CertDashboard CR |
| RedGreaterThanYellow | Rejects CR where redThresholdDays > yellowThresholdDays |
| RedEqualToYellow | Rejects CR where redThresholdDays == yellowThresholdDays |
| EmptyImage | Rejects CR with empty image string |
| NegativeReplicas | Rejects CR with replicas < 0 |
| InvalidNodePort | Rejects CR with nodePort outside valid range (30000-32767) |
| Update | Validates updated CR (same rules as create) |
| DeleteAlwaysAllowed | Allows deletion of any CR without validation |
| DefaultsValid | Verifies defaulting webhook sets correct default values |

### Running Tests

```bash
cd cert-dashboard-operator
go test ./... -v
```

---

## 20. Security

### Authentication

`POST /api/renew` requires a valid Kubernetes ServiceAccount token in the `Authorization: Bearer <token>` header. The dashboard validates the token via the Kubernetes TokenReview API. Unauthenticated requests receive a `401 Unauthorized` response.

Read-only endpoints (`GET /api/certs`, `GET /healthz`, `GET /metrics`, `GET /api/sse/{id}`) do not require authentication.

### Rate Limiting

The renew endpoint is rate-limited to 1 request per 10 seconds (per-server, not per-client). Requests that exceed the limit receive a `429 Too Many Requests` response.

### Input Validation

- Certificate name: maximum 253 characters (Kubernetes DNS subdomain limit)
- Namespace: maximum 63 characters (Kubernetes namespace limit)
- Request body: must be valid JSON with `name` and `namespace` string fields

### Context Deadlines

- Renewal timeout: 90 seconds (context deadline for the entire renewal goroutine)
- HTTP ReadHeaderTimeout: 10 seconds
- HTTP ReadTimeout: 30 seconds
- HTTP IdleTimeout: 120 seconds

### Pod Security

The dashboard Deployment created by the operator enforces:

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
```

### Validation Webhook

The operator registers a validating webhook for `CertDashboard` CRs that enforces:

- `redThresholdDays` must be strictly less than `yellowThresholdDays`
- `image` must not be empty
- `replicas` must be >= 0
- `nodePort` must be in valid range (30000-32767)

---

## 21. Metrics

The dashboard exposes Prometheus metrics at `GET /metrics` in standard Prometheus exposition format.

### Available Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `cert_dashboard_certificates_total` | Gauge | (none) | Total number of monitored certificates |
| `cert_dashboard_certificate_days_remaining` | GaugeVec | `name`, `namespace` | Days remaining until certificate expiry |
| `cert_dashboard_certificate_ready` | GaugeVec | `name`, `namespace` | Whether the certificate is Ready (1) or not (0) |
| `cert_dashboard_renewals_total` | Counter | (none) | Total number of successful certificate renewals |
| `cert_dashboard_renewal_errors_total` | Counter | (none) | Total number of failed certificate renewal attempts |

### Scraping

Add the dashboard to your Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: cert-dashboard
    static_configs:
      - targets: ['cert-dashboard.cert-dashboard.svc:8080']
    metrics_path: /metrics
    scrape_interval: 30s
```

### Example Queries

```promql
# Certificates expiring within 7 days
cert_dashboard_certificate_days_remaining < 7

# Renewal error rate (last 5 minutes)
rate(cert_dashboard_renewal_errors_total[5m])

# Not-ready certificates
cert_dashboard_certificate_ready == 0
```

---

## 22. Troubleshooting

### Image Pull Errors (ImagePullBackOff)

**Symptom:** Dashboard pod shows `ImagePullBackOff`

**Cause:** `imagePullPolicy` defaults to `Always` for `:latest` tags. In kind, images are loaded locally and can't be pulled from a registry.

**Fix:** Set `imagePullPolicy: IfNotPresent` in the controller's Deployment spec:
```go
ImagePullPolicy: corev1.PullIfNotPresent,
```

### Port Not Accessible

**Symptom:** `curl http://localhost:32600` returns connection refused

**Cause:** Port 32600 wasn't in `cluster.yaml` when the kind cluster was created.

**Fix:** Add the port to `extraPortMappings` and recreate the cluster:
```bash
bash scripts/up.sh --fresh
```

**Workaround** (without recreation):
```bash
kubectl port-forward -n cert-dashboard svc/bookstore-certs 32600:8080
```

### SSE Not Streaming (Renewal Goroutine Dies)

**Symptom:** POST /api/renew returns a streamId but SSE shows no events

**Cause:** Using `r.Context()` in the goroutine. The POST request context is cancelled when the response is sent.

**Fix:** Use `context.Background()`:
```go
go s.performRenewal(context.Background(), ...)  // NOT r.Context()
```

### Revision Shows 0

**Symptom:** Dashboard shows `Revision: 0` even though cert-manager reports a higher number

**Cause:** Kubernetes unstructured API stores integers as `int64`, not `float64`.

**Fix:** Use a type switch:
```go
switch rev := status["revision"].(type) {
case int64:  return rev, nil
case float64: return int64(rev), nil
}
```

### Dashboard Pod CrashLoopBackOff

**Symptom:** Dashboard pod keeps restarting

**Check logs:**
```bash
kubectl logs -n cert-dashboard -l app=cert-dashboard --tail=50
```

**Common causes:**
- Missing RBAC — dashboard ServiceAccount can't read certificates
- cert-manager not installed — dynamic client fails to list Certificate resources
- Wrong namespace — NAMESPACES env var doesn't match actual certificate locations

---

## 23. Key Lessons & Gotchas

1. **`imagePullPolicy: IfNotPresent`** is mandatory for kind clusters with locally-loaded images. Without it, Kubernetes tries to pull from Docker Hub and fails.

2. **`context.Background()` for background goroutines** — never pass an HTTP request context to a goroutine that outlives the request.

3. **Kubernetes unstructured integers are `int64`**, not `float64` — always handle both types in type assertions.

4. **Playwright strict mode** — `locator('.class').toBeVisible()` fails if multiple elements match. Use `.first()` when multiple matches are expected.

5. **Single Docker image, two binaries** — simpler CI/CD, single build, single push. The operator creates Deployments with `command: ["/dashboard"]` to override the default entrypoint.

6. **NodePort exposure in kind** — ports must be declared in `cluster.yaml` before cluster creation. Adding ports later requires cluster recreation.

7. **Istio PeerAuthentication for NodePort** — kind NodePort traffic arrives as plaintext. Use `portLevelMtls: PERMISSIVE` on the specific app port (not namespace-wide, which requires `selector`).

8. **cert-manager renewal pattern** — deleting the TLS secret triggers cert-manager to re-issue. The Certificate resource remains unchanged; cert-manager detects the missing secret and starts the issuance pipeline.

9. **Go `embed` for templates** — `//go:embed templates/*` bakes all files into the binary at compile time. No external filesystem needed at runtime, which works perfectly with `readOnlyRootFilesystem: true`.

10. **SSE keepalive** — send comment lines (`: keepalive\n\n`) every 15 seconds to prevent proxy timeouts. Without this, reverse proxies and load balancers may close idle SSE connections.

11. **Finalizer for cluster-scoped resources** — ClusterRole and ClusterRoleBinding are not namespace-scoped, so they won't be garbage-collected when the CR is deleted. A finalizer ensures cleanup.

12. **OLM is optional** — the operator works fine without OLM (just apply CRD + Deployment directly). OLM adds catalog-based installation, dependency management, and upgrade semantics for production environments.
