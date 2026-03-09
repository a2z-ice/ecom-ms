# Infrastructure Portability Plan: kind to Managed Kubernetes

**Date**: 2026-03-08
**Scope**: Make the current kind-based deployment portable to ANY managed Kubernetes service (EKS, AKS, GKE) with minimal configuration changes.
**Approach**: Abstract away kind-specific elements. Do NOT build cloud-specific solutions. Create a single portable codebase with environment-specific overlays.

---

## Table of Contents

1. [Current Kind-Specific Inventory](#1-current-kind-specific-inventory)
2. [Storage Portability](#2-storage-portability)
3. [Networking Portability](#3-networking-portability)
4. [Image Management](#4-image-management)
5. [Secret Management](#5-secret-management)
6. [Configuration Management](#6-configuration-management)
7. [Database Portability](#7-database-portability)
8. [Messaging Portability](#8-messaging-portability)
9. [Observability Portability](#9-observability-portability)
10. [Identity Portability](#10-identity-portability)
11. [Recommended Kustomize Structure](#11-recommended-kustomize-structure)
12. [Migration Checklist](#12-migration-checklist)
13. [Script Portability](#13-script-portability)

---

## 1. Current Kind-Specific Inventory

### 1.1 hostPath Volumes and Local Storage

**Files affected:**
- `infra/storage/storageclass.yaml` -- `provisioner: kubernetes.io/no-provisioner` (manual, local-only)
- `infra/storage/persistent-volumes.yaml` -- 8 PV definitions using `hostPath` (ecom-db, inventory-db, analytics-db, keycloak-db, superset, kafka, redis, flink)
- `infra/kind/cluster.yaml` -- `extraMounts` mapping host `DATA_DIR/*` to `/data/*` on all 3 nodes

**All PVCs explicitly bind to named PVs via `volumeName`:**
- `infra/postgres/ecom-db.yaml` -- `volumeName: ecom-db-pv`, `storageClassName: local-hostpath`
- `infra/postgres/inventory-db.yaml` -- `volumeName: inventory-db-pv`, `storageClassName: local-hostpath`
- `infra/postgres/analytics-db.yaml` -- `volumeName: analytics-db-pv`, `storageClassName: local-hostpath`
- `infra/keycloak/keycloak.yaml` -- `volumeName: keycloak-db-pv`, `storageClassName: local-hostpath`
- `infra/redis/redis.yaml` -- `volumeName: redis-pv`, `storageClassName: local-hostpath`
- `infra/kafka/kafka.yaml` -- `volumeName: kafka-pv`, `storageClassName: local-hostpath`
- `infra/superset/superset.yaml` -- `volumeName: superset-pv`, `storageClassName: local-hostpath`
- `infra/flink/flink-pvc.yaml` -- `volumeName: flink-pv`, `storageClassName: local-hostpath`

### 1.2 NodePort Exposure Patterns

**7 NodePort services (kind-only, not portable):**

| Service | NodePort | File |
|---------|----------|------|
| Flink Dashboard | 32200 | `infra/flink/flink-cluster.yaml` |
| Debezium ecom | 32300 | `infra/debezium/debezium-server-ecom.yaml` |
| Debezium inventory | 32301 | `infra/debezium/debezium-server-inventory.yaml` |
| Superset | 32000 | `infra/superset/superset.yaml` |
| PgAdmin | 31111 | `infra/pgadmin/pgadmin.yaml` |
| Kiali | 32100 | `infra/observability/kiali/kiali-nodeport.yaml` |
| Keycloak Admin | 32400 | `infra/keycloak/keycloak-nodeport.yaml` |

**Main gateway patched to NodePort 30000:**
- `scripts/up.sh` line 84: `kubectl patch svc bookstore-gateway-istio -n infra --type='json' -p='[{"op":"replace","path":"/spec/ports/1/nodePort","value":30000}]'`
- `infra/kgateway/gateway.yaml` -- annotation `networking.istio.io/service-type: NodePort`

### 1.3 kind extraPortMappings

**File:** `infra/kind/cluster.yaml` lines 13-37 -- 8 port mappings (30000, 31111, 32000, 32100, 32200, 32300, 32301, 32400) on control-plane node only.

### 1.4 Docker Image Loading

**`kind load docker-image` usage (not portable to any cloud):**
- `scripts/up.sh` lines 228-235 -- loads 4 custom images: `bookstore/ecom-service`, `bookstore/inventory-service`, `bookstore/flink`, `bookstore/ui-service`
- `scripts/cluster-up.sh` -- references `kind create cluster`
- All custom image Deployments use `imagePullPolicy: Never` or `IfNotPresent`

**`imagePullPolicy: Never` (kind-only, must change for cloud):**
- `infra/flink/flink-cluster.yaml` -- both jobmanager and taskmanager containers + sql-gateway sidecar
- `infra/flink/flink-sql-runner.yaml` -- runner job

### 1.5 /etc/hosts DNS Entries

**Required hosts file entries (not portable):**
```
127.0.0.1  idp.keycloak.net  myecom.net  api.service.net
```

**Referenced in (29 files):**
- HTTPRoutes: `ecom-route.yaml` (api.service.net), `ui-route.yaml` (myecom.net, localhost), `keycloak-route.yaml` (idp.keycloak.net), `inven-route.yaml` (api.service.net)
- Keycloak config: `keycloak.yaml` (`KC_HOSTNAME: idp.keycloak.net`, `KC_HOSTNAME_PORT: 30000`)
- Istio RequestAuthentication: `request-auth.yaml` (issuer: `http://idp.keycloak.net:30000/realms/bookstore`)
- Service secrets: `ecom-service-secret` and `inventory-service-secret` (KEYCLOAK_ISSUER_URI base64 = `http://idp.keycloak.net:30000/realms/bookstore`)
- UI build args: `VITE_KEYCLOAK_AUTHORITY=http://idp.keycloak.net:30000/realms/bookstore`
- UI nginx CSP header: `ui-service.yaml` (`connect-src 'self' http://api.service.net:30000 http://idp.keycloak.net:30000`)
- Realm export: `realm-export.json` (redirectUris: `http://myecom.net:30000/*`, `http://localhost:30000/*`)
- All smoke/verify scripts, E2E tests, auth fixtures

### 1.6 Hardcoded Ports

**Port 30000 embedded in:**
- Keycloak: `KC_HOSTNAME_PORT: "30000"` in `keycloak.yaml`
- OIDC issuer URIs in secrets (`:30000`)
- UI build args
- E2E config: `baseURL: 'http://localhost:30000'`
- Realm export redirectUris

### 1.7 kind-Specific PeerAuthentication (PERMISSIVE workaround)

**7 `portLevelMtls: PERMISSIVE` entries in `infra/istio/security/peer-auth.yaml`:**

These exist solely because kind NodePort sends plaintext traffic from host to pod, bypassing Istio mTLS. On a cloud cluster with LoadBalancer or Ingress, all external traffic enters through the Istio Gateway (which terminates TLS), so these PERMISSIVE overrides are unnecessary and should be removed.

| Policy | Port | Reason |
|--------|------|--------|
| `superset-nodeport-permissive` | 8088 | Superset NodePort |
| `flink-nodeport-permissive` | 8081 | Flink Dashboard NodePort |
| `keycloak-nodeport-permissive` | 8080 | Keycloak admin NodePort |
| `debezium-ecom-nodeport-permissive` | 8080 | Debezium health NodePort |
| `debezium-inventory-nodeport-permissive` | 8080 | Debezium health NodePort |
| `pgadmin-nodeport-permissive` | 80 | PgAdmin NodePort |

### 1.8 kind-Specific Networking

- `infra/kind/cluster.yaml` -- `networking.disableDefaultCNI: false` (kindnet)
- `scripts/up.sh` -- `kind get clusters`, `kubectl config use-context kind-bookstore`
- `scripts/infra-up.sh` line 16 -- context check: `grep -q "kind-bookstore"`
- `scripts/cluster-up.sh` -- entire file is kind-specific

### 1.9 DATA_DIR Substitution

- `infra/kind/cluster.yaml` uses `DATA_DIR` placeholder, replaced by `sed` at runtime
- `scripts/up.sh` line 65: `sed "s|DATA_DIR|${DATA_DIR}|g"`
- `scripts/cluster-up.sh` line 40: same pattern

---

## 2. Storage Portability

### Current State
- Manual `StorageClass` (`local-hostpath`) with `provisioner: kubernetes.io/no-provisioner`
- 8 manually-defined `PersistentVolume` objects with `hostPath` mounts
- 8 PVCs explicitly bound to named PVs via `volumeName`
- kind `extraMounts` to map host directories into nodes

### Target State
- Remove ALL PersistentVolume definitions (cloud provisioners create PVs automatically)
- Remove `volumeName` from ALL PVCs (let dynamic provisioning bind automatically)
- Remove `storageClassName: local-hostpath` from PVCs; use the cluster default StorageClass or a variable
- StorageClass becomes an overlay concern: kind uses `local-hostpath`, cloud uses `gp3`/`managed-premium`/`standard-rwo`

### Changes Required

**Files to modify (remove `volumeName` and `storageClassName`):**

| File | PVC | Current `volumeName` | Current `storageClassName` |
|------|-----|---------------------|---------------------------|
| `infra/postgres/ecom-db.yaml` | `ecom-db-pvc` | `ecom-db-pv` | `local-hostpath` |
| `infra/postgres/inventory-db.yaml` | `inventory-db-pvc` | `inventory-db-pv` | `local-hostpath` |
| `infra/postgres/analytics-db.yaml` | `analytics-db-pvc` | `analytics-db-pv` | `local-hostpath` |
| `infra/keycloak/keycloak.yaml` | `keycloak-db-pvc` | `keycloak-db-pv` | `local-hostpath` |
| `infra/redis/redis.yaml` | `redis-pvc` | `redis-pv` | `local-hostpath` |
| `infra/kafka/kafka.yaml` | `kafka-pvc` | `kafka-pv` | `local-hostpath` |
| `infra/superset/superset.yaml` | `superset-pvc` | `superset-pv` | `local-hostpath` |
| `infra/flink/flink-pvc.yaml` | `flink-checkpoints-pvc` | `flink-pv` | `local-hostpath` |

**Base PVC template (cloud-portable):**
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ecom-db-pvc
  namespace: ecom
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 2Gi
  # storageClassName omitted -- uses cluster default
```

**kind overlay adds back:**
```yaml
# overlays/kind/storage-patch.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ecom-db-pvc
  namespace: ecom
spec:
  storageClassName: local-hostpath
  volumeName: ecom-db-pv
```

**Files to move to kind overlay only:**
- `infra/storage/storageclass.yaml` -- kind-only (cloud clusters have built-in storage classes)
- `infra/storage/persistent-volumes.yaml` -- kind-only (cloud clusters provision PVs dynamically)

### StatefulSet Consideration

Currently all databases are Deployments with replicas=1. This works but is not idiomatic for stateful workloads:
- **Recommended (P2):** Convert PostgreSQL Deployments to StatefulSets with `volumeClaimTemplates`. This eliminates the need for separate PVC manifests entirely and provides stable network identities.
- **Current approach works** for single-replica databases; prioritize other changes first.

### Backup/Restore Strategy (P2)

- Add `VolumeSnapshot` CRDs for point-in-time database backups (supported by all major cloud providers)
- Consider Velero for cross-cluster backup/restore
- For managed databases (RDS/Cloud SQL), use the provider built-in backup

| Item | Effort | Priority |
|------|--------|----------|
| Remove `volumeName` from all 8 PVCs | S | P0 |
| Move `storageClassName` to overlay | S | P0 |
| Move PV definitions + StorageClass to kind overlay | S | P0 |
| Convert DBs to StatefulSets | M | P2 |
| Add VolumeSnapshot support | M | P2 |

---

## 3. Networking Portability

### 3.1 Replace NodePort with LoadBalancer/Ingress

**Current State:** All external access through kind NodePort + extraPortMappings.

**Target State:**
- **Main Gateway:** Change from NodePort to LoadBalancer (one-line annotation change). The Gateway API manifest (`infra/kgateway/gateway.yaml`) already uses `gatewayClassName: istio` which is cloud-portable. Just remove the NodePort annotation:
  ```yaml
  # REMOVE this line from gateway.yaml:
  networking.istio.io/service-type: NodePort
  # Istio defaults to LoadBalancer in cloud environments
  ```
- **Dev/internal tools (PgAdmin, Superset, Flink, Kiali, Debezium):** Route through the gateway via HTTPRoutes (add new routes), OR keep as ClusterIP and access via `kubectl port-forward` in cloud. Remove all 7 NodePort Service definitions.
- **Keycloak admin:** Access through the main gateway (already works via `idp.keycloak.net:30000/admin`). Remove dedicated NodePort.

**Files to modify:**

| File | Change | Overlay |
|------|--------|---------|
| `infra/kgateway/gateway.yaml` | Remove `networking.istio.io/service-type: NodePort` annotation from base | kind overlay adds it back |
| `infra/flink/flink-cluster.yaml` | Remove NodePort Service (lines 196-213) | kind overlay adds it |
| `infra/debezium/debezium-server-ecom.yaml` | Remove NodePort Service (lines 143-160) | kind overlay adds it |
| `infra/debezium/debezium-server-inventory.yaml` | Remove NodePort Service | kind overlay adds it |
| `infra/superset/superset.yaml` | Remove NodePort Service | kind overlay adds it |
| `infra/pgadmin/pgadmin.yaml` | Remove NodePort Service | kind overlay adds it |
| `infra/observability/kiali/kiali-nodeport.yaml` | Move entire file to kind overlay | kind overlay only |
| `infra/keycloak/keycloak-nodeport.yaml` | Move entire file to kind overlay | kind overlay only |
| `scripts/up.sh` | Remove NodePort 30000 patch logic | kind-only script |

### 3.2 DNS Strategy

**Current State:** Fake domains (`idp.keycloak.net`, `myecom.net`, `api.service.net`) resolved via `/etc/hosts` to `127.0.0.1`.

**Target State:** Real DNS records pointing to the cloud LoadBalancer IP.

**Two approaches:**

1. **ExternalDNS (recommended for cloud):** Auto-creates DNS records from Gateway/Service annotations. Add ExternalDNS as an overlay addon.
2. **Manual DNS:** Create A/CNAME records after deploy, pointing to the LoadBalancer external IP.

**The domain names themselves are portable** -- `myecom.net`, `api.service.net`, `idp.keycloak.net` work in cloud as real DNS entries. The only change needed is resolving them to the LoadBalancer IP instead of 127.0.0.1.

**Configuration points that embed domain names (must be parameterized):**

| Location | Current Value | Parameterization |
|----------|--------------|------------------|
| `keycloak.yaml` `KC_HOSTNAME` | `idp.keycloak.net` | ConfigMap/env overlay |
| `keycloak.yaml` `KC_HOSTNAME_PORT` | `30000` | Remove for cloud (default 443/80) |
| `request-auth.yaml` issuer | `http://idp.keycloak.net:30000/...` | Kustomize patch |
| `ecom-service-secret` KEYCLOAK_ISSUER_URI | `http://idp.keycloak.net:30000/...` | Secret overlay |
| `inventory-service-secret` KEYCLOAK_ISSUER_URI | `http://idp.keycloak.net:30000/...` | Secret overlay |
| UI build args `VITE_KEYCLOAK_AUTHORITY` | `http://idp.keycloak.net:30000/...` | Build-time var |
| `ui-service.yaml` CSP header | `http://api.service.net:30000 http://idp.keycloak.net:30000` | ConfigMap overlay |
| `realm-export.json` redirectUris | `http://myecom.net:30000/*`, `http://localhost:30000/*` | Separate realm file per env |

### 3.3 TLS/Certificate Management

**Current State:** All traffic is plaintext HTTP (acceptable for local dev).

**Target State:** TLS termination at the Gateway.

**Recommended approach:**
1. Install cert-manager (cloud-agnostic)
2. Add TLS listener to the Gateway:
   ```yaml
   listeners:
     - name: https
       protocol: HTTPS
       port: 443
       tls:
         mode: Terminate
         certificateRefs:
           - name: bookstore-tls
   ```
3. Create a `Certificate` resource referencing Let's Encrypt or an internal CA
4. Update all `http://` references to `https://` in issuer URIs, redirect URIs, etc.

### 3.4 Gateway API Portability

**Good news:** The project already uses Kubernetes Gateway API (`gateway.networking.k8s.io/v1`) with `gatewayClassName: istio`. This is fully portable:
- All 4 HTTPRoutes are standard Gateway API resources
- No vendor-specific annotations on routes
- Gateway API is supported on EKS (Istio/AWS Gateway Controller), AKS (Istio/Contour), GKE (GKE Gateway Controller or Istio)

**One issue:** The current setup installs Gateway API CRDs from GitHub (`infra/kgateway/install.sh`). Some managed clusters pre-install these. The install script already handles this idempotently.

### 3.5 Istio Service Mesh Portability

**Fully portable.** Istio Ambient Mesh works identically on EKS/AKS/GKE. The Helm-based installation (`infra/istio/install.sh`) is cloud-agnostic. All that changes:
- Remove kind-specific PERMISSIVE PeerAuthentication entries (Section 1.7)
- All `PeerAuthentication` (STRICT), `RequestAuthentication`, and `AuthorizationPolicy` resources work unchanged

### 3.6 PeerAuthentication Cleanup

**Remove from base, move to kind overlay:**
- `superset-nodeport-permissive`
- `flink-nodeport-permissive`
- `keycloak-nodeport-permissive`
- `debezium-ecom-nodeport-permissive`
- `debezium-inventory-nodeport-permissive`
- `pgadmin-nodeport-permissive`

Keep only the 5 namespace-wide STRICT policies in base.

| Item | Effort | Priority |
|------|--------|----------|
| Remove NodePort annotation from Gateway base | S | P0 |
| Move 7 NodePort Services to kind overlay | S | P0 |
| Parameterize domain names + ports in secrets/configs | M | P0 |
| Move PERMISSIVE PeerAuth entries to kind overlay | S | P0 |
| Add TLS listener + cert-manager | M | P1 |
| Add ExternalDNS integration | S | P1 |
| Create separate realm-export per environment | M | P1 |

---

## 4. Image Management

### Current State
- 4 custom images: `bookstore/ecom-service`, `bookstore/inventory-service`, `bookstore/ui-service`, `bookstore/flink`
- All tagged `:latest`
- Loaded via `kind load docker-image` (not portable)
- `imagePullPolicy: Never` on Flink images (kind-only); `IfNotPresent` on app images
- No container registry

### Target State

**4.1 Container Registry Strategy:**
- Use a cloud-agnostic registry: **GitHub Container Registry (ghcr.io)** or **Docker Hub**
- Image naming: `ghcr.io/<org>/bookstore-ecom-service`, etc.
- Alternative: use each cloud native registry (ECR/ACR/GAR) via Kustomize image transformer

**4.2 Image Tagging Strategy:**
- **Never use `:latest` in production.** Use semantic version tags: `v1.0.0`, `v1.0.1`
- CI builds tag with git SHA: `ghcr.io/<org>/bookstore-ecom-service:abc1234`
- Release tags: `ghcr.io/<org>/bookstore-ecom-service:v1.0.0`
- Kustomize `images` transformer replaces image names + tags per overlay

**4.3 Changes Required:**

| File | Current `image` | Change |
|------|----------------|--------|
| `ecom-service/k8s/ecom-service.yaml` | `bookstore/ecom-service:latest` | Base uses placeholder; overlay sets registry+tag |
| `inventory-service/k8s/inventory-service.yaml` | `bookstore/inventory-service:latest` (x2: init + app) | Same |
| `ui/k8s/ui-service.yaml` | `bookstore/ui-service:latest` | Same |
| `infra/flink/flink-cluster.yaml` | `bookstore/flink:latest` (x3: JM, TM, sql-gateway) | Same |
| `infra/flink/flink-sql-runner.yaml` | `bookstore/flink:latest` | Same |

**4.4 imagePullPolicy fix:**
- Change `Never` to `IfNotPresent` in base (works for both kind and cloud)
- kind overlay: no change needed (IfNotPresent works after `kind load`)
- Cloud overlay: no change needed (IfNotPresent pulls from registry if not cached)

**4.5 Kustomize image transformer example:**
```yaml
# overlays/cloud/kustomization.yaml
images:
  - name: bookstore/ecom-service
    newName: ghcr.io/myorg/bookstore-ecom-service
    newTag: v1.0.0
  - name: bookstore/inventory-service
    newName: ghcr.io/myorg/bookstore-inventory-service
    newTag: v1.0.0
  - name: bookstore/ui-service
    newName: ghcr.io/myorg/bookstore-ui-service
    newTag: v1.0.0
  - name: bookstore/flink
    newName: ghcr.io/myorg/bookstore-flink
    newTag: v1.0.0
```

**4.6 CI/CD Pipeline (P1):**
```
Push to main -> Build images -> Push to registry -> Update Kustomize tag -> Deploy
```

GitHub Actions workflow:
1. Build each service Docker image
2. Tag with git SHA + semantic version
3. Push to ghcr.io
4. Update `kustomization.yaml` image tags (or use Flux/ArgoCD image automation)

| Item | Effort | Priority |
|------|--------|----------|
| Change `imagePullPolicy: Never` to `IfNotPresent` | S | P0 |
| Set up container registry (ghcr.io) | S | P1 |
| Add Kustomize image transformer per overlay | S | P1 |
| Create CI pipeline for image builds | M | P1 |
| Replace `:latest` with versioned tags | S | P1 |

---

## 5. Secret Management

### Current State
- All secrets are native Kubernetes `Secret` objects with base64-encoded values committed to the repo
- Placeholder values (`CHANGE_ME`) used, but the secret manifests are in version control
- Cross-namespace secret copying done imperatively in `up.sh` and `infra-up.sh` (Debezium credentials)

### Target State

**Option A (recommended for initial portability): External Secrets Operator (ESO)**
- Install ESO (cloud-agnostic, works with AWS Secrets Manager, Azure Key Vault, GCP Secret Manager, HashiCorp Vault)
- Replace `Secret` manifests with `ExternalSecret` resources that reference an external store
- Secrets never committed to git

**Option B: Sealed Secrets**
- Install Bitnami Sealed Secrets controller
- Replace `Secret` manifests with `SealedSecret` (encrypted, safe to commit)
- Simpler than ESO but less flexible

**Option C (minimum viable): Keep K8s Secrets, remove from git**
- Move secret creation to deployment scripts (already partially done via comments in manifests)
- Use `kubectl create secret` commands in CI/CD pipeline
- Add `.gitignore` entries for any generated secret files

### Secrets Inventory

| Secret | Namespace | File | Contains |
|--------|-----------|------|----------|
| `ecom-db-secret` | ecom | `infra/postgres/ecom-db.yaml` | DB credentials |
| `inventory-db-secret` | inventory | `infra/postgres/inventory-db.yaml` | DB credentials |
| `analytics-db-secret` | analytics | `infra/postgres/analytics-db.yaml` | DB credentials |
| `keycloak-db-secret` | identity | `infra/keycloak/keycloak.yaml` | DB credentials |
| `keycloak-secret` | identity | `infra/keycloak/keycloak.yaml` | Admin + DB credentials |
| `ecom-service-secret` | ecom | `ecom-service/k8s/ecom-service.yaml` | DB URL, JWKS, Kafka, Redis |
| `inventory-service-secret` | inventory | `inventory-service/k8s/inventory-service.yaml` | DB URL, JWKS, Kafka |
| `redis-secret` | infra | `infra/redis/redis.yaml` | Redis password |
| `superset-secret` | analytics | `infra/superset/superset.yaml` | Admin creds, DB URL, secret key |
| `debezium-db-credentials` | infra | Created imperatively by scripts | Cross-ns DB creds |

### Recommended Approach

1. **Immediate (P0):** Separate secret definitions from workload manifests into dedicated files
2. **Phase 2 (P1):** Add ESO `ExternalSecret` resources as a cloud overlay
3. **Phase 3 (P2):** Integrate with HashiCorp Vault for full secret lifecycle management

| Item | Effort | Priority |
|------|--------|----------|
| Separate secrets into standalone files | S | P0 |
| Document all secrets + values needed | S | P0 |
| Add External Secrets Operator overlay | M | P1 |
| Remove base64 secret values from git | S | P1 |
| Vault integration | L | P2 |

---

## 6. Configuration Management

### Current State
- Raw `kubectl apply -f` on individual YAML files
- No Kustomize or Helm
- Environment-specific values hardcoded in manifests (domain names, ports, URLs)
- Shell scripts orchestrate deployment order

### Target State
- **Kustomize** for environment-specific configuration (base + overlays)
- All environment-specific values extracted into ConfigMaps or patches
- Helm used only where already in place (Istio, Kiali -- already Helm-installed)

### Environment Variables That Must Be Parameterized

**Domain/URL configuration (embed scheme + host + port):**

| Variable | Current Value | Where Used |
|----------|--------------|------------|
| Keycloak hostname | `idp.keycloak.net` | keycloak.yaml, request-auth.yaml, secrets |
| Keycloak port | `30000` | keycloak.yaml, all issuer URIs |
| Keycloak scheme | `http` | all issuer URIs (becomes `https` in cloud) |
| UI hostname | `myecom.net` | ui-route.yaml, realm-export.json |
| API hostname | `api.service.net` | ecom-route.yaml, inven-route.yaml, CSP header |
| Full Keycloak issuer URI | `http://idp.keycloak.net:30000/realms/bookstore` | 4+ files |

**Kustomize vars / replacements approach:**
```yaml
# base/kustomization.yaml
replacements:
  - source:
      kind: ConfigMap
      name: env-config
      fieldPath: data.KEYCLOAK_ISSUER_URI
    targets:
      - select: {kind: RequestAuthentication}
        fieldPaths: ["spec.jwtRules.0.issuer"]
      - select: {kind: Secret, name: ecom-service-secret}
        fieldPaths: ["stringData.KEYCLOAK_ISSUER_URI"]
```

| Item | Effort | Priority |
|------|--------|----------|
| Create Kustomize base + kind overlay | L | P0 |
| Extract all env-specific values into ConfigMap | M | P0 |
| Create cloud overlay (generic) | M | P1 |

---

## 7. Database Portability

### Current State
- 4 self-managed PostgreSQL 17 instances (Deployments, 1 replica each)
- Each has its own PVC bound to a hostPath PV
- Migrations: Liquibase (ecom) and Alembic (inventory) as init containers
- `wal_level=logical` enabled for CDC
- Internal ClusterIP services for access

### Target State -- Two Paths

**Path A: Self-Managed PostgreSQL on Cloud K8s (simplest migration)**
- Same manifests, just change storage (Section 2)
- Works on any cloud K8s cluster
- You manage backups, HA, upgrades
- **No application code changes required**

**Path B: Managed Database (RDS/Cloud SQL/Azure Database)**
- Remove PostgreSQL Deployments, PVCs, Services from cloud overlay
- Replace with ExternalName Services or direct endpoint configuration
- Connection strings change (from `ecom-db.ecom.svc.cluster.local:5432` to `ecom-db.xxxx.rds.amazonaws.com:5432`)
- Secrets must contain managed DB connection strings
- **Debezium CDC requires `wal_level=logical`** -- must be enabled on managed DB (supported on RDS, Cloud SQL, Azure DB but requires parameter group/flag changes)
- **Init container migrations still work** -- they connect via DATABASE_URL/DB_URL env vars

### Connection String Abstraction

Connection strings are already abstracted via secrets:
- `ecom-service-secret.DB_URL` = `jdbc:postgresql://ecom-db.ecom.svc.cluster.local:5432/ecomdb`
- `inventory-service-secret.DATABASE_URL` = `postgresql://inventoryuser:CHANGE_ME@inventory-db.inventory.svc.cluster.local:5432/inventorydb`

To switch to managed DB, just update these secret values. No code changes needed.

### Debezium Compatibility

**Critical:** Debezium Server `application.properties` ConfigMap has hardcoded DB hostnames:
```properties
debezium.source.database.hostname=ecom-db.ecom.svc.cluster.local
```

This must be parameterized (ConfigMap overlay or env var substitution).

| Item | Effort | Priority |
|------|--------|----------|
| PVC/storage changes (Section 2) | S | P0 |
| Parameterize DB hostnames in Debezium configs | S | P1 |
| Document managed DB migration path | S | P2 |
| Create ExternalName Service overlay for managed DB | M | P2 |

---

## 8. Messaging Portability

### Current State
- Single-node Kafka (KRaft mode, `confluentinc/cp-kafka:latest`) as a Deployment
- PVC for persistence (`kafka-pvc`)
- `kafka-topics-init.yaml` Job pre-creates 6 topics (4 CDC + 2 Debezium offsets)
- Debezium Server produces to Kafka; Flink SQL consumes from Kafka
- `KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka.infra.svc.cluster.local:9092`

### Target State -- Two Paths

**Path A: Self-Managed Kafka on Cloud K8s**
- Same manifests, just change storage (Section 2)
- Consider Strimzi Operator for production Kafka on K8s (multi-broker, rack-aware)
- No application changes needed

**Path B: Managed Kafka (MSK/Confluent Cloud/Event Hubs)**
- Remove Kafka Deployment, Service, PVC from cloud overlay
- Update `KAFKA_BOOTSTRAP_SERVERS` in all secrets/configs
- Update Debezium Server `bootstrap.servers` in ConfigMap
- Update Flink SQL pipeline bootstrap servers in `flink-sql-runner.yaml` ConfigMap
- **MSK compatibility:** Debezium Server + Flink SQL both work with MSK (standard Kafka protocol)
- **Event Hubs compatibility:** Azure Event Hubs has Kafka-compatible endpoint; works with Debezium + Flink but requires SASL/SSL config changes
- **Authentication:** Managed Kafka typically requires SASL_SSL; add `security.protocol`, `sasl.mechanism`, `sasl.jaas.config` to all producers/consumers

### Kafka Configuration Points

| Component | Config Location | Bootstrap Servers Setting |
|-----------|----------------|--------------------------|
| ecom-service | `ecom-service-secret` | `KAFKA_BOOTSTRAP_SERVERS` |
| inventory-service | `inventory-service-secret` | `KAFKA_BOOTSTRAP_SERVERS` |
| Debezium Server ecom | `debezium-server-ecom-config` ConfigMap | `debezium.sink.kafka.producer.bootstrap.servers` |
| Debezium Server inventory | `debezium-server-inventory-config` ConfigMap | `debezium.sink.kafka.producer.bootstrap.servers` |
| Flink SQL pipeline | `flink-sql-runner.yaml` ConfigMap | `'properties.bootstrap.servers'` in all 4 source tables |
| kafka-topics-init Job | `kafka-topics-init.yaml` | `--bootstrap-server` CLI arg |

All 6 points must be updated consistently. Kustomize ConfigMap patching handles this cleanly.

| Item | Effort | Priority |
|------|--------|----------|
| Parameterize bootstrap servers in all 6 locations | M | P0 |
| Document managed Kafka migration path | S | P2 |
| Add SASL/SSL config overlays for managed Kafka | M | P2 |

---

## 9. Observability Portability

### Current State
- **Prometheus:** Self-managed, deployed to `observability` namespace with RBAC
- **Kiali:** Helm-installed in `istio-system`, NodePort 32100
- **Tracing:** No distributed tracing yet (OpenTelemetry collector manifest exists but unused)
- **Logging:** stdout only (no log aggregator deployed)
- **Grafana:** Not deployed (referenced in architecture but not implemented)

### Target State

**Prometheus:**
- Self-managed Prometheus works on any K8s cluster unchanged
- For cloud: consider Prometheus Operator (kube-prometheus-stack) for better management
- Or use managed monitoring: Amazon Managed Prometheus, Azure Monitor, Google Cloud Monitoring
- The scrape configs in `prometheus-config` ConfigMap are portable (kubernetes_sd_configs works everywhere)

**Kiali:**
- Remove NodePort, access via port-forward or add HTTPRoute through gateway
- Helm install command is portable (no kind-specific config)

**Grafana (P2):**
- Add as an optional component in observability namespace
- Pre-configure dashboards via ConfigMap

**Log Aggregation (P2):**
- Add Fluent Bit DaemonSet or use cloud-native logging (CloudWatch, Azure Monitor, Cloud Logging)
- No application changes needed (all services log to stdout)

**OpenTelemetry (P2):**
- Complete OTel Collector deployment
- Add instrumentation to services (Spring Boot has auto-instrumentation; Python needs opentelemetry-instrument)

| Item | Effort | Priority |
|------|--------|----------|
| Remove Kiali NodePort, use Gateway route | S | P0 |
| Prometheus works as-is | - | - |
| Add Grafana | M | P2 |
| Add log aggregation (Fluent Bit) | M | P2 |
| Complete OTel tracing | L | P2 |

---

## 10. Identity Portability

### Current State
- Self-managed Keycloak 26.5.4 with dedicated PostgreSQL
- Realm config in `realm-export.json` with hardcoded redirect URIs and web origins
- `KC_HOSTNAME: idp.keycloak.net` and `KC_HOSTNAME_PORT: 30000` hardcoded
- NodePort for admin access (32400)

### Target State

**Keycloak deployment is portable** -- same Deployment/Service manifests work on any K8s cluster. Changes needed:

1. **`KC_HOSTNAME`:** Parameterize via overlay (stays `idp.keycloak.net` but could change)
2. **`KC_HOSTNAME_PORT`:** Remove for cloud (Keycloak behind LoadBalancer uses standard 443/80)
3. **`KC_PROXY_HEADERS: xforwarded`:** Already set correctly for behind-reverse-proxy operation
4. **TLS:** In cloud, Gateway terminates TLS. Keycloak stays HTTP internally. Add `KC_HOSTNAME_STRICT_HTTPS=true` for production.
5. **Realm export:** Create per-environment versions with correct redirect URIs:
   - kind: `http://localhost:30000/*`, `http://myecom.net:30000/*`
   - cloud: `https://myecom.net/*` (no port)

### OIDC URL Configuration Abstraction

**The OIDC issuer URI appears in 5+ places and MUST match exactly:**
1. Keycloak `KC_HOSTNAME` + `KC_HOSTNAME_PORT` (determines what Keycloak advertises)
2. `ecom-service-secret` `KEYCLOAK_ISSUER_URI`
3. `inventory-service-secret` `KEYCLOAK_ISSUER_URI`
4. `request-auth.yaml` `issuer`
5. UI `VITE_KEYCLOAK_AUTHORITY` (build-time)

All 5 MUST be the same value. Kustomize `replacements` or a shared ConfigMap can enforce this.

| Item | Effort | Priority |
|------|--------|----------|
| Parameterize KC_HOSTNAME + KC_HOSTNAME_PORT | S | P0 |
| Create per-environment realm-export.json | M | P1 |
| Add TLS configuration for production | S | P1 |
| Centralize OIDC issuer URI as single source of truth | M | P0 |

---

## 11. Recommended Kustomize Structure

```
infra/
  base/                              # Cloud-agnostic base manifests
    kustomization.yaml               # References all base resources
    env-config.yaml                  # ConfigMap: domain names, ports, scheme
    namespaces.yaml                  # (existing, unchanged)
    postgres/
      ecom-db.yaml                   # PVC without volumeName/storageClassName
      inventory-db.yaml
      analytics-db.yaml
    keycloak/
      keycloak.yaml                  # KC_HOSTNAME from env-config
      realm-export-base.json
    kafka/
      kafka.yaml                     # PVC without volumeName/storageClassName
      kafka-topics-init.yaml
      zookeeper.yaml
    redis/
      redis.yaml                     # PVC without volumeName/storageClassName
    debezium/
      debezium-server-ecom.yaml      # No NodePort Service; ClusterIP only
      debezium-server-inventory.yaml
    flink/
      flink-cluster.yaml             # No NodePort Service; imagePullPolicy: IfNotPresent
      flink-config.yaml
      flink-pvc.yaml                 # No volumeName/storageClassName
      flink-sql-runner.yaml
    superset/
      superset.yaml                  # No NodePort Service
      bootstrap-job.yaml
    pgadmin/
      pgadmin.yaml                   # No NodePort Service
    observability/
      prometheus/
        prometheus.yaml
      kiali/
        prometheus-alias.yaml
    istio/
      install.sh                     # Helm-based, cloud-agnostic
      security/
        peer-auth.yaml               # Only namespace-wide STRICT policies
        request-auth.yaml            # issuer from env-config
        serviceaccounts.yaml
        authz-policies/              # All unchanged
    kgateway/
      install.sh
      gateway.yaml                   # No NodePort annotation (default: LoadBalancer)
      routes/                        # All 4 HTTPRoutes (hostnames from env-config)
    kubernetes/
      hpa/
      pdb/
      network-policies/
    secrets/                         # NEW: all secret definitions in one place
      ecom-db-secret.yaml
      inventory-db-secret.yaml
      analytics-db-secret.yaml
      keycloak-secrets.yaml
      ecom-service-secret.yaml
      inventory-service-secret.yaml
      redis-secret.yaml
      superset-secret.yaml

  overlays/
    kind/                            # Local development on kind
      kustomization.yaml
      env-config-patch.yaml          # domains: *.net:30000, scheme: http
      storage/
        storageclass.yaml            # local-hostpath provisioner
        persistent-volumes.yaml      # 8 hostPath PVs
        pvc-patches/                 # Add volumeName + storageClassName to each PVC
      nodeport-services/             # 7 NodePort Services
      gateway-nodeport-patch.yaml    # Add NodePort annotation to gateway
      peer-auth-permissive.yaml      # 6 PERMISSIVE PeerAuth entries
      secrets/                       # CHANGE_ME placeholder secrets
      image-load.sh                  # kind load docker-image wrapper
      realm-export.json              # Redirect URIs with localhost:30000
      cluster.yaml                   # kind cluster config

    generic-cloud/                   # Generic managed K8s (EKS/AKS/GKE)
      kustomization.yaml
      env-config-patch.yaml          # Real domains, scheme: https, no port
      secrets/                       # Placeholder (actual values from ESO or CI)
      realm-export.json              # Redirect URIs with https://
      tls/
        certificate.yaml             # cert-manager Certificate
        gateway-tls-patch.yaml       # Add TLS listener to Gateway
      external-secrets/              # Optional: ESO ExternalSecret definitions
```

### Base `kustomization.yaml`

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - namespaces.yaml
  - secrets/ecom-db-secret.yaml
  - secrets/inventory-db-secret.yaml
  - secrets/analytics-db-secret.yaml
  - secrets/keycloak-secrets.yaml
  - secrets/ecom-service-secret.yaml
  - secrets/inventory-service-secret.yaml
  - secrets/redis-secret.yaml
  - secrets/superset-secret.yaml
  - postgres/ecom-db.yaml
  - postgres/inventory-db.yaml
  - postgres/analytics-db.yaml
  - keycloak/keycloak.yaml
  - kafka/kafka.yaml
  - kafka/kafka-topics-init.yaml
  - redis/redis.yaml
  - debezium/debezium-server-ecom.yaml
  - debezium/debezium-server-inventory.yaml
  - flink/flink-pvc.yaml
  - flink/flink-config.yaml
  - flink/flink-cluster.yaml
  - flink/flink-sql-runner.yaml
  - superset/superset.yaml
  - superset/bootstrap-job.yaml
  - pgadmin/pgadmin.yaml
  - observability/prometheus/prometheus.yaml
  - observability/kiali/prometheus-alias.yaml
  - istio/security/peer-auth.yaml
  - istio/security/request-auth.yaml
  - istio/security/serviceaccounts.yaml
  - istio/security/authz-policies/
  - kgateway/gateway.yaml
  - kgateway/routes/
  - kubernetes/hpa/
  - kubernetes/pdb/
  - kubernetes/network-policies/

configMapGenerator:
  - name: env-config
    literals:
      - KEYCLOAK_HOSTNAME=idp.keycloak.net
      - UI_HOSTNAME=myecom.net
      - API_HOSTNAME=api.service.net
      - SCHEME=http
      - PORT=":30000"
```

### kind overlay `kustomization.yaml`

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../base
  - storage/storageclass.yaml
  - storage/persistent-volumes.yaml
  - nodeport-services/
  - peer-auth-permissive.yaml

patches:
  - path: gateway-nodeport-patch.yaml
  - path: storage/pvc-patches/ecom-db-pvc-patch.yaml
  # ... (one per PVC)
  - path: env-config-patch.yaml
```

---

## 12. Migration Checklist

### Phase 0: Preparation (no cluster changes)

- [ ] **Audit all hardcoded values** -- Use the inventory in Section 1 to find every `localhost`, `30000`, `idp.keycloak.net`, `myecom.net`, `api.service.net` reference
- [ ] **Choose container registry** -- ghcr.io, Docker Hub, or cloud-native
- [ ] **Choose DNS strategy** -- ExternalDNS or manual records
- [ ] **Choose secret management** -- ESO, Sealed Secrets, or K8s Secrets via CI
- [ ] **Choose managed vs self-managed** for PostgreSQL, Kafka, Redis (per environment)

### Phase 1: Restructure Manifests (P0, Effort: L)

- [ ] Create `infra/base/` directory structure
- [ ] Move all manifests to base, removing kind-specific elements:
  - [ ] Remove `volumeName` and `storageClassName` from all 8 PVCs
  - [ ] Remove NodePort Services from base manifests (keep ClusterIP only)
  - [ ] Remove `networking.istio.io/service-type: NodePort` from gateway.yaml
  - [ ] Remove PERMISSIVE PeerAuthentication entries from peer-auth.yaml
  - [ ] Change `imagePullPolicy: Never` to `IfNotPresent` in Flink manifests
- [ ] Separate secrets from workload manifests into `infra/base/secrets/`
- [ ] Create `infra/overlays/kind/` with:
  - [ ] StorageClass + PersistentVolumes
  - [ ] PVC patches (add `volumeName` + `storageClassName`)
  - [ ] NodePort Service definitions
  - [ ] Gateway NodePort patch
  - [ ] PERMISSIVE PeerAuthentication entries
  - [ ] `cluster.yaml` (kind config)
  - [ ] `image-load.sh` script
- [ ] Create `infra/overlays/generic-cloud/` with:
  - [ ] TLS Certificate + Gateway TLS patch
  - [ ] Realm export with HTTPS redirect URIs
  - [ ] Env config patch (real domains, HTTPS, no port)
- [ ] Create `kustomization.yaml` for base and each overlay
- [ ] Extract environment-specific values into `env-config` ConfigMap
- [ ] Parameterize OIDC issuer URI as a single source of truth

### Phase 2: Image Pipeline (P1, Effort: M)

- [ ] Push all 4 custom images to container registry
- [ ] Add Kustomize image transformers to overlays
- [ ] Create CI/CD pipeline for automated builds
- [ ] Replace `:latest` tags with versioned tags

### Phase 3: Security Hardening (P1, Effort: M)

- [ ] Remove secret values from git (replace with ESO or CI injection)
- [ ] Add cert-manager for TLS
- [ ] Create per-environment realm-export.json files
- [ ] Update all HTTP URLs to HTTPS in cloud overlay

### Phase 4: First Cloud Deployment (Effort: M)

- [ ] Provision managed K8s cluster (EKS/AKS/GKE)
- [ ] Install Istio Ambient Mesh (use existing `install.sh`)
- [ ] Install Gateway API CRDs (use existing `install.sh`)
- [ ] Configure DNS records
- [ ] Deploy using `kubectl apply -k infra/overlays/generic-cloud/`
- [ ] Run smoke tests (adapted for cloud URLs)
- [ ] Run E2E tests (adapted for cloud URLs)

### Phase 5: Production Hardening (P2, Effort: L)

- [ ] Add HPA scaling rules for app services
- [ ] Configure PDB for multi-replica deployments
- [ ] Add VolumeSnapshot for database backups
- [ ] Deploy Grafana dashboards
- [ ] Add log aggregation (Fluent Bit)
- [ ] Complete OpenTelemetry tracing

---

## 13. Script Portability

### Script Classification

| Script | Kind-Specific? | Portable? | Action |
|--------|---------------|-----------|--------|
| `scripts/up.sh` | **Yes** -- `kind` commands, `kind load`, NodePort patches, `/etc/hosts` checks | No | Split into kind-specific + generic deploy |
| `scripts/down.sh` | **Yes** -- `kind delete cluster`, `data/` cleanup | No | Move to kind overlay |
| `scripts/cluster-up.sh` | **Yes** -- `kind create cluster`, `sed DATA_DIR` | No | Move to kind overlay |
| `scripts/cluster-down.sh` | **Yes** -- wraps `down.sh` | No | Move to kind overlay |
| `scripts/stack-up.sh` | **Yes** -- calls cluster-up.sh | No | Move to kind overlay |
| `scripts/infra-up.sh` | **Mostly** -- context check for `kind-bookstore` | Fixable | Remove context check; make generic |
| `scripts/keycloak-import.sh` | **No** -- uses kubectl, portable | Yes | Keep in base |
| `scripts/smoke-test.sh` | **Partially** -- hardcoded `localhost:3xxxx` URLs, domain names | Fixable | Parameterize URLs via env vars |
| `scripts/verify-routes.sh` | **Partially** -- hardcoded domain:port URLs | Fixable | Parameterize URLs |
| `scripts/verify-cdc.sh` | **No** -- uses kubectl exec | Yes | Keep in base |
| `scripts/sanity-test.sh` | **Partially** -- hardcoded localhost URLs | Fixable | Parameterize |
| `scripts/restart-after-docker.sh` | **Yes** -- kind/Docker-specific recovery | No | Move to kind overlay |
| `infra/debezium/register-connectors.sh` | **Partially** -- hardcoded localhost:32300/32301 | Fixable | Parameterize URLs |
| `infra/istio/install.sh` | **No** -- Helm-based, cloud-agnostic | Yes | Keep in base |
| `infra/kgateway/install.sh` | **No** -- kubectl apply, cloud-agnostic | Yes | Keep in base |

### Recommended Script Structure

```
scripts/
  deploy.sh                    # Generic: applies Kustomize overlay, waits, runs smoke
  keycloak-import.sh           # Portable (unchanged)
  verify-routes.sh             # Parameterized: reads URLs from env
  verify-cdc.sh                # Portable (unchanged)
  smoke-test.sh                # Parameterized: reads URLs from env
  kind/
    up.sh                      # Kind-specific bootstrap (current up.sh)
    down.sh                    # Kind-specific teardown
    cluster-up.sh              # Kind cluster creation
    image-load.sh              # kind load docker-image
    restart-after-docker.sh    # Docker Desktop recovery
```

### Parameterizing Scripts

The smoke test and verify scripts should read URLs from environment variables with kind defaults:

```bash
# At top of smoke-test.sh:
GATEWAY_URL="${GATEWAY_URL:-http://localhost:30000}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://idp.keycloak.net:30000}"
API_URL="${API_URL:-http://api.service.net:30000}"
UI_URL="${UI_URL:-http://myecom.net:30000}"
PGADMIN_URL="${PGADMIN_URL:-http://localhost:31111}"
SUPERSET_URL="${SUPERSET_URL:-http://localhost:32000}"
DEBEZIUM_ECOM_URL="${DEBEZIUM_ECOM_URL:-http://localhost:32300}"
DEBEZIUM_INV_URL="${DEBEZIUM_INV_URL:-http://localhost:32301}"
```

### CI/CD Pipeline Structure (P1)

```yaml
# .github/workflows/deploy.yaml
name: Build and Deploy
on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build and push images
        run: |
          for svc in ecom-service inventory-service ui flink; do
            docker build -t ghcr.io/${{ github.repository }}/${svc}:${{ github.sha }} ./${svc}
            docker push ghcr.io/${{ github.repository }}/${svc}:${{ github.sha }}
          done
      - name: Update image tags
        run: |
          cd infra/overlays/generic-cloud
          kustomize edit set image bookstore/ecom-service=ghcr.io/.../ecom-service:${{ github.sha }}
      - name: Deploy
        run: kubectl apply -k infra/overlays/generic-cloud/
```

### E2E Test Impact

**E2E tests have 27 files with hardcoded `localhost:30000` or domain references.** These need parameterization:

- `playwright.config.ts` -- `baseURL: 'http://localhost:30000'` must become `process.env.BASE_URL || 'http://localhost:30000'`
- Auth fixtures reference `idp.keycloak.net:30000` for OIDC login flows
- Debezium/Flink spec files reference `localhost:32300`, `localhost:32200`
- Superset spec references `localhost:32000`
- Kiali spec references `localhost:32100`

**Recommended:** Add a `.env` file for E2E tests that overlays can override:
```bash
# e2e/.env.kind (default)
BASE_URL=http://localhost:30000
KEYCLOAK_URL=http://idp.keycloak.net:30000
SUPERSET_URL=http://localhost:32000
KIALI_URL=http://localhost:32100
FLINK_URL=http://localhost:32200
DEBEZIUM_ECOM_URL=http://localhost:32300
DEBEZIUM_INV_URL=http://localhost:32301
PGADMIN_URL=http://localhost:31111
```

| Item | Effort | Priority |
|------|--------|----------|
| Parameterize smoke-test.sh + verify-routes.sh | S | P0 |
| Move kind-specific scripts to scripts/kind/ | S | P0 |
| Create generic deploy.sh | M | P1 |
| Parameterize E2E test URLs | M | P1 |
| Create CI/CD pipeline | L | P1 |

---

## Summary: Priority Matrix

### P0 -- Must Do (blocks cloud deployment)

| Item | Effort | Files Affected |
|------|--------|---------------|
| Remove `volumeName` + `storageClassName` from PVCs (move to overlay) | S | 8 PVC definitions |
| Move PV definitions + StorageClass to kind overlay | S | 2 files |
| Remove NodePort Services from base (move to overlay) | S | 7 service definitions |
| Remove NodePort annotation from Gateway base | S | 1 file |
| Move PERMISSIVE PeerAuth entries to kind overlay | S | 1 file |
| Change `imagePullPolicy: Never` to `IfNotPresent` | S | 2 files |
| Parameterize domain names + ports in secrets/configs | M | 6+ files |
| Centralize OIDC issuer URI | M | 5+ files |
| Create Kustomize base + kind overlay structure | L | All infra files |
| Separate secrets from workload manifests | S | 8 files |
| Parameterize scripts (smoke-test, verify-routes) | S | 4 scripts |
| Move kind-specific scripts to scripts/kind/ | S | 6 scripts |
| Parameterize Kafka bootstrap servers in all 6 locations | M | 6 files |

**Estimated total P0 effort: 3-5 days**

### P1 -- Should Do (production readiness)

| Item | Effort |
|------|--------|
| Set up container registry + CI pipeline | M |
| Kustomize image transformer per overlay | S |
| Replace `:latest` with versioned tags | S |
| Add TLS (cert-manager + Gateway TLS listener) | M |
| Remove secret values from git | S |
| Add External Secrets Operator overlay | M |
| Create per-environment realm-export.json | M |
| Add ExternalDNS integration | S |
| Parameterize E2E test URLs | M |
| Create generic deploy.sh | M |
| Parameterize DB hostnames in Debezium configs | S |

**Estimated total P1 effort: 5-8 days**

### P2 -- Nice to Have (operational maturity)

| Item | Effort |
|------|--------|
| Convert DBs to StatefulSets | M |
| Add VolumeSnapshot support | M |
| Document managed DB/Kafka migration paths | S |
| Add Grafana dashboards | M |
| Add log aggregation (Fluent Bit) | M |
| Complete OpenTelemetry tracing | L |
| Vault integration for secrets | L |
| Strimzi for production Kafka | L |

**Estimated total P2 effort: 10-15 days**

---

## What Does NOT Need to Change

These elements are already cloud-portable:

1. **Application code** -- all 3 services (ecom-service, inventory-service, ui) are fully portable
2. **Dockerfiles** -- multi-stage, non-root, cloud-ready
3. **Gateway API HTTPRoutes** -- standard Kubernetes Gateway API resources
4. **Istio installation** -- Helm-based, works on any K8s
5. **Namespace definitions** -- standard K8s resources with Istio ambient labels
6. **RBAC** -- ServiceAccounts, ClusterRoles, ClusterRoleBindings
7. **HPA / PDB** -- standard K8s autoscaling and disruption budgets
8. **NetworkPolicies** -- standard K8s (may need CNI that supports them)
9. **Flink SQL pipeline** -- the SQL itself is infrastructure-agnostic
10. **Debezium Server config** -- standard CDC config (just parameterize hostnames)
11. **Database migrations** -- Liquibase + Alembic init containers work anywhere
12. **Prometheus scrape config** -- kubernetes_sd_configs is universal
