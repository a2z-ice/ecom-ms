# Known Issues (Solved)

> Extracted from CLAUDE.md for performance. These issues have been resolved but are documented for reference.

## Spring Boot 4.0 / Spring Framework 7.0 Known Issues

These are non-obvious breaking changes from Spring Boot 3.x. The fixes are already in place:

1. **KafkaTemplate generic mismatch**: Autoconfigured `KafkaTemplate<?,?>` does NOT match injection of `KafkaTemplate<String, Object>`. Fix: explicit `KafkaConfig.java` `@Bean`.
2. **Liquibase ordering**: Hibernate validation runs BEFORE Liquibase in Spring Boot 4.0. Fix: `spring.jpa.hibernate.ddl-auto: none` + explicit `LiquibaseConfig.java` `@Bean("liquibase")`.
3. **Actuator health subpaths**: `/actuator/health` pattern does NOT match `/actuator/health/liveness` or `/actuator/health/readiness`. Fix: use `/actuator/health/**` in SecurityConfig.
4. **readOnlyRootFilesystem + Tomcat**: Spring Boot Tomcat needs writable `/tmp`. Fix: emptyDir volume mounted at `/tmp`.
5. **Jackson 3.x package rename**: Spring Boot 4.0 migrates from `com.fasterxml.jackson` to `tools.jackson`. The Kafka `JsonSerializer` must use the new packages. Fix: `Jackson3JsonSerializer.java` in `ecom-service/src/main/java/com/bookstore/ecom/config/` wraps Jackson 3.x for Kafka serialization.
6. **RestClient HTTP/2 upgrade breaks FastAPI**: Spring Boot 4.0's `RestClient.create()` uses `JdkClientHttpRequestFactory` (Java's `HttpClient`). Java's `HttpClient` may send `Connection: Upgrade, HTTP2-Settings` headers even for plain HTTP. Starlette/uvicorn's h11 parser rejects these with `400 Bad Request: "Invalid HTTP request received."`. Fix: force HTTP/1.1 explicitly:
   ```java
   var httpClient = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
   RestClient.builder().requestFactory(new JdkClientHttpRequestFactory(httpClient)).build();
   ```

## Kafka KRaft Mode (no Zookeeper)

The cluster uses `confluentinc/cp-kafka:latest` in KRaft combined mode (broker + controller in one pod). Critical settings:
- `KAFKA_PROCESS_ROLES: "broker,controller"`
- `KAFKA_PORT: ""` — MUST override Kubernetes service-discovery injection
- Listener name MUST be `PLAINTEXT` (not `INTERNAL`) for CP 8.x KRaft
- Readiness probe MUST be TCP socket (not exec) — exec follows advertised listener DNS which has no endpoints until pod is Ready (chicken-and-egg)

`infra/kafka/zookeeper.yaml` exists but is **intentionally empty** (comment only) — it is a placeholder to prevent script failures in `infra-up.sh`. Do not add Zookeeper content to it.

## Keycloak Import Job

The import job (`infra/keycloak/import-job.yaml`) does NOT contain a ConfigMap definition — the ConfigMap is managed by `scripts/keycloak-import.sh` which patches it from `realm-export.json`. Always use the script to run imports, never `kubectl apply -f import-job.yaml` alone.

The Keycloak 26.5.4 image has neither `curl` nor `wget`. Health check uses bash built-in `/dev/tcp`:
```bash
until (bash -c ">/dev/tcp/keycloak.identity.svc.cluster.local/8080" 2>/dev/null); do
  sleep 5
done
```

**`sub` claim in access tokens**: Keycloak's built-in `openid` scope includes the `sub` (subject UUID) claim mapper. When a realm import defines custom `clientScopes` (roles/profile/email), the import replaces Keycloak's built-in scopes and the `openid` scope's `sub` mapper is lost. **Fix**: add `oidc-sub-mapper` explicitly to the `profile` scope in `realm-export.json`. Without `sub`, `jwt.getSubject()` returns null in Spring Security → `null value in column "user_id"` DB errors.
