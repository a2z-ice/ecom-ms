---
name: teardown
description: Tear down the bookstore cluster and optionally wipe data/images
disable-model-invocation: true
argument-hint: [--data] [--images] [--all] [--yes]
allowed-tools: Bash
---

Tear down the bookstore kind cluster.

## Arguments
- No args: delete cluster only (preserves data + images)
- `--data`: also wipe `./data/` directory
- `--images`: also remove Docker images
- `--all`: wipe data + images
- `--yes` or `-y`: skip confirmation prompts

## Steps

1. Confirm with the user what will be destroyed (unless `--yes` passed)
2. Run:
```bash
cd /Volumes/Other/rand/llm/microservice && bash scripts/down.sh $ARGUMENTS 2>&1
```
3. Report what was cleaned up
