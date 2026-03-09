# BookStore Platform — Architecture Summary

## Overview

A production-grade microservices e-commerce bookstore deployed to Kubernetes, demonstrating real-world architecture patterns including zero-trust networking, event-driven data pipelines, and real-time analytics. Built as a proof of concept with production-aligned infrastructure — every component follows the same patterns used in large-scale distributed systems.

## Architecture at a Glance

| Layer | Components | Technology |
|-------|-----------|------------|
| **Client** | Single-page application, OIDC login | React 19.2 + Vite, PKCE (S256) |
| **Ingress / Security** | Gateway routing, mTLS mesh, JWT validation | Istio Ambient 1.28.4, K8s Gateway API |
| **Application Services** | E-Commerce API, Inventory API, Admin API | Spring Boot 4.0.3, FastAPI |
| **Identity** | OIDC provider, RBAC, realm management | Keycloak 26.5.4 |
| **Data & Messaging** | 4 isolated databases, event streaming, CDC | PostgreSQL, Kafka KRaft, Debezium Server 3.4 |
| **Analytics & BI** | Stream processing, star schema, dashboards | Flink 2.2.0 SQL, Superset (3 dashboards, 16 charts) |
| **Observability** | Metrics, service mesh visualization, DB admin | Prometheus, Kiali, PgAdmin |

## Key Architecture Decisions

### Service Mesh & Zero Trust

Istio Ambient Mesh provides mutual TLS across all service-to-service communication without sidecar proxy overhead. ztunnel handles L4 encryption transparently. AuthorizationPolicies operate at L4 only (namespace + SPIFFE principal), compatible with the sidecar-free ambient model. JWT validation occurs independently at every backend service — no service trusts upstream claims.

### Authentication & Authorization

Keycloak serves as the OIDC Identity Provider. The React SPA uses Authorization Code Flow with PKCE (S256 challenge), storing tokens exclusively in memory — never in localStorage or sessionStorage. Role-based access control distinguishes `customer` and `admin` realm roles, enforced at both the API gateway and individual service layers.

### Event-Driven Architecture

Change Data Capture runs through two Debezium Server 3.4 pods (one per source database), capturing PostgreSQL WAL changes into Kafka topics. Apache Flink 2.2.0 runs four streaming SQL jobs with exactly-once semantics, transforming CDC events into a star schema in the analytics database. Kafka runs in KRaft mode (no Zookeeper dependency).

### Data Architecture

Strict database-per-service isolation: four PostgreSQL instances with no cross-database access. Schema migrations run as Kubernetes init containers (Liquibase for Java, Alembic for Python). The analytics database uses a star schema with fact tables, dimension tables, and 10 materialized views powering Superset dashboards.

### API Design

RESTful APIs built with Spring Boot 4.0.3 (Java) and FastAPI (Python). Kubernetes Gateway API handles all ingress routing via HTTPRoutes — no Ingress resources. Rate limiting uses Bucket4j backed by Redis. CSRF tokens are stored server-side in Redis and required for all state-changing requests.

### Observability Stack

Prometheus scrapes Istio telemetry (istiod + ztunnel) and application metrics. Kiali provides real-time service mesh topology visualization with traffic flow. Apache Superset delivers business analytics across three dashboards with 16 charts covering sales, inventory, and revenue.

## Data Flow

**User Request Flow:**
```
Browser → Istio Gateway → UI Service (React SPA)
Browser → Keycloak (OIDC PKCE login)
UI → E-Commerce API (JWT-protected)
E-Commerce → Inventory Service (service-to-service mTLS)
```

**CDC Pipeline:**
```
Source DBs → Debezium Server 3.4 → Kafka → Flink 2.2.0 SQL → analytics-db → Superset
```

**Checkout Flow:**
1. User submits checkout — E-Commerce Service validates cart and JWT
2. E-Commerce calls Inventory Service over mTLS to reserve stock
3. Order persisted to database; `order.created` event published to Kafka
4. Debezium captures the DB change → Kafka → Flink transforms → analytics-db
5. Superset dashboards reflect new order data in real time

## Security Invariants

- All inter-service traffic encrypted via Istio mTLS (STRICT mode)
- JWT validated independently at every backend service
- Non-root containers with read-only root filesystems and all capabilities dropped
- Secrets managed exclusively through Kubernetes Secrets (no hardcoded config)
- NetworkPolicies enforced per namespace
- CSRF tokens stored server-side in Redis

## Infrastructure

- Local Kubernetes via kind (3 nodes: 1 control-plane, 2 workers)
- 8 NodePort services exposed directly via kind host port mappings
- No `kubectl port-forward` used anywhere — all access via stable ports
- All stateful services backed by PersistentVolumeClaims with host-path storage
- Idempotent shell scripts for full cluster lifecycle (bootstrap, recovery, teardown)

## Test Coverage

- 155 end-to-end tests via Playwright (all passing, zero flaky)
- Unit tests for both backend services (JUnit, pytest)
- CDC pipeline verification: insert → poll analytics DB within 30s
- Smoke tests covering pods, HTTP routes, Kafka, and Debezium health

## Technology Stack

| Category | Technology | Version |
|----------|-----------|---------|
| Frontend | React + Vite | 19.2 |
| Backend (Java) | Spring Boot | 4.0.3 |
| Backend (Python) | FastAPI | latest |
| Identity | Keycloak | 26.5.4 |
| Service Mesh | Istio Ambient | 1.28.4 |
| Gateway | Kubernetes Gateway API | istio |
| Databases | PostgreSQL | 4 instances |
| Messaging | Apache Kafka | KRaft mode |
| CDC | Debezium Server | 3.4.1 |
| Stream Processing | Apache Flink | 2.2.0 |
| BI / Analytics | Apache Superset | latest |
| Observability | Prometheus + Kiali | — |
| Cache / Sessions | Redis | — |
| E2E Testing | Playwright | latest |
| Container Orchestration | Kubernetes (kind) | — |

## Diagrams

- [Architecture Diagram](../diagrams/architecture.svg) — Infrastructure architecture overview
- [Data Flow Diagram](../diagrams/data-flow-animated.svg) — Animated data flow with live request paths

---

*Built as a production-grade proof of concept demonstrating microservices best practices, zero-trust security, event-driven architecture, and real-time analytics.*
