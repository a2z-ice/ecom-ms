# Runbook: Security Incident Response

## Trigger
- High 401/403 rates (`High401Rate`, `High403Rate`)
- Rate limit breaches (`RateLimitBreaches`)
- Suspected credential compromise
- Unusual access patterns

## Immediate Actions

### 1. Assess Scope
```bash
# Check 4xx/5xx error rates
curl -sk https://api.service.net:30000/ecom/actuator/prometheus | grep "status=\"4"

# Check CSRF validation failures
kubectl logs -n infra deploy/csrf-service --tail=50 | grep -i "fail\|reject"

# Check Keycloak login attempts
kubectl logs -n identity deploy/keycloak --tail=50 | grep -i "LOGIN_ERROR"
```

### 2. Rotate Compromised Secrets
```bash
# Regenerate ALL secrets
bash scripts/generate-secrets.sh --force

# Restart affected services to pick up new secrets
kubectl rollout restart deployment/ecom-service -n ecom
kubectl rollout restart deployment/inventory-service -n inventory
kubectl rollout restart deployment/csrf-service -n infra
```

### 3. Rotate Keycloak Admin Password
```bash
# Get current admin token
ADMIN_TOKEN=$(curl -sk -X POST "https://idp.keycloak.net:30000/realms/master/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=${OLD_PASSWORD}" \
  -H "Content-Type: application/x-www-form-urlencoded" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# Reset user passwords if compromised
curl -sk -X PUT "https://idp.keycloak.net:30000/admin/realms/bookstore/users/<user-id>/reset-password" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"type": "password", "value": "<new-password>", "temporary": false}'
```

### 4. Revoke Active Sessions
```bash
# Force all users to re-authenticate by restarting Keycloak
kubectl rollout restart deployment/keycloak -n identity
```

### 5. Review Audit Trail
```bash
# Check service logs for unauthorized access
kubectl logs -n ecom deploy/ecom-service --since=1h | grep "403\|401\|Unauthorized"

# Check Istio access logs
kubectl logs -n istio-system -l app=ztunnel --tail=100 | grep "DENY\|403"

# Check network policy violations
kubectl get events -A | grep -i "network\|deny"
```

### 6. Verify Mitigation
```bash
# Run security scan
bash scripts/security-scan.sh

# Run smoke tests
bash scripts/smoke-test.sh

# Verify all endpoints
bash scripts/verify-routes.sh
```

## Post-Incident
1. Document timeline, scope, and root cause
2. Update secrets rotation schedule
3. Review and tighten NetworkPolicies if needed
4. Add monitoring for the specific attack vector
