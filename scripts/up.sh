#!/usr/bin/env bash
# scripts/up.sh
# Master startup script — brings the BookStore stack fully online from any state.
#
# Scenarios handled automatically:
#   1. No kind cluster exists  → fresh full bootstrap (create cluster + all services)
#   2. Cluster exists, healthy → verify connectors are registered, run smoke test
#   3. Cluster exists, degraded → recovery: restart ztunnel + all pods + connectors
#      (typical after Docker Desktop restart)
#
# Options:
#   --fresh         Delete existing cluster first, then full bootstrap from scratch
#   --fresh --data  Delete existing cluster + wipe ./data/, then bootstrap
#   --yes / -y      Skip all confirmation prompts
#
# Usage:
#   ./scripts/up.sh                  # smart start (recommended)
#   ./scripts/up.sh --fresh          # tear down cluster and rebuild (keep data)
#   ./scripts/up.sh --fresh --data   # tear down + wipe data, then rebuild
#   ./scripts/up.sh --yes            # non-interactive (for CI / automation)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${GREEN}==>${NC} $*"; }
section() { echo -e "\n${YELLOW}════════════════════════════════════════${NC}\n  $*\n${YELLOW}════════════════════════════════════════${NC}"; }
warn()    { echo -e "${YELLOW}WARN:${NC} $*"; }
err()     { echo -e "${RED}ERROR:${NC} $*" >&2; }

# ── Parse options ────────────────────────────────────────────────────────────
FRESH=false
WIPE_DATA=false
YES=false
for arg in "$@"; do
  case "$arg" in
    --fresh)    FRESH=true ;;
    --data)     WIPE_DATA=true ;;
    --yes|-y)   YES=true ;;
    *) err "Unknown option: $arg"; echo "Usage: $0 [--fresh] [--data] [--yes|-y]"; exit 1 ;;
  esac
done

confirm() {
  $YES && return 0
  local ans
  read -r -p "$1 [y/N] " ans
  [[ "$ans" =~ ^[Yy] ]]
}

wait_deploy() {
  local name=$1 ns=$2 timeout=${3:-300s}
  kubectl rollout status deployment/"$name" -n "$ns" --timeout="$timeout" || {
    warn "Deployment '$name' in '$ns' did not roll out within $timeout — continuing anyway"
    return 0
  }
}

# ── Bootstrap function: full fresh cluster + all services ────────────────────
bootstrap_fresh() {
  section "Creating kind cluster 'bookstore'"
  mkdir -p "${REPO_ROOT}/data"/{ecom-db,inventory-db,analytics-db,keycloak-db,superset,kafka,redis,flink}
  DATA_DIR="${REPO_ROOT}/data"
  sed "s|DATA_DIR|${DATA_DIR}|g" "${REPO_ROOT}/infra/kind/cluster.yaml" > /tmp/bookstore-cluster.yaml
  kind create cluster --name bookstore --config /tmp/bookstore-cluster.yaml
  kubectl config use-context kind-bookstore
  kubectl wait --for=condition=Ready nodes --all --timeout=120s

  section "Installing Istio Ambient Mesh"
  bash "${REPO_ROOT}/infra/istio/install.sh"

  section "Installing Kubernetes Gateway API (kgateway)"
  bash "${REPO_ROOT}/infra/kgateway/install.sh"

  section "Installing Kiali (service mesh observability)"
  helm repo add kiali https://kiali.org/helm-charts 2>/dev/null || true
  helm repo update kiali
  if helm status kiali-server -n istio-system &>/dev/null; then
    info "Kiali already installed, upgrading..."
    helm upgrade kiali-server kiali/kiali-server \
      -n istio-system \
      --version 1.86.0 \
      --set auth.strategy=anonymous \
      --wait
  else
    helm install kiali-server kiali/kiali-server \
      -n istio-system \
      --version 1.86.0 \
      --set auth.strategy=anonymous \
      --wait
  fi
  kubectl apply -f "${REPO_ROOT}/infra/observability/kiali/kiali-config-patch.yaml"
  kubectl rollout restart deployment/kiali -n istio-system
  kubectl rollout status deployment/kiali -n istio-system --timeout=120s
  kubectl apply -f "${REPO_ROOT}/infra/observability/kiali/kiali-nodeport.yaml"

  section "Applying namespaces and Gateway resource"
  kubectl apply -f "${REPO_ROOT}/infra/namespaces.yaml"
  kubectl apply -f "${REPO_ROOT}/infra/kgateway/gateway.yaml"
  # Istio creates the gateway Service with a random NodePort; patch it to 30000
  # so the kind extraPortMapping (host:30000 → container:30000) routes correctly.
  info "Waiting for Istio to create bookstore-gateway-istio service..."
  for i in $(seq 1 24); do
    if kubectl get svc bookstore-gateway-istio -n infra &>/dev/null 2>&1; then
      kubectl patch svc bookstore-gateway-istio -n infra --type='json' \
        -p='[{"op":"replace","path":"/spec/ports/1/nodePort","value":30000}]' 2>/dev/null || true
      info "Patched bookstore-gateway-istio NodePort → 30000"
      break
    fi
    info "  Service not ready yet (${i}/24), retrying in 5s..."
    sleep 5
  done

  section "Applying StorageClass and PersistentVolumes"
  kubectl apply -f "${REPO_ROOT}/infra/storage/storageclass.yaml"
  kubectl apply -f "${REPO_ROOT}/infra/storage/persistent-volumes.yaml"

  section "Deploying PostgreSQL instances"
  kubectl apply -f "${REPO_ROOT}/infra/postgres/ecom-db.yaml"
  kubectl apply -f "${REPO_ROOT}/infra/postgres/inventory-db.yaml"
  kubectl apply -f "${REPO_ROOT}/infra/postgres/analytics-db.yaml"
  wait_deploy ecom-db ecom
  wait_deploy inventory-db inventory
  wait_deploy analytics-db analytics

  section "Applying analytics DB schema"
  # Apply DDL before Flink starts — JDBC sink requires tables to pre-exist.
  # Use -i flag to pipe stdin through kubectl exec to psql.
  if [[ -f "${REPO_ROOT}/analytics/schema/analytics-ddl.sql" ]]; then
    info "Waiting for analytics-db pod..."
    kubectl wait --for=condition=Ready pod -n analytics -l app=analytics-db --timeout=60s
    ANALYTICS_POD=$(kubectl get pod -n analytics -l app=analytics-db \
      -o jsonpath='{.items[0].metadata.name}')
    cat "${REPO_ROOT}/analytics/schema/analytics-ddl.sql" | \
      kubectl exec -i -n analytics "$ANALYTICS_POD" -- \
      psql -U analyticsuser -d analyticsdb || \
      warn "Analytics DDL apply failed — check schema manually"
    info "Analytics schema applied."
  fi

  section "Deploying Redis"
  kubectl apply -f "${REPO_ROOT}/infra/redis/redis.yaml"
  wait_deploy redis infra

  section "Deploying Kafka (KRaft)"
  kubectl apply -f "${REPO_ROOT}/infra/kafka/zookeeper.yaml" 2>/dev/null || true  # intentionally empty placeholder
  kubectl apply -f "${REPO_ROOT}/infra/kafka/kafka.yaml"
  wait_deploy kafka infra
  # Re-apply to trigger kafka-topic-init Job (idempotent: delete stale job first)
  kubectl delete job kafka-topic-init -n infra --ignore-not-found
  kubectl apply -f "${REPO_ROOT}/infra/kafka/kafka.yaml"
  kubectl wait --for=condition=complete job/kafka-topic-init -n infra --timeout=120s

  section "Deploying Debezium (Kafka Connect)"
  # Create debezium-db-credentials secret from the same passwords used by the DB secrets
  # (ecomuser/CHANGE_ME and inventoryuser/CHANGE_ME — change before production use)
  ECOM_USER=$(kubectl get secret -n ecom ecom-db-secret -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
  ECOM_PASS=$(kubectl get secret -n ecom ecom-db-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
  INV_USER=$(kubectl get secret -n inventory inventory-db-secret -o jsonpath='{.data.POSTGRES_USER}' | base64 -d)
  INV_PASS=$(kubectl get secret -n inventory inventory-db-secret -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)
  kubectl create secret generic debezium-db-credentials -n infra \
    --from-literal=ECOM_DB_USER="$ECOM_USER" \
    --from-literal=ECOM_DB_PASSWORD="$ECOM_PASS" \
    --from-literal=INVENTORY_DB_USER="$INV_USER" \
    --from-literal=INVENTORY_DB_PASSWORD="$INV_PASS" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl apply -f "${REPO_ROOT}/infra/debezium/debezium.yaml"
  wait_deploy debezium infra

  section "Deploying PgAdmin"
  kubectl apply -f "${REPO_ROOT}/infra/pgadmin/pgadmin.yaml"
  wait_deploy pgadmin infra

  section "Deploying Flink (CDC analytics pipeline)"
  kubectl apply -f "${REPO_ROOT}/infra/flink/flink-pvc.yaml"
  kubectl apply -f "${REPO_ROOT}/infra/flink/flink-config.yaml"
  kubectl apply -f "${REPO_ROOT}/infra/flink/flink-cluster.yaml"
  wait_deploy flink-jobmanager analytics
  wait_deploy flink-taskmanager analytics
  kubectl delete job flink-sql-runner -n analytics --ignore-not-found
  kubectl apply -f "${REPO_ROOT}/infra/flink/flink-sql-runner.yaml"
  kubectl wait --for=condition=complete job/flink-sql-runner -n analytics --timeout=180s || \
    warn "flink-sql-runner did not complete in 180s — check: kubectl logs -n analytics -l job-name=flink-sql-runner"

  section "Deploying Keycloak"
  kubectl apply -f "${REPO_ROOT}/infra/keycloak/keycloak.yaml"
  wait_deploy keycloak-db identity
  wait_deploy keycloak identity
  bash "${REPO_ROOT}/scripts/keycloak-import.sh"

  section "Building and loading application Docker images"
  # Build custom bookstore images and load them into kind (imagePullPolicy: IfNotPresent/Never)
  # Format: "image:tag|build_context"
  for img_spec in \
    "bookstore/ecom-service:latest|${REPO_ROOT}/ecom-service" \
    "bookstore/inventory-service:latest|${REPO_ROOT}/inventory-service" \
    "bookstore/flink:latest|${REPO_ROOT}/analytics/flink"; do
    full_img="${img_spec%%|*}"
    ctx="${img_spec##*|}"
    if docker image inspect "$full_img" &>/dev/null; then
      info "Image $full_img already exists — skipping build."
    else
      info "Building $full_img..."
      docker build -t "$full_img" "$ctx"
    fi
    info "Loading $full_img into kind cluster..."
    kind load docker-image "$full_img" --name bookstore
  done
  # UI requires VITE build args — always build fresh (VITE vars are baked in at build time)
  info "Building bookstore/ui-service:latest (VITE build args required)..."
  docker build \
    --build-arg VITE_KEYCLOAK_AUTHORITY=http://idp.keycloak.net:30000/realms/bookstore \
    --build-arg VITE_KEYCLOAK_CLIENT_ID=ui-client \
    --build-arg VITE_REDIRECT_URI=http://localhost:30000/callback \
    -t bookstore/ui-service:latest "${REPO_ROOT}/ui"
  kind load docker-image bookstore/ui-service:latest --name bookstore

  section "Deploying application services"
  kubectl apply -f "${REPO_ROOT}/ecom-service/k8s/"
  if [[ -d "${REPO_ROOT}/inventory-service/k8s/" ]]; then
    kubectl apply -f "${REPO_ROOT}/inventory-service/k8s/"
  fi
  if [[ -d "${REPO_ROOT}/ui/k8s/" ]]; then
    kubectl apply -f "${REPO_ROOT}/ui/k8s/"
  fi
  wait_deploy ecom-service ecom || true
  wait_deploy inventory-service inventory || true
  wait_deploy ui-service ecom || true

  section "Applying HTTPRoutes (kgateway)"
  # -R recurses into routes/ subdirectory; .sh files are ignored by kubectl apply
  kubectl apply -R -f "${REPO_ROOT}/infra/kgateway/"

  section "Applying Istio security policies"
  kubectl apply -R -f "${REPO_ROOT}/infra/istio/security/"

  section "Applying Kubernetes policies (HPA, PDB, NetworkPolicies)"
  kubectl apply -R -f "${REPO_ROOT}/infra/kubernetes/"

  section "Deploying Apache Superset"
  kubectl apply -f "${REPO_ROOT}/infra/superset/superset.yaml"
  wait_deploy superset analytics
  if [[ -f "${REPO_ROOT}/infra/superset/bootstrap-job.yaml" ]]; then
    kubectl delete job superset-bootstrap -n analytics --ignore-not-found
    kubectl apply -f "${REPO_ROOT}/infra/superset/bootstrap-job.yaml"
    kubectl wait --for=condition=complete job/superset-bootstrap -n analytics --timeout=300s || \
      warn "superset-bootstrap did not complete — dashboards may need manual setup"
  fi

  section "Deploying Prometheus"
  kubectl apply -f "${REPO_ROOT}/infra/observability/prometheus/prometheus.yaml"
  kubectl apply -f "${REPO_ROOT}/infra/observability/kiali/prometheus-alias.yaml"
  # Restart Kiali so it picks up the live Prometheus connection
  kubectl rollout restart deployment/kiali -n istio-system
  kubectl rollout status deployment/kiali -n istio-system --timeout=120s

  section "Registering Debezium CDC connectors"
  bash "${REPO_ROOT}/infra/debezium/register-connectors.sh"

  section "Smoke test"
  bash "${REPO_ROOT}/scripts/smoke-test.sh"

  echo ""
  echo -e "${GREEN}✔ Full bootstrap complete. Stack is running.${NC}"
  _print_endpoints
}

# ── Recovery function: after Docker restart (pods need rolling restart) ───────
recovery() {
  section "Recovery mode — restarting ztunnel and all pods"
  info "See docs/restart-app.md for full explanation."

  info "Restarting ztunnel (HBONE network plumbing reset)..."
  kubectl rollout restart daemonset/ztunnel -n istio-system
  kubectl rollout status daemonset/ztunnel -n istio-system --timeout=90s
  info "ztunnel ready — waiting 10s for mesh to stabilize..."
  sleep 10

  section "Restarting DB pods (dependencies first)"
  kubectl rollout restart deploy/ecom-db -n ecom
  kubectl rollout restart deploy/inventory-db -n inventory
  kubectl rollout restart deploy/keycloak-db -n identity
  kubectl rollout restart deploy/analytics-db -n analytics
  wait_deploy ecom-db ecom
  wait_deploy inventory-db inventory
  wait_deploy keycloak-db identity
  wait_deploy analytics-db analytics

  section "Restarting application pods"
  kubectl rollout restart deploy/kafka -n infra
  kubectl rollout restart deploy/redis -n infra
  kubectl rollout restart deploy/keycloak -n identity
  kubectl rollout restart deploy/ecom-service -n ecom
  kubectl rollout restart deploy/inventory-service -n inventory
  kubectl rollout restart deploy/ui-service -n ecom
  kubectl rollout restart deploy/debezium -n infra
  kubectl rollout restart deploy/pgadmin -n infra
  kubectl rollout restart deploy/flink-jobmanager -n analytics
  kubectl rollout restart deploy/flink-taskmanager -n analytics
  kubectl rollout restart deploy/superset -n analytics
  kubectl rollout restart deploy/prometheus -n observability
  kubectl rollout restart deploy/kiali -n istio-system || true

  info "Waiting for critical services..."
  wait_deploy kafka infra
  wait_deploy keycloak identity
  wait_deploy ecom-service ecom
  wait_deploy inventory-service inventory
  wait_deploy debezium infra

  section "Re-registering Debezium CDC connectors"
  bash "${REPO_ROOT}/infra/debezium/register-connectors.sh"

  section "Smoke test"
  bash "${REPO_ROOT}/scripts/smoke-test.sh"

  echo ""
  echo -e "${GREEN}✔ Recovery complete. Stack is running.${NC}"
  _print_endpoints
}

# ── Ensure connectors registered (healthy cluster, connectors may be missing) ─
ensure_connectors() {
  local connectors
  connectors=$(curl -s --max-time 10 "http://localhost:32300/connectors" 2>/dev/null || echo "[]")
  if [[ "$connectors" == "[]" ]] || [[ "$connectors" == "" ]]; then
    info "No connectors registered — re-registering..."
    bash "${REPO_ROOT}/infra/debezium/register-connectors.sh"
  else
    info "Debezium connectors already registered: $connectors"
  fi
}

# ── Print service endpoints ───────────────────────────────────────────────────
_print_endpoints() {
  echo ""
  echo "  Service endpoints:"
  echo "    UI:        http://myecom.net:30000"
  echo "    API:       http://api.service.net:30000/ecom/books"
  echo "    Keycloak:  http://idp.keycloak.net:30000"
  echo "    PgAdmin:   http://localhost:31111"
  echo "    Superset:  http://localhost:32000"
  echo "    Kiali:     http://localhost:32100/kiali"
  echo "    Flink:     http://localhost:32200"
  echo "    Debezium:  http://localhost:32300/connectors"
  echo ""
  echo "  All ports served directly via kind NodePort (no proxy containers needed)."
}

# ── Pre-flight checks ────────────────────────────────────────────────────────
section "Pre-flight checks"
for cmd in kind kubectl docker helm istioctl python3; do
  command -v "$cmd" &>/dev/null || { err "'$cmd' not found on PATH. Please install it."; exit 1; }
done
info "All prerequisites found."

MISSING_HOSTS=()
for host in idp.keycloak.net myecom.net api.service.net; do
  grep -q "$host" /etc/hosts 2>/dev/null || MISSING_HOSTS+=("$host")
done
if [[ ${#MISSING_HOSTS[@]} -gt 0 ]]; then
  warn "The following hosts are missing from /etc/hosts: ${MISSING_HOSTS[*]}"
  warn "Add this line: 127.0.0.1  idp.keycloak.net  myecom.net  api.service.net"
fi

# ── Determine scenario ───────────────────────────────────────────────────────
CLUSTER_EXISTS=false
kind get clusters 2>/dev/null | grep -q "^bookstore$" && CLUSTER_EXISTS=true

# --fresh: tear down first
if $FRESH && $CLUSTER_EXISTS; then
  DOWN_ARGS="--yes"
  $WIPE_DATA && DOWN_ARGS="--data --yes"
  confirm "This will DELETE the existing 'bookstore' cluster$(${WIPE_DATA} && echo ' and ALL data'). Continue?" || \
    { info "Aborted — cluster untouched."; exit 0; }
  bash "${REPO_ROOT}/scripts/down.sh" ${DOWN_ARGS}
  CLUSTER_EXISTS=false
fi

# ── Execute scenario ─────────────────────────────────────────────────────────
if ! $CLUSTER_EXISTS; then
  # Scenario 1: No cluster — full bootstrap
  section "No cluster found — starting fresh bootstrap"
  bootstrap_fresh
elif ! curl -s --max-time 8 -o /dev/null -w "%{http_code}" \
    "http://api.service.net:30000/ecom/books" 2>/dev/null | grep -q "^200$"; then
  # Scenario 3: Cluster exists but stack is not responding — recovery
  section "Cluster exists but stack is not responding — starting recovery"
  kubectl config use-context kind-bookstore
  recovery
else
  # Scenario 2: Cluster healthy — ensure connectors and smoke test
  section "Cluster is healthy"
  kubectl config use-context kind-bookstore
  ensure_connectors
  bash "${REPO_ROOT}/scripts/smoke-test.sh"
  echo ""
  echo -e "${GREEN}✔ Stack is running.${NC}"
  _print_endpoints
fi
