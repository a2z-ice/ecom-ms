#!/usr/bin/env bash
# scripts/verify-backup.sh
# Triggers an on-demand CNPG backup for ecom-db and verifies it completes.
# Used to validate the backup pipeline is working (MinIO + barman).
#
# Usage: bash scripts/verify-backup.sh

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}==>${NC} $*"; }
fail()  { echo -e "${RED}FAIL:${NC} $*"; exit 1; }

info "Verifying CNPG backup pipeline..."

# ── 1. Check MinIO is running ──────────────────────────────────────────────
info "Checking MinIO availability..."
kubectl exec -n infra deploy/minio -- curl -sf http://localhost:9000/minio/health/ready >/dev/null 2>&1 \
  || fail "MinIO is not healthy"

# ── 2. Trigger on-demand backup for ecom-db ────────────────────────────────
BACKUP_NAME="verify-backup-$(date +%s)"
info "Triggering on-demand backup: ${BACKUP_NAME}..."

kubectl apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: ${BACKUP_NAME}
  namespace: ecom
spec:
  cluster:
    name: ecom-db
EOF

# ── 3. Wait for backup to complete (up to 120s) ───────────────────────────
info "Waiting for backup to complete (up to 120s)..."
for i in $(seq 1 24); do
  STATUS=$(kubectl get backup "${BACKUP_NAME}" -n ecom -o jsonpath='{.status.phase}' 2>/dev/null || echo "pending")
  if [[ "$STATUS" == "completed" ]]; then
    info "Backup completed successfully!"
    break
  elif [[ "$STATUS" == "failed" ]]; then
    fail "Backup failed. Check: kubectl describe backup ${BACKUP_NAME} -n ecom"
  fi
  echo "  Status: ${STATUS} (waiting...)"
  sleep 5
done

FINAL_STATUS=$(kubectl get backup "${BACKUP_NAME}" -n ecom -o jsonpath='{.status.phase}' 2>/dev/null || echo "unknown")
if [[ "$FINAL_STATUS" != "completed" ]]; then
  fail "Backup did not complete within 120s. Status: ${FINAL_STATUS}"
fi

# ── 4. Verify backup exists in MinIO ──────────────────────────────────────
info "Verifying backup objects in MinIO..."
OBJECT_COUNT=$(kubectl exec -n infra deploy/minio -- \
  sh -c 'ls -1 /data/cnpg-backups/ecom-db/ 2>/dev/null | wc -l' || echo "0")

if [[ "$OBJECT_COUNT" -gt 0 ]]; then
  info "MinIO contains backup data (${OBJECT_COUNT} objects in cnpg-backups/ecom-db/)"
else
  fail "No backup objects found in MinIO"
fi

# ── 5. Clean up verification backup ──────────────────────────────────────
info "Cleaning up verification backup..."
kubectl delete backup "${BACKUP_NAME}" -n ecom --ignore-not-found

echo ""
echo -e "${GREEN}Backup pipeline verification passed.${NC}"
echo "  MinIO: healthy"
echo "  CNPG barman backup: completed"
echo "  Storage: objects verified"
