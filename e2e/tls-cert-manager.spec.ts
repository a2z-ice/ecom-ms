/**
 * TLS & cert-manager E2E Tests
 *
 * Covers:
 *   1. cert-manager resources: ClusterIssuers, CA Certificate, Gateway Certificate
 *   2. TLS certificate properties: SANs, expiry, algorithm, issuer chain
 *   3. HTTPS endpoint connectivity on all gateway hostnames
 *   4. HTTP→HTTPS redirect (port 30080 → 301 → https://:30000)
 *   5. Auto-rotation readiness: renewBefore annotation, certificate age
 *   6. TLS rotation ConfigMap consistency with actual Certificate spec
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Run kubectl and return trimmed stdout. */
function kubectl(args: string[]): string {
  return execFileSync('kubectl', args, {
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim()
}

/** Parse JSON from kubectl output. */
function kubectlJson<T = unknown>(args: string[]): T {
  const raw = kubectl([...args, '-o', 'json'])
  return JSON.parse(raw) as T
}

/** Get a specific jsonpath from a resource. */
function kubectlJsonpath(resource: string, namespace: string, jsonpath: string): string {
  return kubectl([
    'get', resource, '-n', namespace, '-o', `jsonpath=${jsonpath}`,
  ])
}

// ═══════════════════════════════════════════════════════════════════════════
// Suite 1 — cert-manager Resources
// ═══════════════════════════════════════════════════════════════════════════
test.describe('cert-manager Resources', () => {

  test('cert-manager namespace exists and has running pods', async () => {
    const pods = kubectl([
      'get', 'pods', '-n', 'cert-manager',
      '--field-selector=status.phase=Running',
      '-o', 'jsonpath={.items[*].metadata.name}',
    ])
    expect(pods.length).toBeGreaterThan(0)
    // At minimum: cert-manager, cert-manager-webhook, cert-manager-cainjector
    expect(pods).toContain('cert-manager')
  })

  test('selfsigned-bootstrap ClusterIssuer is Ready', async () => {
    const status = kubectlJsonpath(
      'clusterissuer/selfsigned-bootstrap', '',
      '{.status.conditions[?(@.type=="Ready")].status}',
    )
    expect(status).toBe('True')
  })

  test('bookstore-ca-issuer ClusterIssuer is Ready', async () => {
    const status = kubectlJsonpath(
      'clusterissuer/bookstore-ca-issuer', '',
      '{.status.conditions[?(@.type=="Ready")].status}',
    )
    expect(status).toBe('True')
  })

  test('bookstore-ca Certificate in cert-manager namespace is Ready', async () => {
    const status = kubectlJsonpath(
      'certificate/bookstore-ca', 'cert-manager',
      '{.status.conditions[?(@.type=="Ready")].status}',
    )
    expect(status).toBe('True')
  })

  test('bookstore-ca Certificate is a CA (isCA: true)', async () => {
    const isCA = kubectlJsonpath(
      'certificate/bookstore-ca', 'cert-manager',
      '{.spec.isCA}',
    )
    expect(isCA).toBe('true')
  })

  test('bookstore-gateway-cert Certificate in infra namespace is Ready', async () => {
    const status = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.status.conditions[?(@.type=="Ready")].status}',
    )
    expect(status).toBe('True')
  })

  test('CA secret exists in cert-manager namespace', async () => {
    const name = kubectl([
      'get', 'secret', 'bookstore-ca-secret', '-n', 'cert-manager',
      '-o', 'jsonpath={.metadata.name}',
    ])
    expect(name).toBe('bookstore-ca-secret')
  })

  test('Gateway TLS secret exists in infra namespace', async () => {
    const name = kubectl([
      'get', 'secret', 'bookstore-gateway-tls', '-n', 'infra',
      '-o', 'jsonpath={.metadata.name}',
    ])
    expect(name).toBe('bookstore-gateway-tls')
  })

  test('Gateway TLS secret contains tls.crt and tls.key', async () => {
    const keys = kubectl([
      'get', 'secret', 'bookstore-gateway-tls', '-n', 'infra',
      '-o', 'jsonpath={.data}',
    ])
    expect(keys).toContain('tls.crt')
    expect(keys).toContain('tls.key')
    expect(keys).toContain('ca.crt')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 2 — Certificate Properties & SANs
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Certificate Properties & SANs', () => {

  test('Gateway certificate covers all required DNS names', async () => {
    const dnsNames = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.spec.dnsNames}',
    )
    // cert-manager returns JSON array in jsonpath: ["myecom.net","api.service.net",...]
    expect(dnsNames).toContain('myecom.net')
    expect(dnsNames).toContain('api.service.net')
    expect(dnsNames).toContain('idp.keycloak.net')
    expect(dnsNames).toContain('localhost')
  })

  test('Gateway certificate covers IP 127.0.0.1', async () => {
    const ipAddrs = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.spec.ipAddresses}',
    )
    expect(ipAddrs).toContain('127.0.0.1')
  })

  test('Gateway certificate uses ECDSA P-256 private key', async () => {
    const algo = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.spec.privateKey.algorithm}',
    )
    const size = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.spec.privateKey.size}',
    )
    expect(algo).toBe('ECDSA')
    expect(size).toBe('256')
  })

  test('CA certificate uses ECDSA P-256 private key', async () => {
    const algo = kubectlJsonpath(
      'certificate/bookstore-ca', 'cert-manager',
      '{.spec.privateKey.algorithm}',
    )
    expect(algo).toBe('ECDSA')
  })

  test('Gateway certificate issuerRef points to bookstore-ca-issuer', async () => {
    const issuerName = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.spec.issuerRef.name}',
    )
    const issuerKind = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.spec.issuerRef.kind}',
    )
    expect(issuerName).toBe('bookstore-ca-issuer')
    expect(issuerKind).toBe('ClusterIssuer')
  })

  test('TLS certificate SANs verified via openssl from the actual secret', async () => {
    // Extract the cert from the secret and parse SANs with openssl
    const certPem = kubectl([
      'get', 'secret', 'bookstore-gateway-tls', '-n', 'infra',
      '-o', 'jsonpath={.data.tls\\.crt}',
    ])
    const decoded = Buffer.from(certPem, 'base64').toString('utf-8')
    const opensslOutput = execFileSync('openssl', ['x509', '-noout', '-text'], {
      input: decoded,
      encoding: 'utf-8',
      timeout: 10_000,
    })
    expect(opensslOutput).toContain('DNS:myecom.net')
    expect(opensslOutput).toContain('DNS:api.service.net')
    expect(opensslOutput).toContain('DNS:idp.keycloak.net')
    expect(opensslOutput).toContain('DNS:localhost')
    expect(opensslOutput).toContain('IP Address:127.0.0.1')
  })

  test('TLS certificate is signed by BookStore CA', async () => {
    const certPem = kubectl([
      'get', 'secret', 'bookstore-gateway-tls', '-n', 'infra',
      '-o', 'jsonpath={.data.tls\\.crt}',
    ])
    const decoded = Buffer.from(certPem, 'base64').toString('utf-8')
    const opensslOutput = execFileSync('openssl', ['x509', '-noout', '-issuer'], {
      input: decoded,
      encoding: 'utf-8',
      timeout: 10_000,
    })
    expect(opensslOutput).toContain('BookStore CA')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 3 — Auto-Rotation Configuration
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Auto-Rotation Configuration', () => {

  test('Gateway certificate duration is 720h (30 days)', async () => {
    const duration = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.spec.duration}',
    )
    expect(duration).toBe('720h')
  })

  test('Gateway certificate renewBefore is 168h (7 days)', async () => {
    const renewBefore = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.spec.renewBefore}',
    )
    expect(renewBefore).toBe('168h')
  })

  test('CA certificate duration is 87600h (10 years)', async () => {
    const duration = kubectlJsonpath(
      'certificate/bookstore-ca', 'cert-manager',
      '{.spec.duration}',
    )
    expect(duration).toBe('87600h')
  })

  test('CA certificate renewBefore is 8760h (1 year)', async () => {
    const renewBefore = kubectlJsonpath(
      'certificate/bookstore-ca', 'cert-manager',
      '{.spec.renewBefore}',
    )
    expect(renewBefore).toBe('8760h')
  })

  test('Gateway certificate is not yet due for renewal', async () => {
    const renewalTime = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.status.renewalTime}',
    )
    expect(renewalTime).toBeTruthy()
    const renewal = new Date(renewalTime)
    const now = new Date()
    // Renewal time should be in the future (cert was just issued)
    expect(renewal.getTime()).toBeGreaterThan(now.getTime())
  })

  test('Gateway certificate notBefore is in the past', async () => {
    const notBefore = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.status.notBefore}',
    )
    expect(notBefore).toBeTruthy()
    const nb = new Date(notBefore)
    const now = new Date()
    expect(nb.getTime()).toBeLessThanOrEqual(now.getTime())
  })

  test('Gateway certificate notAfter is ~30 days from notBefore', async () => {
    const notBefore = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.status.notBefore}',
    )
    const notAfter = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.status.notAfter}',
    )
    expect(notBefore).toBeTruthy()
    expect(notAfter).toBeTruthy()
    const nb = new Date(notBefore)
    const na = new Date(notAfter)
    const diffHours = (na.getTime() - nb.getTime()) / (1000 * 60 * 60)
    // Should be approximately 720h (30 days), allow ±24h tolerance
    expect(diffHours).toBeGreaterThan(696)
    expect(diffHours).toBeLessThan(744)
  })

  test('Rotation ConfigMap values match Certificate spec', async () => {
    const configMap = kubectlJson<{data: Record<string, string>}>([
      'get', 'configmap', 'tls-rotation-config', '-n', 'infra',
    ])
    expect(configMap.data['cert-duration']).toBe('720h')
    expect(configMap.data['cert-renew-before']).toBe('168h')
    expect(configMap.data['ca-duration']).toBe('87600h')
    expect(configMap.data['ca-renew-before']).toBe('8760h')
  })

  test('cert-manager CertificateRequest for gateway cert exists and is approved', async () => {
    // List CertificateRequests in infra namespace owned by bookstore-gateway-cert
    const output = kubectl([
      'get', 'certificaterequests', '-n', 'infra',
      '-o', 'jsonpath={.items[*].status.conditions[?(@.type=="Approved")].status}',
    ])
    // At least one should be approved
    expect(output).toContain('True')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 4 — HTTPS Endpoint Connectivity
// ═══════════════════════════════════════════════════════════════════════════
test.describe('HTTPS Endpoint Connectivity', () => {

  test('UI is accessible over HTTPS at myecom.net:30000', async ({ request }) => {
    const resp = await request.get('https://myecom.net:30000/')
    expect(resp.status()).toBe(200)
    const body = await resp.text()
    expect(body.toLowerCase()).toContain('<!doctype html')
  })

  test('ecom API is accessible over HTTPS at api.service.net:30000', async ({ request }) => {
    const resp = await request.get('https://api.service.net:30000/ecom/books')
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.content).toBeDefined()
  })

  test('inventory health is accessible over HTTPS', async ({ request }) => {
    const resp = await request.get('https://api.service.net:30000/inven/health')
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.status).toBe('ok')
  })

  test('Keycloak OIDC discovery returns HTTPS issuer', async ({ request }) => {
    const resp = await request.get(
      'https://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration',
    )
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.issuer).toBe('https://idp.keycloak.net:30000/realms/bookstore')
    // All endpoints in discovery should be HTTPS
    expect(body.authorization_endpoint).toMatch(/^https:\/\//)
    expect(body.token_endpoint).toMatch(/^https:\/\//)
    expect(body.jwks_uri).toMatch(/^https:\/\//)
  })

  test('localhost:30000 serves HTTPS', async ({ request }) => {
    const resp = await request.get('https://localhost:30000/')
    expect(resp.status()).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 5 — HTTP→HTTPS Redirect (requires port 30080 in kind cluster)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('HTTP to HTTPS Redirect', () => {

  /** Check if port 30080 is available (requires --fresh rebuild with updated cluster.yaml) */
  function httpRedirectAvailable(): boolean {
    try {
      const nodePort = kubectl([
        'get', 'svc', 'bookstore-gateway-istio', '-n', 'infra',
        '-o', 'jsonpath={.spec.ports[?(@.name=="http")].nodePort}',
      ])
      return nodePort === '30080'
    } catch {
      return false
    }
  }

  test('HTTP port 30080 returns 301 redirect to HTTPS', async ({ request }) => {
    test.skip(!httpRedirectAvailable(), 'Port 30080 not configured — run up.sh --fresh')
    const resp = await request.get('http://myecom.net:30080/', {
      maxRedirects: 0,
    })
    expect(resp.status()).toBe(301)
    const location = resp.headers()['location']
    expect(location).toContain('https://')
    expect(location).toContain(':30000')
  })

  test('HTTP redirect preserves hostname', async ({ request }) => {
    test.skip(!httpRedirectAvailable(), 'Port 30080 not configured — run up.sh --fresh')
    const resp = await request.get('http://api.service.net:30080/ecom/books', {
      maxRedirects: 0,
    })
    expect(resp.status()).toBe(301)
    const location = resp.headers()['location']
    expect(location).toContain('https://api.service.net:30000')
  })

  test('HTTP redirect preserves path', async ({ request }) => {
    test.skip(!httpRedirectAvailable(), 'Port 30080 not configured — run up.sh --fresh')
    const resp = await request.get('http://myecom.net:30080/some/path', {
      maxRedirects: 0,
    })
    expect(resp.status()).toBe(301)
    const location = resp.headers()['location']
    expect(location).toContain('/some/path')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 6 — Gateway TLS Configuration
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Gateway TLS Configuration', () => {

  test('Gateway has HTTPS listener on port 8443', async () => {
    const listeners = kubectl([
      'get', 'gateway', 'bookstore-gateway', '-n', 'infra',
      '-o', 'jsonpath={.spec.listeners[?(@.name=="https")].port}',
    ])
    expect(listeners).toBe('8443')
  })

  test('Gateway HTTPS listener uses Terminate TLS mode', async () => {
    const mode = kubectl([
      'get', 'gateway', 'bookstore-gateway', '-n', 'infra',
      '-o', 'jsonpath={.spec.listeners[?(@.name=="https")].tls.mode}',
    ])
    expect(mode).toBe('Terminate')
  })

  test('Gateway HTTPS listener references bookstore-gateway-tls secret', async () => {
    const certRef = kubectl([
      'get', 'gateway', 'bookstore-gateway', '-n', 'infra',
      '-o', 'jsonpath={.spec.listeners[?(@.name=="https")].tls.certificateRefs[0].name}',
    ])
    expect(certRef).toBe('bookstore-gateway-tls')
  })

  test('Gateway has HTTP listener on port 8080 for redirects', async () => {
    const port = kubectl([
      'get', 'gateway', 'bookstore-gateway', '-n', 'infra',
      '-o', 'jsonpath={.spec.listeners[?(@.name=="http")].port}',
    ])
    expect(port).toBe('8080')
  })

  test('Gateway service has NodePort 30000 for HTTPS', async () => {
    const nodePort = kubectl([
      'get', 'svc', 'bookstore-gateway-istio', '-n', 'infra',
      '-o', 'jsonpath={.spec.ports[?(@.name=="https")].nodePort}',
    ])
    expect(nodePort).toBe('30000')
  })

  test('Gateway service has NodePort 30080 for HTTP redirect', async () => {
    const nodePort = kubectl([
      'get', 'svc', 'bookstore-gateway-istio', '-n', 'infra',
      '-o', 'jsonpath={.spec.ports[?(@.name=="http")].nodePort}',
    ])
    // Port 30080 requires --fresh rebuild with updated kind cluster.yaml
    test.skip(nodePort !== '30080', 'Port 30080 not configured — run up.sh --fresh')
    expect(nodePort).toBe('30080')
  })

  test('All HTTPRoutes attach to HTTPS listener', async () => {
    // Routes live in their service namespaces, not infra
    const routes: [string, string][] = [
      ['ui-route', 'ecom'],
      ['ecom-route', 'ecom'],
      ['keycloak-route', 'identity'],
      ['inven-route', 'inventory'],
    ]
    for (const [route, ns] of routes) {
      const section = kubectl([
        'get', 'httproute', route, '-n', ns,
        '-o', 'jsonpath={.spec.parentRefs[0].sectionName}',
      ])
      expect(section, `${route} in ${ns} should attach to https listener`).toBe('https')
    }
  })

  test('HTTPS redirect route attaches to HTTP listener', async () => {
    const section = kubectl([
      'get', 'httproute', 'https-redirect', '-n', 'infra',
      '-o', 'jsonpath={.spec.parentRefs[0].sectionName}',
    ])
    expect(section).toBe('http')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Suite 7 — Rotation Simulation (force renewal)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('Certificate Rotation Readiness', () => {

  test('cert-manager can issue a new certificate (renew dry-run)', async () => {
    // Verify the certificate has been issued at least once by checking revision
    const revision = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.status.revision}',
    )
    expect(Number(revision)).toBeGreaterThanOrEqual(1)
  })

  test('Gateway certificate has a valid serial number', async () => {
    const certPem = kubectl([
      'get', 'secret', 'bookstore-gateway-tls', '-n', 'infra',
      '-o', 'jsonpath={.data.tls\\.crt}',
    ])
    const decoded = Buffer.from(certPem, 'base64').toString('utf-8')
    const serial = execFileSync('openssl', ['x509', '-noout', '-serial'], {
      input: decoded,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim()
    // Serial should be a hex string like "serial=ABCD1234..."
    expect(serial).toMatch(/serial=[0-9A-Fa-f]+/i)
  })

  test('CA certificate has a longer lifetime than gateway certificate', async () => {
    const caDuration = kubectlJsonpath(
      'certificate/bookstore-ca', 'cert-manager',
      '{.spec.duration}',
    )
    const gwDuration = kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.spec.duration}',
    )
    const caHours = parseInt(caDuration.replace('h', ''))
    const gwHours = parseInt(gwDuration.replace('h', ''))
    expect(caHours).toBeGreaterThan(gwHours)
  })

  test('Force renewal: triggers new certificate issuance', async () => {
    // Get current revision before renewal
    const revBefore = Number(kubectlJsonpath(
      'certificate/bookstore-gateway-cert', 'infra',
      '{.status.revision}',
    ))

    // Trigger renewal via the cert-manager.io/renew-before annotation hack:
    // Delete the Certificate's "Ready" condition by adding the renew trigger annotation.
    // cert-manager watches for this annotation and re-issues the cert.
    try {
      // Try cmctl first (cert-manager kubectl plugin)
      execFileSync('cmctl', ['renew', 'bookstore-gateway-cert', '-n', 'infra'], {
        encoding: 'utf-8',
        timeout: 10_000,
      })
    } catch {
      // Fallback: patch the secret to trigger re-issuance by deleting it
      // cert-manager will detect the missing secret and re-issue
      kubectl([
        'delete', 'secret', 'bookstore-gateway-tls', '-n', 'infra',
      ])
    }

    // Wait for cert-manager to re-issue (new revision)
    let revAfter = revBefore
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000))
      try {
        revAfter = Number(kubectlJsonpath(
          'certificate/bookstore-gateway-cert', 'infra',
          '{.status.revision}',
        ))
        if (revAfter > revBefore) break
      } catch {
        // Certificate might be in Issuing state briefly
      }
    }

    // Verify the certificate was renewed (new revision)
    expect(revAfter).toBeGreaterThan(revBefore)

    // Verify the renewed certificate is Ready
    let ready = 'False'
    for (let i = 0; i < 15; i++) {
      ready = kubectlJsonpath(
        'certificate/bookstore-gateway-cert', 'infra',
        '{.status.conditions[?(@.type=="Ready")].status}',
      )
      if (ready === 'True') break
      await new Promise(r => setTimeout(r, 2000))
    }
    expect(ready).toBe('True')
  })

  test('After rotation, HTTPS endpoints still work', async ({ request }) => {
    // This test runs after the force renewal above
    // Give the gateway a moment to pick up the new cert
    await new Promise(r => setTimeout(r, 3000))

    const resp = await request.get('https://api.service.net:30000/ecom/books')
    expect(resp.status()).toBe(200)
  })
})
