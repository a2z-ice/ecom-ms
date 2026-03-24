/**
 * Security Hardening E2E Tests (Session 30)
 *
 * Validates container and network security improvements:
 *   1. .dockerignore files exist for all services
 *   2. Gateway egress NetworkPolicy restricts to named namespaces/ports
 *   3. Kafka ingress restricted to named pods only
 *   4. Inventory CORS does not allow DELETE
 *   5. Cert-dashboard RBAC trimmed (no create/delete on ClusterRoles)
 *   6. Ecom logging uses LOG_LEVEL env var
 *   7. PSS restricted on ecom and inventory namespaces
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')

function kubectl(args: string[]): string {
  return execFileSync('kubectl', args, { encoding: 'utf-8', timeout: 15_000 }).trim()
}

function kubectlJson<T>(args: string[]): T {
  const raw = kubectl([...args, '-o', 'json'])
  return JSON.parse(raw) as T
}

test.describe('Session 30 — Security: Container & Network Layer', () => {

  test.describe('Dockerignore files', () => {
    for (const svc of ['ecom-service', 'inventory-service', 'ui']) {
      test(`${svc} has .dockerignore`, () => {
        const p = path.join(REPO_ROOT, svc, '.dockerignore')
        expect(fs.existsSync(p), `${svc}/.dockerignore should exist`).toBeTruthy()
        const content = fs.readFileSync(p, 'utf-8')
        expect(content).toContain('.git')
        expect(content).toContain('.env')
      })
    }
  })

  test.describe('Gateway egress NetworkPolicy', () => {
    test('gateway-egress restricts to named namespaces', () => {
      const np = kubectlJson<any>(['get', 'networkpolicy', 'gateway-egress', '-n', 'infra'])
      const egress = np.spec.egress
      expect(egress.length).toBeGreaterThanOrEqual(4)
      // Should NOT have a blanket allow-all rule (empty object)
      const hasOpenEgress = egress.some((r: any) =>
        Object.keys(r).length === 0 ||
        (r.to === undefined && r.ports === undefined)
      )
      expect(hasOpenEgress, 'gateway should not have open egress').toBeFalsy()
    })

    test('gateway-egress allows ecom namespace on port 8080', () => {
      const np = kubectlJson<any>(['get', 'networkpolicy', 'gateway-egress', '-n', 'infra'])
      const egress = np.spec.egress
      const ecomRule = egress.find((r: any) =>
        r.to?.some((t: any) =>
          t.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'ecom'
        ) && r.ports?.some((p: any) => p.port === 8080)
      )
      expect(ecomRule, 'should have ecom:8080 egress rule').toBeTruthy()
    })
  })

  test.describe('Kafka ingress NetworkPolicy', () => {
    test('kafka-ingress restricts infra access to named pods', () => {
      const np = kubectlJson<any>(['get', 'networkpolicy', 'kafka-ingress', '-n', 'infra'])
      const ingress = np.spec.ingress
      // Should NOT have a blanket podSelector: {} rule
      const hasOpenPodSelector = ingress.some((r: any) =>
        r.from?.some((f: any) =>
          f.podSelector && Object.keys(f.podSelector).length === 0 && !f.namespaceSelector
        )
      )
      expect(hasOpenPodSelector, 'kafka should not have open podSelector').toBeFalsy()
    })

    test('kafka-ingress allows debezium and schema-registry pods', () => {
      const np = kubectlJson<any>(['get', 'networkpolicy', 'kafka-ingress', '-n', 'infra'])
      const ingress = np.spec.ingress
      const namedRule = ingress.find((r: any) =>
        r.from?.some((f: any) =>
          f.podSelector?.matchExpressions?.[0]?.values?.includes('debezium-server-ecom')
        )
      )
      expect(namedRule, 'should have named pod selector for debezium').toBeTruthy()
    })
  })

  test.describe('Inventory CORS', () => {
    test('inventory does not allow DELETE in CORS', async ({ request }) => {
      const resp = await request.fetch('https://api.service.net:30000/inven/health', {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://myecom.net:30000',
          'Access-Control-Request-Method': 'DELETE',
        },
        ignoreHTTPSErrors: true,
      })
      const allowMethods = resp.headers()['access-control-allow-methods'] || ''
      expect(allowMethods).not.toContain('DELETE')
    })
  })

  test.describe('Cert-dashboard RBAC', () => {
    test('manager-role does not have create/delete on ClusterRoles', () => {
      const cr = kubectlJson<any>(['get', 'clusterrole', 'manager-role'])
      const rbacRule = cr.rules.find((r: any) =>
        r.apiGroups?.includes('rbac.authorization.k8s.io') &&
        r.resources?.includes('clusterroles')
      )
      expect(rbacRule, 'should have rbac rule').toBeTruthy()
      expect(rbacRule.verbs).not.toContain('create')
      expect(rbacRule.verbs).not.toContain('delete')
    })
  })

  test.describe('Pod Security Standards', () => {
    for (const ns of ['ecom', 'inventory']) {
      test(`${ns} namespace has PSS restricted`, () => {
        const nsObj = kubectlJson<any>(['get', 'namespace', ns])
        expect(nsObj.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted')
      })
    }

    for (const ns of ['infra', 'identity', 'analytics', 'observability']) {
      test(`${ns} namespace stays at PSS baseline`, () => {
        const nsObj = kubectlJson<any>(['get', 'namespace', ns])
        expect(nsObj.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('baseline')
      })
    }
  })

  test.describe('Ecom logging config', () => {
    test('ecom-service deployment has LOG_LEVEL or uses default INFO', () => {
      // Verify the application.yml uses LOG_LEVEL env var
      const appYml = fs.readFileSync(
        path.join(REPO_ROOT, 'ecom-service/src/main/resources/application.yml'),
        'utf-8'
      )
      expect(appYml).toContain('${LOG_LEVEL:INFO}')
    })
  })
})
