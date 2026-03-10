---
name: recover
description: Recover the stack after Docker Desktop restart — ztunnel, pod restarts, Debezium health
disable-model-invocation: true
allowed-tools: Bash
---

Recover the bookstore stack after a Docker Desktop restart.

## Context
After Docker Desktop restarts, three things break:
1. **ztunnel** — Istio Ambient mesh HBONE plumbing breaks; ztunnel must restart first
2. **All pods** — lose HBONE registration; must restart in dependency order (DBs first, then apps)
3. **Debezium** — offset files on emptyDir are lost; servers re-snapshot automatically on restart

## Steps

1. First try the smart startup (auto-detects degraded state):
```bash
cd /Volumes/Other/rand/llm/microservice && bash scripts/up.sh 2>&1
```

2. If that doesn't work, use the dedicated recovery script:
```bash
bash scripts/restart-after-docker.sh 2>&1
```

3. After recovery, run the smoke test:
```bash
bash scripts/smoke-test.sh 2>&1
```

4. Report the recovery status and any remaining issues.
