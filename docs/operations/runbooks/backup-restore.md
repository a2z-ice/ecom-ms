# Runbook: Backup & Restore

## Automated Backups
CNPG ScheduledBackup runs daily at 02:00 UTC for all 4 databases:
- `ecom-db` → `s3://cnpg-backups/ecom-db/` (MinIO)
- `inventory-db` → `s3://cnpg-backups/inventory-db/`
- `analytics-db` → `s3://cnpg-backups/analytics-db/`
- `keycloak-db` → `s3://cnpg-backups/keycloak-db/`

## Check Backup Status
```bash
# List all backups
kubectl cnpg backup list ecom-db -n ecom
kubectl cnpg backup list inventory-db -n inventory

# Check scheduled backup CRs
kubectl get scheduledbackups -A
```

## Trigger On-Demand Backup
```bash
# Via CNPG
kubectl cnpg backup ecom-db -n ecom

# Via manual script (pg_dump to local filesystem)
bash scripts/backup.sh
```

## Verify Backup Pipeline
```bash
bash scripts/verify-backup.sh
```

## Restore from CNPG Barman Backup
```bash
# 1. List available backups
kubectl cnpg backup list ecom-db -n ecom

# 2. Create a recovery cluster from backup
kubectl apply -f - <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ecom-db-restore
  namespace: ecom
spec:
  instances: 1
  bootstrap:
    recovery:
      source: ecom-db
  externalClusters:
    - name: ecom-db
      barmanObjectStore:
        destinationPath: "s3://cnpg-backups/ecom-db/"
        endpointURL: "http://minio.infra.svc.cluster.local:9000"
        s3Credentials:
          accessKeyId:
            name: minio-secret
            key: ACCESS_KEY_ID
          secretAccessKey:
            name: minio-secret
            key: SECRET_ACCESS_KEY
EOF

# 3. Verify restored data
kubectl exec -n ecom ecom-db-restore-1 -- psql -U ecomuser -d ecomdb -c "SELECT count(*) FROM books;"

# 4. Swap over (update ExternalName service to point to restore cluster)
# 5. Clean up old cluster
```

## Restore from Manual Backup
```bash
bash scripts/restore.sh <timestamp>
# Backups stored in: backups/<timestamp>/
```

## RTO/RPO Targets
| Component | RPO | RTO |
|-----------|-----|-----|
| PostgreSQL (CNPG) | 0 (sync replication) | ~30s (auto-failover) |
| Full cluster restore | Last backup (daily) | ~10 min |
| Kafka events | ~5s (flush interval) | ~60s (pod restart) |
