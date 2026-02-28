# Session 10 — Istio Security Hardening

**Goal:** Zero-trust enforcement: strict mTLS, JWT validation at mesh level, and fine-grained authorization policies.

## Deliverables

- `infra/istio/security/peer-auth.yaml` — `PeerAuthentication` STRICT mTLS for all app namespaces
- `infra/istio/security/request-auth.yaml` — `RequestAuthentication` pointing to Keycloak JWKS for `ecom` and `inventory` namespaces
- `infra/istio/security/authz-policies/` — `AuthorizationPolicy` per service:
  - `ecom-service-policy.yaml`
  - `inventory-service-policy.yaml`
  - DB-level policies per service namespace
- `infra/kubernetes/network-policies/` — `NetworkPolicy` per namespace (deny-all + explicit allow)
- `infra/kubernetes/pod-security/` — `PodSecurity` admission labels on each namespace

## Istio Ambient mTLS — L4 Only (Critical)

ztunnel (Istio Ambient without waypoint proxy) enforces **L4 only**. L7 attributes (methods, paths, `requestPrincipals`) in `AuthorizationPolicy` are silently omitted → implicit deny-all. Use only: `namespaces`, `principals`, `notNamespaces`, `notPrincipals`.

**Policy layering order (per namespace):**
1. `PeerAuthentication` — `mtls.mode: STRICT` (namespace-wide)
2. `RequestAuthentication` — Keycloak JWKS for JWT validation
3. `AuthorizationPolicy` — explicit allow rules; default deny-all implied

## Network Policy Notes

- HBONE port 15008 required in NetworkPolicies: Istio Ambient ztunnel uses this port for inter-node mTLS tunneling
- Gateway pod is in `infra` namespace (not `kgateway-system`) — NetworkPolicy and AuthorizationPolicy must allow from `infra` namespace
- `ui-service` nginx proxies `/ecom/*` and `/inven/*` — both service NetworkPolicies must allow ingress from `ecom` namespace (where ui-service lives)

## Acceptance Criteria

- [x] Traffic between services encrypted via Istio mTLS
- [x] Cross-namespace calls without valid mTLS rejected
- [x] DB pods accessible only from their owning namespace
- [x] PodSecurity violations fail admission

## Status: Complete ✓
