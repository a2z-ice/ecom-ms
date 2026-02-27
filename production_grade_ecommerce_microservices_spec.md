# Production-Grade Microservices E-Commerce Platform (Book Store)

## Technical Specification (POC -- Production-Aligned Architecture)

**Version:** 1.0\
**Generated On:** 2026-02-26\
**Deployment Target:** Local Kubernetes (kind)\
**Architecture Style:** Microservices + Event-Driven + Service Mesh

------------------------------------------------------------------------

# 1. Executive Summary

This document defines the architecture and implementation specification
for a production-grade, secure, microservices-based e-commerce
application for book selling.

The platform will:

-   Provide a public catalog of books
-   Support search functionality
-   Allow adding books to cart
-   Require OIDC authentication (Keycloak)
-   Deduct inventory after checkout
-   Store transaction data (no payment integration)
-   Provide real-time analytics using CDC and Kafka
-   Be fully deployed inside a local kind Kubernetes cluster
-   Follow security best practices and 15-Factor App methodology

------------------------------------------------------------------------

# 2. High-Level Architecture

## Core Microservices

1.  UI Service (React version 19.2) 
2.  E-Commerce Service (Spring Boot version 4.0.3)
3.  Inventory Service (Python FastAPI)
4.  Analytics Pipeline (Kafka + Debezium)
5.  Analytics Database (PostgreSQL)
6.  Apache Superset (Reporting)

## Infrastructure Components

-   Kubernetes (kind)
-   Istio Ambient Mesh (mTLS, JWT validation) ISTIO version 1.28.4
-   KGateway (Kubernetes Gateway) latest
-   Keycloak version 26.5.4 (OIDC Provider)
-   Redis (Session + CSRF) latest
-   Kafka (Event streaming) latest
-   Debezium (CDC) latest 
-   PostgreSQL (per-service DB) latest
-   PgAdmin (DB Admin) latest

------------------------------------------------------------------------

# 3. Domain & URL Mapping

Mapped in /etc/hosts:

-   idp.keycloak.net:30000 → Keycloak
-   myecom.net:30000 → UI
-   api.service.net:30000/ecom → Spring Boot API
-   api.service.net:30000/inven → Inventory API

NodePorts and hostMappings must be configured inside kind cluster
configuration. No port-forwarding allowed.

------------------------------------------------------------------------

# 4. Microservices Design

## 4.1 UI Service (React - Latest)

### Responsibilities

-   Public catalog view
-   Search books
-   Add to cart
-   Initiate login
-   Display cart post-login
-   Checkout flow

### Authentication

-   OIDC Authorization Code Flow with PKCE
-   Access + Refresh tokens
-   Secure HTTP-only cookies

### Security

-   CSRF protection
-   XSS protection
-   Content Security Policy
-   Secure headers
-   Token storage: memory only (no localStorage)

------------------------------------------------------------------------

## 4.2 E-Commerce Service (Spring Boot - Latest)

### Responsibilities

-   Book catalog management
-   Cart management
-   Order persistence
-   Publish order events to Kafka

### Database

-   PostgreSQL (dedicated DB)
-   Liquibase for schema migration

### Security

-   Spring Security OIDC Resource Server
-   JWT validation via Keycloak
-   Role-based access control
-   CSRF enabled (stateless JWT validation)
-   Input validation
-   Rate limiting

### APIs

-   GET /books
-   GET /books/search
-   POST /cart
-   GET /cart
-   POST /checkout

------------------------------------------------------------------------

## 4.3 Inventory Service (Python FastAPI - Latest)

### Responsibilities

-   Maintain book stock
-   Deduct stock on order
-   Publish inventory events

### Database

-   PostgreSQL (dedicated DB)
-   Alembic for migrations

### Security

-   OIDC JWT validation
-   Input validation
-   Role enforcement

------------------------------------------------------------------------

# 5. Event-Driven Architecture

## 5.1 Kafka

Topics: - order.created - inventory.updated

## 5.2 Debezium CDC

-   Monitor all PostgreSQL databases
-   Capture:
    -   INSERT
    -   UPDATE
    -   DELETE
    -   Schema changes
-   Publish to Kafka

## 5.3 Analytics Sync

Kafka → Debezium → Kafka Streams → Analytics DB

Analytics DB: - Consolidated PostgreSQL database - Fully synchronized
with source systems

------------------------------------------------------------------------

# 6. Analytics & Reporting

## Apache Superset

Reports required:

1.  Bar Chart: Product Sales Volume
2.  Trend Analysis Chart: Sales Over Time

Data Source: - Central Analytics PostgreSQL

Superset exposed via NodePort.

------------------------------------------------------------------------

# 7. Security Architecture

## Identity & Access Management

-   Keycloak (OIDC)
-   Code Flow with PKCE
-   JWT validation in all services

## Istio Ambient Mesh

-   mTLS between services
-   RequestAuthentication for JWT
-   AuthorizationPolicy enforcement

## Security Best Practices

-   CSRF protection
-   XSS protection
-   Input validation
-   Rate limiting
-   Secure cookies
-   NetworkPolicies
-   PodSecurity standards
-   Non-root containers
-   Secrets via Kubernetes Secrets

------------------------------------------------------------------------

# 8. Kubernetes Deployment Model

## Cluster

-   kind (local)

## Exposure

-   NodePort only
-   hostMapping in kind config
-   No kubectl port-forward

## Gateway

-   KGateway for routing

## Observability

-   Prometheus
-   Kiali
-   Grafana

------------------------------------------------------------------------

# 9. Database Architecture

Each service has:

-   Dedicated PostgreSQL instance/schema
-   Independent migration lifecycle
-   No cross-database coupling

PgAdmin: - Accessible via localhost:31111

------------------------------------------------------------------------

# 10. Redis Usage

-   Central CSRF token store
-   Optional distributed session cache
-   Rate limiting store

------------------------------------------------------------------------

# 11. 15-Factor Compliance

-   Config via environment variables
-   Stateless services
-   Backing services treated as attached resources
-   Strict dependency isolation
-   Logs to stdout
-   Disposable services
-   Dev/prod parity
-   Admin tasks as one-off jobs

------------------------------------------------------------------------

# 12. Production-Grade Enhancements (Recommended)

-   OpenTelemetry for tracing
-   Centralized logging (ELK or Loki)
-   CI/CD pipeline (GitOps with ArgoCD)
-   Helm charts for deployment
-   Container image scanning
-   Dependency vulnerability scanning
-   Horizontal Pod Autoscaling
-   Resource requests/limits
-   PodDisruptionBudgets
-   Backup strategy for PostgreSQL
-   Secrets management enhancement (Vault optional)

------------------------------------------------------------------------

# 13. Data Flow Summary

User → UI → Keycloak → UI\
UI → E-Commerce API\
E-Commerce → Inventory API\
E-Commerce DB → Debezium → Kafka → Analytics DB\
Inventory DB → Debezium → Kafka → Analytics DB\
Superset → Analytics DB

------------------------------------------------------------------------

# 14. Technology Stack (Latest Stable Versions)

-   React version 19.2
-   Spring Boot version 4.0.3
-   Python FastAPI
-   Keycloak 26.4.5
-   Redis latest
-   PostgreSQL
-   Kafka
-   Debezium
-   Apache Superset
-   Istio Ambient Mesh
-   KGateway
-   kind Kubernetes


------------------------------------------------------------------------

# 15. Write complete End to End test using playwrite

- Each and every feature must need to be tested by playwrite
- Also take care of writing CDC pipeline. The CDC functionality must need to be tested use the best tools to test it
- The Apache Superset analytics report also need to be tested




------------------------------------------------------------------------

# 16. Conclusion

This architecture provides:

-   Secure OIDC authentication
-   Zero-trust service mesh
-   Event-driven CDC-based analytics
-   Independent scalable microservices
-   Production-aligned architecture running locally

This serves as a strong POC foundation while preserving enterprise-grade
principles.
