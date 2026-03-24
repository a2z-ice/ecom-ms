# Contributing to BookStore Microservices

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Docker Desktop | Latest | [docker.com](https://www.docker.com/products/docker-desktop/) |
| kind | v0.20+ | `brew install kind` |
| kubectl | v1.28+ | `brew install kubectl` |
| Helm | v3.12+ | `brew install helm` |
| Maven | 3.9+ | `brew install maven` |
| Java JDK | 21 | `brew install openjdk@21` |
| Python | 3.12+ | `brew install python@3.12` |
| Poetry | Latest | `pip install poetry` |
| Node.js | 20+ | `brew install node@20` |
| Playwright | Latest | `npx playwright install` |

## Quick Start

```bash
# 1. Clone the repository
git clone <repo-url> && cd microservice

# 2. Set up /etc/hosts entries
echo '127.0.0.1  idp.keycloak.net myecom.net api.service.net' | sudo tee -a /etc/hosts

# 3. Bootstrap the full cluster (takes ~10 min first time)
bash scripts/up.sh

# 4. Trust the self-signed CA (macOS Keychain)
bash scripts/trust-ca.sh --install

# 5. Verify everything is running
bash scripts/smoke-test.sh

# 6. Open the app
open https://myecom.net:30000
```

Default credentials: `user1` / `CHANGE_ME`, Admin: `admin1` / `CHANGE_ME`

## Project Structure

```
microservice/
├── ecom-service/          # Spring Boot 4.0.3 (Java 21, Maven)
├── inventory-service/     # FastAPI (Python 3.12, Poetry)
├── ui/                    # React 19.2 (Vite, TypeScript)
├── e2e/                   # Playwright E2E tests
├── analytics/             # Flink SQL pipeline
├── infra/                 # Kubernetes manifests
│   ├── cnpg/              # CloudNativePG database clusters
│   ├── kafka/             # Kafka (KRaft mode)
│   ├── redis/             # Redis
│   ├── debezium/          # CDC connectors
│   ├── flink/             # Flink cluster + SQL jobs
│   ├── kgateway/          # Kubernetes Gateway API routes
│   ├── cert-manager/      # TLS certificates
│   ├── kubernetes/        # HPA, PDB, NetworkPolicy, ResourceQuota
│   └── observability/     # Prometheus, Grafana, Loki, Tempo, OTel
├── scripts/               # Cluster lifecycle scripts
├── plans/                 # Session plans
├── docs/                  # Documentation
└── cert-dashboard-operator/  # Go-based K8s operator
```

## Development Workflow

### E-Commerce Service (Java/Spring Boot)

```bash
cd ecom-service
mvn test                          # Run unit tests
mvn package -DskipTests           # Build JAR
mvn test -Dtest=BookControllerTest#testGetBooks  # Single test

# Build + deploy to cluster
docker build -t bookstore/ecom-service:latest .
kind load docker-image bookstore/ecom-service:latest --name bookstore
kubectl rollout restart deploy/ecom-service -n ecom
```

### Inventory Service (Python/FastAPI)

```bash
cd inventory-service
poetry install                    # Install dependencies
poetry run pytest                 # Run all tests
poetry run pytest tests/test_stock.py::test_get_stock -v  # Single test

# Build + deploy to cluster
docker build -t bookstore/inventory-service:latest .
kind load docker-image bookstore/inventory-service:latest --name bookstore
kubectl rollout restart deploy/inventory-service -n inventory
```

### UI (React/TypeScript)

```bash
cd ui
npm install
npm run dev                       # Local dev server
npm run build                     # Production build
npm run lint                      # ESLint

# Build + deploy (note: VITE_ vars are build-time)
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=https://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=https://localhost:30000/callback \
  -t bookstore/ui-service:latest .
kind load docker-image bookstore/ui-service:latest --name bookstore
kubectl rollout restart deploy/ui-service -n ecom
```

### E2E Tests (Playwright)

```bash
cd e2e
npm install
npm run test                      # Headless, sequential
npm run test:headed               # Watch in browser
npx playwright test checkout.spec.ts  # Single spec
npx playwright test -g "should display"  # By test name
npm run report                    # Open HTML report
```

## Code Conventions

- **No hardcoded secrets** — Always use Kubernetes Secrets + `secretKeyRef` env vars
- **No localStorage for tokens** — OIDC tokens stored in memory only
- **Containers run as non-root** — `runAsNonRoot: true`, `readOnlyRootFilesystem: true`, drop ALL capabilities
- **Migrations as init containers** — Never run manually; Liquibase (ecom) and Alembic (inventory)
- **15-Factor app** — All config via environment variables
- **RFC 7807 errors** — ecom-service uses Spring ProblemDetail for all error responses

## Testing Requirements

- Every user-facing feature must have Playwright E2E coverage
- CDC pipeline changes must verify data propagation (Debezium → Kafka → Analytics DB)
- Infrastructure changes should have E2E tests verifying the configuration

## Domain / Hosts Setup

Add these entries to `/etc/hosts`:

```
127.0.0.1  idp.keycloak.net
127.0.0.1  myecom.net
127.0.0.1  api.service.net
```

All gateway traffic goes through HTTPS on port 30000. Tool UIs (PgAdmin, Grafana, etc.) use plain HTTP on dedicated NodePorts.

## Debugging Tips

```bash
# Pod logs
kubectl logs -n ecom deploy/ecom-service -f
kubectl logs -n inventory deploy/inventory-service -f

# DB shell
kubectl exec -n ecom -it ecom-db-1 -- psql -U ecom

# Kafka topics
kubectl exec -n infra deploy/kafka -- kafka-topics --bootstrap-server localhost:9092 --list

# Full health check
bash scripts/sanity-test.sh
```

## Session Planning Convention

Every new feature or enhancement requires a plan file:

1. Create `plans/session-<NN>-<slug>.md` with: Goal, Deliverables, Acceptance Criteria, Build & Deploy commands, Status
2. Update `plans/implementation-plan.md` with the new session section
3. Implement, test, and mark the plan as complete
