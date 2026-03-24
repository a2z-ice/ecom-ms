/**
 * Resilience Hardening E2E Tests (Session 32)
 *
 * Validates resilience improvements:
 *   1. preStop hooks on stateful services
 *   2. HPA memory metric on inventory-service
 *   3. Tempo retention 72h
 *   4. Loki retention 72h with compactor
 */
import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'

function kubectl(args: string[]): string {
  return execFileSync('kubectl', args, { encoding: 'utf-8', timeout: 15_000 }).trim()
}

function kubectlJson<T>(args: string[]): T {
  const raw = kubectl([...args, '-o', 'json'])
  return JSON.parse(raw) as T
}

test.describe('Session 32 — Resilience & Reliability', () => {

  test.describe('preStop hooks', () => {
    const preStopTargets = [
      { name: 'kafka', ns: 'infra', container: 'kafka' },
      { name: 'redis', ns: 'infra', container: 'redis' },
      { name: 'flink-jobmanager', ns: 'analytics', container: 'jobmanager' },
      { name: 'flink-taskmanager', ns: 'analytics', container: 'taskmanager' },
      { name: 'debezium-server-ecom', ns: 'infra', container: 'debezium-server' },
      { name: 'debezium-server-inventory', ns: 'infra', container: 'debezium-server' },
    ]

    for (const target of preStopTargets) {
      test(`${target.name} has preStop hook`, () => {
        const dep = kubectlJson<any>(['get', 'deployment', target.name, '-n', target.ns])
        const containers = dep.spec.template.spec.containers || []
        const container = containers.find((c: any) => c.name === target.container)
        expect(container, `container ${target.container} should exist`).toBeTruthy()
        expect(container.lifecycle?.preStop, `${target.name}/${target.container} should have preStop hook`).toBeTruthy()
      })
    }
  })

  test.describe('HPA metrics', () => {
    test('inventory-service HPA has memory metric', () => {
      const hpa = kubectlJson<any>(['get', 'hpa', 'inventory-service-hpa', '-n', 'inventory'])
      const metrics = hpa.spec.metrics || []
      const memoryMetric = metrics.find((m: any) =>
        m.type === 'Resource' && m.resource?.name === 'memory'
      )
      expect(memoryMetric, 'HPA should have memory metric').toBeTruthy()
      expect(memoryMetric.resource.target.averageUtilization).toBe(80)
    })

    test('ecom-service HPA still has both CPU and memory', () => {
      const hpa = kubectlJson<any>(['get', 'hpa', 'ecom-service-hpa', '-n', 'ecom'])
      const metrics = hpa.spec.metrics || []
      const cpuMetric = metrics.find((m: any) => m.resource?.name === 'cpu')
      const memMetric = metrics.find((m: any) => m.resource?.name === 'memory')
      expect(cpuMetric, 'ecom HPA should have CPU metric').toBeTruthy()
      expect(memMetric, 'ecom HPA should have memory metric').toBeTruthy()
    })
  })

  test.describe('Retention policies', () => {
    test('Tempo retention is 72h', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'tempo-config', '-n', 'otel'])
      const config = cm.data['tempo.yaml']
      expect(config).toContain('block_retention: 72h')
    })

    test('Loki has retention_period 72h', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'loki-config', '-n', 'otel'])
      const config = cm.data['loki.yaml']
      expect(config).toContain('retention_period: 72h')
    })

    test('Loki has compactor enabled', () => {
      const cm = kubectlJson<any>(['get', 'configmap', 'loki-config', '-n', 'otel'])
      const config = cm.data['loki.yaml']
      expect(config).toContain('retention_enabled: true')
      expect(config).toContain('compaction_interval')
    })
  })
})
