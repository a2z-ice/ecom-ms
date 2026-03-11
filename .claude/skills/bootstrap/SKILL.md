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
- cert-manager is installed during bootstrap (`infra/cert-manager/install.sh`); self-signed CA + gateway cert provisioned automatically
- After bootstrap, trust the CA for browser access: `bash scripts/trust-ca.sh --install` (adds to macOS Keychain)
- `up.sh --fresh` is required when adding new kind port mappings (e.g., port 30080 for HTTP→HTTPS redirect)
- Cert Dashboard operator deployed via `bash scripts/cert-dashboard-up.sh` (builds images, installs OLM, deploys operator + CR)
- TLS certificates: CA (10yr) + gateway cert (30d auto-rotation) managed by cert-manager; dashboard at `http://localhost:32600`
