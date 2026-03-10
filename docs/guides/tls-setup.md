# TLS Setup Guide

## Overview

The bookstore platform uses TLS (HTTPS) for all external-facing endpoints via the Istio Gateway. Certificates are managed by cert-manager with automatic rotation.

## Architecture

```
User (HTTPS) → kind NodePort 30000 → Istio Gateway (TLS termination) → Services (HTTP)
```

- **TLS termination** happens at the Istio Gateway
- **cert-manager** manages certificate lifecycle (issuance + rotation)
- **Self-signed CA** issues all certificates
- **Single multi-SAN cert** covers all 4 hostnames + 127.0.0.1
- Pod-to-pod traffic is already encrypted via Istio mTLS (unchanged)

## Certificate Chain

```
selfsigned-bootstrap (ClusterIssuer)
  └── bookstore-ca (Certificate, 10yr) → bookstore-ca-secret
        └── bookstore-ca-issuer (ClusterIssuer)
              └── bookstore-gateway-cert (Certificate, 30d) → bookstore-gateway-tls
```

## Hostnames Covered

- `myecom.net` — UI
- `api.service.net` — ecom + inventory APIs
- `idp.keycloak.net` — Keycloak OIDC provider
- `localhost` — local development
- `127.0.0.1` — IP access

## Rotation

| Certificate | Duration | Renew Before | Auto-Rotate |
|---|---|---|---|
| Gateway cert | 30 days | 7 days before expiry | Yes (cert-manager) |
| CA cert | 10 years | 1 year before expiry | Yes (cert-manager) |

cert-manager watches Certificate resources and automatically renews them before expiry. No manual intervention needed.

## Tool NodePorts

These remain HTTP (internal dev tools, not user-facing):

| Tool | URL |
|---|---|
| PgAdmin | `http://localhost:31111` |
| Superset | `http://localhost:32000` |
| Kiali | `http://localhost:32100/kiali` |
| Flink | `http://localhost:32200` |
| Debezium ecom | `http://localhost:32300/q/health` |
| Debezium inventory | `http://localhost:32301/q/health` |
| Keycloak Admin (direct) | `http://localhost:32400/admin` |
| Grafana | `http://localhost:32500` |

## Trusting the CA

### Extract CA certificate

```bash
bash scripts/trust-ca.sh
```

This saves the CA cert to `certs/bookstore-ca.crt`.

### Use with curl

```bash
curl --cacert certs/bookstore-ca.crt https://api.service.net:30000/ecom/books
# Or use -k to skip verification:
curl -k https://api.service.net:30000/ecom/books
```

### Use with Node.js / Playwright

```bash
export NODE_EXTRA_CA_CERTS=certs/bookstore-ca.crt
cd e2e && npm run test
```

### Install in macOS Keychain (browser trust)

```bash
bash scripts/trust-ca.sh --install
```

After this, browsers will trust the bookstore TLS certificate without warnings.

## HTTP → HTTPS Redirect

Port 30080 serves an HTTP listener that redirects all requests to HTTPS on port 30000 via an HTTPRoute (301 Moved Permanently):

```bash
curl -v http://myecom.net:30080/
# → 301 Moved Permanently → https://myecom.net:30000/
```

Port 30000 serves HTTPS only. The redirect is configured in `infra/kgateway/routes/https-redirect.yaml`.

## Troubleshooting

### Certificate not ready

```bash
kubectl get certificate -n infra bookstore-gateway-cert
kubectl describe certificate -n infra bookstore-gateway-cert
kubectl get certificaterequest -n infra
```

### Gateway not serving HTTPS

```bash
kubectl get gateway -n infra bookstore-gateway -o yaml
kubectl get svc bookstore-gateway-istio -n infra
```

### Check certificate details

```bash
kubectl get secret bookstore-gateway-tls -n infra -o jsonpath='{.data.tls\.crt}' | \
  base64 -d | openssl x509 -text -noout
```

## Files

| File | Purpose |
|---|---|
| `infra/cert-manager/install.sh` | cert-manager installation |
| `infra/cert-manager/ca-issuer.yaml` | CA bootstrap + issuer |
| `infra/cert-manager/gateway-certificate.yaml` | Gateway TLS cert |
| `infra/cert-manager/rotation-config.yaml` | Rotation settings reference |
| `infra/kgateway/gateway.yaml` | HTTPS listener config |
| `infra/kgateway/routes/https-redirect.yaml` | HTTP→HTTPS redirect |
| `scripts/trust-ca.sh` | CA cert extraction + macOS trust |
