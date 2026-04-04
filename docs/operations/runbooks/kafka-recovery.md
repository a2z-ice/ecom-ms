# Runbook: Kafka Recovery

## Trigger
- Kafka pod crash or restart
- Alert: `KafkaBrokerDown`, `KafkaConsumerLagCritical`
- After Docker Desktop restart

## Automatic Recovery
Kafka uses KRaft mode (no Zookeeper). On pod restart:
1. Recovers from local log segments
2. Consumers resume from committed offsets

## Steps

### 1. Verify Kafka Health
```bash
kubectl get pods -n infra -l app=kafka
kubectl logs -n infra deploy/kafka --tail=30
```

### 2. Check Topics
```bash
kubectl exec -n infra deploy/kafka -- kafka-topics \
  --bootstrap-server localhost:9092 --list
```

### 3. Check Consumer Lag
```bash
kubectl exec -n infra deploy/kafka -- kafka-consumer-groups \
  --bootstrap-server localhost:9092 --all-groups --describe
```

### 4. Re-register Debezium (if topics lost)
After a full Kafka restart, offset topics may be lost:
```bash
# Restart Debezium servers to re-register
kubectl rollout restart deployment/debezium-server-ecom -n infra
kubectl rollout restart deployment/debezium-server-inventory -n infra
```

### 5. Reset Consumer Offset (if stuck)
```bash
kubectl exec -n infra deploy/kafka -- kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --group flink-analytics-consumer \
  --reset-offsets --to-earliest --all-topics --execute
```

### 6. Verify CDC Pipeline
```bash
bash scripts/verify-cdc.sh
```

## After Docker Desktop Restart
Use the recovery script which handles Kafka + Debezium:
```bash
bash scripts/up.sh
```
