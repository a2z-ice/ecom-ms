# Load Tests (k6)

Performance and load testing scripts using [k6](https://k6.io/).

## Prerequisites

Install k6:
```bash
brew install k6
```

## Scripts

| Script | Target | Description |
|--------|--------|-------------|
| `k6-books.js` | `GET /ecom/books` | Public catalog endpoint — 10 VUs for 1 min |
| `k6-stock.js` | `GET /inven/stock/bulk` | Bulk stock lookup — 10 VUs for 1 min |
| `k6-checkout.js` | `POST /ecom/cart` | Authenticated cart operations — 3 VUs for 40s |

## Usage

```bash
# Run single test
k6 run load-tests/k6-books.js

# Run with custom VUs/duration
k6 run --vus 20 --duration 2m load-tests/k6-books.js

# Run all tests
for f in load-tests/k6-*.js; do k6 run "$f"; done
```

## Thresholds

- `k6-books.js`: p95 < 500ms, error rate < 1%
- `k6-stock.js`: p95 < 300ms, error rate < 1%
- `k6-checkout.js`: p95 < 2000ms, error rate < 5%
