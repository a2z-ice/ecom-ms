---
name: bootstrap
description: Bootstrap the entire bookstore stack from scratch or smart-start
disable-model-invocation: true
argument-hint: [--fresh] [--yes]
allowed-tools: Bash
---

Bootstrap the bookstore platform stack.

## Arguments
- No args: smart start (auto-detects fresh/recovery/healthy)
- `--fresh`: force full teardown + rebuild from scratch
- `--yes` or `-y`: skip confirmation prompts

## Steps

1. Run the bootstrap script:
```bash
cd /Volumes/Other/rand/llm/microservice && bash scripts/up.sh $ARGUMENTS 2>&1
```

2. After bootstrap completes, verify by running the smoke test:
```bash
bash scripts/smoke-test.sh 2>&1
```

3. Report the final status including:
   - Total pods running
   - Any failed pods
   - Smoke test results
   - Endpoint availability

## Important
- Bootstrap can take 10-15 minutes for `--fresh`
- Smart start (no args) takes 1-2 minutes if cluster is healthy
- If bootstrap fails, check pod logs: `kubectl logs -n <namespace> <pod>`
- The script is idempotent — safe to re-run
