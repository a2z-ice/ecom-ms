# Performance Baseline & Capacity Planning

Methodology and baselines for measuring BookStore platform performance.

## Measurement Methodology

### Tools

- **k6** — Load testing (recommended for API benchmarks)
- **Playwright** — E2E user flow timing
- **Prometheus + Grafana** — Runtime metrics collection and visualization
- **kubectl top** — Real-time resource utilization

### Key Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| p50 latency (GET /books) | < 50ms | k6 HTTP request duration |
| p95 latency (GET /books) | < 200ms | k6 HTTP request duration |
| p99 latency (POST /checkout) | < 2s | k6 HTTP request duration |
| Throughput (GET /books) | > 100 rps | k6 iterations/second |
| Error rate | < 1% | k6 http_req_failed |
| CDC propagation | < 30s | E2E poll (order → analytics DB) |

## Running Load Tests

### Prerequisites

```bash
# Install k6
brew install k6
```

### Basic API Benchmark

```javascript
// k6/books-load.js
import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  stages: [
    { duration: '30s', target: 10 },   // ramp up
    { duration: '1m',  target: 10 },   // steady
    { duration: '10s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
}

export default function () {
  const res = http.get('https://api.service.net:30000/ecom/books', {
    insecureSkipTLSVerify: true,
  })
  check(res, { 'status 200': (r) => r.status === 200 })
  sleep(0.5)
}
```

```bash
k6 run k6/books-load.js
```

### Authenticated Checkout Benchmark

```javascript
// k6/checkout-load.js
import http from 'k6/http'
import { check } from 'k6'

const BASE = 'https://api.service.net:30000/ecom'
const TOKEN = __ENV.ACCESS_TOKEN  // pass via -e ACCESS_TOKEN=...

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(99)<2000'],
  },
}

export default function () {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  }
  // Add item to cart
  http.post(`${BASE}/cart`, JSON.stringify({ bookId: '<uuid>', quantity: 1 }), {
    headers,
    insecureSkipTLSVerify: true,
  })
  // Checkout
  const res = http.post(`${BASE}/checkout`, null, {
    headers,
    insecureSkipTLSVerify: true,
  })
  check(res, { 'checkout ok': (r) => [200, 409, 422].includes(r.status) })
}
```

## Resource Utilization Baselines

Measured on kind cluster (Docker Desktop, 8 CPU / 16 GB RAM).

### Per-Service (Idle / Under Load)

| Service | CPU Idle | CPU Load | Memory Idle | Memory Load |
|---------|----------|----------|-------------|-------------|
| ecom-service (x2) | 10m | 200m | 300Mi | 600Mi |
| inventory-service (x2) | 5m | 100m | 80Mi | 200Mi |
| Kafka | 50m | 300m | 500Mi | 1.2Gi |
| Redis | 2m | 20m | 10Mi | 50Mi |
| PostgreSQL (x4 clusters) | 20m each | 100m each | 100Mi each | 300Mi each |
| Flink JobManager | 20m | 100m | 300Mi | 500Mi |
| Flink TaskManager | 30m | 200m | 400Mi | 800Mi |

### Cluster-Wide Limits (ResourceQuota)

| Namespace | CPU Requests | Memory Requests | CPU Limits | Memory Limits | Pods |
|-----------|-------------|-----------------|-----------|---------------|------|
| ecom | 2 | 4Gi | 4 | 8Gi | 10 |
| inventory | 1500m | 3Gi | 3 | 6Gi | 10 |

## Known Bottlenecks

1. **Single Kafka broker** — Throughput limited to ~10k messages/sec. Scale to 3 brokers for production.
2. **HPA scaling lag** — CPU-based HPA has 30-60s reaction time. Pre-scale for known traffic spikes.
3. **Inventory reserve call** — Synchronous mTLS call during checkout adds ~50-100ms latency per item.
4. **CDC propagation** — Debezium polling interval + Flink processing window adds 5-30s end-to-end latency.

## Capacity Planning

### Scaling Triggers

| Metric | Threshold | Action |
|--------|-----------|--------|
| ecom-service CPU | > 70% sustained | HPA scales to max 4 replicas |
| inventory-service CPU | > 70% sustained | HPA scales to max 4 replicas |
| Kafka disk usage | > 70% | Reduce retention or expand PVC |
| PostgreSQL connections | > 80% pool | Increase HikariCP max-pool-size |
| Redis memory | > 80% maxmemory | Increase maxmemory or review eviction |

### Production Recommendations

- Kafka: 3 brokers, RF=3, min.insync.replicas=2
- PostgreSQL: CNPG with 1 primary + 2 standbys per cluster
- Redis: Sentinel or Redis Cluster for HA
- Ingress: Multiple gateway replicas behind load balancer
