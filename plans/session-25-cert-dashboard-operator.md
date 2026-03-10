# Session 25 — Cert Dashboard Kubernetes Operator

## Goal

Create a Go-based Kubernetes operator (OLM-compatible) that deploys a web dashboard for monitoring and renewing cert-manager certificates. The dashboard shows certificate info with expiry progress bars (green/yellow/red), a renewal button with confirmation modal, and SSE-based live streaming of the renewal process.

## Status: COMPLETE

## Deliverables

| # | Deliverable | Status |
|---|---|---|
| 1 | Go-based Kubernetes operator (operator-sdk) | Done |
| 2 | CertDashboard CRD (v1alpha1) | Done |
| 3 | Go web dashboard with embedded HTML/CSS/JS | Done |
| 4 | Certificate info display (issuer, SANs, algorithm, serial, expiry) | Done |
| 5 | Progress bar (green > 10d, yellow ≤ 10d, red ≤ 5d) | Done |
| 6 | Renew button with confirmation modal | Done |
| 7 | SSE live streaming for renewal status | Done |
| 8 | OLM bundle + OLM installation | Done |
| 9 | NodePort 32600 with kind hostPort mapping | Done |
| 10 | Deployment script (scripts/cert-dashboard-up.sh) | Done |
| 11 | Istio PeerAuthentication for NodePort | Done |
| 12 | E2E tests (cert-dashboard.spec.ts) | Done |
| 13 | kind cluster.yaml updated with port 32600 | Done |
| 14 | Validation webhook (CertDashboardValidator) | Done |
| 15 | Kubernetes TokenReview auth middleware | Done |
| 16 | Prometheus custom metrics (5 cert_dashboard_* metrics) | Done |
| 17 | Rate limiter (1 renewal per 10s globally) | Done |
| 18 | Pod security hardening (seccomp, capabilities drop ALL) | Done |
| 19 | CertProvider interface for testability | Done |
| 20 | 44 Go tests (controller 8, handlers 11, cert_watcher 7, webhook 9) | Done |
| 21 | scripts/cert-dashboard-up.sh rewritten (test → build → deploy → verify) | Done |

## Key Design Decisions

- **Single Docker image**: Both operator and dashboard binaries in one image, different entrypoints (`/manager` vs `/dashboard`)
- **Operator deploys dashboard**: CertDashboard CR triggers creation of Deployment + Service + RBAC
- **Renewal via secret deletion**: Deleting the TLS secret triggers cert-manager re-issuance (proven pattern)
- **SSE over WebSocket**: Simpler, unidirectional, sufficient for status streaming
- **OLM for production-grade lifecycle**: Operator Lifecycle Manager handles operator installation and upgrades
- **NodePort 32600**: Next available after 32500 (Grafana)
- **15s polling interval**: Dashboard refreshes certificate data every 15s from the Kubernetes API

## Architecture

```
CertDashboard CR → Operator (controller-runtime) → creates:
  ├── ServiceAccount + ClusterRole/Binding
  ├── Deployment (dashboard binary, port 8080)
  └── Service (NodePort 32600)

Dashboard watches: cert-manager Certificates + K8s Secrets
Dashboard exposes: GET /api/certs, POST /api/renew, GET /api/sse/{id}
```

## Files Created

- `cert-dashboard-operator/` — Full operator-sdk project
  - `api/v1alpha1/certdashboard_types.go` — CRD types
  - `internal/controller/certdashboard_controller.go` — Reconciler
  - `internal/dashboard/server.go` — HTTP server
  - `internal/dashboard/handlers.go` — API handlers (certs, renew, SSE)
  - `internal/dashboard/cert_watcher.go` — Certificate watcher
  - `internal/dashboard/templates/` — Embedded HTML/CSS/JS
  - `cmd/dashboard/main.go` — Dashboard entrypoint
  - `config/` — CRD, RBAC, manager manifests
  - `bundle/` — OLM bundle
- `infra/cert-dashboard/namespace.yaml`
- `infra/cert-dashboard/certdashboard-cr.yaml`
- `infra/cert-dashboard/peer-auth.yaml`
- `scripts/cert-dashboard-up.sh`
- `e2e/cert-dashboard.spec.ts`

## Files Modified

- `infra/kind/cluster.yaml` — Added port 32600 to extraPortMappings

## Post-Review Enterprise Hardening

### New Files Created
- `internal/dashboard/auth.go` — Kubernetes TokenReview auth middleware + rate limiter
- `internal/dashboard/metrics.go` — 5 Prometheus custom metrics + UpdateCertMetrics()
- `internal/webhook/certdashboard_webhook.go` — CRD validation webhook
- `internal/webhook/certdashboard_webhook_test.go` — 9 webhook tests
- `internal/dashboard/cert_watcher_test.go` — 7 cert watcher tests
- `internal/dashboard/handlers_test.go` — 11 handler tests (was 0)

### Files Modified
- `internal/controller/certdashboard_controller.go` — Pod seccomp profile, capabilities drop ALL, ObservedGeneration, RequeueAfter 10s
- `internal/controller/certdashboard_controller_test.go` — Rewritten: 8 comprehensive tests (was 1 stub)
- `internal/dashboard/server.go` — CertProvider interface (was *CertWatcher), NewServerWithProvider(), HTTP timeouts, /metrics endpoint, requireAuth on POST /api/renew
- `internal/dashboard/handlers.go` — Input validation (253/63 char limits), context deadline (90s), rate limiter, s.streams moved to Server struct
- `internal/dashboard/cert_watcher.go` — CertProvider interface, safe type assertions (panic fix), nil guard in enrichFromSecret, public Refresh(), UpdateCertMetrics() call
- `config/manifests/bases/cert-dashboard-operator.clusterserviceversion.yaml` — Real description, icon, installModes, keywords, maturity
- `scripts/cert-dashboard-up.sh` — Complete pipeline: test → build → deploy → verify (8 checks)

### Test Coverage Summary
- Controller: 8 tests (envtest integration)
- Handlers: 11 tests (HTTP unit)
- CertWatcher: 7 tests (parsing unit)
- Webhook: 9 tests (validation unit)
- E2E: 29 tests (Playwright)
- Total: 64 tests

## Build & Deploy

```bash
# Deploy cert-dashboard operator (builds images, installs OLM, deploys everything)
bash scripts/cert-dashboard-up.sh

# Requires --fresh for port 32600 to be available
bash scripts/up.sh --fresh --yes
bash scripts/cert-dashboard-up.sh

# Run E2E tests
cd e2e && npm run test -- --grep "cert-dashboard"
```

## Acceptance Criteria

1. `kubectl get crd certdashboards.certs.bookstore.io` — CRD exists
2. `kubectl get certdashboard -n cert-dashboard` — CR is Ready=true
3. `curl http://localhost:32600/healthz` → `{"status":"ok"}`
4. `curl http://localhost:32600/api/certs` → JSON array with bookstore-gateway-cert and bookstore-ca
5. Browser: http://localhost:32600 → Dashboard loads with certificate cards
6. Progress bars show green for fresh certs (>10 days)
7. Click "Renew" → modal appears → confirm → SSE streams live status → cert renewed
8. `cd e2e && npm run test -- --grep "cert-dashboard"` → all pass
