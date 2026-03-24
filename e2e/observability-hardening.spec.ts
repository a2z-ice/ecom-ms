/**
 * Observability Hardening E2E Tests (Session 33)
 *
 * Validates observability improvements:
 *   1. Business metrics (orders_total, checkout_duration_seconds, inventory_reserved_total)
 *   2. CDC pipeline Grafana dashboard
 *   3. Security alert rules in Prometheus
 *   4. AlertManager configured receiver
 *   5. Git SHA image tagging in build scripts
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const REPO_ROOT = path.resolve(__dirname, '..')
const ECOM_ACTUATOR = 'https://api.service.net:30000/ecom/actuator/prometheus'
const INVENTORY_METRICS = 'https://api.service.net:30000/inven/metrics'
const GRAFANA_URL = 'http://localhost:32500'
const PROMETHEUS_URL = 'http://localhost:9090'

function kubectl(args: string[]): string {
  return execFileSync('kubectl', args, { encoding: 'utf-8', timeout: 15_000 }).trim()
}

function kubectlJson<T>(args: string[]): T {
  const raw = kubectl([...args, '-o', 'json'])
  return JSON.parse(raw) as T
}

test.describe('Session 33 — Observability Hardening', () => {

  test.describe('Business metrics — ecom-service', () => {
    test('orders_total metric registered', async ({ request }) => {
      const resp = await request.get(ECOM_ACTUATOR, { ignoreHTTPSErrors: true })
      expect(resp.ok()).toBeTruthy()
      const body = await resp.text()
      expect(body).toContain('orders_total')
    })

    test('checkout_duration_seconds metric registered', async ({ request }) => {
      const resp = await request.get(ECOM_ACTUATOR, { ignoreHTTPSErrors: true })
      expect(resp.ok()).toBeTruthy()
      const body = await resp.text()
      expect(body).toContain('checkout_duration_seconds')
    })
  })

  test.describe('Business metrics — inventory-service', () => {
    test('inventory_reserved_total metric registered', async ({ request }) => {
      const resp = await request.get(INVENTORY_METRICS, { ignoreHTTPSErrors: true })
      expect(resp.ok()).toBeTruthy()
      const body = await resp.text()
      expect(body).toContain('inventory_reserved_total')
    })
  })

  test.describe('CDC pipeline Grafana dashboard', () => {
    test('cdc-pipeline dashboard exists in ConfigMap', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'grafana-dashboards', '-n', 'observability'])
      expect(cm.data['cdc-pipeline.json']).toBeTruthy()
      const dashboard = JSON.parse(cm.data['cdc-pipeline.json'])
      expect(dashboard.uid).toBe('cdc-pipeline')
      expect(dashboard.panels.length).toBeGreaterThanOrEqual(5)
    })

    test('cdc-pipeline dashboard has Kafka lag panel', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'grafana-dashboards', '-n', 'observability'])
      const dashboard = JSON.parse(cm.data['cdc-pipeline.json'])
      const lagPanel = dashboard.panels.find((p: any) => p.title.includes('Kafka Consumer Group Lag'))
      expect(lagPanel).toBeTruthy()
    })

    test('cdc-pipeline dashboard has Debezium status panel', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'grafana-dashboards', '-n', 'observability'])
      const dashboard = JSON.parse(cm.data['cdc-pipeline.json'])
      const panel = dashboard.panels.find((p: any) => p.title.includes('Debezium'))
      expect(panel).toBeTruthy()
    })

    test('cdc-pipeline dashboard has Flink checkpoint panel', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'grafana-dashboards', '-n', 'observability'])
      const dashboard = JSON.parse(cm.data['cdc-pipeline.json'])
      const panel = dashboard.panels.find((p: any) => p.title.includes('Flink Checkpoint'))
      expect(panel).toBeTruthy()
    })

    test('cdc-pipeline dashboard accessible in Grafana', async ({ request }) => {
      const resp = await request.get(`${GRAFANA_URL}/api/dashboards/uid/cdc-pipeline`, {
        headers: { 'Authorization': 'Basic ' + Buffer.from('admin:CHANGE_ME').toString('base64') },
      })
      expect(resp.ok()).toBeTruthy()
      const body = await resp.json()
      expect(body.dashboard.uid).toBe('cdc-pipeline')
    })
  })

  test.describe('Security alert rules', () => {
    test('prometheus-rules has security_alerts group', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'prometheus-rules', '-n', 'observability'])
      const rules = cm.data['alerts.yaml']
      expect(rules).toContain('security_alerts')
      expect(rules).toContain('High401Rate')
      expect(rules).toContain('High403Rate')
      expect(rules).toContain('RateLimitBreaches')
    })
  })

  test.describe('AlertManager receiver', () => {
    test('alertmanager config has non-empty webhook_configs', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'alertmanager-config', '-n', 'observability'])
      const config = cm.data['alertmanager.yml']
      expect(config).toContain('webhook_configs')
      expect(config).not.toContain('webhook_configs: []')
    })

    test('alertmanager is healthy', async ({ request }) => {
      const resp = await request.get('http://localhost:9093/-/healthy').catch(() => null)
      // AlertManager may not be exposed via NodePort, check via kubectl
      if (!resp?.ok()) {
        const result = kubectl(['exec', '-n', 'observability', 'deploy/alertmanager', '--',
          'wget', '-q', '-O', '-', 'http://localhost:9093/-/healthy'])
        expect(result).toBeTruthy()
      }
    })
  })

  test.describe('Git SHA image tagging', () => {
    test('up.sh includes git SHA tagging logic', () => {
      const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts/up.sh'), 'utf-8')
      expect(script).toContain('GIT_SHA')
      expect(script).toContain('git rev-parse --short HEAD')
    })
  })
})
