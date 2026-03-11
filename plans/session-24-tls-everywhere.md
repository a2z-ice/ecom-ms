# Session 24 — TLS Everywhere with cert-manager Auto-Rotation

## Goal

Enable HTTPS on all external-facing endpoints using self-signed certificates managed by cert-manager, with automatic 30-day rotation. TLS terminates at the Istio Gateway.

## Status: COMPLETE

## Deliverables

| # | Deliverable | Status |
|---|---|---|
| 1 | cert-manager v1.17.2 install script | Done |
| 2 | Self-signed CA + ClusterIssuer chain | Done |
| 3 | Multi-SAN gateway certificate (4 hosts + IP) | Done |
| 4 | Gateway HTTPS listener + HTTP→HTTPS redirect | Done |
| 5 | Keycloak issuer URL updated to https:// | Done |
| 6 | Service secrets updated (KEYCLOAK_ISSUER_URI) | Done |
| 7 | Istio RequestAuthentication issuer updated | Done |
| 8 | UI CSP + AuthContext fallback updated | Done |
| 9 | UI build args updated (VITE_ vars) | Done |
| 10 | Smoke test + verify-routes updated with -k | Done |
| 11 | E2E tests updated (https:// + ignoreHTTPSErrors) | Done |
| 12 | CA trust script (scripts/trust-ca.sh) | Done |
| 13 | Documentation (tls-setup.md, tls-manual-testing.md) | Done |
| 14 | Skills updated (status, smoke) | Done |

## Key Design Decisions

- **Port 30000 stays** — serves HTTPS instead of HTTP (no new port)
- **Tool NodePorts stay HTTP** — Superset/Grafana/Flink/Debezium/PgAdmin/Kiali
- **Single multi-SAN cert** — one Certificate covers myecom.net, api.service.net, idp.keycloak.net, localhost, 127.0.0.1
- **HTTP→HTTPS redirect** — port 30080 (HTTP) redirects to port 30000 (HTTPS) via HTTPRoute
- **Port 30080 for HTTP** — new kind port mapping for the redirect listener
- **CA trust prompt** — `trust-ca.sh --install` runs during bootstrap, prompts for sudo
- **`curl -k`** — scripts use insecure flag for self-signed certs
- **`ignoreHTTPSErrors: true`** — Playwright config for E2E tests
- **Requires `--fresh`** — Keycloak issuer change invalidates all tokens

## Files Created

- `infra/cert-manager/install.sh`
- `infra/cert-manager/ca-issuer.yaml`
- `infra/cert-manager/gateway-certificate.yaml`
- `infra/cert-manager/rotation-config.yaml`
- `infra/kgateway/routes/https-redirect.yaml`
- `scripts/trust-ca.sh` (with `--install` and `--yes` flags)
- `e2e/tls-cert-manager.spec.ts` (cert-manager + rotation E2E tests)
- `docs/guides/tls-setup.md`
- `docs/guides/tls-manual-testing.md`
- `plans/session-24-tls-everywhere.md`

## Files Modified

- `infra/kgateway/gateway.yaml` — HTTPS listener + HTTP listener
- `infra/kgateway/routes/ui-route.yaml` — sectionName: https
- `infra/kgateway/routes/ecom-route.yaml` — sectionName: https
- `infra/kgateway/routes/keycloak-route.yaml` — sectionName: https
- `infra/kgateway/routes/inven-route.yaml` — sectionName: https
- `infra/keycloak/keycloak.yaml` — KC_HOSTNAME_SCHEME=https
- `infra/keycloak/realm-export.json` — https:// redirect URIs + web origins
- `infra/istio/security/request-auth.yaml` — https:// issuer
- `ecom-service/k8s/ecom-service.yaml` — https:// KEYCLOAK_ISSUER_URI
- `inventory-service/k8s/inventory-service.yaml` — https:// KEYCLOAK_ISSUER_URI
- `ui/k8s/ui-service.yaml` — https:// in CSP header
- `ui/src/auth/AuthContext.tsx` — https:// fallback URL
- `infra/kind/cluster.yaml` — added port 30080 for HTTP→HTTPS redirect
- `scripts/up.sh` — cert-manager step, HTTPS+HTTP NodePort patch, VITE build args, CA trust prompt
- `scripts/smoke-test.sh` — https:// URLs, -k flag, TLS cert check, HTTP→HTTPS redirect test
- `scripts/verify-routes.sh` — https:// URLs, -k flag, redirect at port 30080
- `e2e/playwright.config.ts` — https:// baseURL, ignoreHTTPSErrors
- `e2e/*.spec.ts` (14 files) — http:// → https:// for gateway URLs
- `.gitignore` — certs/ directory
- `.claude/skills/status/SKILL.md` — https:// URLs
- `.claude/skills/smoke/SKILL.md` — note about -k flag

## Acceptance Criteria

1. `curl -k https://api.service.net:30000/ecom/books` → 200
2. `curl -k https://myecom.net:30000/` → 200
3. `curl -k https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration` → 200 with https:// issuer
4. `curl http://myecom.net:30080/` → 301 redirect to https://:30000
5. `bash scripts/smoke-test.sh` → all passed
6. `cd e2e && npm run test` → all passed
7. `kubectl get certificate -n infra bookstore-gateway-cert` → Ready=True
8. `kubectl get certificate -n cert-manager bookstore-ca` → Ready=True

## Build & Deploy

```bash
# Full rebuild required (Keycloak issuer URL change)
bash scripts/up.sh --fresh --yes
```
