# Architecture Review & Proposed Architecture
## E-Commerce Microservices Platform — Detailed Technical Assessment

> **Scope:** Full architecture review of Sessions 1–18 implementation, security analysis, and a
> proposed production-grade target architecture designed for large traffic, maintainability, and
> security. Intended as the foundation for future enhancement roadmap.
>
> **Date:** 2026-03-01 | **Current State:** 89/89 E2E tests passing, kind cluster (3 nodes)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current Architecture Review](#2-current-architecture-review)
   - 2.1 Strengths
   - 2.2 Weaknesses & Gaps
   - 2.3 Production Readiness Scorecard
3. [Security Review](#3-security-review)
   - 3.1 Current Security Posture
   - 3.2 Security Gaps & Vulnerabilities
   - 3.3 Security Recommendations
4. [Proposed Architecture](#4-proposed-architecture)
   - 4.1 Design Principles
   - 4.2 Architecture Overview
   - 4.3 Layer-by-Layer Breakdown
5. [Service Decomposition Recommendations](#5-service-decomposition-recommendations)
6. [Data Architecture Recommendations](#6-data-architecture-recommendations)
7. [Observability Strategy](#7-observability-strategy)
8. [Migration Roadmap (Phased)](#8-migration-roadmap-phased)
9. [Technology Decision Matrix](#9-technology-decision-matrix)

---

## 1. Executive Summary

The current platform is a well-structured, production-aligned Proof of Concept with excellent
foundations: Istio Ambient mTLS, OIDC/PKCE authentication, Kafka CDC pipeline, and Apache Flink
SQL analytics. It demonstrates genuine architectural maturity for a POC.

However, transitioning this to a **real e-commerce platform at scale** requires addressing
critical gaps across five dimensions:

| Dimension | Current Grade | Target Grade | Priority |
|-----------|--------------|-------------|----------|
| **Resilience** | D — no circuit breakers, no retry | A | Critical |
| **Observability** | D — no traces, no log agg, no custom metrics | A | Critical |
| **Security** | C — good mesh, gaps in secrets & rate limiting | A | Critical |
| **Scalability** | C — HPA exists, no event-driven scaling | A | High |
| **Maintainability** | B — clean code, no GitOps | A | High |
| **Data Layer** | C — no HA, no caching | A | High |

The proposed architecture adds an **Edge & API Gateway layer**, implements **full-stack
observability** (traces + metrics + logs), introduces **event-driven autoscaling** (KEDA),
hardens security with **Vault + External Secrets**, and adopts **GitOps** (ArgoCD) for
declarative deployment management.

---

## 2. Current Architecture Review

### 2.1 What's Working Well

#### Microservice Isolation
Each service owns its database exclusively. No cross-database access exists. This is the
single most important microservice pattern — correctly implemented. Service boundaries are
clean: E-Commerce handles orders/cart/books, Inventory handles stock, Analytics handles
reporting.

#### Service Mesh (Istio Ambient)
Istio Ambient Mesh with `STRICT` mTLS is correctly applied namespace-wide. The choice of
Ambient (no sidecars) over traditional sidecar mode is forward-looking and reduces resource
overhead by ~30%. All inter-service traffic is encrypted and authenticated at the transport
layer. NetworkPolicies add a second layer of defense.

#### Event-Driven CDC Pipeline
The Debezium → Kafka → Flink SQL pipeline is architecturally sound:
- **No polling** — WAL-based CDC means zero DB overhead for change capture
- **Exactly-once delivery** — Flink checkpoints guarantee no duplicates in analytics-db
- **Schema evolution** — plain JSON format (not Avro) keeps the pipeline flexible for POC

#### Identity Management
Keycloak with OIDC Authorization Code + PKCE is the correct choice for SPA authentication.
Tokens stored in memory (never localStorage) is a security best practice. The JWT validation
at both the API gateway and service levels provides defense-in-depth.

#### Deployment Automation
The `up.sh` smart script that auto-detects cluster state (fresh/degraded/healthy) is
excellent operational tooling. Idempotent scripts are a strong DevOps practice.

---

### 2.2 Weaknesses & Gaps

#### A. Resilience — CRITICAL

**No Circuit Breakers Anywhere**

The ecom-service calls inventory-service synchronously on every checkout. If inventory-service
becomes slow or unavailable, ecom-service threads block. With no timeout configured, a stuck
inventory service cascades into a full ecom-service outage.

```
Current:
ecom-service ──(sync HTTP)──► inventory-service
     │                             │
     └── blocks indefinitely if inventory slow/down
     └── no retry, no exponential backoff
     └── no fallback strategy

Problem:
5 pods × 10 Tomcat threads = 50 threads max
If inventory takes 10s: 50 checkout requests fill all threads → ecom-service 503
```

**No Kafka Dead-Letter Queue**

The `order.created` consumer in inventory-service has no error handling for poison messages.
A single malformed message can stall the entire Kafka consumer partition.

**No Database Connection Pool Limits under Scale**

With HPA scaling ecom-service to 5 pods, max connections = 5 × 10 = 50. PostgreSQL
default `max_connections = 100`. While currently safe, adding more services or pods
exhausts connections quickly.

---

#### B. Observability — CRITICAL

**No Distributed Tracing**

A checkout request touches: UI → ecom-service → inventory-service (sync) + Kafka (async) →
Flink → analytics-db → Superset. There is no way to answer:
- "Why did this specific order take 3 seconds?"
- "Which service caused the latency spike at 14:32?"
- "Did the inventory reserve fail before or after Kafka publish?"

The OpenTelemetry Collector is deployed but no application sends traces to it.

**No Log Aggregation**

Logs go to stdout only. To investigate an incident, you must `kubectl logs` each pod
individually. With multiple replicas + multiple services, this is operationally impossible.

**No Custom Business Metrics**

Prometheus scrapes JVM and Istio metrics but no application-level metrics:
- Orders per minute
- Checkout success/failure rate
- Average cart size
- Inventory reserve failures
- Kafka consumer lag (critical for CDC health monitoring)

**Prometheus Data is Ephemeral**

Prometheus uses `emptyDir` storage — all historical metrics are lost on pod restart. This
means you cannot investigate past incidents.

---

#### C. Caching — HIGH

**Redis Deployed, Unused for Application Caching**

Redis is deployed for CSRF tokens only. The most expensive queries hit the database directly
on every request:

| Query | Frequency | DB Cost | Cache Potential |
|-------|-----------|---------|----------------|
| `GET /books` (catalog) | Every page load | Full table scan + pagination | Very high (TTL 5min) |
| `GET /books/{id}` | Every product view | Single row lookup | Very high (TTL 30min) |
| `GET /stock/{book_id}` | Every checkout page | Single row lookup | Medium (TTL 30s) |
| JWKS public keys | Every JWT validation | External HTTP + parse | Very high (TTL 1hr) |

Without caching, the database becomes the bottleneck as traffic grows. PostgreSQL can handle
~1,000–5,000 simple reads/sec on small hardware, but a book catalog with thousands of
products and hundreds of concurrent users will exceed this quickly.

---

#### D. Rate Limiting — HIGH

Bucket4j 8.10.1 is declared as a Maven dependency but **never implemented**. There are zero
rate limiting rules in the entire codebase. This means:

- A bot can hammer `GET /books/search?q=...` millions of times per hour
- A malicious user can attempt thousands of checkout requests
- No per-IP or per-user throttling exists
- The platform is vulnerable to trivial scraping and resource exhaustion attacks

---

#### E. Data Layer — HIGH

**No Database High Availability**

All four PostgreSQL instances are single-pod with no replication. A pod restart loses
the in-flight connection pool and causes a brief outage. A node failure loses the database
entirely (PVC is node-bound with `local-hostpath`).

**No Read/Write Separation**

All reads and writes go to the same PostgreSQL instance. Under high read traffic (catalog
browsing), writes (orders) compete for the same connection pool and I/O resources.

**Kafka Topics Lost on Restart**

Kafka uses `emptyDir` for topic data. All CDC events are lost when Kafka pod restarts.
Debezium connectors must be re-registered and Flink jobs restart from earliest offset, which
may replay all historical events unnecessarily.

---

#### F. Search — MEDIUM

`GET /books/search?q=...` performs a `LIKE '%query%'` on PostgreSQL. This:
- Cannot use indexes efficiently (leading wildcard)
- Returns results with no relevance ranking
- Cannot support faceted search (by genre, author, price range)
- Does not support typo tolerance (fuzzy matching)
- Becomes extremely slow as the book catalog grows

---

#### G. Deployment — MEDIUM

**No GitOps**

All deployments are done via `kubectl apply` from shell scripts. There is no:
- Drift detection (who changed what in the cluster?)
- Audit trail of deployments
- Automated rollback on health check failure
- Progressive delivery (canary, blue/green)

**No Secret Rotation**

Kubernetes Secrets contain static credentials (PostgreSQL passwords, etc.) with no rotation
policy. A compromised secret requires manual intervention: update secret, restart pods.

---

### 2.3 Production Readiness Scorecard

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    PRODUCTION READINESS SCORECARD                        │
├────────────────────────┬──────────┬─────────────────────────────────────┤
│ Category               │  Score   │ Key Issues                          │
├────────────────────────┼──────────┼─────────────────────────────────────┤
│ Authentication/AuthZ   │ ████░ B+ │ JWT ✓, mTLS ✓, no MFA for admin    │
│ Circuit Breaking       │ ░░░░░ F  │ Zero circuit breakers anywhere      │
│ Retry & Timeout        │ ░░░░░ F  │ No retry, no timeout configured     │
│ Rate Limiting          │ ░░░░░ F  │ Declared but never implemented      │
│ Caching                │ █░░░░ D  │ Redis deployed, not used for cache  │
│ Distributed Tracing    │ ░░░░░ F  │ OTEL collector deployed, unused     │
│ Log Aggregation        │ ░░░░░ F  │ stdout only, no central search      │
│ Custom Metrics         │ █░░░░ D  │ JVM metrics, no business metrics    │
│ Database HA            │ ░░░░░ F  │ Single-pod PostgreSQL, no replicas  │
│ Kafka Persistence      │ █░░░░ D  │ emptyDir (lost on restart)          │
│ Search                 │ █░░░░ D  │ LIKE query, no relevance ranking    │
│ GitOps/CD              │ ██░░░ C  │ Scripts exist, no ArgoCD            │
│ Secret Management      │ ██░░░ C  │ K8s Secrets, no Vault/rotation      │
│ Scaling                │ ███░░ B- │ HPA ✓, no event-driven scaling      │
│ Service Isolation      │ █████ A  │ DB isolation ✓, NetworkPolicy ✓     │
│ Event-Driven CDC       │ ████░ A- │ Debezium+Flink ✓, no persistence    │
└────────────────────────┴──────────┴─────────────────────────────────────┘
```

---

## 3. Security Review

### 3.1 Current Security Posture

**Strengths:**

| Control | Implementation | Assessment |
|---------|---------------|------------|
| Transport Encryption | Istio Ambient mTLS STRICT | Excellent — all pod-to-pod traffic encrypted |
| Authentication | Keycloak OIDC + JWT | Excellent — industry-standard, PKCE for SPA |
| Token Storage | In-memory only (never localStorage) | Excellent — mitigates XSS token theft |
| Network Segmentation | Kubernetes NetworkPolicy per namespace | Good — limits blast radius |
| Container Security | Non-root, readOnlyRootFilesystem, drop ALL caps | Excellent |
| AuthorizationPolicy | Istio L4 policies per namespace | Good — service-to-service allow-list |
| Database Isolation | One DB per service, no cross-access | Excellent |

---

### 3.2 Security Gaps & Vulnerabilities

#### GAP 1: No Rate Limiting (DDoS / Brute Force Risk) — CRITICAL

**Risk:** Public endpoints (`GET /books`, `GET /books/search`) have no rate limiting. An
attacker can exhaust database connections or cause OOM with high-volume requests. The
`/checkout` endpoint (authenticated) has no per-user limit, enabling automated fraud.

**Attack scenario:**
```
Attacker → 10,000 req/sec → GET /books/search?q=aaa
         → 10,000 PostgreSQL connections exhausted
         → All legitimate users get 503
```

**Fix:** Implement per-IP rate limiting at the API Gateway + per-user rate limiting in
application middleware. See Section 4.3.2.

---

#### GAP 2: JWT Validation Weaknesses — HIGH

**Risk 1 — No `aud` (audience) claim validation**

The Spring Boot security config validates issuer and signature but there is no evidence
of `audience` validation. An access token issued for a different client (e.g., an admin
portal) can be used against the ecom-service API.

```yaml
# Current (application.yml) — missing audience validation:
spring.security.oauth2.resourceserver.jwt:
  jwk-set-uri: ${KEYCLOAK_JWKS_URI}
  issuer-uri: ${KEYCLOAK_ISSUER_URI}
  # Missing: audiences: [ecom-service]
```

**Risk 2 — Token Replay Attacks**

JWT tokens are valid until expiry (~15 minutes). If a token is intercepted (even over TLS,
via XSS), there is no server-side token revocation mechanism. Keycloak supports token
introspection but it is not used.

**Risk 3 — JWKS Cache Poisoning**

The inventory-service caches JWKS as a global in-memory singleton with no TTL. If Keycloak
rotates its signing keys, the cached JWKS becomes stale and all JWT validations fail.

---

#### GAP 3: Secrets Management — HIGH

**Risk:** All secrets are stored as Kubernetes Secrets (base64-encoded, not encrypted). In
kind, etcd is not encrypted at rest by default. Any user with `kubectl get secret` access
can decode all credentials immediately.

```bash
# Any user with RBAC access can do this:
kubectl get secret ecom-db-secret -n ecom -o json | jq '.data | map_values(@base64d)'
# → {"POSTGRES_PASSWORD": "actualpassword"}
```

**Specific risks:**
- PostgreSQL passwords: static, never rotated
- Keycloak admin password: static
- Debezium DB credentials: static, stored in K8s Secret
- No audit log of secret access

---

#### GAP 4: Missing Input Validation at API Gateway — HIGH

**Risk:** No Web Application Firewall (WAF) or input sanitization at the gateway level.
Each service must independently validate all inputs. If a service has a validation bug:

- SQL injection via search queries (the Spring Data JPA parameterized queries mitigate this,
  but custom queries could be vulnerable)
- Path traversal in book ID parameters
- Large payload attacks (no max request body size at gateway)
- Header injection attacks

---

#### GAP 5: CORS Configuration — MEDIUM

**Risk:** The UI's Content Security Policy is set in Nginx config, but CORS headers on
the backend APIs are controlled by Spring Boot and FastAPI individually. There is no
centralized CORS policy:

- `GET /ecom/books` — Spring Boot allows any origin (not configured = Spring default = any)
- `POST /inven/reserve` — FastAPI has no CORS middleware configured

A compromised third-party site could make cross-origin requests to these APIs using a
victim user's credentials (CSRF via XHR).

---

#### GAP 6: No mTLS Certificate Rotation Policy — MEDIUM

**Risk:** Istio automatically manages mTLS certificates, but there is no monitoring of
certificate expiry or rotation success. If Istio's certificate authority (istiod) fails to
rotate certificates (e.g., due to a bug), pods continue to use expired certificates until
they are restarted, at which point mTLS connections fail silently.

No alerting exists for certificate rotation failures.

---

#### GAP 7: Container Image Supply Chain — MEDIUM

**Risk:** All Docker images are built locally with no vulnerability scanning:
- `postgres:15`, `confluentinc/cp-kafka:latest`, `quay.io/debezium/connect:2.7.0.Final`
  etc. are pulled without digest pinning
- `:latest` tags for some images mean unexpected breaking changes can be pulled
- No Software Bill of Materials (SBOM) for audit purposes
- No image signing (Sigstore/Cosign)

---

#### GAP 8: Excessive Pod Permissions (RBAC) — MEDIUM

**Risk:** Service accounts `ecom-service` and `inventory-service` exist but have no
associated RBAC Roles/RoleBindings. Services run with the default service account's
permissions in some cases. The Prometheus service account has `ClusterRole` with broad
pod/node listing permissions — if Prometheus is compromised, an attacker gains cluster
metadata visibility.

---

#### GAP 9: No Egress Controls — MEDIUM

**Risk:** NetworkPolicies control ingress traffic but there are no egress rules restricting
which external services pods can connect to. A compromised pod could:
- Exfiltrate database contents to an external server
- Connect to command-and-control infrastructure
- Download additional malicious payloads

---

#### GAP 10: Missing Security Headers — LOW

**Risk:** The Nginx config sets basic headers (X-Frame-Options, X-Content-Type-Options) but
is missing:
- `Permissions-Policy` (restrict browser APIs)
- `Cross-Origin-Embedder-Policy` (COEP)
- `Cross-Origin-Opener-Policy` (COOP)
- Subresource Integrity (SRI) for external CDN assets

---

### 3.3 Security Recommendations

**Priority 1 — Implement Rate Limiting (Immediate)**
```
API Gateway: 100 req/min per IP for public endpoints
             10 req/min per user for /checkout
Application: Bucket4j with Redis (already declared in pom.xml)
```

**Priority 2 — Add JWT Audience Validation**
```yaml
# application.yml
spring.security.oauth2.resourceserver.jwt:
  audiences: ["ecom-service"]
```

**Priority 3 — Deploy HashiCorp Vault + External Secrets Operator**
```
All K8s Secrets → External Secrets pulling from Vault
Vault auto-rotates PostgreSQL passwords every 30 days
Vault audit log records all secret accesses
```

**Priority 4 — Add CORS Policy at Gateway**
```
Centralized CORS in Istio VirtualService or API Gateway
Allowlist: only myecom.net:30000
```

**Priority 5 — Pin Docker Image Digests**
```
FROM postgres@sha256:abc123...  (not :15)
Trivy scanning in CI pipeline for each build
```

**Priority 6 — Implement Token Introspection for Sensitive Ops**
```
POST /checkout → validate token against Keycloak introspection endpoint
(confirms token is not revoked, even within TTL window)
```

**Priority 7 — Add NetworkPolicy Egress Rules**
```yaml
# Restrict egress to known services only
egress:
  - to: [keycloak.identity, ecom-db.ecom, kafka.infra]
    ports: [5432, 9092, 8080]
```

**Priority 8 — Image Vulnerability Scanning**
```
GitHub Actions: trivy scan on every PR + weekly cron scan of deployed images
Block deployment if CRITICAL vulnerabilities found
```

---

## 4. Proposed Architecture

### 4.1 Design Principles

The proposed architecture is guided by these principles, aligned with real-world e-commerce
at scale (think: a book store growing from 100 to 1,000,000 daily active users):

1. **Resilience First** — Every service-to-service call has circuit breaker, retry with
   exponential backoff, and timeout. Systems degrade gracefully.

2. **Observability is Not Optional** — Traces, metrics, and logs are built in from day one.
   Every request generates a trace ID that links all related log entries and spans.

3. **Event-Driven Scaling** — Autoscaling is driven by business signals (Kafka consumer lag,
   request queue depth) not just CPU%.

4. **Defense in Depth** — Security controls at every layer: Edge (WAF), Gateway (authN/authZ,
   rate limiting), Service Mesh (mTLS), Application (input validation), Database (row-level
   security).

5. **GitOps** — No human directly applies manifests to production. All changes flow through
   Git → ArgoCD → Kubernetes.

6. **Data Sovereignty** — Each bounded context owns its data. Cross-context reads go through
   APIs or event streams, never direct DB joins.

---

### 4.2 Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              PROPOSED ARCHITECTURE                               │
│                        (Target State — Production Scale)                         │
└─────────────────────────────────────────────────────────────────────────────────┘

 ┌──────────────────────────────────────────────────────────────────────────┐
 │                          CLIENTS                                          │
 │  Web Browser (React SPA)  │  Mobile App  │  Third-party API Consumers   │
 └──────────────────────────────────────────────────────────────────────────┘
                                     │
                    ┌────────────────▼─────────────────┐
                    │         EDGE LAYER               │
                    │  CDN (CloudFlare / Fastly)       │
                    │  DDoS Protection + WAF           │
                    │  TLS Termination                 │
                    │  Static Asset Caching            │
                    └────────────────┬─────────────────┘
                                     │
                    ┌────────────────▼─────────────────┐
                    │       API GATEWAY LAYER           │
                    │  Kong / AWS API Gateway           │
                    │  • Rate Limiting (per IP + user)  │
                    │  • JWT Validation (centralized)   │
                    │  • Request/Response Transform     │
                    │  • API Versioning (/v1, /v2)      │
                    │  • Circuit Breaker (global)       │
                    │  • Request Tracing (inject IDs)   │
                    └────┬──────────────────────────┬──┘
                         │                          │
          ┌──────────────▼──┐           ┌──────────▼─────────┐
          │  IDENTITY LAYER  │           │   SERVICE MESH      │
          │  Keycloak 26.x   │           │  Istio Ambient 1.x  │
          │  • OIDC/PKCE     │           │  • mTLS STRICT      │
          │  • MFA (TOTP)    │           │  • Waypoint Proxy   │
          │  • Social Login  │           │  • L7 AuthzPolicy   │
          │  • Token Revoke  │           │  • Retry/Timeout    │
          └──────────────────┘           └────────────────────┘
                                                  │
 ┌────────────────────────────────────────────────┼────────────────────────┐
 │                   MICROSERVICES LAYER          │                         │
 │                                                │                         │
 │  ┌─────────────────┐  ┌──────────────────┐  ┌─▼───────────────────┐   │
 │  │  E-Commerce Svc  │  │  Inventory Svc   │  │  Notification Svc   │   │
 │  │  Spring Boot 4   │  │  FastAPI + Python │  │  (NEW) Node.js      │   │
 │  │  HPA: 2–20 pods  │  │  HPA: 2–10 pods  │  │  Email / SMS / Push │   │
 │  │  Resilience4j:   │  │  httpx retry +   │  │  Template-driven    │   │
 │  │  Circuit Breaker  │  │  circuit breaker │  │  Kafka consumer     │   │
 │  │  Retry (exp.boff) │  │  Kafka DLQ       │  └──────────────────────┘  │
 │  └────────┬─────────┘  └──────────┬───────┘                             │
 │           │                       │                                       │
 │  ┌────────▼──────────────────────▼──────────────────────────────────┐  │
 │  │                      EVENT BUS (Kafka)                             │  │
 │  │  Topics: order.created, order.confirmed, order.cancelled          │  │
 │  │          inventory.updated, inventory.depleted                     │  │
 │  │          notification.email, notification.sms                      │  │
 │  │          payment.initiated, payment.confirmed                      │  │
 │  │  Schema Registry (Confluent / Apicurio) — Avro schemas            │  │
 │  │  Dead-Letter Queues: *.dlq per topic                               │  │
 │  │  Kafka Persistence: PVC-backed (not emptyDir)                      │  │
 │  │  KEDA autoscaling: consumer lag → pod count                        │  │
 │  └───────────────────────────────────────────────────────────────────┘  │
 └────────────────────────────────────────────────────────────────────────-┘
                    │                          │
 ┌──────────────────▼──────────────┐  ┌───────▼────────────────────────────┐
 │         DATA LAYER               │  │         SEARCH LAYER                │
 │                                  │  │                                      │
 │  ecom-db:                        │  │  Elasticsearch / OpenSearch          │
 │    Primary (writes)              │  │  • Full-text book search             │
 │    Replica (reads) ←─PgBouncer  │  │  • Faceted filtering                 │
 │                                  │  │  • Fuzzy matching (typos)            │
 │  inventory-db:                   │  │  • Relevance ranking                 │
 │    Primary (writes)              │  │  • Auto-complete                     │
 │    Replica (reads)               │  │                                      │
 │                                  │  │  Sync: Debezium → Kafka → ES Index  │
 │  Redis Cluster:                  │  └──────────────────────────────────────┘
 │    • Book catalog cache (5 min)  │
 │    • Stock level cache (30 sec)  │  ┌─────────────────────────────────────┐
 │    • Session/CSRF tokens         │  │       PAYMENT SERVICE (NEW)          │
 │    • Rate limit counters         │  │  Stripe / PayPal integration         │
 │    • Distributed locks           │  │  Idempotency keys (Redis)            │
 │                                  │  │  PCI-DSS isolation (separate NS)     │
 └──────────────────────────────────┘  └──────────────────────────────────────┘
                    │
 ┌──────────────────▼───────────────────────────────────────────────────────┐
 │                         ANALYTICS LAYER                                    │
 │                                                                            │
 │  Debezium → Kafka → Flink SQL (4+ jobs) → analytics-db (PostgreSQL)      │
 │                                               ↓                            │
 │  Superset (3+ dashboards) ← 10+ SQL Views ← analytics-db                 │
 │                                                                            │
 │  Data Warehouse (future): Snowflake / BigQuery for historical analysis    │
 └────────────────────────────────────────────────────────────────────────────┘
                    │
 ┌──────────────────▼───────────────────────────────────────────────────────┐
 │                       OBSERVABILITY STACK                                  │
 │                                                                            │
 │  Traces:   OpenTelemetry SDK → OTEL Collector → Jaeger / Grafana Tempo   │
 │  Metrics:  Prometheus (PVC-backed) → Grafana Dashboards + Alerts          │
 │  Logs:     Fluent Bit → Loki → Grafana (structured JSON logs)            │
 │  Uptime:   Alertmanager → PagerDuty / Slack (on-call rotation)           │
 │  SLOs:     Pyrra (SLO tracking: 99.9% checkout success rate)             │
 └────────────────────────────────────────────────────────────────────────────┘
                    │
 ┌──────────────────▼───────────────────────────────────────────────────────┐
 │                      PLATFORM / GITOPS LAYER                               │
 │                                                                            │
 │  ArgoCD: Git → cluster sync (declarative, drift detection)                │
 │  Vault + External Secrets Operator: secret management + rotation          │
 │  Tekton / GitHub Actions: CI pipeline (test + build + scan + push)       │
 │  Flagger: canary deployments with automatic rollback                      │
 │  Trivy: image vulnerability scanning (block critical CVEs)                │
 └────────────────────────────────────────────────────────────────────────────┘
```

---

### 4.3 Layer-by-Layer Breakdown

#### 4.3.1 Edge Layer — CDN + WAF

**Current:** No CDN. Traffic goes directly to the kind cluster's NodePort.

**Proposed:**

```
CloudFlare (or Fastly) sits in front of everything:

Browser → CloudFlare → Load Balancer → Kubernetes Ingress
              │
              ├── DDoS protection (L3/L4 volumetric attack scrubbing)
              ├── WAF rules (OWASP Top 10: SQLi, XSS, Path Traversal, etc.)
              ├── Bot management (fingerprint-based bot scoring)
              ├── Rate limiting (IP-based, 1,000 req/min, before hitting your servers)
              ├── Static asset caching (UI assets, JS/CSS bundles with long TTLs)
              └── TLS termination (offloads crypto from your services)
```

**Why this matters at scale:**

A launch-day traffic spike (e.g., book sale event) can be 100x normal traffic. Without
a CDN, this hits your Kubernetes cluster directly. With CloudFlare, 80%+ of static asset
requests never reach your cluster (cached at edge), and burst traffic is absorbed.

**Recommendation:** Use CloudFlare Free/Pro tier initially. It handles up to millions of
requests per day with automatic DDoS protection.

---

#### 4.3.2 API Gateway Layer

**Current:** Kubernetes Gateway API (Istio implementation) handles routing only. No
centralized rate limiting, no auth validation, no request transformation.

**Proposed:** Add Kong Gateway (open source) as a dedicated API Gateway layer.

```
Kong Gateway responsibilities:
┌─────────────────────────────────────────────────────────┐
│  1. Rate Limiting Plugin                                 │
│     - 100 req/min per IP for public endpoints           │
│     - 1,000 req/min per JWT user for protected endpoints│
│     - 10 req/min per user for /checkout (fraud control) │
│                                                          │
│  2. JWT Validation Plugin                               │
│     - Validates token signature, expiry, audience       │
│     - Strips token before forwarding to services        │
│     - Adds X-User-ID header (trusted by internal svcs)  │
│                                                          │
│  3. Request Size Limiting                               │
│     - Max 1MB for POST bodies                           │
│     - Protects against payload flood attacks            │
│                                                          │
│  4. CORS Plugin                                         │
│     - Centralized CORS: allow-list myecom.net only      │
│                                                          │
│  5. Request Tracing                                     │
│     - Inject X-Request-ID header on every request       │
│     - Propagate to all downstream services              │
│                                                          │
│  6. API Versioning                                      │
│     - /v1/books → ecom-service                          │
│     - /v2/books → ecom-service-v2 (canary)             │
└─────────────────────────────────────────────────────────┘
```

**Alternative:** If staying cloud-native, AWS API Gateway (if deploying to EKS) or
Nginx Ingress with annotations. Kong is recommended for self-hosted Kubernetes.

---

#### 4.3.3 Service Resilience — Circuit Breakers & Retry

**Current:** No circuit breakers. Sync call ecom → inventory has no timeout or retry.

**Proposed (ecom-service — Resilience4j):**

```java
// OrderService.java
@CircuitBreaker(name = "inventoryService", fallbackMethod = "reserveFallback")
@Retry(name = "inventoryService")
@TimeLimiter(name = "inventoryService")
public CompletableFuture<ReservationResult> reserveInventory(ReserveRequest request) {
    return CompletableFuture.supplyAsync(
        () -> inventoryClient.reserve(request)
    );
}

// Fallback: queue the order, process asynchronously when inventory recovers
private CompletableFuture<ReservationResult> reserveFallback(
    ReserveRequest request, Exception ex) {
    // Publish to Kafka: order.pending-inventory
    // Return: "Order accepted, processing..."
    return CompletableFuture.completedFuture(ReservationResult.QUEUED);
}
```

**Circuit Breaker Configuration:**
```yaml
# application.yml
resilience4j:
  circuitbreaker:
    instances:
      inventoryService:
        slidingWindowSize: 20
        failureRateThreshold: 50        # Open if 50% of last 20 calls fail
        waitDurationInOpenState: 10s    # Try again after 10s
        permittedNumberOfCallsInHalfOpenState: 5
  retry:
    instances:
      inventoryService:
        maxAttempts: 3
        waitDuration: 200ms
        enableExponentialBackoff: true
        exponentialBackoffMultiplier: 2  # 200ms → 400ms → 800ms
  timelimiter:
    instances:
      inventoryService:
        timeoutDuration: 2s              # Fail fast if inventory takes > 2s
```

**Also add Istio-level retry (mesh-wide backup):**
```yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: inventory-service
  namespace: inventory
spec:
  hosts: [inventory-service]
  http:
  - retries:
      attempts: 3
      perTryTimeout: 2s
      retryOn: "gateway-error,connect-failure,retriable-4xx"
    timeout: 10s
    route:
    - destination:
        host: inventory-service
```

**Kafka Dead-Letter Queue (inventory consumer):**
```python
# inventory-service/app/kafka/consumer.py
async def process_order(msg):
    try:
        await handle_order_created(msg)
    except Exception as e:
        logger.error(f"Failed to process order {msg.key}: {e}")
        # Publish to dead-letter queue
        await producer.send("order.created.dlq", msg.value, headers=msg.headers)
        # Don't re-raise: commit offset to avoid infinite loop
```

---

#### 4.3.4 Caching Strategy

**Current:** Redis deployed, used only for CSRF tokens.

**Proposed — Three-Layer Cache:**

```
Layer 1: Browser Cache
  Static assets (JS, CSS, images) — Cache-Control: max-age=31536000
  API responses (book list) — Cache-Control: max-age=300 (5 minutes)

Layer 2: CDN Cache (CloudFlare)
  GET /v1/books — cached at edge for 60 seconds globally
  GET /v1/books/{id} — cached at edge for 5 minutes
  Bypassed for: authenticated requests, POST/PUT/DELETE

Layer 3: Redis Application Cache
  Book catalog:   cache GET /books results for 5 minutes
  Book detail:    cache GET /books/{id} for 30 minutes (TTL)
  Stock level:    cache GET /stock/{id} for 30 seconds
  JWKS keys:      cache with 60-minute TTL (already in Spring)
```

**Spring Boot Redis Cache Implementation:**
```java
// BookService.java
@Cacheable(value = "books", key = "#pageable.pageNumber + '-' + #pageable.pageSize")
public Page<BookResponse> findAll(Pageable pageable) {
    return bookRepository.findAll(pageable).map(BookResponse::from);
}

@CacheEvict(value = "books", allEntries = true)
@Transactional
public Book create(BookRequest request) { ... }

// application.yml
spring.cache:
  type: redis
  redis:
    time-to-live: 300000  # 5 minutes
```

**Cache Invalidation Strategy:**

The biggest challenge with caching is invalidation. Use the CDC pipeline you already have:

```
PostgreSQL (books table) → Debezium → Kafka (ecom-connector.public.books)
                                           ↓
                                    Cache Invalidation Consumer
                                    (new microservice or ecom-service listener)
                                           ↓
                                    Redis: DEL books:*
```

This way, when an admin updates a book, the cache is automatically invalidated via the
CDC event — no manual cache-busting needed.

---

#### 4.3.5 Database High Availability

**Current:** Single-pod PostgreSQL per service with local-hostpath PVC.

**Proposed:**

```
Development / Local Kind:
  Keep current setup (single-pod, PVC backed by host data/)
  Add PVC-backed Kafka (replace emptyDir)

Staging / Production (cloud or bare-metal):
  PostgreSQL → CloudNativePG Operator
                ├── Primary (accepts writes)
                ├── Replica-1 (read-only, sync replication)
                └── Replica-2 (read-only, async replication, disaster recovery)
                     ↓
                PgBouncer (connection pooler, transaction mode)
                     ↓
                ecom-service (writes → primary, reads → replica)

  Benefits:
  - Zero-downtime failover (replica promoted in < 30s)
  - Read scaling (catalog queries hit replica, not primary)
  - Reduces connection overhead (PgBouncer multiplexes connections)
  - Automatic backups (WAL shipping to S3 / object storage)
```

**PgBouncer Configuration:**
```ini
[databases]
ecomdb = host=ecom-db-primary port=5432 dbname=ecomdb

[pgbouncer]
pool_mode = transaction
max_client_conn = 1000       # external connections (app pods)
default_pool_size = 20       # actual PostgreSQL connections
server_pool_mode = transaction
```

---

#### 4.3.6 Search with Elasticsearch

**Current:** `LIKE '%query%'` SQL query — slow, no ranking, no typo tolerance.

**Proposed:**

```
                                    ┌──────────────────────┐
                                    │   Elasticsearch 8.x   │
ecom-service ──(search query)──────►│   books index         │
                                    │   • title (text)      │
                                    │   • author (keyword)  │
                                    │   • description (text)│
                                    │   • genre (keyword)   │
                                    │   • price (double)    │
                                    └──────────────────────┘
                                              ▲
ecom-db.books ──(CDC)──► Debezium ──► Kafka ─┘
                          (ecom-connector.public.books)
                          → Elasticsearch Sink Connector
```

**Search capabilities unlocked:**
- Fuzzy search: "harrry potter" → finds "Harry Potter"
- Faceted: filter by genre + price range + author simultaneously
- Relevance ranking: title match > description match
- Auto-complete: real-time suggestions as user types
- Highlighting: show matched terms in search results

**Spring Boot search endpoint:**
```java
// BookSearchController.java
@GetMapping("/search")
public SearchResponse search(
    @RequestParam String q,
    @RequestParam(required=false) String genre,
    @RequestParam(required=false) Double minPrice,
    @RequestParam(required=false) Double maxPrice
) {
    var query = SearchQuery.of(q)
        .fuzziness(Fuzziness.ONE)
        .filter(genre != null ? Filter.term("genre", genre) : null)
        .filter(priceRange(minPrice, maxPrice));
    return elasticsearchClient.search(query, Book.class);
}
```

---

#### 4.3.7 Event-Driven Autoscaling (KEDA)

**Current:** HPA scales on CPU/memory only. These metrics lag behind actual load.

**Proposed:** KEDA (Kubernetes Event-Driven Autoscaling) scales on business signals.

```yaml
# Scale inventory-service based on Kafka consumer lag
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: inventory-service-scaler
  namespace: inventory
spec:
  scaleTargetRef:
    name: inventory-service
  minReplicaCount: 2
  maxReplicaCount: 20
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka.infra.svc.cluster.local:9092
      consumerGroup: inventory-kafka-consumer
      topic: order.created
      lagThreshold: "50"        # Scale up if lag > 50 messages
      offsetResetPolicy: latest

---
# Scale ecom-service based on request rate (from Prometheus)
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: ecom-service-scaler
  namespace: ecom
spec:
  scaleTargetRef:
    name: ecom-service
  minReplicaCount: 2
  maxReplicaCount: 20
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.observability:9090
      metricName: http_requests_total
      threshold: "1000"         # Scale up if > 1000 req/min per pod
      query: |
        sum(rate(http_server_requests_seconds_count{
          app="ecom-service",
          uri=~"/ecom/.*"
        }[2m])) * 60
```

**Why event-driven scaling beats CPU scaling:**

| Scenario | CPU-based HPA | KEDA |
|----------|---------------|------|
| 1,000 checkout requests/min arrive | No scale (low CPU) | Scale immediately (request rate trigger) |
| Kafka lag builds up (slow consumer) | No scale | Scale (lag trigger) |
| Flash sale: 10x traffic in 10s | Scale too slowly (CPU takes 2-3min) | Scale in 30s |
| Night traffic drops to zero | Scale to 1 pod | Scale to 0 pods (cost saving) |

---

#### 4.3.8 New Microservice: Payment Service

**Current:** No payment processing. The checkout creates an order without collecting payment.

**Proposed:**

```
POST /checkout:
  Old: ecom-service → creates order → publishes order.created
  New: ecom-service → publishes payment.initiated
         ↓
       payment-service (separate namespace, PCI-DSS isolation)
         ├── Stripe API call
         ├── On success: publishes payment.confirmed
         └── On failure: publishes payment.failed

  ecom-service:
    - Listens to payment.confirmed → sets order status = CONFIRMED
    - Listens to payment.failed → cancels order, publishes inventory.released
```

**PCI-DSS considerations:**
- Payment service in dedicated `payment` namespace with strict NetworkPolicy
- Never stores raw card numbers (Stripe tokenizes)
- Separate K8s Secret for Stripe API key (Vault-managed)
- Audit log of all payment events
- No Istio tracing headers contain payment data (sanitize before export)

---

#### 4.3.9 New Microservice: Notification Service

**Current:** No notifications. User places order and hears nothing until they refresh.

**Proposed:**

```
Kafka topics consumed by notification-service:
  order.confirmed   → Email "Your order #12345 has been confirmed"
  order.cancelled   → Email "Your order was cancelled"
  inventory.depleted → Email "Item back in stock" (wishlist subscribers)

Notification channels:
  Email: AWS SES / SendGrid (template-based)
  SMS:   Twilio (order confirmation)
  Push:  Firebase Cloud Messaging (mobile, future)

notification-service tech stack:
  Node.js + Bull queue (Redis-backed job queue for retries)
  Handlebars email templates
  Rate limiting: max 1 email per event per user per minute
```

---

## 5. Service Decomposition Recommendations

### Current Bounded Contexts

The current services map reasonably well to business domains. The recommended decomposition
for scale adds three new services and extracts search from ecom-service:

```
┌─────────────────────────────────────────────────────────────────┐
│            BOUNDED CONTEXT MAP — PROPOSED                        │
├─────────────────┬───────────────────────────────────────────────┤
│ Context         │ Services                                        │
├─────────────────┼───────────────────────────────────────────────┤
│ Catalog         │ ecom-service (books CRUD + cart)               │
│                 │ search-service (Elasticsearch proxy, optional)  │
├─────────────────┼───────────────────────────────────────────────┤
│ Orders          │ ecom-service (order creation, history)          │
│                 │ payment-service (NEW — PCI-DSS isolated)        │
├─────────────────┼───────────────────────────────────────────────┤
│ Inventory       │ inventory-service (stock management)            │
├─────────────────┼───────────────────────────────────────────────┤
│ Notifications   │ notification-service (NEW — email/SMS/push)     │
├─────────────────┼───────────────────────────────────────────────┤
│ Identity        │ Keycloak (existing)                             │
│                 │ (add: MFA, social login, admin portal)          │
├─────────────────┼───────────────────────────────────────────────┤
│ Analytics       │ Flink SQL pipeline (existing)                   │
│                 │ Superset dashboards (existing)                  │
│                 │ (add: real-time recommendations engine)         │
└─────────────────┴───────────────────────────────────────────────┘
```

### When NOT to Split Further

A common mistake is over-decomposing into too many microservices too early. Resist splitting:

- **Don't** create a separate "Cart Service" — cart is tightly coupled to orders and books.
  Splitting would require distributed transactions (saga pattern) for checkout.
- **Don't** create a separate "Books Service" — catalog and cart reads go together. Extract
  only if catalog needs independent scaling (high read traffic) or separate deployment cadence.
- **Don't** split inventory into "Reservation Service" + "Stock Service" — they share the
  same database rows and need transactional consistency.

---

## 6. Data Architecture Recommendations

### 6.1 Event Schema Registry

**Current:** Kafka messages are plain JSON with no schema enforcement.

**Problem:** As services evolve, producers change message formats and consumers break silently.

**Proposed:** Apicurio Schema Registry (open-source) or Confluent Schema Registry.

```
Producer (ecom-service):
  order.created message → validated against Avro schema v1.3

Consumer (inventory-service):
  reads schema v1.3 from registry → deserializes safely

Schema evolution rules (BACKWARD_TRANSITIVE):
  - OK: add optional field (consumers ignore unknown fields)
  - OK: remove field with default value
  - NOT OK: rename required field (breaking change)
  - NOT OK: change field type

Result: consumers can be deployed before producers update
        producers can be deployed before consumers update
        → independent deployability of services
```

### 6.2 CQRS for Book Catalog

As the catalog grows and read traffic dominates, apply CQRS:

```
Command side (writes):
  POST /books, PUT /books/{id} → ecom-db (PostgreSQL)
  → publishes book.created / book.updated event

Query side (reads):
  GET /books, GET /books/{id}, GET /books/search
  → Redis cache (warm) → Elasticsearch index (fallback)
  → ecom-db (last resort, cache miss + ES miss)

The query side is populated by the CDC pipeline:
  ecom-db.books → Debezium → Kafka → ES Sink Connector → Elasticsearch
                                    → Cache Invalidation Consumer → Redis DEL
```

### 6.3 Saga Pattern for Checkout

**Current:** Checkout is a synchronous call chain with no compensation.

```
Current (synchronous, fragile):
  POST /checkout → reserve() → create order → publish event
  If reserve() fails: no order (ok)
  If create order fails after reserve(): inventory reserved forever (bug!)
```

**Proposed (Choreography-based Saga):**

```
POST /checkout (initiates saga):
  1. ecom-service: publishes payment.initiated {orderId, amount}

  2. payment-service:
     payment.initiated → charge card → publishes payment.confirmed OR payment.failed

  3a. On payment.confirmed:
      ecom-service: creates order (status=CONFIRMED)
      ecom-service: publishes inventory.reserve {orderId, items}
      inventory-service: reserves stock → publishes inventory.reserved

  3b. On payment.failed:
      ecom-service: does nothing (no order created)
      → respond to user with failure

  4. On inventory.depleted (stock out):
      ecom-service: publishes payment.refund
      payment-service: refunds card → publishes payment.refunded
      ecom-service: updates order status=CANCELLED

Compensating transactions ensure consistency without distributed locks.
```

---

## 7. Observability Strategy

### 7.1 The Three Pillars (+ One)

**Current state vs. proposed:**

```
                Current          Proposed
Metrics:        ████░░░░░░  →   ██████████  (Prometheus PVC + custom metrics + Grafana)
Logs:           ██░░░░░░░░  →   ██████████  (Fluent Bit → Loki → Grafana unified)
Traces:         ░░░░░░░░░░  →   ██████████  (OTEL SDK in all services → Jaeger/Tempo)
Events:         ░░░░░░░░░░  →   █████░░░░░  (Kubernetes events → Loki)
```

### 7.2 OpenTelemetry Integration

The OTEL Collector is already deployed. Add OTEL SDK to each service:

**ecom-service (Java/Spring Boot):**
```xml
<!-- pom.xml — zero-code instrumentation -->
<dependency>
  <groupId>io.opentelemetry.instrumentation</groupId>
  <artifactId>opentelemetry-spring-boot-starter</artifactId>
  <version>2.x</version>
</dependency>
```
```yaml
# application.yml
management.tracing:
  sampling.probability: 1.0      # 100% in dev, 10% in prod

otel:
  exporter.otlp.endpoint: http://otel-collector.observability:4317
  resource.attributes.service.name: ecom-service
  propagators: tracecontext,baggage,b3
```

**inventory-service (Python/FastAPI):**
```python
# main.py
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor
from opentelemetry.instrumentation.aio_pika import AioPikaInstrumentor

FastAPIInstrumentor.instrument_app(app)
SQLAlchemyInstrumentor().instrument(engine=engine)
```

**What you get automatically (zero code changes):**
- Every HTTP request generates a trace with spans for DB queries, Kafka publishes
- `X-Request-ID` is the trace ID — appears in all logs automatically
- Slow DB queries appear as long spans in Jaeger
- Kafka produce/consume lag appears in trace timeline

### 7.3 Custom Business Metrics

Add these to ecom-service for actionable alerting:

```java
// OrderService.java
private final MeterRegistry registry;
private final Counter ordersCreated;
private final Counter checkoutFailures;
private final Timer checkoutLatency;
private final Gauge activeCartsGauge;

// In constructor:
ordersCreated = Counter.builder("ecom.orders.created")
    .tag("channel", "web")
    .description("Total orders created")
    .register(registry);

checkoutLatency = Timer.builder("ecom.checkout.duration")
    .publishPercentiles(0.5, 0.95, 0.99)
    .register(registry);

// In checkout():
checkoutLatency.record(() -> {
    ordersCreated.increment();
    // ... checkout logic
});
```

**Alert Rules (Prometheus):**
```yaml
groups:
- name: ecom-alerts
  rules:
  - alert: HighCheckoutFailureRate
    expr: |
      rate(ecom_checkout_failures_total[5m]) /
      rate(ecom_orders_created_total[5m]) > 0.05
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Checkout failure rate > 5% for 2 minutes"

  - alert: InventoryServiceDown
    expr: up{job="inventory-service"} == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Inventory service is down — checkouts will fail"

  - alert: KafkaConsumerLagHigh
    expr: kafka_consumer_group_lag{group="inventory-kafka-consumer"} > 1000
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "Inventory Kafka consumer is falling behind (lag > 1000)"
```

### 7.4 Centralized Logging (Fluent Bit + Loki)

```yaml
# fluent-bit DaemonSet — runs on every node, tails /var/log/containers/
# Adds Kubernetes metadata, sends to Loki
[INPUT]
    Name              tail
    Path              /var/log/containers/*.log
    multiline.parser  docker, cri

[FILTER]
    Name              kubernetes
    Match             *
    Merge_Log         On
    K8s-Logging.Parser On

[OUTPUT]
    Name              loki
    Match             *
    Host              loki.observability
    Port              3100
    Labels            job=fluentbit,namespace=$kubernetes['namespace_name']
```

**Grafana unified view:**
- Trace ID from ecom-service → click → see all logs from all services for that request
- Filter: `{namespace="ecom"} |= "orderId=abc123"` → all log lines across pods
- Alert: `count_over_time({namespace="ecom"} |= "ERROR" [5m]) > 10`

---

## 8. Migration Roadmap (Phased)

### Phase 1: Foundation (Immediate — 2 Weeks)
*Fix the critical gaps that risk data loss or service outages.*

| Task | Why Now | Effort |
|------|---------|--------|
| Implement Bucket4j rate limiting (already in pom.xml) | DDoS risk | 1 day |
| Add JWT audience validation in Spring Security | Token misuse risk | 2 hours |
| Kafka PVC persistence (replace emptyDir) | Topics lost on restart | 1 day |
| Prometheus PVC persistence | Lose all metrics on restart | 2 hours |
| Add Istio retry + timeout policies (DestinationRule) | Service resilience | 1 day |
| Add `order_by_cols` + Superset bootstrap idempotency | Already done ✓ | - |
| Fix CORS policy (Spring Boot + Nginx) | Security gap | 2 hours |

**Acceptance Criteria:** All existing 89 E2E tests pass. Kafka topics survive pod restart.
Rate limiting returns 429 after threshold.

---

### Phase 2: Observability (1 Month)
*You can't improve what you can't measure.*

| Task | Why Now | Effort |
|------|---------|--------|
| Add OTEL SDK to ecom-service (auto-instrumentation) | Trace every request | 1 day |
| Add OTEL SDK to inventory-service | Full trace coverage | 1 day |
| Deploy Jaeger (or Grafana Tempo) | Trace storage + UI | 1 day |
| Deploy Fluent Bit DaemonSet + Grafana Loki | Log aggregation | 2 days |
| Deploy Grafana dashboards (metrics + logs + traces) | Unified observability | 2 days |
| Add custom business metrics (orders/min, checkout latency) | Alert on business KPIs | 1 day |
| Configure Alertmanager → Slack/PagerDuty | On-call alerts | 1 day |

**Acceptance Criteria:** Can trace a single checkout request across all services. Can search
logs in Grafana without `kubectl logs`. Alert fires when checkout failure rate > 5%.

---

### Phase 3: Resilience (1 Month)
*Make the system handle failures gracefully.*

| Task | Why Now | Effort |
|------|---------|--------|
| Add Resilience4j to ecom-service (circuit breaker + retry) | Inventory failures cascade | 3 days |
| Add Kafka DLQ for inventory consumer | Poison messages stall partition | 1 day |
| Implement Redis application cache (books, stock) | DB bottleneck at scale | 3 days |
| Implement cache invalidation via CDC | Keep cache consistent | 2 days |
| Add PostgreSQL read replicas (CloudNativePG) | Read scalability | 3 days |
| Add PgBouncer connection pooler | Connection exhaustion | 1 day |

**Acceptance Criteria:** ecom-service returns 200 (queued) when inventory-service is down.
Book catalog served from Redis cache (DB query count drops 90%).

---

### Phase 4: Deployment & Security Hardening (2 Months)
*Automate operations and harden security.*

| Task | Why | Effort |
|------|-----|--------|
| Deploy ArgoCD (GitOps) | No more manual kubectl apply | 3 days |
| Migrate manifests to Helm charts | Versioned, templated | 1 week |
| Deploy HashiCorp Vault + External Secrets Operator | Secret rotation | 1 week |
| Add Trivy image scanning in CI pipeline | Supply chain security | 2 days |
| Deploy Flagger (canary releases) | Safe deployments | 3 days |
| Add KEDA (Kafka-lag-based autoscaling) | Event-driven scaling | 2 days |
| Egress NetworkPolicy (restrict outbound) | Exfiltration prevention | 2 days |
| Kubernetes RBAC for service accounts | Least privilege | 2 days |

**Acceptance Criteria:** Zero direct kubectl applies to production. Canary deployment rolls
back automatically when error rate > 5%. Secrets rotate without pod restart.

---

### Phase 5: Scale (Ongoing)
*Add new capabilities as traffic grows.*

| Task | When to Add | Trigger |
|------|-------------|---------|
| Elasticsearch for search | When search is > 10% of DB load | |
| CDN (CloudFlare) | Before first public launch | |
| Kong API Gateway | When rate limiting becomes complex | |
| Payment Service | Before accepting real money | Required |
| Notification Service | When users ask "where's my order?" | Required |
| Schema Registry (Avro) | When schema drift causes incidents | |
| Multi-region read replicas | When latency SLA requires < 100ms globally | |
| Data Warehouse (BigQuery) | When Superset queries become slow | |

---

## 9. Technology Decision Matrix

### Keep (Already Good)

| Technology | Reason to Keep |
|-----------|---------------|
| Istio Ambient Mesh | Future-proof, low overhead, excellent mTLS |
| Keycloak | Full-featured IAM, Kubernetes-native, open source |
| Kafka (KRaft) | Correct choice for event streaming, no Zookeeper overhead |
| Debezium | Best-in-class CDC, PostgreSQL WAL native |
| Apache Flink | Exactly-once semantics, SQL DSL, production-grade |
| Apache Superset | Open-source BI, good Kafka/PostgreSQL integration |
| PostgreSQL | Reliable, feature-rich, JSONB for flexible schemas |
| Playwright E2E | Modern, fast, parallel-capable |

### Replace / Upgrade

| Current | Replace With | Reason |
|---------|-------------|--------|
| `emptyDir` for Kafka | PVC (local-hostpath or cloud disk) | Topics survive pod restart |
| `emptyDir` for Prometheus | PVC | Metrics survive pod restart |
| LIKE SQL search | Elasticsearch 8.x | Relevance, fuzzy, facets, autocomplete |
| Manual kubectl apply | ArgoCD GitOps | Audit trail, drift detection, rollback |
| K8s Secrets (plain base64) | Vault + External Secrets Operator | Encryption, rotation, audit |
| CPU-only HPA | KEDA (event-driven) | Scale on business signals (Kafka lag) |
| No circuit breakers | Resilience4j | Fault isolation, cascading failure prevention |

### Add New

| Technology | Purpose | Priority |
|-----------|---------|---------|
| Grafana Loki | Log aggregation + Grafana integration | Critical |
| Grafana Tempo / Jaeger | Distributed tracing backend | Critical |
| Grafana (additional dashboards) | Unified metrics + logs + traces UI | Critical |
| Fluent Bit | Log shipping from pods to Loki | Critical |
| Resilience4j | Circuit breaker + retry (Spring Boot) | Critical |
| KEDA | Event-driven autoscaling | High |
| CloudNativePG | PostgreSQL HA operator | High |
| Kong Gateway | API gateway (rate limiting, auth, routing) | High |
| Apicurio Schema Registry | Kafka schema governance | Medium |
| HashiCorp Vault | Secret management + rotation | Medium |
| ArgoCD | GitOps continuous deployment | Medium |
| Flagger | Canary + blue/green deployments | Medium |
| CloudFlare | CDN + WAF + DDoS protection | Before public launch |
| Trivy | Container vulnerability scanning | Medium |

---

## Closing Notes

### The Most Important Improvements (Do These First)

1. **Rate limiting** — You're currently wide open to DDoS. Bucket4j is already in your
   pom.xml. Implementing it takes one day and immediately closes a critical security gap.

2. **Distributed tracing** — You cannot debug production incidents without it. OTEL
   auto-instrumentation for Spring Boot requires zero code changes — just add the starter.

3. **Kafka persistence** — Any Kafka pod restart loses all CDC events. One line change in
   the manifest: replace `emptyDir` with a PVC.

4. **Circuit breakers** — One slow inventory-service will take down all of ecom-service
   under load. Resilience4j adds circuit breaking in a day.

5. **JWT audience validation** — Two lines of configuration that prevent token misuse across
   different applications in your Keycloak realm.

### Architecture Philosophy for Scale

The biggest lesson from large-scale e-commerce (Amazon, Shopify, etc.) is that **reliability
is a feature**. Customers who experience 503 errors or slow checkouts don't come back.

The proposed architecture prioritizes:
- **Graceful degradation** over hard failures (circuit breakers, fallbacks)
- **Observability first** so you know about problems before users do
- **Event-driven** over synchronous for cross-service operations (reduces coupling)
- **Stateless services** that can scale to zero and back (KEDA + Redis for state)
- **Defense in depth** so no single layer failure causes a security breach

This platform has excellent bones. The CDC pipeline, Flink SQL analytics, Istio mesh,
and OIDC authentication are all production-grade. The path to handling millions of users
is adding resilience, observability, and horizontal scale — not rebuilding from scratch.

---

*Generated: 2026-03-01 | Architecture Review for Book Store E-Commerce Microservices Platform*
*Based on Sessions 1–18 implementation (89/89 E2E tests passing)*
