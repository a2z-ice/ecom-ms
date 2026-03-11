---
name: deploy
description: Build and deploy a specific service (ecom, inventory, ui, flink, cert-dashboard) to the kind cluster
disable-model-invocation: true
argument-hint: <service-name>
allowed-tools: Bash, Read, Grep
---

Build a Docker image and deploy a specific service to the kind cluster.

## Arguments
`$ARGUMENTS` must be one of: `ecom`, `inventory`, `ui`, `flink`, `cert-dashboard`, or `all`.

## Service build commands

### ecom
```bash
cd /Volumes/Other/rand/llm/microservice/ecom-service
mvn package -DskipTests
docker build -t bookstore/ecom-service:latest .
kind load docker-image bookstore/ecom-service:latest --name bookstore
kubectl rollout restart deployment/ecom-service -n ecom
kubectl rollout status deployment/ecom-service -n ecom --timeout=120s
```

### inventory
```bash
cd /Volumes/Other/rand/llm/microservice/inventory-service
docker build -t bookstore/inventory-service:latest .
kind load docker-image bookstore/inventory-service:latest --name bookstore
kubectl rollout restart deployment/inventory-service -n inventory
kubectl rollout status deployment/inventory-service -n inventory --timeout=120s
```

### ui
IMPORTANT: VITE_ vars must be passed as --build-arg (baked in at build time).
```bash
cd /Volumes/Other/rand/llm/microservice/ui
docker build \
  --build-arg VITE_KEYCLOAK_AUTHORITY=https://idp.keycloak.net:30000/realms/bookstore \
  --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
  --build-arg VITE_REDIRECT_URI=https://localhost:30000/callback \
  -t bookstore/ui-service:latest .
kind load docker-image bookstore/ui-service:latest --name bookstore
kubectl rollout restart deployment/ui-service -n ecom
kubectl rollout status deployment/ui-service -n ecom --timeout=120s
```

### flink
```bash
cd /Volumes/Other/rand/llm/microservice/analytics/flink
docker build -t bookstore/flink:latest .
kind load docker-image bookstore/flink:latest --name bookstore
kubectl rollout restart deployment/flink-jobmanager -n analytics
kubectl rollout restart deployment/flink-taskmanager -n analytics
kubectl rollout status deployment/flink-jobmanager -n analytics --timeout=120s
# Re-submit Flink SQL runner
kubectl delete job flink-sql-runner -n analytics --ignore-not-found
kubectl apply -f /Volumes/Other/rand/llm/microservice/infra/flink/flink-sql-runner.yaml
kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=120s
```

### cert-dashboard
```bash
cd /Volumes/Other/rand/llm/microservice/cert-dashboard-operator
docker build -t bookstore/cert-dashboard-operator:latest .
docker tag bookstore/cert-dashboard-operator:latest bookstore/cert-dashboard:latest
kind load docker-image bookstore/cert-dashboard-operator:latest --name bookstore
kind load docker-image bookstore/cert-dashboard:latest --name bookstore
kubectl rollout restart deployment/cert-dashboard-operator -n cert-dashboard
kubectl rollout status deployment/cert-dashboard-operator -n cert-dashboard --timeout=120s
# Wait for operator to recreate dashboard pod
sleep 5
kubectl rollout restart deployment/bookstore-certs -n cert-dashboard 2>/dev/null || true
kubectl rollout status deployment/bookstore-certs -n cert-dashboard --timeout=60s
```

### all
Run ecom, inventory, ui, flink, cert-dashboard in sequence.

## After deploy
1. Verify the pod is Running
2. Run a quick health check on the deployed service endpoint
3. Report success/failure
