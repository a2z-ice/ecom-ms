# Runbook — Book Store E-Commerce Platform

## Full Stack Boot (from scratch)

```bash
# 1. Add to /etc/hosts (once)
echo "127.0.0.1  idp.keycloak.net  myecom.net  api.service.net" | sudo tee -a /etc/hosts

# 2. Start cluster + Istio + KGateway + namespaces
./scripts/cluster-up.sh

# 3. Deploy all infrastructure services
./scripts/infra-up.sh

# 4. Deploy Keycloak and import realm
kubectl apply -f infra/keycloak/keycloak.yaml
kubectl rollout status deployment/keycloak-db -n identity --timeout=120s
kubectl rollout status deployment/keycloak -n identity --timeout=180s
./scripts/keycloak-import.sh

# 5. Build and load service images into kind
docker build -t bookstore/ecom-service:latest ./ecom-service
docker build -t bookstore/inventory-service:latest ./inventory-service
docker build -t bookstore/ui-service:latest ./ui
kind load docker-image bookstore/ecom-service:latest --name bookstore
kind load docker-image bookstore/inventory-service:latest --name bookstore
kind load docker-image bookstore/ui-service:latest --name bookstore

# 6. Deploy application services
kubectl apply -f ecom-service/k8s/ecom-service.yaml
kubectl apply -f inventory-service/k8s/inventory-service.yaml
kubectl apply -f ui/k8s/ui-service.yaml

# 7. Apply KGateway routes
kubectl apply -f infra/kgateway/routes/

# 8. Deploy analytics DB schema
kubectl exec -n analytics deploy/analytics-db -- \
  psql -U $POSTGRES_USER -d $POSTGRES_DB -f /analytics-ddl.sql

# 9. Wait for Debezium Server health
# (No connector registration needed — Debezium Server auto-starts CDC on launch)
# The register-connectors.sh script now polls /q/health until both servers report UP.
bash infra/debezium/register-connectors.sh

# 10. Deploy Superset and bootstrap dashboards
kubectl apply -f infra/superset/superset.yaml
kubectl rollout status deployment/superset -n analytics --timeout=180s
# Run bootstrap job (after Superset is ready)

# 11. Apply Istio security policies
kubectl apply -f infra/istio/security/peer-auth.yaml
kubectl apply -f infra/istio/security/request-auth.yaml
kubectl apply -f infra/istio/security/authz-policies/

# 12. Apply NetworkPolicies and PodDisruptionBudgets
kubectl apply -f infra/kubernetes/network-policies/
kubectl apply -f infra/kubernetes/pdb/pdb.yaml
kubectl apply -f infra/kubernetes/hpa/hpa.yaml

# 13. Deploy observability
kubectl apply -f infra/observability/otel-collector.yaml
kubectl apply -f infra/observability/prometheus/prometheus.yaml

# 14. Verify
./scripts/verify-routes.sh
./scripts/verify-cdc.sh
./scripts/smoke-test.sh
```

## Debezium Server Operations

Debezium Server uses no REST API. Configuration is in `application.properties` ConfigMaps. All operations are via `kubectl`.

```bash
# Check health of both servers
curl -s http://localhost:32300/q/health | python3 -c "import sys,json; print('ecom:', json.load(sys.stdin)['status'])"
curl -s http://localhost:32301/q/health | python3 -c "import sys,json; print('inventory:', json.load(sys.stdin)['status'])"

# Wait for both servers to be healthy (used by up.sh)
bash infra/debezium/register-connectors.sh

# Restart a server (e.g. after config change)
kubectl rollout restart deployment/debezium-server-ecom -n infra
kubectl rollout restart deployment/debezium-server-inventory -n infra

# View logs
kubectl logs -n infra deploy/debezium-server-ecom --tail=50
kubectl logs -n infra deploy/debezium-server-inventory --tail=50

# Update credentials (if DB passwords change)
ECOM_USER=$(kubectl get secret -n ecom ecom-db-secret -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
ECOM_PASS=$(kubectl get secret -n ecom ecom-db-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
INV_USER=$(kubectl get secret -n inventory inventory-db-secret -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
INV_PASS=$(kubectl get secret -n inventory inventory-db-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
kubectl create secret generic debezium-db-credentials -n infra \
  --from-literal=ECOM_DB_USER="$ECOM_USER" --from-literal=ECOM_DB_PASSWORD="$ECOM_PASS" \
  --from-literal=INVENTORY_DB_USER="$INV_USER" --from-literal=INVENTORY_DB_PASSWORD="$INV_PASS" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/debezium-server-ecom deployment/debezium-server-inventory -n infra
```

## Reset Keycloak

```bash
# Delete and re-import realm (users are recreated, passwords reset to defaults)
kubectl delete job keycloak-realm-import -n identity --ignore-not-found
./scripts/keycloak-import.sh
```

## Run E2E Tests

```bash
cd e2e
npm ci
npx playwright install chromium

# Set env vars for test users and DB
export USER1_USERNAME=user1
export USER1_PASSWORD=<user1-password>
export ANALYTICS_DB_URL=postgresql://analyticsuser:<password>@localhost:5432/analyticsdb

# Run all tests
npx playwright test

# Run only CDC tests
npx playwright test cdc.spec.ts

# Debug with UI
npx playwright test --ui
```

## Tear Down

```bash
kind delete cluster --name bookstore
```
