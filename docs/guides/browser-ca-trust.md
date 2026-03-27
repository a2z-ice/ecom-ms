# Browser CA Trust Guide

## Why You See "Your Connection Is Not Private"

The BookStore platform uses **HTTPS everywhere** — all traffic through the gateway (port 30000) is encrypted with TLS. The certificates are issued by a **self-signed Certificate Authority (CA)** managed by cert-manager inside the Kubernetes cluster.

Browsers trust certificates signed by well-known CAs (Let's Encrypt, DigiCert, etc.) because those CAs are pre-installed in the operating system's trust store. Our self-signed CA is **not** in any OS trust store by default, so browsers show the `ERR_CERT_AUTHORITY_INVALID` warning.

**The connection IS encrypted** — the warning only means the browser doesn't recognize the CA that signed the certificate, not that the encryption is broken.

## How the Certificate Chain Works

```
selfsigned-bootstrap (ClusterIssuer)
  └── bookstore-ca (Certificate, 10-year lifetime, isCA: true)
        └── bookstore-ca-issuer (ClusterIssuer)
              └── bookstore-gateway-cert (Certificate, 30-day lifetime)
                    └── bookstore-gateway-tls (Secret, mounted on Istio Gateway)
```

### Certificate Details

| Certificate | Lifetime | Auto-Renew | Purpose |
|---|---|---|---|
| **bookstore-ca** | 10 years (87,600 hours) | Renewed 1 year before expiry | Root CA — signs all leaf certs |
| **bookstore-gateway-cert** | 30 days (720 hours) | Renewed 7 days before expiry | TLS termination at gateway |

### How bookstore-ca.crt Is Created

1. **cert-manager** creates a self-signed CA certificate (`bookstore-ca`) using the `selfsigned-bootstrap` ClusterIssuer
2. The CA certificate is stored as a Kubernetes Secret (`bookstore-ca-secret` in `cert-manager` namespace)
3. The `trust-ca.sh` script extracts the CA's public certificate from this secret:
   ```bash
   kubectl get secret bookstore-ca-secret -n cert-manager \
     -o jsonpath='{.data.ca\.crt}' | base64 -d > certs/bookstore-ca.crt
   ```
4. This `bookstore-ca.crt` file is what you install in your OS trust store

### Hostnames Covered by the Gateway Certificate

- `myecom.net` — UI
- `api.service.net` — API gateway
- `idp.keycloak.net` — Keycloak identity provider
- `localhost` — local development
- `127.0.0.1` — IP access

---

## Install CA Certificate (Trust the Self-Signed CA)

### Step 1: Extract the CA Certificate

Run from the project root (requires `kubectl` access to the cluster):

```bash
bash scripts/trust-ca.sh
```

This saves the CA cert to `certs/bookstore-ca.crt`.

### Step 2: Install in Your OS Trust Store

#### macOS

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  certs/bookstore-ca.crt
```

Then **quit and reopen Chrome** (it caches certificate state).

**Or use the one-liner:**
```bash
bash scripts/trust-ca.sh --install --yes
```

#### Ubuntu / Debian Linux

```bash
# Copy the CA cert to the system trust store
sudo cp certs/bookstore-ca.crt /usr/local/share/ca-certificates/bookstore-ca.crt

# Update the system CA bundle
sudo update-ca-certificates
```

Then restart Chrome:
```bash
# Chrome on Linux reads from NSS database — also import there
certutil -d sql:$HOME/.pki/nssdb -A \
  -t "C,," \
  -n "BookStore CA" \
  -i certs/bookstore-ca.crt
```

Restart Chrome after both commands.

#### RHEL / CentOS / Fedora

```bash
# Copy the CA cert to the system trust anchors
sudo cp certs/bookstore-ca.crt /etc/pki/ca-trust/source/anchors/bookstore-ca.crt

# Update the system CA bundle
sudo update-ca-trust extract
```

Then import into Chrome's NSS database:
```bash
certutil -d sql:$HOME/.pki/nssdb -A \
  -t "C,," \
  -n "BookStore CA" \
  -i certs/bookstore-ca.crt
```

Restart Chrome.

#### Windows

**Option A: GUI**
1. Double-click `certs/bookstore-ca.crt`
2. Click **Install Certificate...**
3. Select **Local Machine** → Next
4. Select **Place all certificates in the following store** → Browse → **Trusted Root Certification Authorities** → OK → Next → Finish
5. Click **Yes** on the security warning
6. Restart Chrome

**Option B: PowerShell (Admin)**
```powershell
Import-Certificate -FilePath .\certs\bookstore-ca.crt `
  -CertStoreLocation Cert:\LocalMachine\Root
```

Restart Chrome.

---

## Verify It Works

After installing the CA cert and restarting your browser:

```bash
# Should show a padlock (trusted) in the browser
https://myecom.net:30000/
https://api.service.net:30000/ecom/books
https://idp.keycloak.net:30000/

# curl should work without -k flag
curl --cacert certs/bookstore-ca.crt https://api.service.net:30000/ecom/books
```

---

## What Happens When Certificates Expire

### Gateway Certificate (30 days)

**You don't need to do anything.** cert-manager automatically renews the gateway certificate 7 days before expiry. The renewal is seamless — Istio picks up the new certificate without downtime.

You can verify the current certificate status:
```bash
kubectl get certificate -n infra bookstore-gateway-cert
# READY=True means certificate is valid
# NOT_AFTER shows expiry date
```

### CA Certificate (10 years)

The CA certificate expires in **10 years**. When it's renewed (1 year before expiry), you need to:

1. Re-extract the new CA cert: `bash scripts/trust-ca.sh`
2. Re-install it in your OS trust store (same commands as above)
3. The old CA cert in your trust store will stop working for new leaf certs

### Force Certificate Renewal

If you need to manually trigger a renewal (e.g., after changing hostnames):

```bash
# Delete the gateway cert secret — cert-manager will re-issue
kubectl delete secret bookstore-gateway-tls -n infra

# Verify renewal
kubectl get certificate -n infra bookstore-gateway-cert -w
# Wait for READY=True
```

The CA cert in your OS trust store does NOT need to be reinstalled after a gateway cert renewal — only after a CA cert renewal.

---

## Revert: Remove CA Certificate from Trust Store

If you want to undo the trust and restore the browser warning:

### macOS

```bash
sudo security delete-certificate -c "bookstore-ca" /Library/Keychains/System.keychain
```

Or open **Keychain Access** → System → search for `bookstore-ca` → right-click → Delete.

### Ubuntu / Debian Linux

```bash
sudo rm /usr/local/share/ca-certificates/bookstore-ca.crt
sudo update-ca-certificates --fresh

# Also remove from Chrome NSS database
certutil -d sql:$HOME/.pki/nssdb -D -n "BookStore CA"
```

### RHEL / CentOS / Fedora

```bash
sudo rm /etc/pki/ca-trust/source/anchors/bookstore-ca.crt
sudo update-ca-trust extract

# Also remove from Chrome NSS database
certutil -d sql:$HOME/.pki/nssdb -D -n "BookStore CA"
```

### Windows

**Option A: GUI**
1. Press `Win+R` → type `certmgr.msc` → Enter
2. Navigate to **Trusted Root Certification Authorities** → **Certificates**
3. Find `bookstore-ca` → right-click → **Delete**

**Option B: PowerShell (Admin)**
```powershell
Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "*bookstore*" } | Remove-Item
```

Restart your browser after removing the certificate.

---

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| Warning persists after install | Browser cached old state | Quit and reopen browser (not just refresh) |
| `certutil` command not found (Linux) | NSS tools not installed | `sudo apt install libnss3-tools` (Ubuntu) or `sudo dnf install nss-tools` (RHEL) |
| "The certificate is not trusted" on curl | Using wrong CA file | Use `--cacert certs/bookstore-ca.crt` (not the gateway cert) |
| Certificate expired | Gateway cert auto-renewed but CA was re-issued | Re-extract: `bash scripts/trust-ca.sh --install` |
| Multiple browser profiles | Each Chrome profile may have its own NSS DB | Repeat `certutil` command for each profile's `$HOME/.pki/nssdb` |
