---
name: e2e
description: Run Playwright end-to-end tests — full suite, specific file, or headed/UI mode
disable-model-invocation: true
argument-hint: [test-file] [--headed] [--ui]
allowed-tools: Bash
---

Run Playwright E2E tests for the bookstore platform.

## Arguments
- No args: run the full test suite (headless, sequential)
- `<file>`: run a specific test file, e.g. `cart.spec.ts` or `admin`
- `--headed`: run in headed browser mode
- `--ui`: open Playwright UI mode

## Steps

Parse the arguments and determine the run mode:

- If `$ARGUMENTS` is empty → `npm run test`
- If `$ARGUMENTS` contains `--ui` → `npm run test:ui`
- If `$ARGUMENTS` contains `--headed` → `npm run test:headed`
- If `$ARGUMENTS` is a test file or grep pattern → `npx playwright test --grep "$ARGUMENTS"` or `npx playwright test $ARGUMENTS`

```bash
cd /Volumes/Other/rand/llm/microservice/e2e && <chosen command> 2>&1
```

## After tests complete

1. Report: X passed, Y failed, Z flaky
2. For any failures, show the error message and suggest investigation steps
3. If there are screenshot attachments, mention them

## Known flaky test
`cart.spec.ts:12` "authenticated user can add a book to cart" — cold-start flake on first run after fresh deploy. Passes on automatic retry. This is expected.
