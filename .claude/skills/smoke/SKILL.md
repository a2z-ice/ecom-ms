---
name: smoke
description: Run the full stack smoke test (31 checks — pods, HTTP, Kafka, Debezium, admin)
disable-model-invocation: true
allowed-tools: Bash
---

Run the comprehensive smoke test suite.

## Steps

1. Run:
```bash
cd /Volumes/Other/rand/llm/microservice && bash scripts/smoke-test.sh 2>&1
```

2. If any tests fail, investigate by:
   - Checking pod status: `kubectl get pods -n <namespace>`
   - Checking pod logs: `kubectl logs -n <namespace> deploy/<name> --tail=50`
   - Suggest fixes based on the failure pattern

3. Report results summary (X passed, Y failed).
