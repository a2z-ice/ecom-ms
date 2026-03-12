# Session 27 — PostgreSQL High Availability with CloudNativePG

## Goal

Replace single-replica PostgreSQL Deployments with CloudNativePG-managed HA clusters (1 primary + 1 standby per database) providing automatic failover, streaming replication, and zero application downtime on database pod failure.

## Key Design Decisions

- **D1. ExternalName Service Aliases** — CNPG creates `-rw`, `-ro`, `-r` services. ExternalName aliases with original names (`ecom-db`, `inventory-db`, etc.) point to `-rw` services. Zero app config changes.
- **D2. Debezium Offset Storage → Kafka** — `KafkaOffsetBackingStore` replaces `FileOffsetBackingStore`. After CNPG failover, Debezium reconnects via ExternalName alias and resumes from Kafka-stored offset.
- **D3. Storage: kind `standard` StorageClass** — CNPG manages its own PVCs dynamically. Data survives pod/Docker restarts but not `kind delete cluster`.
- **D4. Instance Count: 2 per cluster** — 1 primary + 1 standby. Total: 8 DB pods + 1 CNPG operator pod.
- **D5. CNPG + Istio Ambient Mesh** — `cnpg-system` namespace enrolled in ambient mesh with STRICT mTLS PeerAuthentication.

## Deliverables

| # | File | Action | Description |
|---|------|--------|-------------|
| 1 | `infra/cnpg/install.sh` | NEW | Install CNPG operator v1.25.1 |
| 2 | `infra/cnpg/ecom-db-cluster.yaml` | NEW | CNPG Cluster (2 instances, logical WAL, ExternalName alias) |
| 3 | `infra/cnpg/inventory-db-cluster.yaml` | NEW | Same pattern |
| 4 | `infra/cnpg/analytics-db-cluster.yaml` | NEW | Same (5Gi, no logical WAL) |
| 5 | `infra/cnpg/keycloak-db-cluster.yaml` | NEW | Same pattern |
| 6 | `infra/cnpg/peer-auth.yaml` | NEW | STRICT mTLS for cnpg-system |
| 7 | `infra/postgres/ecom-db.yaml` | DELETE | Replaced by CNPG |
| 8 | `infra/postgres/inventory-db.yaml` | DELETE | Replaced by CNPG |
| 9 | `infra/postgres/analytics-db.yaml` | DELETE | Replaced by CNPG |
| 10 | `infra/keycloak/keycloak.yaml` | MODIFY | Remove keycloak-db section; update wait-for-db |
| 11 | `infra/storage/persistent-volumes.yaml` | MODIFY | Remove 4 DB PVs |
| 12 | `infra/kind/cluster.yaml` | MODIFY | Remove 4 DB extraMounts |
| 13 | `infra/debezium/debezium-server-ecom.yaml` | MODIFY | Kafka offset storage |
| 14 | `infra/debezium/debezium-server-inventory.yaml` | MODIFY | Kafka offset storage |
| 15-18 | `infra/kubernetes/network-policies/*.yaml` | MODIFY | CNPG labels + inter-pod rules |
| 19-22 | `infra/istio/security/authz-policies/*.yaml` | MODIFY | CNPG labels + cnpg-system source |
| 23 | `scripts/infra-up.sh` | MODIFY | CNPG install + cluster apply + wait |
| 24 | `scripts/up.sh` | MODIFY | Bootstrap + recovery flow for CNPG |
| 25 | `scripts/cluster-up.sh` | MODIFY | Remove DB data dirs |
| 26 | `scripts/restart-after-docker.sh` | MODIFY | CNPG pod restart |
| 27 | `scripts/smoke-test.sh` | MODIFY | CNPG label selectors |
| 28 | `scripts/full-stack-test.sh` | MODIFY | CNPG label selectors |
| 29-32 | `e2e/{helpers/db.ts,fixtures/base.ts,debezium-flink.spec.ts,global-setup.ts}` | MODIFY | Label-based pod exec |

## Acceptance Criteria

- [ ] `kubectl get clusters -A` — All 4 CNPG clusters show "Cluster in healthy state"
- [ ] `kubectl get pods -n ecom -l cnpg.io/cluster=ecom-db` — 2 pods (1 primary, 1 standby)
- [ ] `kubectl get svc ecom-db -n ecom` — ExternalName pointing to `ecom-db-rw`
- [ ] `curl -sk https://api.service.net:30000/ecom/books` — 200 (app connects through alias)
- [ ] CNPG failover: delete primary, standby promoted, app reconnects within seconds
- [ ] Debezium health: `curl http://localhost:32300/q/health` → UP after failover
- [ ] `bash scripts/smoke-test.sh` — all checks pass
- [ ] `cd e2e && npm run test` — all E2E tests pass

## Build & Deploy

```bash
# Requires --fresh (kind cluster config changed)
bash scripts/up.sh --fresh --yes
```

## Docker Rebuilds Required

**None.** All changes are infrastructure manifests, scripts, and test helpers. No application code changes.

## Status: In Progress
