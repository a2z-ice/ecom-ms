---
name: cdc-verify
description: Verify the CDC pipeline — Debezium health, Flink jobs, Kafka topics, analytics DB sync
disable-model-invocation: true
allowed-tools: Bash
---

Verify the full CDC (Change Data Capture) pipeline end-to-end.

## Steps

1. **Debezium Server health**:
```bash
echo "Debezium ecom:" && curl -s http://localhost:32300/q/health | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])"
echo "Debezium inventory:" && curl -s http://localhost:32301/q/health | python3 -c "import sys,json; print(json.load(sys.stdin)['status'])"
```

2. **Flink streaming jobs** (expect 4 RUNNING):
```bash
curl -s http://localhost:32200/jobs | python3 -c "
import sys,json
d=json.load(sys.stdin)
for j in d['jobs']:
    print(f'  {j[\"id\"][:12]} → {j[\"status\"]}')
running = sum(1 for j in d['jobs'] if j['status'] == 'RUNNING')
print(f'\n{running}/4 jobs RUNNING')
"
```

3. **Kafka topics** (verify CDC topics exist):
```bash
kubectl exec -n infra deploy/kafka -- kafka-topics --list --bootstrap-server localhost:9092 2>/dev/null | grep -E "ecom-connector|inventory-connector"
```

4. **Analytics DB tables**:
```bash
kubectl exec -n analytics deploy/analytics-db -- psql -U analytics -d analytics -c "\dt" 2>/dev/null
```

5. **Analytics views**:
```bash
kubectl exec -n analytics deploy/analytics-db -- psql -U analytics -d analytics -c "\dv vw_*" 2>/dev/null
```

6. **Data sync check** — verify dim_books has data:
```bash
kubectl exec -n analytics deploy/analytics-db -- psql -U analytics -d analytics -c "SELECT count(*) as book_count FROM dim_books;" 2>/dev/null
```

7. **Run the dedicated CDC verification script** (inserts a test row and polls):
```bash
cd /Volumes/Other/rand/llm/microservice && bash scripts/verify-cdc.sh 2>&1
```

8. Report a summary table of all CDC components and their status.
