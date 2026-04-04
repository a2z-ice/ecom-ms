# Runbook: Service Degradation

## Trigger
- High latency alerts (`HighLatency`)
- Pod restart loops (`PodRestartLoop`)
- High error rates (`HighErrorRate`)

## Diagnosis Steps

### 1. Identify the Affected Service
```bash
# Check pod status across all namespaces
kubectl get pods -A | grep -v Running

# Check recent events
kubectl get events -A --sort-by=.metadata.creationTimestamp | tail -20
```

### 2. Check Resource Pressure
```bash
# CPU/Memory usage
kubectl top pods -n ecom
kubectl top pods -n inventory
kubectl top nodes

# Check HPA status
kubectl get hpa -A
```

### 3. Check Logs
```bash
# ecom-service
kubectl logs -n ecom deploy/ecom-service --tail=50 | grep -i "error\|warn\|exception"

# inventory-service
kubectl logs -n inventory deploy/inventory-service --tail=50 | grep -i "error\|warn"

# Grafana dashboard
open http://localhost:32500
```

### 4. Common Issues

#### OOMKilled
```bash
kubectl describe pod <pod-name> -n <namespace> | grep -A5 "Last State"
# Fix: Increase memory limits in k8s manifest
```

#### Connection Pool Exhaustion
```bash
# Check ecom-service Hikari pool metrics
curl -sk https://api.service.net:30000/ecom/actuator/prometheus | grep hikari
# Look for: hikaricp_connections_pending > 0
```

#### Circuit Breaker Open
```bash
# Check circuit breaker state
curl -sk https://api.service.net:30000/ecom/actuator/prometheus | grep resilience4j
# Fix: Wait for recovery or restart inventory-service
```

#### Database Connection Errors
```bash
# Check CNPG cluster health
kubectl cnpg status ecom-db -n ecom
# Check connection to DB
kubectl exec -n ecom deploy/ecom-service -- curl -s localhost:8080/ecom/actuator/health/readiness
```

### 5. Emergency Actions
```bash
# Restart a service
kubectl rollout restart deployment/ecom-service -n ecom

# Scale up manually
kubectl scale deployment/ecom-service -n ecom --replicas=3

# Full recovery
bash scripts/up.sh
```
