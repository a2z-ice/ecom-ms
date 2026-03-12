# HA PostgreSQL + Debezium CDC Diagram — Before/After Comparison

## Overview

The HA PostgreSQL + Debezium CDC Architecture diagram (`html/diagrams/ha-postgres-debezium-animated.svg`) was completely redesigned to add Kubernetes context, improve edge routing, and present a professional, publication-ready layout.

---

## Before vs After

### Before: Flat Layout, No Kubernetes Context

**Issues identified:**

| Problem | Description |
|---|---|
| Missing Kubernetes boundary | No cluster boundary — looks like standalone services, not a K8s deployment |
| No namespace groupings | All components floating freely — no visual indication of which namespace owns what |
| Overlapping edges | WAL→Debezium path curved through the middle of the diagram, crossing other edges |
| Debezium→Kafka path | Diagonal line crossing the CNPG Operator health check paths |
| No analytics-db | Flink was a dead end — missing the analytics-db sink |
| No Istio/mTLS context | No indication of the Istio Ambient Mesh securing inter-service traffic |
| No read replica callout | ecom-db-ro service not mentioned |
| Cramped layout | 1600x1100 with components packed too tightly |

### After: Namespace-Organized, Clean Edge Routing

**Improvements:**

| Improvement | Description |
|---|---|
| Kubernetes Cluster boundary | Outer rounded rectangle with `KUBERNETES CLUSTER (kind: bookstore)` label |
| 4 namespace boundaries | `cnpg-system` (top), `ecom` (left), `infra` (center-right), `analytics` (right) |
| Clean vertical data flow | App → ExternalName → -rw Service → Primary flows straight down |
| Clean horizontal replication | Primary → Standby is a pure horizontal dashed line |
| Elbow WAL→Debezium path | Right along bottom, then up — no diagonal crossing |
| Vertical Debezium→Kafka | Clean upward flow, CDC events + offsets as parallel lines |
| Elbow Kafka→Flink path | Right then down — avoids crossing any other edges |
| analytics-db added | Flink → analytics-db sink with "10 materialized views" label |
| ecom-db-ro callout | Read replica routing annotation |
| Istio mTLS callout | "STRICT mTLS between all pods" annotation in infra namespace |
| Auto failover callout | "< 30s recovery" timing annotation |
| Wider canvas | 1700x1150 for proper spacing |
| Enhanced legend | Added Namespace, CNPG Cluster, and K8s Cluster symbols |

---

## Diagram Components

### Nodes (12 total)

| Component | Namespace | Visual |
|---|---|---|
| E-Commerce Service | ecom | Blue border, node glow |
| ExternalName Service | ecom | Cyan border, DNS alias label |
| ecom-db-rw | ecom | Green border, auto-managed |
| PRIMARY (ecom-db-1) | ecom | Green border (thick), pulsing indicator |
| STANDBY (ecom-db-2) | ecom | Blue border (thick), pulsing indicator |
| Write-Ahead Log (WAL) | ecom | Red border, animated bars |
| WAL Replay | ecom | Blue border (thin) |
| Debezium Server 3.4 | infra | Amber border, slot + publication labels |
| Apache Kafka | infra | Amber border, topic listing |
| Apache Flink SQL | analytics | Purple border, 4 streaming jobs |
| analytics-db | analytics | Purple border (thin) |
| CNPG Operator | cnpg-system | Green border, v1.25.1 |
| K8s API Server | cnpg-system | Gray border |

### Edges (13 connections)

| From | To | Style | Label |
|---|---|---|---|
| App | ExternalName | Solid blue, vertical | JDBC |
| ExternalName | ecom-db-rw | Solid cyan, vertical | DNS alias |
| ecom-db-rw | PRIMARY | Solid green, angled | route |
| PRIMARY | WAL | Solid red, vertical | WAL write |
| PRIMARY | STANDBY | Dashed blue, horizontal | Streaming replication |
| STANDBY | WAL Replay | Solid blue, vertical | — |
| WAL | Debezium | Solid red, elbow (right+up) | Logical decoding (WAL CDC) |
| Debezium | Kafka | Solid amber, vertical up | CDC events |
| Debezium | Kafka | Dashed amber, parallel | offsets |
| Kafka | Flink | Solid purple, elbow (right+down) | consume |
| Flink | analytics-db | Solid purple, vertical | sink |
| CNPG Operator | PRIMARY | Dashed green, curved | health check |
| CNPG Operator | STANDBY | Dashed green, curved | health check |
| K8s API | CNPG Operator | Dashed gray, horizontal | CRD watch |

### Annotations (6 callouts)

| Callout | Position | Content |
|---|---|---|
| Zero App Code Changes | Right of ExternalName | Same hostname: ecom-db |
| Auto Failover | Left sidebar | Standby → Primary, < 30s recovery |
| Logical Replication Slot | Below WAL | debezium_ecom_slot |
| KafkaOffsetBackingStore | Below Kafka | Survives pod restarts + DB failovers |
| Istio Ambient Mesh | Top of infra namespace | STRICT mTLS between all pods |
| ecom-db-ro | Right of -rw Service | Routes to standby for read scaling |

---

## Edge Routing Strategy

The redesigned diagram uses a strict routing discipline:

1. **Vertical paths** for hierarchical relationships (service → database)
2. **Horizontal paths** for peer relationships (primary → standby)
3. **Elbow paths** (L-shaped) for cross-namespace connections — never diagonal
4. **Dashed lines** for control-plane / management connections
5. **Parallel lines** for related but distinct flows (CDC events vs offset storage)

This eliminates all edge crossings and makes the data flow immediately readable.

---

## Files

| File | Size | Description |
|---|---|---|
| `html/diagrams/ha-postgres-debezium-animated.svg` | ~18KB | Source SVG with CSS animations |
| `html/diagrams/ha-postgres-debezium.png` | ~276KB | Static PNG screenshot |
| `html/diagrams/ha-postgres-debezium.gif` | ~1.0MB | Animated GIF (8s loop, 10fps) |
| `html/diagrams/ha-failover-animated.svg` | — | Failover sequence (unchanged) |
| `html/diagrams/ha-failover.png` | ~137KB | Static PNG screenshot |
| `html/diagrams/ha-failover.gif` | ~1.1MB | Animated GIF (10s loop, 10fps) |

### Regenerating GIFs

```bash
node html/diagrams/generate-gifs.mjs ha
```

Requires: Playwright (from `e2e/node_modules`) + ImageMagick (`brew install imagemagick`).

To generate all diagrams (architecture + data-flow + HA):
```bash
node html/diagrams/generate-gifs.mjs
```
