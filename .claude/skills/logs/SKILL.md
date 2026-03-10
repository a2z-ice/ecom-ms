---
name: logs
description: View logs for a service or pod — supports ecom, inventory, ui, kafka, debezium, flink, keycloak
disable-model-invocation: true
argument-hint: <service> [--tail N] [--follow]
allowed-tools: Bash
---

View logs for a bookstore service.

## Arguments
- `$0`: service name (required) — one of: `ecom`, `inventory`, `ui`, `kafka`, `debezium-ecom`, `debezium-inventory`, `flink`, `keycloak`, `superset`, `grafana`, `loki`, `tempo`, `otel`, `prometheus`
- Additional flags are passed through to `kubectl logs`

## Service-to-pod mapping

| Service | kubectl command |
|---------|----------------|
| ecom | `kubectl logs -n ecom deploy/ecom-service` |
| inventory | `kubectl logs -n inventory deploy/inventory-service` |
| ui | `kubectl logs -n ecom deploy/ui-service` |
| kafka | `kubectl logs -n infra deploy/kafka` |
| debezium-ecom | `kubectl logs -n infra deploy/debezium-server-ecom` |
| debezium-inventory | `kubectl logs -n infra deploy/debezium-server-inventory` |
| flink | `kubectl logs -n analytics deploy/flink-jobmanager` |
| flink-tm | `kubectl logs -n analytics deploy/flink-taskmanager` |
| keycloak | `kubectl logs -n identity deploy/keycloak` |
| superset | `kubectl logs -n analytics deploy/superset` |
| grafana | `kubectl logs -n observability deploy/grafana` |
| loki | `kubectl logs -n otel deploy/loki` |
| tempo | `kubectl logs -n otel deploy/tempo` |
| otel | `kubectl logs -n otel deploy/otel-collector` |
| prometheus | `kubectl logs -n observability deploy/prometheus` |

## Steps

1. Map the service name from `$0` to the correct kubectl command
2. Default to `--tail=100` if no `--tail` flag provided
3. Run: `kubectl logs <namespace/deploy> --tail=<N>` with any additional flags
4. If the user wants to investigate errors, grep for `ERROR`, `Exception`, `WARN`
5. Summarize any issues found in the logs
