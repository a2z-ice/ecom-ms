# Cert Dashboard Operator

<!-- ![Build Status](https://img.shields.io/badge/build-passing-brightgreen) -->
<!-- ![Go Version](https://img.shields.io/badge/go-1.24-blue) -->
<!-- ![License](https://img.shields.io/badge/license-Apache%202.0-blue) -->

A Kubernetes operator that deploys and manages a real-time certificate monitoring dashboard. It watches [cert-manager](https://cert-manager.io/) `Certificate` resources and their backing TLS secrets, presenting expiry timelines, health status, and one-click renewal through a web UI and REST API.

Built with [Operator SDK](https://sdk.operatorframework.io/) (Kubebuilder v4 layout), Go 1.24, controller-runtime v0.21.0, and Kubernetes API v0.33.0.

---

## Features

- **Custom Resource** (`CertDashboard`) to declaratively configure the dashboard
- **Automatic child resource management**: ServiceAccount, ClusterRole, ClusterRoleBinding, Deployment, NodePort Service -- all created and reconciled by the operator
- **Finalizers** for cluster-scoped resource cleanup (ClusterRole, ClusterRoleBinding) on CR deletion
- **Validation webhook** (`CertDashboardValidator`) enforces threshold ordering, image presence, replica bounds, and NodePort range
- **CertProvider interface** abstracts certificate operations for full testability with mock providers
- **Kubernetes TokenReview authentication** on the `POST /api/renew` endpoint
- **Global rate limiting** on renewal operations (1 per 10 seconds)
- **SSE (Server-Sent Events)** streaming for live renewal progress
- **Prometheus custom metrics** (5 metrics exposed at `/metrics`)
- **Auto-refresh** every 15 seconds (server-side polling of cert-manager resources)
- **Pod security hardened**: seccomp RuntimeDefault, capabilities drop ALL, non-root user, read-only root filesystem
- **ObservedGeneration** tracking in status conditions
- **RequeueAfter** (10s) when the managed Deployment is not yet ready
- **HTTP server hardening**: ReadHeaderTimeout 10s, ReadTimeout 30s, IdleTimeout 120s
- **Input validation**: certificate name max 253 chars, namespace max 63 chars
- **Context deadlines**: 90-second timeout on renewal operations
- **OLM bundle** included for Operator Lifecycle Manager distribution

---

## Architecture

```
                         +----------------------------+
                         |   Kubernetes API Server     |
                         +----------------------------+
                                   |
                   +---------------+---------------+
                   |                               |
          +--------v--------+            +---------v---------+
          |    /manager     |            |   cert-manager     |
          |   (Operator)    |            |   controller       |
          |                 |            +--------------------+
          | Watches:        |                     |
          |  CertDashboard  |            Creates/renews Certificates
          |  Deployment     |            and TLS Secrets
          |  Service        |                     |
          |  ServiceAccount |                     v
          +---------+-------+            +--------+-----------+
                    |                    |  Certificate CRs   |
          Reconciles & creates           |  TLS Secrets       |
                    |                    +--------+-----------+
                    v                             |
          +---------+-------+                     |
          |   /dashboard    |  <-- watches -------+
          |   (Web Server)  |
          |                 |
          | Endpoints:      |
          |  GET  /         |  (Web UI)
          |  GET  /api/certs|  (JSON API)
          |  POST /api/renew|  (TokenReview auth)
          |  GET  /api/sse/ |  (SSE stream)
          |  GET  /healthz  |
          |  GET  /metrics  |  (Prometheus)
          +-----------------+
                    |
            NodePort 32600
                    |
                    v
              Browser / curl
```

The operator produces a single Docker image containing two binaries:

| Binary | Purpose | Default Port |
|--------|---------|-------------|
| `/manager` | Operator controller (reconciles CertDashboard CRs) | 8081 (health probes) |
| `/dashboard` | Web server (certificate list, renewal, metrics) | 8080 (HTTP) |

---

## Prerequisites

- Go 1.24.0+
- Docker 17.03+
- kubectl v1.28+
- A Kubernetes cluster (kind, kubeadm, EKS, AKS, GKE)
- [cert-manager](https://cert-manager.io/) installed in the cluster
- [kind](https://kind.sigs.k8s.io/) (for local development with the bookstore cluster)
- [operator-sdk](https://sdk.operatorframework.io/) v1.42+ (for OLM workflows)

---

## Quick Start

The fastest way to test, build, and deploy is the all-in-one script:

```bash
bash scripts/cert-dashboard-up.sh
```

This script performs 7 stages:
1. Prerequisite checks (go, docker, kubectl, kind)
2. Tests (go vet, webhook tests, dashboard unit tests, controller integration tests via envtest)
3. Docker image build (multi-stage, distroless runtime)
4. Load images into the kind cluster
5. Install OLM (if not present)
6. Deploy operator (namespace, CRD, RBAC, Deployment, PeerAuthentication, CertDashboard CR)
7. Verification (8 checks: operator pod, dashboard pod, CR status, healthz, certs API, metrics, security context, seccomp)

Script options:

```bash
bash scripts/cert-dashboard-up.sh --skip-test   # skip Go tests (faster redeploy)
bash scripts/cert-dashboard-up.sh --test-only    # run tests only, no build/deploy
bash scripts/cert-dashboard-up.sh --build-only   # test + build only, no deploy
```

After deployment, the dashboard is available at:

| Endpoint | URL |
|----------|-----|
| Web UI | `http://localhost:32600` |
| Certs API | `http://localhost:32600/api/certs` |
| Metrics | `http://localhost:32600/metrics` |
| Health | `http://localhost:32600/healthz` |

---

## CRD Reference

**Group:** `certs.bookstore.io`
**Version:** `v1alpha1`
**Kind:** `CertDashboard`
**Resource:** `certdashboards`

### Spec Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `namespaces` | `[]string` | `[]` (all namespaces) | Namespaces to monitor for Certificate resources |
| `nodePort` | `int32` | `32600` | NodePort to expose the dashboard (range: 30000-32767) |
| `yellowThresholdDays` | `int` | `10` | Days before expiry when status turns yellow |
| `redThresholdDays` | `int` | `5` | Days before expiry when status turns red |
| `replicas` | `int32` | `1` | Number of dashboard pod replicas |
| `image` | `string` | `bookstore/cert-dashboard:latest` | Container image for the dashboard |

### Status Fields

| Field | Type | Description |
|-------|------|-------------|
| `ready` | `bool` | Whether the dashboard Deployment has ready replicas |
| `url` | `string` | Dashboard URL (e.g., `http://localhost:32600`) |
| `conditions` | `[]metav1.Condition` | Standard Kubernetes conditions (type: `Available`) |

### Print Columns

```
NAME              READY   URL                         AGE
bookstore-certs   true    http://localhost:32600       5m
```

### Example CR

```yaml
apiVersion: certs.bookstore.io/v1alpha1
kind: CertDashboard
metadata:
  name: bookstore-certs
  namespace: cert-dashboard
spec:
  namespaces:
    - istio-system
    - cert-manager
    - ecom
    - inventory
  nodePort: 32600
  yellowThresholdDays: 10
  redThresholdDays: 5
  replicas: 1
  image: bookstore/cert-dashboard:latest
```

### Validation Rules (Webhook)

- `redThresholdDays` must be strictly less than `yellowThresholdDays`
- `image` must not be empty
- `replicas` must be >= 0
- `nodePort` must be in range 30000-32767 (also enforced by CRD schema)
- Deletions are always allowed

---

## API Reference

### GET /

Returns the web UI (HTML page with embedded JavaScript for auto-refresh and renewal controls).

### GET /api/certs

Returns a JSON array of all monitored certificates.

```bash
curl -s http://localhost:32600/api/certs | jq .
```

Response:

```json
[
  {
    "name": "bookstore-gateway-cert",
    "namespace": "istio-system",
    "issuer": "bookstore-ca-issuer",
    "issuerKind": "ClusterIssuer",
    "dnsNames": ["myecom.net", "api.service.net", "idp.keycloak.net"],
    "ipAddresses": ["127.0.0.1"],
    "algorithm": "ECDSA P-256",
    "serialNumber": "1A2B3C...",
    "notBefore": "2026-03-10T00:00:00Z",
    "notAfter": "2026-04-09T00:00:00Z",
    "renewalTime": "2026-04-02T00:00:00Z",
    "duration": "720h",
    "renewBefore": "168h",
    "revision": 3,
    "ready": true,
    "daysTotal": 30,
    "daysElapsed": 5,
    "daysRemaining": 25,
    "status": "green",
    "secretName": "bookstore-gateway-tls",
    "isCA": false
  }
]
```

Status colors are determined by the CertDashboard CR thresholds:
- **green**: `daysRemaining > yellowThresholdDays`
- **yellow**: `redThresholdDays < daysRemaining <= yellowThresholdDays`
- **red**: `daysRemaining <= redThresholdDays`

### POST /api/renew

Triggers certificate renewal by deleting the TLS secret (cert-manager re-issues automatically). Requires Kubernetes ServiceAccount token authentication via TokenReview API.

**CLI usage:**

```bash
TOKEN=$(kubectl create token bookstore-certs -n cert-dashboard --duration=10m)

curl -X POST http://localhost:32600/api/renew \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "bookstore-gateway-cert", "namespace": "infra"}'
```

Response:

```json
{
  "streamId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

Use the returned `streamId` to subscribe to live renewal progress via SSE.

**Browser usage:** Click "Renew Certificate" on any card. The confirmation dialog includes:
- The exact `kubectl create token` command with a clipboard copy icon
- A password-masked token input field with Show/Hide toggle
- Client-side validation (empty token shows error, modal stays open)

The token is sent as `Authorization: Bearer <token>` in the renewal request.

**Rate limit:** 1 renewal per 10 seconds globally. Returns `429 Too Many Requests` if exceeded.

**Input constraints:** `name` max 253 characters, `namespace` max 63 characters.

### GET /api/sse/{streamId}

Server-Sent Events stream for renewal progress. Connect after receiving a `streamId` from `/api/renew`.

```bash
curl -N http://localhost:32600/api/sse/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

Events:

```
event: status
data: {"event":"status","phase":"deleting-secret","message":"Deleting TLS secret 'bookstore-gateway-tls' to trigger renewal..."}

event: status
data: {"event":"status","phase":"waiting-issuing","message":"Secret deleted. Waiting for cert-manager to issue new certificate..."}

event: status
data: {"event":"status","phase":"issued","message":"New certificate issued by cert-manager."}

event: status
data: {"event":"status","phase":"ready","message":"Certificate is Ready. Revision: 3 → 4"}

event: complete
data: {"event":"complete","message":"Renewal complete","done":true}
```

Phases: `deleting-secret` -> `waiting-issuing` -> `issued` -> `ready` -> `complete` (or `error` at any step).

### GET /healthz

Health check endpoint (unauthenticated). Used by Kubernetes liveness and readiness probes.

```bash
curl http://localhost:32600/healthz
```

```json
{"status":"ok"}
```

### GET /metrics

Prometheus metrics endpoint (unauthenticated). See the Prometheus Metrics section below.

---

## Prometheus Metrics

All metrics use the `cert_dashboard_` namespace prefix.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `cert_dashboard_certificates_total` | Gauge | -- | Total number of certificates being monitored |
| `cert_dashboard_certificate_days_remaining` | GaugeVec | `name`, `namespace` | Days remaining until certificate expiry |
| `cert_dashboard_certificate_ready` | GaugeVec | `name`, `namespace` | Whether the certificate is ready (1) or not (0) |
| `cert_dashboard_renewals_total` | Counter | -- | Total number of certificate renewals triggered |
| `cert_dashboard_renewal_errors_total` | Counter | -- | Total number of failed certificate renewals |

Metrics are updated every 15 seconds when the certificate cache is refreshed.

Example Prometheus scrape config:

```yaml
- job_name: cert-dashboard
  static_configs:
    - targets: ['bookstore-certs.cert-dashboard.svc.cluster.local:8080']
```

---

## Security

### Authentication

- `POST /api/renew` requires a valid Kubernetes ServiceAccount token in the `Authorization: Bearer <token>` header.
- Token validation uses the Kubernetes TokenReview API (server-side verification, not local JWT parsing).
- All other endpoints (GET /api/certs, GET /healthz, GET /metrics) are unauthenticated, suitable for monitoring and scraping.
- When running outside a cluster (local development), authentication is bypassed with a warning log.

### Rate Limiting

- Global rate limit: 1 renewal per 10 seconds.
- Returns HTTP 429 with `{"error":"rate limit exceeded, try again later"}` when exceeded.

### Pod Security

The operator configures the dashboard Deployment with the following security controls:

**Pod-level:**
- `runAsNonRoot: true`
- `seccompProfile: RuntimeDefault`

**Container-level:**
- `runAsNonRoot: true`
- `runAsUser: 1000`
- `readOnlyRootFilesystem: true`
- `allowPrivilegeEscalation: false`
- `capabilities.drop: ["ALL"]`

The operator itself runs as UID 65532 (distroless nonroot).

### HTTP Server Hardening

- `ReadHeaderTimeout: 10s` -- mitigates Slowloris attacks
- `ReadTimeout: 30s` -- bounds total request read time
- `IdleTimeout: 120s` -- reclaims idle connections
- `WriteTimeout` is intentionally omitted because SSE streams are long-lived

### Input Validation

- Certificate name: max 253 characters (Kubernetes DNS subdomain limit)
- Namespace: max 63 characters (Kubernetes label value limit)
- Context deadline: 90 seconds per renewal operation

---

## Testing

### Running Tests

```bash
# All tests (via the deployment script)
bash scripts/cert-dashboard-up.sh --test-only

# Or manually:
cd cert-dashboard-operator

# Webhook validation tests (9 tests)
go test ./internal/webhook/ -v -count=1

# Dashboard handler + cert_watcher tests (18 tests)
go test ./internal/dashboard/ -v -count=1

# Controller integration tests via envtest (8 tests)
make test

# E2E tests (requires deployed operator)
make test-e2e
```

### Test Breakdown

| Package | Framework | Test Count | Description |
|---------|-----------|-----------|-------------|
| `internal/controller` | Ginkgo/Gomega + envtest | 8 | Reconciliation, RBAC, finalizers, status conditions, requeue behavior |
| `internal/dashboard` (handlers) | Go stdlib `testing` | 11 | HTTP handlers: certs list, renewal, SSE, healthz, index, input validation |
| `internal/dashboard` (cert_watcher) | Go stdlib `testing` | 7 | Certificate parsing: full spec, minimal spec, edge cases, revision types |
| `internal/webhook` | Go stdlib `testing` | 9 | Validation: thresholds, image, replicas, nodePort, create/update/delete |
| `test/e2e` | Ginkgo/Gomega | E2E suite | Full operator lifecycle: deploy, reconcile, metrics |

The `CertProvider` interface enables handler tests to use a `mockProvider` without requiring a live Kubernetes cluster. Controller tests use envtest (API server + etcd, no kubelet).

---

## Configuration

The dashboard server reads configuration from environment variables. The operator sets these automatically from the CertDashboard CR spec.

| Environment Variable | Default | Maps to CR Field |
|---------------------|---------|-----------------|
| `DASHBOARD_PORT` | `8080` | (internal, always 8080) |
| `NAMESPACES` | `""` (all) | `spec.namespaces` (comma-separated) |
| `YELLOW_THRESHOLD_DAYS` | `10` | `spec.yellowThresholdDays` |
| `RED_THRESHOLD_DAYS` | `5` | `spec.redThresholdDays` |

---

## Deployment Options

### kind (Local Development)

This is the primary deployment target. The bookstore kind cluster must be running.

```bash
# Ensure bookstore cluster is up
bash scripts/up.sh

# Deploy the operator
bash scripts/cert-dashboard-up.sh
```

The kind cluster must have port 32600 in its `extraPortMappings` for the dashboard NodePort to be accessible at `http://localhost:32600`.

### kubeadm / Self-Managed Clusters

```bash
# Install CRD
kubectl apply -f cert-dashboard-operator/config/crd/bases/

# Deploy operator (adjust image registry as needed)
make deploy IMG=your-registry/cert-dashboard-operator:latest

# Create a CertDashboard CR
kubectl apply -f infra/cert-dashboard/certdashboard-cr.yaml
```

### EKS / AKS / GKE

The operator works on managed Kubernetes services. Key considerations:

- Replace `NodePort` with `LoadBalancer` or use an Ingress controller for external access.
- Ensure cert-manager is installed and CRDs are available.
- Push the operator image to a container registry accessible by the cluster (ECR, ACR, GCR).
- The operator ServiceAccount needs RBAC for cert-manager CRDs and Secrets.

---

## OLM (Operator Lifecycle Manager)

An OLM bundle is included for distribution via the Operator Lifecycle Manager.

### Generate the Bundle

```bash
cd cert-dashboard-operator
make bundle IMG=your-registry/cert-dashboard-operator:v0.0.1
```

### Build and Push Bundle Image

```bash
make bundle-build bundle-push BUNDLE_IMG=your-registry/cert-dashboard-operator-bundle:v0.0.1
```

### Install via OLM

```bash
operator-sdk olm install               # if OLM is not yet installed
operator-sdk run bundle your-registry/cert-dashboard-operator-bundle:v0.0.1
```

The `scripts/cert-dashboard-up.sh` script handles OLM installation automatically when deploying to the bookstore kind cluster.

---

## Operator Capability Level

The operator follows the [Operator Framework Capability Model](https://sdk.operatorframework.io/docs/overview/#operator-capability-level):

| Level | Name | Status | Description |
|-------|------|--------|-------------|
| 1 | Basic Install | Achieved | Automated deployment via CR. Operator manages Deployment, Service, RBAC. |
| 2 | Seamless Upgrades | Achieved | `CreateOrUpdate` reconciliation handles spec changes. OLM bundle for versioned upgrades. |
| 3 | Full Lifecycle | Achieved | Finalizers for cleanup. Validation webhook. Status conditions with ObservedGeneration. Health probes. Requeue on not-ready. |
| 4 | Deep Insights | Partial | Prometheus metrics for certificate health and renewal operations. Web UI for visualization. Alerting rules not yet defined. |
| 5 | Auto Pilot | Not yet | Auto-renewal based on threshold policies and predictive expiry detection are not implemented. |

**Current level: 3 (Full Lifecycle)** with partial Level 4 coverage.

---

## Contributing

1. Fork the repository.
2. Create a feature branch from `main`.
3. Ensure all tests pass: `bash scripts/cert-dashboard-up.sh --test-only`
4. Run `make manifests generate` to regenerate CRD and RBAC manifests if types changed.
5. Submit a pull request.

Key development commands:

```bash
cd cert-dashboard-operator

make manifests        # Regenerate CRD and RBAC YAML from Go markers
make generate         # Run controller-gen for DeepCopy methods
make test             # Run all tests (envtest for controller, stdlib for dashboard/webhook)
make build            # Build manager and dashboard binaries
make docker-build     # Build Docker image
make install          # Install CRDs into the current cluster
make deploy           # Deploy operator to the current cluster
make undeploy         # Remove operator from the current cluster
make uninstall        # Remove CRDs from the current cluster
```

---

## License

Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
