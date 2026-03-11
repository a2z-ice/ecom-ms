# Observability & Infrastructure Security Review

**Date**: 2026-03-09
**Scope**: Full security audit of the observability stack (otel + observability namespaces) and cross-cutting infrastructure security posture.
**Reviewer**: Claude Code (Session 23)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope & Methodology](#2-scope--methodology)
3. [Architecture Overview](#3-architecture-overview)
4. [mTLS & Encryption](#4-mtls--encryption)
5. [Network Segmentation](#5-network-segmentation)
6. [Authorization Policies](#6-authorization-policies)
7. [Container Security](#7-container-security)
8. [RBAC & Service Accounts](#8-rbac--service-accounts)
9. [Secrets Management](#9-secrets-management)
10. [Image Security](#10-image-security)
11. [Attack Surface Analysis](#11-attack-surface-analysis)
12. [Findings Summary](#12-findings-summary)
13. [Remediation Plan](#13-remediation-plan)
14. [Appendix: File Inventory](#14-appendix-file-inventory)

---

## 1. Executive Summary

The observability stack underwent a security hardening pass in Session 23. The primary defense is now **NetworkPolicy** (CNI-level, independent of Istio), with AuthorizationPolicies providing defense-in-depth. The otel namespace remains on **PERMISSIVE mTLS** due to a technical constraint (see Section 4), with a documented migration path to STRICT.

### Risk Rating

| Area | Rating | Notes |
|------|--------|-------|
| mTLS Encryption | **MEDIUM** | otel namespace PERMISSIVE; all others STRICT |
| Network Segmentation | **LOW** | Default deny + explicit allow in all namespaces |
| Authorization Policies | **LOW** | L4 enforcement by ztunnel; otel defense-in-depth only |
| Container Security | **HIGH** | 5 services missing container-level securityContext |
| RBAC | **MEDIUM** | kube-state-metrics ClusterRole overly broad |
| Secrets Management | **LOW** | All via secretKeyRef; placeholder passwords (POC) |
| Image Pinning | **MEDIUM** | 4 services use `:latest` tags |

**Overall Risk: MEDIUM** — Network segmentation is strong; container hardening has gaps.

---

## 2. Scope & Methodology

### Files Reviewed

| Category | Files |
|----------|-------|
| PeerAuthentication | `infra/istio/security/peer-auth.yaml` |
| RequestAuthentication | `infra/istio/security/request-auth.yaml` |
| AuthorizationPolicy | 8 files in `infra/istio/security/authz-policies/` |
| NetworkPolicy | `ecom-netpol.yaml`, `inventory-netpol.yaml`, `otel-netpol.yaml`, `observability-netpol.yaml` |
| Deployments | All 15+ deployment manifests across all namespaces |
| Scripts | `infra-up.sh` (inline PeerAuthentication for otel) |

### Methodology

1. Review all Istio security resources (PeerAuth, RequestAuth, AuthzPolicy)
2. Review all NetworkPolicies for default deny + explicit allow
3. Audit container securityContext on every Deployment
4. Check RBAC scope for all ServiceAccounts
5. Verify secrets handling (no hardcoded credentials in manifests)
6. Assess image pinning and supply chain risk
7. Threat model: lateral movement from compromised pod

---

## 3. Architecture Overview

### Namespace Layout

```
                    +-----------+     +-----------+     +-----------+
                    |   ecom    |     | inventory |     | analytics |
                    | ecom-svc  |     | inv-svc   |     | flink-jm  |
                    | ui-svc    |     | inv-db    |     | flink-tm  |
                    | ecom-db   |     +-----------+     | analytics |
                    +-----------+           |            | superset  |
                         |                 |            +-----------+
                    +----+-----------------+----+
                    |         infra              |
                    | kafka, redis, debezium x2  |
                    | pgadmin, schema-registry   |
                    | istio-gateway              |
                    +----------------------------+
                         |
              +----------+----------+
              |                     |
        +-----+------+     +-------+------+
        | observability|     |     otel     |
        | prometheus   |     | otel-collect |
        | grafana      |     | loki         |
        | ksm, alertmgr|     | tempo        |
        +--------------+     +--------------+
```

### Data Flow (Observability)

```
ecom-service  ──OTLP──▶  OTel Collector  ──HTTP──▶  Loki (logs)
inventory-svc ──OTLP──▶  OTel Collector  ──HTTP──▶  Tempo (traces)
                          OTel Collector  ──:8889──▶  Prometheus (metrics scrape)

Grafana  ──HTTP──▶  Loki (3100)   ◀── query logs
Grafana  ──HTTP──▶  Tempo (3200)  ◀── query traces
Grafana  ──HTTP──▶  Prometheus (9090) ◀── query metrics
Kiali    ──HTTP──▶  Prometheus (9090) ◀── traffic graph
Prometheus ──scrape──▶  all namespaces (targets)
```

---

## 4. mTLS & Encryption

### PeerAuthentication Matrix

| Namespace | Mode | Enforced By | Notes |
|-----------|------|-------------|-------|
| ecom | STRICT | ztunnel | All traffic encrypted |
| inventory | STRICT | ztunnel | All traffic encrypted |
| analytics | STRICT | ztunnel | Superset + Flink: port-level PERMISSIVE for NodePort |
| identity | STRICT | ztunnel | Keycloak: port-level PERMISSIVE for NodePort 32400 |
| infra | STRICT | ztunnel | Debezium + PgAdmin: port-level PERMISSIVE for NodePorts |
| observability | **STRICT** | ztunnel | Grafana: port-level PERMISSIVE for NodePort 32500 |
| **otel** | **PERMISSIVE** | ztunnel (partial) | See Finding-1 below |

### Finding-1: otel Namespace PERMISSIVE mTLS (MEDIUM)

**Status**: Known limitation, documented, mitigated.

**Root Cause**: All 3 otel pods have `ambient.istio.io/redirection: disabled` annotation. Despite Istio CNI overriding this (pod annotations show `enabled`), the annotation prevents ztunnel from setting up proper HBONE listeners on the destination side. With STRICT, source ztunnel requires HBONE handshake, which fails → connection timeout.

**Impact**: Traffic to/from otel pods may fall back to plaintext within the cluster network. An attacker with access to the pod network could sniff OTel telemetry data (traces, logs, metrics).

**Mitigations in place**:
- NetworkPolicy default deny + explicit allow (primary defense)
- Only ecom, inventory, and observability namespaces can reach otel pods
- Telemetry data has lower sensitivity than business data (no PII in traces/logs by default)

**Remediation path**: Remove `ambient.istio.io/redirection: disabled` annotations from all 3 otel pods → change PeerAuth to STRICT. See `docs/guides/otel-strict-mtls-migration-guide.md` for the step-by-step procedure.

### Finding-2: NodePort PERMISSIVE Exceptions (LOW)

Multiple services require port-level PERMISSIVE for NodePort access from the host:

| Service | Port | NodePort | Justification |
|---------|------|----------|---------------|
| Grafana | 3000 | 32500 | Admin UI access |
| Superset | 8088 | 32000 | Analytics UI |
| Flink JM | 8081 | 32200 | Dashboard |
| Keycloak | 8080 | 32400 | Admin console |
| Debezium ecom | 8080 | 32300 | Health check |
| Debezium inv | 8080 | 32301 | Health check |
| PgAdmin | 80 | 31111 | DB admin UI |

**Risk**: These ports accept plaintext from the host machine. In a kind/dev cluster this is acceptable. In production, these would be replaced with an ingress controller + TLS termination.

**Mitigation**: Each uses a workload-specific `PeerAuthentication` with `selector` — only the targeted port on the targeted pod is PERMISSIVE. All other ports remain STRICT.

### Finding-3: infra-up.sh Inline PERMISSIVE PeerAuth (LOW)

`scripts/infra-up.sh` (lines 122-131) creates a PERMISSIVE PeerAuthentication for the otel namespace inline via `cat <<'OTEL_PA'`. This duplicates the declaration in `peer-auth.yaml`.

**Risk**: If `peer-auth.yaml` is changed to STRICT but `infra-up.sh` is not updated, the inline block overwrites it back to PERMISSIVE on next `infra-up.sh` run.

**Remediation**: Remove the inline block from `infra-up.sh`. The PeerAuthentication should be managed solely by `peer-auth.yaml`.

---

## 5. Network Segmentation

### NetworkPolicy Coverage

| Namespace | Default Deny | Ingress Rules | Egress Rules | Rating |
|-----------|-------------|---------------|--------------|--------|
| ecom | Yes (ingress + egress) | Gateway, ui-service, observability | DB, Kafka, Redis, Keycloak, inventory, otel, HBONE, DNS | GOOD |
| inventory | Yes (ingress + egress) | Gateway, ecom, observability | DB, Kafka, Keycloak, otel, HBONE, DNS | GOOD |
| otel | Yes (ingress + egress) | Per-pod explicit allow + HBONE | Per-pod explicit allow + HBONE + DNS | GOOD |
| observability | Yes (ingress only) | Per-pod explicit allow + HBONE | **No egress restrictions** | FAIR |
| analytics | **No NetworkPolicy** | N/A | N/A | **GAP** |
| identity | **No NetworkPolicy** | N/A | N/A | **GAP** |
| infra | **No NetworkPolicy** | N/A | N/A | **GAP** |

### Finding-4: Missing NetworkPolicies in analytics, identity, infra Namespaces (MEDIUM)

**Impact**: Any pod in these namespaces can communicate with any other pod in any namespace (subject to AuthorizationPolicy enforcement). A compromised Kafka pod could reach ecom-db directly (though AuthorizationPolicy would block at L4).

**Mitigations in place**:
- AuthorizationPolicies enforce namespace-level access at L4 for all DB pods
- STRICT mTLS ensures SPIFFE identity verification on all connections

**Remediation**: Create NetworkPolicies for analytics, identity, and infra namespaces following the same default-deny + explicit-allow pattern used in ecom, inventory, and otel.

### Finding-5: observability Namespace Missing Egress NetworkPolicy (LOW)

The observability namespace only has ingress deny. Prometheus needs broad egress (scrapes all namespaces), but Grafana, AlertManager, and kube-state-metrics egress is unrestricted.

**Impact**: A compromised Grafana pod could attempt outbound connections to any namespace/port.

**Mitigations in place**:
- Grafana only has datasource configs for Prometheus, Loki, Tempo
- AuthorizationPolicies on destination pods restrict inbound access

**Remediation**: Add egress NetworkPolicy to observability namespace:
- Prometheus: egress to all namespaces (required for scraping)
- Grafana: egress to Prometheus (9090), Loki (3100), Tempo (3200), HBONE (15008), DNS
- AlertManager: egress to DNS only (or webhook targets if configured)
- kube-state-metrics: egress to kube-apiserver only

### Finding-6: HBONE Port 15008 Open to All Sources (LOW)

All NetworkPolicies use `from: []` (all sources) for port 15008 HBONE ingress. This is required because ztunnel on any node may need to establish HBONE tunnels to any pod.

**Risk**: Minimal. HBONE is managed by ztunnel (not application code). An attacker would need to compromise ztunnel itself to exploit this, at which point all mTLS guarantees are void.

**Mitigation**: This is the standard pattern for Istio Ambient mesh. Cannot be tightened without breaking HBONE.

---

## 6. Authorization Policies

### AuthorizationPolicy Matrix

| Target | Namespace | Allows From | Enforced? |
|--------|-----------|-------------|-----------|
| ecom-service | ecom | infra, ecom, observability | Yes (mesh-enrolled) |
| ecom-db | ecom | ecom, infra | Yes |
| inventory-service | inventory | infra, ecom, observability | Yes |
| inventory-db | inventory | inventory, infra | Yes |
| analytics-db | analytics | infra, analytics | Yes |
| keycloak-db | identity | identity | Yes |
| prometheus | observability | observability, istio-system | Yes |
| grafana | observability | ALL (rule: `{}`) | Yes (broad) |
| kube-state-metrics | observability | observability | No (annotation override) |
| otel-collector | otel | ecom, inventory, observability | **No** (annotation override) |
| loki | otel | otel, observability | **No** (annotation override) |
| tempo | otel | otel, observability | **No** (annotation override) |

### Finding-7: Grafana AuthorizationPolicy is ALLOW-ALL (LOW)

The Grafana AuthorizationPolicy uses `rules: [{}]` (allow all traffic). This is required because NodePort traffic from the host has no SPIFFE identity, so namespace-based restrictions would block it.

**Mitigations in place**:
- NetworkPolicy restricts ingress to port 3000 only
- Grafana requires admin credentials for login
- PeerAuthentication: port-level PERMISSIVE on 3000 only

**Assessment**: Acceptable for dev/POC. In production, replace NodePort with an authenticated ingress controller.

### Finding-8: otel AuthorizationPolicies Not Enforced (MEDIUM)

All 3 otel AuthorizationPolicies exist but are **not enforced** by ztunnel because the pods have `ambient.istio.io/redirection: disabled` (overridden by CNI, but still affects enforcement).

**Impact**: The policies document intended access control but provide no actual enforcement. NetworkPolicy is the sole enforced boundary.

**Mitigations in place**:
- NetworkPolicy (enforced at CNI level) restricts the same traffic flows
- Policies will become enforced automatically when the annotation is removed (see STRICT migration guide)

### Finding-9: RequestAuthentication Only in ecom + inventory (INFO)

`RequestAuthentication` (Keycloak JWT validation) is applied only to ecom and inventory namespaces. The observability and otel namespaces have no JWT validation at the Istio level.

**Assessment**: Correct by design. Observability services are internal-only and don't serve user-facing APIs. JWT validation would be inappropriate for metrics scraping, log pushing, and trace collection.

---

## 7. Container Security

### Security Context Audit

| Component | runAsNonRoot | runAsUser | allowPrivilegeEscalation | capabilities.drop | readOnlyRootFS | Rating |
|-----------|-------------|-----------|--------------------------|-------------------|----------------|--------|
| OTel Collector | Yes | 10001 | - | - | - | FAIR |
| Loki | Yes | 10001 | false | ALL | - | GOOD |
| Tempo | Yes | 10001 | false | ALL | - | GOOD |
| Grafana | Yes | 472 | false | ALL | - | GOOD |
| Prometheus | Yes | 65534 | **missing** | **missing** | - | **POOR** |
| AlertManager | Yes | 65534 | false | ALL | - | GOOD |
| kube-state-metrics | Yes | 65534 | false | ALL | true | EXCELLENT |
| Schema Registry | Yes | 1000 | false | ALL | false | GOOD |
| **Kafka** | Yes | 1000 | **missing** | **missing** | - | **POOR** |
| **Redis** | Yes | 999 | **missing** | **missing** | - | **POOR** |
| **Keycloak** | Yes | 1000 | **missing** | **missing** | - | **POOR** |
| **Keycloak-DB** | fsGroup only | **missing** | **missing** | **missing** | - | **CRITICAL** |
| Debezium ecom | Yes | 1001 | false | ALL | false | GOOD |
| Debezium inv | Yes | 1001 | false | ALL | false | GOOD |
| **ecom-db** | fsGroup only | **missing** | **missing** | **missing** | - | **CRITICAL** |
| **inventory-db** | fsGroup only | **missing** | **missing** | **missing** | - | **CRITICAL** |
| **analytics-db** | fsGroup only | **missing** | **missing** | **missing** | - | **CRITICAL** |

### Finding-10: 5 Services Missing Container-Level securityContext (HIGH)

**Affected**: Kafka, Redis, Keycloak, Prometheus, OTel Collector (container-level only; pod-level is present)

These containers can potentially:
- Escalate privileges (`allowPrivilegeEscalation` defaults to `true`)
- Retain all Linux capabilities (including `NET_RAW`, `SYS_PTRACE`)
- Write to the root filesystem

### Finding-11: 4 PostgreSQL Instances Missing runAsNonRoot (HIGH)

**Affected**: ecom-db, inventory-db, analytics-db, keycloak-db

All PostgreSQL instances only have `fsGroup: 999` at pod level. The `postgres:17-alpine` image runs the PostgreSQL process as the `postgres` user (UID 70) internally, but without explicit `runAsNonRoot: true` + `runAsUser: 70`, Kubernetes does not enforce this.

**Risk**: If the image changes behavior (or a different tag is used), the process could run as root.

**Remediation**: Add explicit `runAsNonRoot: true` and `runAsUser: 70` (postgres user in Alpine) to all PostgreSQL deployments. Note: `postgres:17-alpine` needs write access to the data directory, so `readOnlyRootFilesystem` is not feasible.

### Finding-12: readOnlyRootFilesystem Not Enforced (MEDIUM)

Only kube-state-metrics has `readOnlyRootFilesystem: true`. All other services can write to the container filesystem.

**Impact**: A compromised container could write malicious binaries, modify configs, or create persistence mechanisms on the root filesystem.

**Remediation**: Enable `readOnlyRootFilesystem: true` where feasible, using `emptyDir` or `tmpfs` for writable paths:
- Grafana: needs `/tmp`, `/var/lib/grafana` → emptyDir
- Prometheus: needs `/prometheus` → PVC/emptyDir
- OTel Collector: no writable paths needed → can enable immediately
- Loki/Tempo: already use emptyDir for data → can enable with `/tmp` emptyDir

---

## 8. RBAC & Service Accounts

### ServiceAccount Inventory

| Namespace | ServiceAccount | ClusterRole | Scope |
|-----------|---------------|-------------|-------|
| ecom | ecom-service | None | Namespace-scoped |
| inventory | inventory-service | None | Namespace-scoped |
| observability | prometheus | prometheus | Cluster-wide (nodes, pods, services, endpoints) |
| observability | kube-state-metrics | kube-state-metrics | Cluster-wide (broad) |
| All others | default | None | Namespace-scoped |

### Finding-13: kube-state-metrics ClusterRole Reads All Secrets (MEDIUM)

The `kube-state-metrics` ClusterRole includes `secrets` in its resource list with `list` and `watch` verbs:

```yaml
- apiGroups: [""]
  resources: [configmaps, secrets, nodes, pods, ...]
  verbs: [list, watch]
```

**Impact**: kube-state-metrics can read the metadata (names, namespaces, annotations, labels) of ALL Secrets cluster-wide. While it doesn't read Secret data values, the metadata exposure includes secret names which may reveal sensitive information.

**Mitigations**: kube-state-metrics only exposes metadata as Prometheus metrics (e.g., `kube_secret_info`). The actual secret data is never exposed.

**Remediation**: Remove `secrets` from the resource list if secret metadata metrics are not needed. The standard kube-state-metrics installation includes this by default — evaluate whether `kube_secret_*` metrics are being used before removing.

### Finding-14: Most Pods Use `default` ServiceAccount (LOW)

Pods in analytics, identity, infra, and otel namespaces use the `default` ServiceAccount. This is fine for Istio SPIFFE identity (which uses namespace + SA name), but means all pods in a namespace share the same identity.

**Impact**: AuthorizationPolicies cannot distinguish between pods within the same namespace (e.g., cannot allow Kafka but deny PgAdmin within infra namespace).

**Remediation**: Create dedicated ServiceAccounts for each deployment. Update AuthorizationPolicies to use `principals` instead of `namespaces` for finer-grained access control.

---

## 9. Secrets Management

### Secret Inventory

| Secret | Namespace | Used By | Method |
|--------|-----------|---------|--------|
| ecom-db-secret | ecom | ecom-db, ecom-service | secretKeyRef / envFrom |
| inventory-db-secret | inventory | inventory-db, inventory-service | secretKeyRef / envFrom |
| analytics-db-secret | analytics | analytics-db, Flink, Superset | secretKeyRef / envFrom |
| keycloak-secret | identity | keycloak | secretKeyRef |
| keycloak-db-secret | identity | keycloak-db | secretKeyRef / envFrom |
| redis-secret | infra | redis | secretKeyRef |
| debezium-db-credentials | infra | debezium-server-ecom, debezium-server-inv | secretKeyRef |
| grafana-secret | observability | grafana | secretKeyRef |

### Finding-15: All Secrets Use Placeholder Values (INFO — POC Only)

All secrets are base64-encoded `CHANGE_ME` placeholders. This is acceptable for a POC/dev environment but must be replaced with strong, unique passwords before any production or shared deployment.

### Finding-16: Redis Password in Command Args (LOW)

Redis receives its password via `--requirepass $(REDIS_PASSWORD)`. The expanded command is visible in `/proc/<pid>/cmdline` within the container.

**Mitigations**: Pod-level `runAsNonRoot` prevents other users from reading the process. Only processes within the same pod or the node's root can see it.

**Remediation**: Use a Redis config file mounted from a Secret volume instead of command-line args.

### Finding-17: Debezium DB Credentials Cross-Namespace Copy (INFO)

`infra-up.sh` reads credentials from `ecom-db-secret` (ecom ns) and `inventory-db-secret` (inventory ns), then creates `debezium-db-credentials` in the infra namespace. This is the correct pattern for namespace-scoped secrets.

**Assessment**: Properly implemented. The copy is done via `kubectl --dry-run=client -o yaml | kubectl apply -f -` (idempotent).

---

## 10. Image Security

### Image Pinning Status

| Component | Image | Pinned? | Risk |
|-----------|-------|---------|------|
| OTel Collector | `otel/opentelemetry-collector-contrib:0.104.0` | Yes | LOW |
| Loki | `grafana/loki:3.4.2` | Yes | LOW |
| Tempo | `grafana/tempo:2.6.1` | Yes | LOW |
| **Grafana** | `grafana/grafana:latest` | **No** | **MEDIUM** |
| Prometheus | `prom/prometheus:v2.53.0` | Yes | LOW |
| **AlertManager** | `prom/alertmanager:latest` | **No** | **MEDIUM** |
| kube-state-metrics | `registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0` | Yes | LOW |
| **Schema Registry** | `confluentinc/cp-schema-registry:latest` | **No** | **MEDIUM** |
| **Kafka** | `confluentinc/cp-kafka:latest` | **No** | **MEDIUM** |
| Redis | `redis:7-alpine` | Partial (major) | LOW |
| Keycloak | `quay.io/keycloak/keycloak:26.5.4` | Yes | LOW |
| Debezium | `quay.io/debezium/server:3.4.1.Final` | Yes | LOW |
| PostgreSQL | `postgres:17-alpine` | Partial (major) | LOW |
| Flink | `bookstore/flink:latest` (custom) | N/A (local) | LOW |

### Finding-18: 4 Services Use `:latest` Image Tags (MEDIUM)

**Affected**: Grafana, AlertManager, Kafka, Schema Registry

**Risk**: `:latest` tags are mutable. A `docker pull` or pod restart could pull a different version with breaking changes or vulnerabilities, without any manifest change.

**Remediation**: Pin to specific versions:
- Grafana: `grafana/grafana:11.5.2` (or current stable)
- AlertManager: `prom/alertmanager:v0.27.0`
- Kafka: `confluentinc/cp-kafka:7.7.1`
- Schema Registry: `confluentinc/cp-schema-registry:7.7.1`

---

## 11. Attack Surface Analysis

### Scenario 1: Compromised OTel Collector Pod

**Current exposure**:
- Can reach Loki (3100), Tempo (4318) — by design (exporter config)
- Can reach DNS (53/UDP) — required
- Cannot reach any DB, Kafka, Redis, or application service (NetworkPolicy blocks)

**With PERMISSIVE mTLS**:
- Outbound traffic may be plaintext within cluster network → telemetry data visible on the wire
- AuthorizationPolicy NOT enforced → if NetworkPolicy is misconfigured, no second line of defense

**With STRICT mTLS (after migration)**:
- All traffic encrypted
- AuthorizationPolicy enforced by ztunnel as second line of defense
- Lateral movement: cannot reach anything outside Loki/Tempo/DNS

**Assessment**: Low lateral movement risk. OTel Collector is a data sink with limited egress.

### Scenario 2: Compromised Grafana Pod

**Current exposure**:
- Can reach Prometheus (9090), Loki (3100), Tempo (3200) — by design
- Can reach any namespace on any port (no egress NetworkPolicy in observability)
- NodePort 32500 exposed to host — protected by Grafana login credentials
- AuthorizationPolicy is ALLOW-ALL (required for NodePort)

**Risk**: Medium. Grafana is the highest-risk observability pod due to:
1. External NodePort access (wider attack surface)
2. No egress restrictions (can probe internal services)
3. ALLOW-ALL AuthorizationPolicy
4. Admin credentials may be weak (CHANGE_ME placeholder)

**Remediation**:
- Add egress NetworkPolicy (restrict to Prometheus, Loki, Tempo, DNS only)
- Use strong admin credentials
- Consider restricting admin access to read-only for non-admin users

### Scenario 3: Compromised Prometheus Pod

**Current exposure**:
- Ingress: Grafana (9090), Kiali (9090), HBONE (15008)
- Egress: ALL namespaces (required for scraping)
- Has ClusterRole with broad read access (nodes, pods, services, endpoints)
- STRICT mTLS enforced (mesh-enrolled)

**Risk**: Medium-High if compromised. Prometheus has the broadest network reach of any observability pod (scrapes all namespaces). Its ServiceAccount has cluster-wide RBAC read access.

**Mitigations**:
- AuthorizationPolicy enforced (only observability and istio-system can reach it)
- STRICT mTLS (cannot be impersonated)
- Read-only RBAC (cannot modify resources)

### Scenario 4: Compromised Loki/Tempo Pod

**Current exposure**:
- Ingress: OTel Collector + Grafana only (NetworkPolicy)
- Egress: DNS only (NetworkPolicy)
- Runs as non-root (UID 10001)
- No RBAC, no ServiceAccount privileges

**Risk**: Very Low. These are pure data sinks with minimal egress. Cannot reach any other service except DNS.

### Scenario 5: Compromised PostgreSQL Instance

**Current exposure**:
- ecom-db: reachable from ecom namespace + infra (Debezium) only
- inventory-db: reachable from inventory namespace + infra only
- analytics-db: reachable from infra (Flink JDBC) + analytics (Superset) only
- keycloak-db: reachable from identity namespace only
- No egress rules (all DB pods have `egress: []` or no egress policy)

**Risk**: Low for lateral movement (NetworkPolicy restricts ingress tightly). However, containers run without explicit non-root enforcement (Finding-11).

---

## 12. Findings Summary

### Critical (Must Fix)

| ID | Finding | Affected | Remediation |
|----|---------|----------|-------------|
| F-11 | PostgreSQL instances missing runAsNonRoot | ecom-db, inventory-db, analytics-db, keycloak-db | Add `runAsNonRoot: true`, `runAsUser: 70` |

### High (Should Fix)

| ID | Finding | Affected | Remediation |
|----|---------|----------|-------------|
| F-10 | Container-level securityContext missing | Kafka, Redis, Keycloak, Prometheus, OTel Collector | Add `allowPrivilegeEscalation: false`, `capabilities.drop: ["ALL"]` |
| F-4 | NetworkPolicies missing for 3 namespaces | analytics, identity, infra | Create default-deny + explicit-allow policies |

### Medium

| ID | Finding | Affected | Remediation |
|----|---------|----------|-------------|
| F-1 | otel namespace PERMISSIVE mTLS | otel | Follow STRICT migration guide |
| F-5 | observability namespace missing egress policy | observability | Add egress NetworkPolicy per pod |
| F-13 | kube-state-metrics ClusterRole reads secrets | observability | Remove `secrets` from resource list |
| F-18 | 4 services use `:latest` image tags | Grafana, AlertManager, Kafka, Schema Registry | Pin to specific versions |
| F-12 | readOnlyRootFilesystem not enforced | Most services | Enable where feasible |

### Low

| ID | Finding | Affected | Remediation |
|----|---------|----------|-------------|
| F-2 | NodePort PERMISSIVE exceptions | 7 services | Acceptable for dev; use ingress + TLS in prod |
| F-3 | infra-up.sh inline PERMISSIVE PeerAuth | scripts/infra-up.sh | Remove inline block |
| F-6 | HBONE port 15008 open to all sources | All NetworkPolicies | Standard Istio Ambient pattern; no fix needed |
| F-7 | Grafana AuthorizationPolicy is ALLOW-ALL | observability | Required for NodePort; add ingress in prod |
| F-14 | Most pods use `default` ServiceAccount | analytics, identity, infra, otel | Create dedicated SAs |
| F-16 | Redis password in command args | infra | Use config file from Secret |

### Informational

| ID | Finding | Notes |
|----|---------|-------|
| F-8 | otel AuthorizationPolicies not enforced | Will be enforced after STRICT migration |
| F-9 | RequestAuthentication only in ecom + inventory | Correct by design |
| F-15 | Placeholder passwords (CHANGE_ME) | POC only |
| F-17 | Debezium cross-namespace secret copy | Correctly implemented |

---

## 13. Remediation Plan

### Phase 1: Container Hardening (Quick Wins)

**Effort**: Low | **Impact**: High

1. Add container-level securityContext to Kafka, Redis, Keycloak, Prometheus, OTel Collector:
   ```yaml
   securityContext:
     allowPrivilegeEscalation: false
     capabilities:
       drop: ["ALL"]
   ```

2. Add pod-level securityContext to all PostgreSQL instances:
   ```yaml
   securityContext:
     runAsNonRoot: true
     runAsUser: 70
     fsGroup: 999
   ```

3. Pin image tags:
   - `grafana/grafana:latest` → `grafana/grafana:11.5.2`
   - `prom/alertmanager:latest` → `prom/alertmanager:v0.27.0`
   - `confluentinc/cp-kafka:latest` → `confluentinc/cp-kafka:7.7.1`
   - `confluentinc/cp-schema-registry:latest` → `confluentinc/cp-schema-registry:7.7.1`

### Phase 2: Network Hardening

**Effort**: Medium | **Impact**: Medium

4. Create NetworkPolicies for analytics, identity, infra namespaces (default deny + explicit allow)
5. Add egress NetworkPolicy to observability namespace (restrict Grafana, AlertManager, kube-state-metrics)
6. Remove inline PERMISSIVE PeerAuth from `infra-up.sh`

### Phase 3: STRICT mTLS Migration

**Effort**: Medium | **Impact**: Medium

7. Follow `docs/guides/otel-strict-mtls-migration-guide.md`:
   - Remove `ambient.istio.io/redirection: disabled` from OTel Collector, Loki, Tempo
   - Change otel PeerAuth to STRICT
   - Verify data flow + run E2E tests

### Phase 4: Fine-Grained Access Control

**Effort**: High | **Impact**: Low (defense-in-depth)

8. Create dedicated ServiceAccounts for all deployments
9. Review kube-state-metrics ClusterRole (remove `secrets` if not needed)
10. Enable `readOnlyRootFilesystem` where feasible
11. Move Redis password to config file

---

## 14. Appendix: File Inventory

### Security Resources

| File | Type | Namespace(s) |
|------|------|-------------|
| `infra/istio/security/peer-auth.yaml` | PeerAuthentication | ecom, inventory, analytics, identity, infra, otel, observability |
| `infra/istio/security/request-auth.yaml` | RequestAuthentication | ecom, inventory |
| `infra/istio/security/authz-policies/ecom-service-policy.yaml` | AuthorizationPolicy | ecom |
| `infra/istio/security/authz-policies/ecom-db-policy.yaml` | AuthorizationPolicy | ecom |
| `infra/istio/security/authz-policies/inventory-service-policy.yaml` | AuthorizationPolicy | inventory |
| `infra/istio/security/authz-policies/inventory-db-policy.yaml` | AuthorizationPolicy | inventory |
| `infra/istio/security/authz-policies/analytics-policy.yaml` | AuthorizationPolicy | analytics |
| `infra/istio/security/authz-policies/keycloak-db-policy.yaml` | AuthorizationPolicy | identity |
| `infra/istio/security/authz-policies/otel-policy.yaml` | AuthorizationPolicy | otel |
| `infra/istio/security/authz-policies/observability-policy.yaml` | AuthorizationPolicy | observability |
| `infra/kubernetes/network-policies/ecom-netpol.yaml` | NetworkPolicy | ecom |
| `infra/kubernetes/network-policies/inventory-netpol.yaml` | NetworkPolicy | inventory |
| `infra/kubernetes/network-policies/otel-netpol.yaml` | NetworkPolicy | otel |
| `infra/kubernetes/network-policies/observability-netpol.yaml` | NetworkPolicy | observability |

### Deployment Manifests Reviewed

| File | Namespace | Pod(s) |
|------|-----------|--------|
| `infra/observability/otel-collector.yaml` | otel | otel-collector |
| `infra/observability/loki/loki.yaml` | otel | loki |
| `infra/observability/tempo/tempo.yaml` | otel | tempo |
| `infra/observability/grafana/grafana.yaml` | observability | grafana |
| `infra/observability/prometheus/prometheus.yaml` | observability | prometheus |
| `infra/observability/alertmanager/alertmanager.yaml` | observability | alertmanager |
| `infra/observability/kube-state-metrics/kube-state-metrics.yaml` | observability | kube-state-metrics |
| `infra/schema-registry/schema-registry.yaml` | infra | schema-registry |
| `infra/kafka/kafka.yaml` | infra | kafka |
| `infra/redis/redis.yaml` | infra | redis |
| `infra/keycloak/keycloak.yaml` | identity | keycloak, keycloak-db |
| `infra/debezium/debezium-server-ecom.yaml` | infra | debezium-server-ecom |
| `infra/debezium/debezium-server-inventory.yaml` | infra | debezium-server-inventory |
| `infra/postgres/ecom-db.yaml` | ecom | ecom-db |
| `infra/postgres/inventory-db.yaml` | inventory | inventory-db |
| `infra/postgres/analytics-db.yaml` | analytics | analytics-db |
