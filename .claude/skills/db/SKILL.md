---
name: db
description: Run SQL queries against any bookstore database — ecom, inventory, analytics, keycloak
disable-model-invocation: true
argument-hint: <database> <query>
allowed-tools: Bash
---

Run a SQL query against a bookstore database.

## Arguments
- `$0`: database name — one of: `ecom`, `inventory`, `analytics`, `keycloak`
- Remaining args: the SQL query to execute

## Database connection mapping

| Database | Namespace | Deploy | User | DB Name |
|----------|-----------|--------|------|---------|
| ecom | ecom | ecom-db | ecom | ecom |
| inventory | inventory | inventory-db | inventory | inventory |
| analytics | analytics | analytics-db | analytics | analytics |
| keycloak | identity | keycloak-db | keycloak | keycloak |

## Steps

1. Map `$0` to the correct namespace, deployment, user, and database name
2. Run the query via kubectl exec:
```bash
kubectl exec -n <namespace> deploy/<deploy> -- psql -U <user> -d <dbname> -c "<query>" 2>/dev/null
```

## Common queries to suggest if no query provided
- `\dt` — list tables
- `\dv` — list views
- `SELECT count(*) FROM <table>` — row count
- `SELECT * FROM <table> LIMIT 5` — sample data

## Examples
- `/db ecom SELECT count(*) FROM books`
- `/db analytics \dv vw_*`
- `/db inventory SELECT * FROM inventory LIMIT 5`
