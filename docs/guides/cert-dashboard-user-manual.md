# Cert Dashboard — User Manual

A step-by-step guide to using the cert-dashboard operator web interface for monitoring and renewing cert-manager TLS certificates.

**Dashboard URL:** `http://localhost:32600`

---

## Table of Contents

1. [Accessing the Dashboard](#1-accessing-the-dashboard)
2. [Understanding the Dashboard Layout](#2-understanding-the-dashboard-layout)
3. [Reading a Certificate Card](#3-reading-a-certificate-card)
4. [Certificate Status Indicators](#4-certificate-status-indicators)
5. [Understanding the Progress Bar](#5-understanding-the-progress-bar)
6. [Identifying CA vs Leaf Certificates](#6-identifying-ca-vs-leaf-certificates)
7. [Certificate Details Reference](#7-certificate-details-reference)
8. [Renewing a Certificate](#8-renewing-a-certificate)
9. [Understanding the Renewal SSE Stream](#9-understanding-the-renewal-sse-stream)
10. [After Renewal — Verifying Changes](#10-after-renewal--verifying-changes)
11. [Using the REST API](#11-using-the-rest-api)
12. [Auto-Refresh Behaviour](#12-auto-refresh-behaviour)
13. [Quick Reference](#13-quick-reference)
14. [FAQ](#14-faq)

---

## 1. Accessing the Dashboard

Open your browser and navigate to:

```
http://localhost:32600
```

The dashboard loads immediately and displays all monitored cert-manager certificates.

![Dashboard Full Page](../../e2e/screenshots/cert-dashboard/cert-dashboard-01-full-page.png)

**What you see on first load:**
- A header with the title "Certificate Dashboard"
- One card per certificate managed by cert-manager
- A footer indicating auto-refresh is active

If the page shows "No certificates found", verify that cert-manager is installed and has at least one Certificate resource in the monitored namespaces.

---

## 2. Understanding the Dashboard Layout

The dashboard has three sections:

### Header

![Header](../../e2e/screenshots/cert-dashboard/cert-dashboard-um-header.png)

- **Title**: "Certificate Dashboard" in gradient blue-purple text
- **Subtitle**: "cert-manager Certificate Monitoring & Renewal"

### Main Content Area

The main area contains **certificate cards** — one per cert-manager `Certificate` resource. Cards are listed in the order they're discovered from the monitored Kubernetes namespaces.

### Footer

![Footer](../../e2e/screenshots/cert-dashboard/cert-dashboard-um-footer.png)

- Shows "BookStore Platform - cert-manager Operator Dashboard - Auto-refresh every 30s"
- Data refreshes automatically every 30 seconds without a page reload

---

## 3. Reading a Certificate Card

Each certificate card contains all the information you need at a glance.

### Gateway Certificate Example

![Gateway Certificate Card](../../e2e/screenshots/cert-dashboard/cert-dashboard-um-gateway-card-full.png)

A card has four sections from top to bottom:

| Section | Content |
|---------|---------|
| **Header Row** | Certificate name, namespace badge, Ready indicator |
| **Details Grid** | 10 metadata fields in a responsive 3-column grid |
| **Progress Bar** | Visual lifetime indicator with days remaining |
| **Actions** | Renew button (and SSE panel during renewal) |

### CA Certificate Example

![CA Certificate Card](../../e2e/screenshots/cert-dashboard/cert-dashboard-um-ca-card-full.png)

CA certificates look the same but include an additional purple **CA** badge and typically have a much longer lifetime (e.g., 3650 days for a 10-year CA).

---

## 4. Certificate Status Indicators

### Ready Status

![Ready Indicator](../../e2e/screenshots/cert-dashboard/cert-dashboard-um-ready-indicator.png)

Every card shows a status indicator in the top-right corner:

| Indicator | Meaning |
|-----------|---------|
| **Green dot + "Ready"** | Certificate is valid and the TLS secret exists |
| **Red dot + "Not Ready"** | Certificate is being issued, or has an error |

A "Not Ready" state is normal during renewal (typically lasts 2-10 seconds). If it persists, check cert-manager logs.

### CA Badge

![CA Badge](../../e2e/screenshots/cert-dashboard/cert-dashboard-um-ca-badge.png)

CA (Certificate Authority) certificates are identified by a purple **CA** badge next to the namespace. These are root or intermediate certificates used to sign other certificates. You typically should **not** renew a CA certificate unless you understand the impact on all leaf certificates it has signed.

---

## 5. Understanding the Progress Bar

The progress bar provides a visual representation of the certificate's remaining lifetime.

![Progress Bar Green](../../e2e/screenshots/cert-dashboard/cert-dashboard-04-progress-bar-green.png)

### Color Coding

| Color | Condition | Action Required |
|-------|-----------|-----------------|
| **Green** | More than 10 days remaining | None — certificate is healthy |
| **Yellow** | 10 days or fewer remaining | Plan a renewal soon |
| **Red** | 5 days or fewer remaining | Renew immediately |

### How to Read It

- **Width**: Percentage of total lifetime remaining (100% = full bar = just issued)
- **Label**: "Certificate Lifetime" on the left
- **Days counter**: "X days remaining" on the right, colored to match the bar

**Example:** A 30-day certificate with 30 days remaining shows a full green bar. At 10 days remaining, it turns yellow and the bar is approximately 33% filled. At 5 days, it turns red.

> **Note:** cert-manager automatically renews certificates before expiry (controlled by the `renewBefore` field, typically 7 days). The progress bar helps you visually confirm that auto-renewal is working.

---

## 6. Identifying CA vs Leaf Certificates

| Feature | CA Certificate | Leaf Certificate |
|---------|---------------|------------------|
| **CA badge** | Purple "CA" badge visible | No CA badge |
| **Issuer** | `selfsigned-bootstrap` (self-signed) | `bookstore-ca-issuer` (signed by CA) |
| **Lifetime** | Very long (e.g., 87600h = 10 years) | Short (e.g., 720h = 30 days) |
| **DNS Names** | Usually none (dash "—") | Lists all covered hostnames |
| **IP Addresses** | Usually none | May include 127.0.0.1 |
| **Renewal risk** | HIGH — breaks all leaf certs | LOW — only affects this cert |

**Rule of thumb:** Only renew leaf certificates through the dashboard. CA renewal should be planned carefully.

---

## 7. Certificate Details Reference

The details grid shows 10 fields:

![Details Grid](../../e2e/screenshots/cert-dashboard/cert-dashboard-um-details-grid.png)

| Field | Description | Example |
|-------|-------------|---------|
| **Issuer** | Who signed this certificate (name + kind) | `bookstore-ca-issuer (ClusterIssuer)` |
| **DNS Names** | Hostnames the certificate covers | `myecom.net, api.service.net, idp.keycloak.net, localhost` |
| **IP Addresses** | IP addresses the certificate covers | `127.0.0.1` |
| **Algorithm** | Cryptographic algorithm and key size | `ECDSA P-256` |
| **Serial Number** | Unique hex identifier from the X.509 certificate | `999A5CD56B64C9B2E7D92943B054BA73` |
| **Duration / Renew Before** | Total lifetime / how early to auto-renew | `720h / 168h` (30 days / 7 days before expiry) |
| **Not Before** | When the certificate became valid | `Mar 10, 2026, 01:45 PM EDT` |
| **Not After (Expiry)** | When the certificate expires | `Apr 9, 2026, 01:45 PM EDT` |
| **Renewal Time** | When cert-manager plans to auto-renew | `Apr 2, 2026, 01:45 PM EDT` |
| **Revision** | How many times this certificate has been issued | `21` (increments on each renewal) |

### Key Fields Explained

- **Duration / Renew Before**: `720h / 168h` means the cert lasts 30 days and cert-manager will auto-renew 7 days before expiry (at day 23).
- **Revision**: Starts at 1 on first issuance. Each renewal increments by 1. A revision of 21 means the certificate has been renewed 20 times.
- **Serial Number**: Changes on every renewal. Useful for verifying that a renewal actually produced a new certificate.
- **Renewal Time**: The date cert-manager will automatically renew. This is calculated as `Not After - Renew Before`.

---

## 8. Renewing a Certificate

### Authentication Requirement

Certificate renewal is a **destructive operation** (it deletes TLS secrets). To prevent unauthorized renewals, the `POST /api/renew` endpoint requires a valid Kubernetes ServiceAccount token.

There are **two ways** to renew a certificate, depending on your workflow:

| Method | Best For | Auth Handling |
|--------|----------|---------------|
| [Method A: CLI with curl](#method-a-renew-via-cli-recommended) | Production, automation, scripting | You provide the Bearer token explicitly via curl |
| [Method B: Browser UI with token input](#method-b-renew-via-browser-ui-recommended-for-interactive-use) | Interactive use, visual monitoring | You paste a token into the confirmation dialog |

---

### Method A: Renew via CLI (Recommended)

This is the **recommended production method** for cluster administrators. It provides a full audit trail and works in any environment.

#### Step 1: Identify the certificate to renew

```bash
# List all certificates visible to the dashboard
curl -s http://localhost:32600/api/certs | python3 -c "
import sys, json
for c in json.load(sys.stdin):
    print(f\"  {c['namespace']}/{c['name']}  (secret: {c['secretName']}, days left: {c['daysRemaining']}, rev: {c['revision']})\")
"
```

Example output:
```
  cert-manager/bookstore-ca  (secret: bookstore-ca-secret, days left: 3649, rev: 1)
  infra/bookstore-gateway-cert  (secret: bookstore-gateway-tls, days left: 29, rev: 21)
```

#### Step 2: Get a Kubernetes ServiceAccount token

The dashboard runs as ServiceAccount `bookstore-certs` in namespace `cert-dashboard`. Create a short-lived token for it:

```bash
TOKEN=$(kubectl create token bookstore-certs -n cert-dashboard --duration=10m)
```

This creates a token valid for 10 minutes — long enough to trigger a renewal and watch the SSE stream.

> **Who can run this?** Any user with `create` permission on `serviceaccounts/token` in the `cert-dashboard` namespace. Typically this means cluster-admin or a user with an explicit RBAC binding.

#### Step 3: Trigger the renewal

```bash
RESPONSE=$(curl -s -X POST http://localhost:32600/api/renew \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"bookstore-gateway-cert","namespace":"infra"}')

echo "$RESPONSE"
```

Expected response:
```json
{"streamId":"505c9948-be50-436b-8724-aab86bac4d8c"}
```

#### Step 4: Watch the renewal progress via SSE

```bash
STREAM_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['streamId'])")
curl -sN http://localhost:32600/api/sse/$STREAM_ID
```

You'll see live events:
```
: keepalive

event: status
data: {"event":"status","phase":"deleting-secret","message":"Deleting TLS secret 'bookstore-gateway-tls' to trigger renewal..."}

event: status
data: {"event":"status","phase":"waiting-issuing","message":"Secret deleted. Waiting for cert-manager to issue new certificate..."}

event: status
data: {"event":"status","phase":"issued","message":"New certificate issued by cert-manager."}

event: status
data: {"event":"status","phase":"ready","message":"Certificate is Ready. Revision: 21 → 22"}

event: complete
data: {"event":"complete","message":"Renewal complete","done":true}
```

#### Step 5: Verify the renewal

```bash
# Check the certificate was renewed (revision should have incremented)
curl -s http://localhost:32600/api/certs | python3 -c "
import sys, json
for c in json.load(sys.stdin):
    if c['name'] == 'bookstore-gateway-cert':
        print(f\"Revision: {c['revision']}\")
        print(f\"Not After: {c['notAfter']}\")
        print(f\"Serial:    {c['serialNumber']}\")
        print(f\"Days Left: {c['daysRemaining']}\")
"

# Verify HTTPS still works
curl -sk https://api.service.net:30000/ecom/books | head -c 100
```

#### Complete one-liner for experienced admins

```bash
# Renew bookstore-gateway-cert in one shot (non-interactive)
TOKEN=$(kubectl create token bookstore-certs -n cert-dashboard --duration=10m) && \
STREAM_ID=$(curl -s -X POST http://localhost:32600/api/renew \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"bookstore-gateway-cert","namespace":"infra"}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['streamId'])") && \
curl -sN http://localhost:32600/api/sse/$STREAM_ID
```

---

### Method B: Renew via Browser UI (Recommended for Interactive Use)

The dashboard UI has a built-in token input field in the renewal confirmation dialog. This is the easiest way to renew certificates interactively.

#### Step 1: Open the dashboard

```
http://localhost:32600
```

![Dashboard Overview](../../e2e/screenshots/cert-dashboard-overview.png)

#### Step 2: Click "Renew Certificate" on the target card

Find the certificate card and click the blue **"Renew Certificate"** button.

> The button is disabled (grayed out) if the certificate is not in a Ready state.

#### Step 3: Get a ServiceAccount token

A confirmation dialog appears with a **token section** that shows the exact `kubectl` command to run:

![Token Modal](../../e2e/screenshots/cert-dashboard-token-modal.png)

1. Click the **clipboard icon** (top-right of the command box) — it will briefly show a checkmark to confirm the copy
2. Open a terminal and paste the command:

```bash
kubectl create token bookstore-certs -n cert-dashboard --duration=10m
```

3. Copy the output token (it starts with `eyJ...`)

> **Who can run this?** Any user with `create` permission on `serviceaccounts/token` in the `cert-dashboard` namespace. Typically this means cluster-admin or a user with an explicit RBAC binding.

#### Step 4: Paste the token into the dialog

Paste the token into the **password-masked input field**. The token is masked by default for security.

![Token Masked](../../e2e/screenshots/cert-dashboard-token-masked.png)

Use the **"Show"** button to reveal the token if you need to verify it was pasted correctly:

![Token Visible](../../e2e/screenshots/cert-dashboard-token-visible.png)

> If you click "Renew Certificate" without entering a token, you'll see a validation error:

![Token Error](../../e2e/screenshots/cert-dashboard-token-error.png)

#### Step 5: Confirm the renewal

| Button | Action |
|--------|--------|
| **Cancel** (gray) | Closes the modal, clears the token, no changes made |
| **Renew Certificate** (red) | Validates the token, triggers the renewal process |

After clicking "Renew Certificate" with a valid token:
- The modal closes
- The SSE status panel appears on the certificate card
- Live progress events stream in real-time (see [Section 9](#9-understanding-the-renewal-sse-stream))

#### Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| "A valid token is required" | Empty token field | Paste the token from Step 3 |
| "authorization header required" (401) | Token not sent | Refresh the page and try again |
| "invalid or expired token" (401) | Token expired (>10 min) | Generate a new token with `kubectl create token` |
| "authentication service unavailable" (500) | Dashboard can't reach K8s API | Check dashboard pod logs: `kubectl logs -n cert-dashboard -l app=cert-dashboard` |
| "rate limit exceeded" (429) | Too many renewals too fast | Wait 10 seconds and try again |

> **Dev mode fallback:** When the dashboard runs outside a Kubernetes cluster (e.g., `go run` locally), the auth middleware cannot reach the TokenReview API and gracefully skips token validation. The token field still appears but any value (or even empty) will work.

---

### What Happens During Renewal

Regardless of which method you use, the renewal process is the same:

1. The dashboard records the current certificate revision number
2. The TLS secret is deleted from Kubernetes
3. cert-manager detects the missing secret and starts re-issuance
4. cert-manager requests a new certificate from the issuer (CA)
5. The issuer signs the new certificate
6. cert-manager stores the new certificate in a new secret
7. The Certificate resource becomes Ready with an incremented revision
8. The dashboard refreshes its cache

---

## 9. Understanding the Renewal SSE Stream

After confirming a renewal, a dark panel appears below the certificate card showing real-time progress:

### In-Progress View

![SSE In Progress](../../e2e/screenshots/cert-dashboard/cert-dashboard-07-sse-in-progress.png)

### Completed View

![SSE Complete](../../e2e/screenshots/cert-dashboard/cert-dashboard-08-sse-complete.png)

### Phase-by-Phase Breakdown

| # | Phase | Icon | Color | Message | What's Happening |
|---|-------|------|-------|---------|------------------|
| 1 | Start | Spinner | Gray | "Starting renewal..." | Dashboard is preparing |
| 2 | `deleting-secret` | Spinner | Yellow | "Deleting TLS secret 'X' to trigger renewal..." | TLS secret is being deleted from Kubernetes |
| 3 | `waiting-issuing` | Spinner | Blue | "Secret deleted. Waiting for cert-manager to issue new certificate..." | cert-manager detected the missing secret and is requesting a new one from the issuer |
| 4 | `issued` | Spinner | Green | "New certificate issued by cert-manager." | The issuer has signed a new certificate |
| 5 | `ready` | None | **Green bold** | "Certificate is Ready. Revision: 20 -> 21" | The new certificate is stored in a secret and the Certificate resource is Ready |
| 6 | `complete` | None | **Green bold** | "Renewal complete" | Process finished successfully |

### Timing

- **Typical duration**: 2-5 seconds for the entire renewal
- **Maximum timeout**: 60 seconds (if cert-manager is slow to issue)
- **HTTPS interruption**: Momentary (< 1 second) while the old secret is deleted and the new one is created

### Error Handling

If any step fails, you'll see a red error message:

| Error | Likely Cause |
|-------|-------------|
| "Failed to get current revision" | Dashboard can't read the Certificate resource — check RBAC |
| "Failed to delete secret" | Dashboard doesn't have delete permission on the secret |
| "Timeout waiting for certificate" | cert-manager didn't issue within 60s — check cert-manager logs |

---

## 10. After Renewal — Verifying Changes

### Immediate View (SSE Panel Still Visible)

![After Renewal](../../e2e/screenshots/cert-dashboard/cert-dashboard-09-after-renewal.png)

The SSE panel stays visible for about 10 seconds so you can review the log.

### Refreshed View (Updated Certificate Data)

![Refreshed After Renewal](../../e2e/screenshots/cert-dashboard/cert-dashboard-10-refreshed-after-renewal.png)

After the auto-refresh, the certificate card updates with:

| Field | What Changed |
|-------|-------------|
| **Serial Number** | New hex value (every certificate gets a unique serial) |
| **Not Before** | Updated to the renewal timestamp |
| **Not After** | Extended by the certificate's duration (e.g., +30 days) |
| **Renewal Time** | Recalculated based on new Not After |
| **Revision** | Incremented by 1 (e.g., 20 -> 21) |
| **Progress Bar** | Full green (100% lifetime remaining) |

### Verify HTTPS Still Works

After renewing a gateway certificate, verify that HTTPS endpoints are still functional:

```bash
curl -sk https://api.service.net:30000/ecom/books | head -c 100
```

Expected: HTTP 200 with JSON response.

---

## 11. Using the REST API

The dashboard exposes a REST API for programmatic access and automation.

### Health Check

```bash
curl http://localhost:32600/healthz
```

![Health Endpoint](../../e2e/screenshots/cert-dashboard/cert-dashboard-11-healthz.png)

**Response:** `{"status":"ok"}`

Use this endpoint for Kubernetes liveness/readiness probes or external monitoring.

### List All Certificates

```bash
curl -s http://localhost:32600/api/certs | python3 -m json.tool
```

![API Certs](../../e2e/screenshots/cert-dashboard/cert-dashboard-12-api-certs.png)

**Response:** JSON array of certificate objects with all fields shown in the dashboard cards.

**Example response structure:**
```json
[
  {
    "name": "bookstore-gateway-cert",
    "namespace": "infra",
    "issuer": "bookstore-ca-issuer",
    "issuerKind": "ClusterIssuer",
    "dnsNames": ["myecom.net", "api.service.net", "idp.keycloak.net", "localhost"],
    "ipAddresses": ["127.0.0.1"],
    "algorithm": "ECDSA P-256",
    "serialNumber": "999A5CD56B64C9B2E7D92943B054BA73",
    "notBefore": "2026-03-10T17:45:00Z",
    "notAfter": "2026-04-09T17:45:00Z",
    "renewalTime": "2026-04-02T17:45:00Z",
    "duration": "720h",
    "renewBefore": "168h",
    "revision": 21,
    "ready": true,
    "daysTotal": 30,
    "daysElapsed": 0,
    "daysRemaining": 30,
    "status": "green",
    "secretName": "bookstore-gateway-tls",
    "isCA": false
  }
]
```

### Prometheus Metrics

```bash
curl -s http://localhost:32600/metrics
```

**Response:** Prometheus exposition format with certificate counts, days remaining, ready status, and renewal counters.

### Trigger Renewal via API

**Authentication required.** The renew endpoint requires a valid Kubernetes ServiceAccount token.

```bash
# Step 1: Get a short-lived token (valid 10 minutes)
TOKEN=$(kubectl create token bookstore-certs -n cert-dashboard --duration=10m)

# Step 2: Trigger the renewal
curl -s -X POST http://localhost:32600/api/renew \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"bookstore-gateway-cert","namespace":"infra"}'
```

**Response:**
```json
{"streamId":"505c9948-be50-436b-8724-aab86bac4d8c"}
```

> For the full step-by-step walkthrough including SSE monitoring and verification, see [Section 8: Renewing a Certificate — Method A](#method-a-renew-via-cli-recommended).

### Subscribe to Renewal Stream

```bash
# Use the streamId from the renew response (no auth required for SSE)
curl -sN http://localhost:32600/api/sse/505c9948-be50-436b-8724-aab86bac4d8c
```

**Response** (Server-Sent Events format):
```
: keepalive

event: status
data: {"event":"status","phase":"deleting-secret","message":"Deleting TLS secret 'bookstore-gateway-tls' to trigger renewal..."}

event: status
data: {"event":"status","phase":"waiting-issuing","message":"Secret deleted. Waiting for cert-manager to issue new certificate..."}

event: status
data: {"event":"status","phase":"issued","message":"New certificate issued by cert-manager."}

event: status
data: {"event":"status","phase":"ready","message":"Certificate is Ready. Revision: 21 → 22"}

event: complete
data: {"event":"complete","message":"Renewal complete","done":true}
```

### API Error Responses

| Endpoint | Status | Body | Cause | Fix |
|----------|--------|------|-------|-----|
| `POST /api/renew` | 400 | `{"error":"name and namespace required"}` | Empty name or namespace | Provide both `name` and `namespace` in JSON body |
| `POST /api/renew` | 400 | `{"error":"name or namespace exceeds maximum length"}` | Name > 253 chars or namespace > 63 chars | Use valid Kubernetes resource names |
| `POST /api/renew` | 401 | `{"error":"authorization header required"}` | No `Authorization` header sent | Add `Authorization: Bearer $TOKEN` header (see [Method A](#method-a-renew-via-cli-recommended)) |
| `POST /api/renew` | 401 | `{"error":"invalid authorization header format"}` | Header present but not `Bearer <token>` format | Use format: `Authorization: Bearer <token>` |
| `POST /api/renew` | 401 | `{"error":"invalid or expired token"}` | Token failed Kubernetes TokenReview validation | Generate a fresh token: `kubectl create token bookstore-certs -n cert-dashboard` |
| `POST /api/renew` | 404 | `{"error":"certificate not found"}` | Certificate doesn't exist in monitored namespaces | Verify cert exists: `kubectl get cert -A` |
| `POST /api/renew` | 429 | `{"error":"rate limit exceeded, try again later"}` | Another renewal was triggered < 10 seconds ago | Wait 10 seconds and retry |
| `POST /api/renew` | 500 | `{"error":"authentication service unavailable"}` | Kubernetes API server unreachable | Check cluster health: `kubectl cluster-info` |
| `GET /api/sse/{id}` | 400 | `streamId required` | No stream ID in URL path | Use the `streamId` from the renew response |
| `GET /api/sse/{id}` | 404 | `stream not found` | Invalid or expired stream ID (streams expire ~2s after completion) | Trigger a new renewal to get a fresh streamId |

---

## 12. Auto-Refresh Behaviour

The dashboard refreshes certificate data automatically:

| Trigger | Interval | Condition |
|---------|----------|-----------|
| **Background poll** | Every 30 seconds | Only when no SSE panel is active |
| **After renewal** | 10 seconds after completion | SSE panel clears and fresh data loads |
| **Watcher (server-side)** | Every 15 seconds | Dashboard backend polls Kubernetes API |

**Important:** Auto-refresh does NOT cause a full page reload. Only the certificate data is fetched and re-rendered. If you're viewing an SSE renewal stream, the refresh is paused to avoid disrupting the live view.

---

## 13. Quick Reference

### URLs

| URL | Purpose |
|-----|---------|
| `http://localhost:32600` | Dashboard UI |
| `http://localhost:32600/healthz` | Health check |
| `http://localhost:32600/api/certs` | Certificate list (JSON) |
| `http://localhost:32600/api/renew` | Trigger renewal (POST, auth required) |
| `http://localhost:32600/api/sse/{id}` | Renewal SSE stream |
| `http://localhost:32600/metrics` | Prometheus metrics |

### kubectl Commands

```bash
# Check dashboard pod
kubectl get pods -n cert-dashboard -l app=cert-dashboard

# Check operator pod
kubectl get pods -n cert-dashboard -l app=cert-dashboard-operator

# View CR status
kubectl get certdashboard -n cert-dashboard

# Dashboard logs
kubectl logs -n cert-dashboard -l app=cert-dashboard --tail=50

# Operator logs
kubectl logs -n cert-dashboard -l app=cert-dashboard-operator --tail=50

# List cert-manager certificates
kubectl get certificates --all-namespaces
```

### Progress Bar Color Thresholds

| Days Remaining | Color | Urgency |
|---------------|-------|---------|
| > 10 | Green | No action needed |
| 6 - 10 | Yellow | Renewal approaching |
| 0 - 5 | Red | Renewal overdue or imminent |

### Renewal Impact

| Certificate Type | Impact of Renewal | Downtime |
|-----------------|-------------------|----------|
| **Leaf (gateway)** | Brief HTTPS interruption (< 1 second) | Minimal |
| **CA** | All leaf certs signed by this CA become untrusted | **Significant** |

---

## 14. FAQ

### Q: How often does cert-manager auto-renew certificates?

cert-manager renews certificates automatically based on the `renewBefore` field. For a certificate with `duration: 720h` (30 days) and `renewBefore: 168h` (7 days), cert-manager will auto-renew at day 23 — you don't need to click Renew manually.

The dashboard's Renew button is for **forced on-demand renewal** when you need a new certificate immediately (e.g., after a key compromise or configuration change).

### Q: Will renewing a certificate break my application?

For **leaf certificates** (like `bookstore-gateway-cert`): there may be a momentary HTTPS interruption (< 1 second) while the old secret is deleted and the new one is created. Active connections using the old certificate will continue to work until they're closed.

For **CA certificates**: **yes** — renewing a CA invalidates all leaf certificates signed by it. Do not renew CA certificates through the dashboard unless you plan to re-issue all leaf certificates afterward.

### Q: What does "Revision: 20 -> 21" mean?

The revision number tracks how many times cert-manager has issued this certificate. `20 -> 21` means this was the 21st issuance. The number increments by 1 on each successful renewal.

### Q: The progress bar is red — is the certificate expired?

Not necessarily. Red means **5 days or fewer** remain. cert-manager should auto-renew before expiry (based on `renewBefore`). If the bar is red and the certificate shows "Ready", check the `Renewal Time` field — cert-manager may be about to renew.

If the certificate is **Not Ready** and red, check cert-manager logs:
```bash
kubectl logs -n cert-manager deploy/cert-manager --tail=50
```

### Q: Can I use the API to build automated monitoring?

Yes. Poll `GET /api/certs` and check the `status` and `daysRemaining` fields:

```bash
# Alert if any certificate has fewer than 7 days remaining
curl -s http://localhost:32600/api/certs | \
  python3 -c "
import sys, json
certs = json.load(sys.stdin)
for c in certs:
    if c['daysRemaining'] < 7:
        print(f\"ALERT: {c['name']} in {c['namespace']} has {c['daysRemaining']} days remaining\")
"
```

### Q: The dashboard shows "No certificates found"

Check:
1. cert-manager is installed: `kubectl get pods -n cert-manager`
2. Certificates exist: `kubectl get certificates --all-namespaces`
3. The CertDashboard CR monitors the right namespaces:
   ```bash
   kubectl get certdashboard -n cert-dashboard -o jsonpath='{.items[0].spec.namespaces}'
   ```
4. Dashboard RBAC allows reading certificates:
   ```bash
   kubectl auth can-i list certificates.cert-manager.io \
     --as=system:serviceaccount:cert-dashboard:bookstore-certs \
     -n infra
   ```

### Q: Can I change the threshold days for yellow/red?

Yes. Edit the CertDashboard CR:

```bash
kubectl edit certdashboard bookstore-certs -n cert-dashboard
```

Change:
```yaml
spec:
  yellowThresholdDays: 14   # was 10
  redThresholdDays: 7       # was 5
```

The operator will update the dashboard deployment with the new thresholds.

### Q: How do I add more namespaces to monitor?

Edit the CertDashboard CR and add namespaces to the `spec.namespaces` array:

```bash
kubectl patch certdashboard bookstore-certs -n cert-dashboard \
  --type=json -p='[{"op":"add","path":"/spec/namespaces/-","value":"my-new-namespace"}]'
```

### Q: How do I renew a certificate from the browser?

Click "Renew Certificate" on any card. The confirmation dialog will ask you to paste a Kubernetes ServiceAccount token. Run the kubectl command shown in the dialog to get the token, paste it in, and click "Renew Certificate". See [Method B: Browser UI](#method-b-renew-via-browser-ui-recommended-for-interactive-use) for the full walkthrough.

### Q: Why does the browser Renew button show "authorization header required"?

This happens if the frontend code is outdated. Refresh the page — the latest version includes a token input field in the confirmation dialog. If the error persists, check the dashboard pod is running the latest image (see `rebuild-deploy.sh`).

Viewing certificates (`GET /api/certs`) and the health check (`GET /healthz`) do **not** require authentication — only the renewal endpoint is protected.

### Q: How do I get a ServiceAccount token for renewal?

```bash
# Create a short-lived token (10 minutes)
TOKEN=$(kubectl create token bookstore-certs -n cert-dashboard --duration=10m)
echo "$TOKEN"
```

**Prerequisites:**
- You must have `kubectl` configured with cluster access
- Your kubeconfig user must have permission to create tokens for ServiceAccounts in the `cert-dashboard` namespace
- Cluster-admin role satisfies this; otherwise you need an RBAC binding:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: cert-dashboard-token-creator
  namespace: cert-dashboard
rules:
- apiGroups: [""]
  resources: ["serviceaccounts/token"]
  verbs: ["create"]
```

### Q: The token expired and I get "invalid or expired token" — what now?

`kubectl create token` generates short-lived tokens (default: 1 hour, or whatever you set with `--duration`). Simply generate a new one:

```bash
TOKEN=$(kubectl create token bookstore-certs -n cert-dashboard --duration=10m)
```

### Q: Can I use my own ServiceAccount token instead of bookstore-certs?

Yes. Any valid Kubernetes ServiceAccount token will pass the TokenReview check. The dashboard validates that the token is **authenticated** (not expired, properly signed) but does not enforce specific roles or service accounts. Use any SA token your cluster admin has access to:

```bash
# Using the default SA in kube-system (cluster-admin typically has access)
TOKEN=$(kubectl create token default -n kube-system --duration=10m)
```

### Q: Why does POST /api/renew return 429?

Rate limiting allows only one renewal every 10 seconds. This prevents accidental rapid-fire renewals that could overwhelm cert-manager.

```bash
# If you get 429, just wait and retry
sleep 10
TOKEN=$(kubectl create token bookstore-certs -n cert-dashboard --duration=10m)
curl -s -X POST http://localhost:32600/api/renew \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"bookstore-gateway-cert","namespace":"infra"}'
```

### Q: How do I automate certificate renewal in a CronJob?

Create a Kubernetes CronJob that uses the dashboard's ServiceAccount token:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: cert-renew-gateway
  namespace: cert-dashboard
spec:
  schedule: "0 2 15 * *"  # 2 AM on the 15th of each month
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: bookstore-certs
          containers:
          - name: renew
            image: curlimages/curl:latest
            command:
            - sh
            - -c
            - |
              # Read the mounted SA token
              TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
              # Trigger renewal
              RESPONSE=$(curl -sf -X POST http://bookstore-certs.cert-dashboard:8080/api/renew \
                -H "Content-Type: application/json" \
                -H "Authorization: Bearer $TOKEN" \
                -d '{"name":"bookstore-gateway-cert","namespace":"infra"}')
              echo "Renewal triggered: $RESPONSE"
          restartPolicy: OnFailure
```

> **Note:** The CronJob pod's auto-mounted ServiceAccount token is valid and passes TokenReview. No need for `kubectl create token` when running inside the cluster.

### Q: The SSE stream shows "SSE connection lost"

This usually means:
- A reverse proxy or load balancer timed out the SSE connection
- The dashboard pod restarted during renewal
- Network interruption between browser and cluster

The renewal may still have succeeded. Refresh the page to check the current certificate state.
