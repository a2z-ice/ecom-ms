# Runbook: Database Failover

## Trigger
- CNPG primary pod crashes or becomes unresponsive
- Alert: `CNPGPodNotReady`

## Automatic Recovery
CNPG automatically promotes the standby to primary within ~30 seconds. No manual action needed for:
- Primary pod crash → standby promoted
- Node failure → pod rescheduled + promoted

## Verify Failover
```bash
# Check cluster status
kubectl cnpg status ecom-db -n ecom

# Verify primary is healthy
kubectl get pods -n ecom -l cnpg.io/cluster=ecom-db -o wide

# Check replication lag
kubectl exec -n ecom ecom-db-1 -- psql -U ecomuser -d ecomdb -c "SELECT pg_is_in_recovery();"
```

## Post-Failover Checks
1. **Debezium CDC**: Verify logical replication slot synced to new primary
   ```bash
   kubectl exec -n ecom $(kubectl get pod -n ecom -l cnpg.io/cluster=ecom-db,cnpg.io/instanceRole=primary -o name) -- \
     psql -U ecomuser -d ecomdb -c "SELECT slot_name, active FROM pg_replication_slots;"
   ```
2. **Application connectivity**: Check ecom-service logs for connection errors
   ```bash
   kubectl logs -n ecom deploy/ecom-service --tail=20 | grep -i "connection\|error"
   ```
3. **Debezium restart** (if slot was lost):
   ```bash
   kubectl rollout restart deployment/debezium-server-ecom -n infra
   ```

## Manual Switchover (planned maintenance)
```bash
kubectl cnpg promote ecom-db-2 -n ecom
```

## Restore from Backup
If both instances are lost:
```bash
bash scripts/restore.sh <timestamp>
# Or restore from MinIO via CNPG:
kubectl cnpg backup list ecom-db -n ecom
```
