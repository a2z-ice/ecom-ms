# Session 33 — Observability: Business Metrics, CDC Dashboard, Security Alerts

## Goal
Add custom business metrics, CDC Grafana dashboard, and security alerting.

## Deliverables

| # | Item | Files |
|---|------|-------|
| 1 | `orders_total` counter + `checkout_duration_seconds` histogram | `OrderService.java` |
| 2 | `inventory_reserved_total` counter | `inventory-service/app/api/stock.py` |
| 3 | CDC pipeline Grafana dashboard (6 panels) | `infra/observability/grafana/grafana.yaml` |
| 4 | Security alert rules (401/403/429) | `infra/observability/prometheus/prometheus.yaml` |
| 5 | AlertManager webhook receiver | `infra/observability/alertmanager/alertmanager.yaml` |
| 6 | Git SHA image tagging | `scripts/up.sh` |
| 7 | E2E tests | `e2e/observability-hardening.spec.ts` |

## Acceptance Criteria
- 3 business metrics scrapeable at /actuator/prometheus and /metrics
- CDC dashboard with 6 panels (Kafka lag, Debezium status, Flink checkpoints, failed checkpoints, throughput, Flink status)
- Security alerts configured (High401Rate, High403Rate, RateLimitBreaches)
- AlertManager has webhook receiver
- Git SHA tagging on all image builds
- All existing tests pass

## Status: COMPLETE
