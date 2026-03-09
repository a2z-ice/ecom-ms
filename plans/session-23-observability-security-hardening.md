# Session 23 — Observability Security Hardening

## Goal

Harden the security posture of the observability stack (otel + observability namespaces) without breaking existing functionality. Close the gaps where a compromised OTel/Grafana/Loki/Tempo pod could pivot to other services or intercept unencrypted traffic.

## Context

The observability stack was deployed with PERMISSIVE mTLS and no NetworkPolicies in the otel namespace. While the `ambient.istio.io/redirection: disabled` annotations on OTel Collector, Loki, and Tempo mean Istio mTLS doesn't apply to those pods (they bypass ztunnel), the **lack of NetworkPolicies** is the primary security gap — any pod in any namespace can reach any port in the otel namespace.

## Deliverables

| # | Deliverable | File(s) | Status |
|---|------------|---------|--------|
| 1 | Create otel namespace NetworkPolicy (default deny + explicit allow) | `infra/kubernetes/network-policies/otel-netpol.yaml` (NEW) | DONE |
| 2 | Tighten observability namespace NetworkPolicies | `infra/kubernetes/network-policies/observability-netpol.yaml` | DONE |
| 3 | Add AuthorizationPolicies for otel + observability namespaces | `infra/istio/security/authz-policies/otel-policy.yaml` (NEW), `observability-policy.yaml` (NEW) | DONE |
| 4 | Change namespace-wide PERMISSIVE to STRICT where possible | `infra/istio/security/peer-auth.yaml` | DONE (observability→STRICT; otel must stay PERMISSIVE) |
| 5 | Fix Loki and Tempo to run as non-root | `infra/observability/loki/loki.yaml`, `infra/observability/tempo/tempo.yaml` | DONE |
| 6 | Add missing ecom-service egress to OTel Collector | `infra/kubernetes/network-policies/ecom-netpol.yaml` | DONE |
| 7 | Update docs with security hardening notes | `docs/guides/observability-issues-and-fixes.md` | DONE |

## Security Model After Hardening

### otel namespace (OTel Collector, Loki, Tempo)

**NetworkPolicy (primary defense — pods are excluded from mesh):**
- Default deny all ingress/egress
- OTel Collector: ingress from ecom + inventory (4317/4318), egress to Loki (3100) + Tempo (4318) + Prometheus exporter (8889)
- Loki: ingress from OTel Collector only (3100), ingress from Grafana (3100)
- Tempo: ingress from OTel Collector only (4317/4318), ingress from Grafana (3200)
- All: DNS egress (53/UDP)

**PeerAuthentication:** STRICT (no effect on pods with `ambient.istio.io/redirection: disabled`, but prevents future pods without the annotation from accepting plaintext)

**AuthorizationPolicy:** Defense-in-depth (won't apply to annotated pods, but protects any future mesh-enrolled pods)

### observability namespace (Prometheus, Grafana, kube-state-metrics)

**NetworkPolicy:**
- Prometheus: ingress only from istio-system (Kiali) + grafana (queries) + HBONE
- Grafana: ingress only from host NodePort (all sources on port 3000) + HBONE
- kube-state-metrics: ingress only from Prometheus (8080/8081)
- Prometheus egress: to all namespaces for scraping (required)

**PeerAuthentication:** STRICT namespace-wide + port-level PERMISSIVE for Grafana NodePort (already exists)

**AuthorizationPolicy:** Allow specific namespaces only

## Acceptance Criteria

1. All 11+ Prometheus scrape targets remain UP
2. Grafana dashboards still show data (all 4 dashboards)
3. Loki still receives logs from both services
4. Tempo still receives traces
5. E2E tests pass: `npx playwright test otel-loki.spec.ts` — 43/43
6. No pod in non-authorized namespaces can reach otel components
7. Loki and Tempo run as non-root (runAsUser: 10001)

## Build & Deploy

```bash
# Apply all security changes
kubectl apply -f infra/kubernetes/network-policies/otel-netpol.yaml
kubectl apply -f infra/kubernetes/network-policies/observability-netpol.yaml
kubectl apply -f infra/kubernetes/network-policies/ecom-netpol.yaml
kubectl apply -f infra/istio/security/authz-policies/otel-policy.yaml
kubectl apply -f infra/istio/security/authz-policies/observability-policy.yaml
kubectl apply -f infra/istio/security/peer-auth.yaml
kubectl apply -f infra/observability/loki/loki.yaml
kubectl apply -f infra/observability/tempo/tempo.yaml

# Restart affected pods
kubectl rollout restart deployment loki -n otel
kubectl rollout restart deployment tempo -n otel

# Verify
cd e2e && npx playwright test otel-loki.spec.ts --reporter=list
```
