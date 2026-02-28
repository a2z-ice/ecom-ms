# Session 03 — Keycloak Identity Provider

**Goal:** Keycloak running and fully configured: realm, clients, roles, and test users ready.

## Deliverables

- `infra/keycloak/` — Keycloak 26.5.4 Deployment + Service (namespace: `identity`)
- `infra/keycloak/realm-export.json` — Keycloak realm export containing:
  - Realm: `bookstore`
  - Clients:
    - `ui-client` — public, Authorization Code + PKCE, redirect URIs for `myecom.net`
    - `ecom-service` — confidential (for service-to-service token introspection if needed)
    - `inventory-service` — confidential
  - Roles: `customer`, `admin`
  - Test users: `user1` (customer), `admin1` (admin)
- `infra/keycloak/import-job.yaml` — Kubernetes Job to import realm on first boot
- `infra/kgateway/routes/keycloak-route.yaml` — HTTPRoute: `idp.keycloak.net:30000` → Keycloak service

## Import Process

The import job does NOT contain a ConfigMap definition — the ConfigMap is managed by `scripts/keycloak-import.sh` which patches it from `realm-export.json`.

**Always use the script, never `kubectl apply -f import-job.yaml` alone:**
```bash
bash scripts/keycloak-import.sh
```

The Keycloak 26.5.4 image has neither `curl` nor `wget`. Health check uses bash built-in `/dev/tcp`:
```bash
until (bash -c ">/dev/tcp/keycloak.identity.svc.cluster.local/8080" 2>/dev/null); do
  sleep 5
done
```

## Acceptance Criteria

- [x] `http://idp.keycloak.net:30000` reachable from host (NodePort, no port-forward)
- [x] Bookstore realm visible in Keycloak admin console
- [x] OIDC discovery endpoint responds: `http://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration`
- [x] `user1` can obtain a token via password grant

## Status: Complete ✓
