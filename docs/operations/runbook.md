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

# 9. Register Debezium CDC connectors
DEBEZIUM_URL=$(kubectl get svc debezium -n infra -o jsonpath='{.spec.clusterIP}'):8083
./infra/debezium/register-connectors.sh

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

## Re-register Debezium Connectors

```bash
# Port-forward Debezium (exception — only for admin ops, not application traffic)
# Or use the register script which calls via cluster-internal URL:
DEBEZIUM_URL=http://debezium.infra.svc.cluster.local:8083 \
  ./infra/debezium/register-connectors.sh
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
