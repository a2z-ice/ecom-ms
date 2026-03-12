---
name: fix-debezium
description: Fix Debezium Server crash loop after CNPG failover — recreate slot, clear offsets, restart
disable-model-invocation: true
allowed-tools: Bash
---

Fix Debezium Server when it's in CrashLoopBackOff after a CNPG HA failover.

## Root Cause
After CNPG failover, the new primary may lack the logical replication slot. The stored Kafka offset references a WAL position that no longer exists.

## Steps

1. Check which Debezium instance is failing:
```bash
kubectl get pods -n infra -l app=debezium-server-ecom
kubectl get pods -n infra -l app=debezium-server-inventory
```

2. For the failing instance (ecom example), recreate the replication slot:
```bash
ECOM_PRIMARY=$(kubectl get pods -n ecom -l cnpg.io/cluster=ecom-db,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')
echo "Primary: $ECOM_PRIMARY"

# Check if slot exists
kubectl exec -n ecom "$ECOM_PRIMARY" -- psql -U postgres -d ecomdb -tAc \
  "SELECT slot_name, active FROM pg_replication_slots WHERE slot_name = 'debezium_ecom_slot';"

# Recreate if missing
kubectl exec -n ecom "$ECOM_PRIMARY" -- psql -U postgres -d ecomdb -c \
  "SELECT pg_create_logical_replication_slot('debezium_ecom_slot', 'pgoutput');"
```

3. Delete stale offset topic:
```bash
KAFKA_POD=$(kubectl get pods -n infra -l app=kafka -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n infra "$KAFKA_POD" -- kafka-topics --bootstrap-server localhost:9092 \
  --delete --topic debezium.ecom.offsets
```

4. Restart the Debezium deployment:
```bash
kubectl rollout restart deploy/debezium-server-ecom -n infra
kubectl rollout status deploy/debezium-server-ecom -n infra --timeout=120s
```

5. Verify health:
```bash
sleep 15
curl -s http://localhost:32300/q/health | python3 -m json.tool
```

6. For inventory, repeat with `inventory-db`, `debezium_inventory_slot`, `debezium.inventory.offsets`, `debezium-server-inventory`.
