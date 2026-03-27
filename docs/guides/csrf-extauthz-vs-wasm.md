# CSRF Protection: ext_authz vs Istio Wasm Plugin

## 1. Executive Summary

**Verdict: ext_authz is the better choice for this use case.**

The BookStore platform's CSRF protection is best served by the current ext_authz Go microservice because it provides process isolation from the gateway, battle-tested fail-open semantics with a single Istio config line, and a maintenance model that any Go developer can contribute to without specialized Wasm toolchain knowledge. The marginal latency advantage of an in-process Wasm plugin (1-3ms savings per request) is irrelevant at the platform's scale and is largely negated by the fact that both approaches still require an async Redis call for token validation.

---

## 2. Architecture Comparison

### ext_authz Flow (Current)

```
Browser
  |
  v
Gateway Envoy ──[HTTP ext_authz call]──> csrf-service pod (Go, port 8080)
                                              |
                                              v
                                         Redis (token store, 10min sliding TTL)
                                              |
                                              v
                                         Response (200 OK / 403 Forbidden)
  |
  v
Gateway Envoy continues to upstream (ecom-service / inventory-service)
```

- Envoy makes a synchronous HTTP call to the csrf-service before forwarding the request.
- The csrf-service runs as an independent Deployment (2 replicas, HPA 2-5, PDB).
- If the csrf-service is unreachable, Istio's `failOpen: true` allows the request through.

### Wasm Plugin Flow (Alternative)

```
Browser
  |
  v
Gateway Envoy ──[in-process Wasm module executes]──> [async dispatch_http_call() to Redis proxy]
                       |                                         |
                       |                                         v
                       |                                    Redis response
                       v
                  Wasm returns allow/deny decision
  |
  v
Gateway Envoy continues to upstream
```

- The Wasm module is loaded directly into Envoy's filter chain.
- No separate pod or network hop for the authz decision itself.
- Redis access requires Envoy's `dispatch_http_call()` to a Redis HTTP proxy (no native Redis protocol in Wasm).

---

## 3. Detailed Comparison Matrix

| Dimension | ext_authz (Current) | Wasm Plugin | Winner |
|-----------|---------------------|-------------|--------|
| **Latency** | +2-5ms network hop per request to csrf-service pod | ~0.1ms in-process execution, but async Redis callout adds ~1-2ms | Wasm (marginal, 1-3ms) |
| **Security** | Isolated process with its own container, distroless image, read-only FS, drop ALL caps. A vulnerability in the CSRF code cannot crash Envoy. | Runs inside Envoy's address space. A Wasm bug or panic can crash the entire gateway proxy, taking down all traffic. | **ext_authz** |
| **Resilience (fail-open)** | Native: Istio extensionProvider `failOpen: true` is a single config line. If csrf-service is down, all requests pass through. | Possible but harder: Wasm must handle panics gracefully or the entire Envoy filter chain breaks. No native Istio fail-open config for Wasm. | **ext_authz** |
| **Reliability** | Independent scaling (HPA 2-5), independent restarts, PDB ensures min availability. csrf-service restarts do not affect gateway. | Tied to gateway pod lifecycle. Wasm module crash = gateway pod restart = all traffic disrupted. | **ext_authz** |
| **High Traffic** | Horizontally scalable via HPA (2-5 replicas). Each replica has its own Redis connection pool (10 connections). | Single gateway pod handles all Wasm execution. Limited by Envoy's Wasm execution threads. Scaling requires scaling the gateway itself. | **ext_authz** |
| **Maintenance** | Standard Go code (770 lines, 11 files). Standard `go test`, `go vet`, `golangci-lint`. Any Go developer can contribute. | Requires Wasm SDK (proxy-wasm). Rust recommended (best Wasm support). Limited debugging tools. No standard test framework for Wasm filter logic. | **ext_authz** |
| **Redis Integration** | Native Go Redis client (go-redis v9). Connection pooling, configurable timeouts, fail-open on error. | Must use Envoy's `dispatch_http_call()` to a Redis HTTP proxy. No native Redis protocol in Wasm. Alternatively, must deploy a sidecar Redis REST proxy. | **ext_authz** |
| **Observability** | Prometheus `/metrics` endpoint. Structured JSON logging via `slog`. OpenTelemetry-ready. Custom metrics: request counts by type/status, Redis errors, latency histograms. | Limited: Wasm has `proxy_log()` for logging. No native Prometheus metrics. Must use Envoy's stats system which is less flexible. | **ext_authz** |
| **Testing** | Standard Go testing (`go test`). miniredis for Redis mocks. `httptest` for HTTP handlers. 25 unit tests + 33 E2E tests. | No standard Wasm test framework. Must test via integration tests against a running Envoy. Significantly slower development cycle. | **ext_authz** |
| **Developer Experience** | Any Go developer can contribute. Standard IDE support (GoLand, VS Code). Step debugger (Delve). Fast compile/test cycle. | Requires Wasm/Rust expertise. Limited IDE support. No step debugger for Wasm running inside Envoy. Complex build chain: Rust -> wasm32-wasi -> OCI image -> WasmPlugin CRD. | **ext_authz** |
| **Deployment Complexity** | Separate Deployment + Service + HPA + PDB + NetworkPolicy + ServiceAccount. More K8s objects to manage. | Single WasmPlugin CRD. No Deployment, Service, or HPA needed. Simpler K8s surface area. | **Wasm** |
| **Resource Overhead** | Extra pod: 50m CPU request, 32Mi RAM per replica. With 2 replicas: 100m CPU, 64Mi RAM total. | Zero additional pods. Wasm module adds ~2-5MB memory to Envoy process. | **Wasm** |
| **Language Flexibility** | Go (current), or any language that can serve HTTP. Swap to Rust, Java, Node.js without changing Istio config. | Rust recommended (best proxy-wasm support). Go possible via TinyGo but with significant stdlib limitations (no `net/http`, no `encoding/json`). C++ also supported. | **ext_authz** |
| **Upgrade Path** | Independent versioning. Roll back csrf-service without touching Envoy/Istio. | Tied to Envoy/Istio version. Wasm ABI version must match. Envoy upgrade may break Wasm module. | **ext_authz** |
| **Production Maturity** | ext_authz is GA in Envoy/Istio since 1.5+ (2020). Battle-tested in production by thousands of organizations. | Wasm support is stable in Envoy but less battle-tested for custom auth plugins in production. Most Wasm usage is for telemetry, not security-critical auth. | **ext_authz** |
| **Industry Adoption** | Used by OPA (Open Policy Agent), Ory Oathkeeper, Authzed/SpiceDB, AWS API Gateway. | Used by Istio internally for telemetry and metadata exchange. Few documented production CSRF use cases. | **ext_authz** |

**Score: ext_authz wins 13 of 16 dimensions. Wasm wins 2 (deployment complexity, resource overhead). 1 marginal win for Wasm (latency).**

---

## 4. Security Deep Dive

### Process Isolation (ext_authz)

The csrf-service runs in its own container with a minimal attack surface:

- **Distroless base image**: No shell, no package manager, no unnecessary binaries.
- **Read-only root filesystem**: `readOnlyRootFilesystem: true` in the security context.
- **Drop ALL capabilities**: `capabilities: drop: ["ALL"]`.
- **Non-root user**: `runAsNonRoot: true, runAsUser: 1000`.

A vulnerability in the CSRF validation code (e.g., a buffer overflow in a dependency, a logic bug in token comparison) is contained within the csrf-service container. It cannot affect the Envoy gateway process, other services, or the cluster.

### Wasm Sandbox

Wasm runs inside Envoy's process in a sandboxed VM (V8 or Wasmtime). The sandbox provides:

- Memory isolation (Wasm linear memory is separate from Envoy's heap).
- No direct system call access.
- Controlled access to Envoy internals via the proxy-wasm ABI.

However, the sandbox has full access to:

- All request headers, body, and trailers passing through the filter.
- Envoy's internal state via the ABI (route metadata, cluster info).
- The ability to modify responses, add headers, and reject requests.

A Wasm panic or unrecoverable error causes the entire Envoy filter chain to fail. Depending on configuration, this can either crash the gateway pod or leave it in an inconsistent state where subsequent requests are also affected.

### Memory Safety

- **Go (ext_authz)**: Garbage collected, memory safe. No buffer overflows, no use-after-free. Well-understood memory model.
- **Rust (Wasm)**: Also memory safe (ownership model). Equivalent safety guarantees. However, TinyGo (Go for Wasm) has known limitations: reduced stdlib, different garbage collector, and less testing coverage than standard Go.

### Supply Chain

- **ext_authz**: Uses standard Go modules (`go-redis/redis/v9`, `prometheus/client_golang`). Widely audited, reproducible builds, extensive CVE monitoring.
- **Wasm**: Requires the `proxy-wasm` SDK (fewer contributors, less scrutiny). The Wasm build toolchain (Rust + wasm-pack or TinyGo) has more moving parts and fewer eyes reviewing security-critical paths.

---

## 5. Resilience Deep Dive

### ext_authz Fail-Open

Istio's extensionProvider configuration supports native fail-open behavior:

```yaml
extensionProviders:
  - name: csrf-ext-authz
    envoyExtAuthz:
      service: csrf-service.infra.svc.cluster.local
      port: 8080
      failOpen: true
      timeout: 2s
```

If the csrf-service is unreachable (pod crash, network partition, Redis outage), **all requests pass through without CSRF validation**. This is a deliberate design choice: availability takes priority over CSRF enforcement. The csrf-service also implements application-level fail-open (if Redis is unreachable, `Validate()` returns `true`).

### Wasm Fail Behavior

Wasm modules can be configured with a `fail_open` policy in the WasmPlugin CRD:

```yaml
apiVersion: extensions.istio.io/v1alpha1
kind: WasmPlugin
metadata:
  name: csrf-wasm
spec:
  failStrategy: FAIL_OPEN
```

However, Wasm panics are harder to predict and recover from:

- A panic in the Wasm VM may leave Envoy's filter chain in an inconsistent state.
- Envoy's Wasm runtime has a panic counter; after too many panics, it may disable the Wasm module entirely.
- The `FAIL_OPEN` strategy handles module loading failures but may not handle all runtime panics gracefully.

### Circuit Breaking

The ext_authz approach benefits from Envoy's built-in circuit breaker on the outbound cluster to the csrf-service. If the csrf-service starts returning errors or timing out, Envoy will circuit-break and fail-open automatically. Wasm has no equivalent circuit-breaking mechanism for its own execution.

### Independent Restarts

The csrf-service can be restarted, upgraded, or rolled back without any impact on the gateway:

```bash
kubectl rollout restart deploy/csrf-service -n infra
```

A Wasm module update requires either a gateway pod restart or Envoy's experimental hot-reload mechanism (which is not yet production-stable for Wasm modules in Istio).

---

## 6. Performance / High Traffic Deep Dive

### ext_authz Latency

The ext_authz HTTP call adds approximately 2-5ms per request:

- ~1ms for the TCP connection (loopback within the cluster network).
- ~1-2ms for the csrf-service to process the request (JWT extraction, Redis lookup, timing-safe comparison).
- ~1-2ms for the Redis round-trip.

For the BookStore platform operating at fewer than 100 RPS, this overhead is negligible.

### Wasm Latency

The in-process Wasm execution adds approximately 0.1ms for the module itself. However, the Redis lookup still requires an async HTTP callout via `dispatch_http_call()`, which adds approximately 1-2ms. Net difference from ext_authz: approximately 1-3ms.

### Scaling

- **ext_authz**: The csrf-service scales independently via HPA (2-5 replicas). Under heavy load (10K+ RPS), additional replicas handle the increased request volume. Each replica maintains its own Redis connection pool (10 connections).
- **Wasm**: Limited by the single gateway pod's CPU. Scaling Wasm means scaling the gateway itself, which is a heavier operation and affects all traffic routing.

### Connection Pooling

The ext_authz csrf-service uses `go-redis/redis/v9` with a dedicated connection pool:

- Pool size: 10 connections per replica.
- Min idle connections: 3.
- Connection timeout: 5 seconds.
- Read/write timeout: 2 seconds.

Wasm has no native Redis client. To reach Redis, the Wasm module must:

1. Use `dispatch_http_call()` to an HTTP-to-Redis proxy (e.g., Webdis), adding another hop and another service to deploy, OR
2. Implement the Redis RESP protocol over Envoy's raw TCP support (complex and fragile), OR
3. Use a sidecar container running a Redis proxy co-located with the gateway pod.

All three options are significantly more complex than the native `go-redis` client.

### At What Scale Does Wasm Win?

Only at extreme scale (more than 50,000 RPS) where the cumulative 1-3ms per-request savings becomes significant. At 100 RPS (BookStore's expected load), the total time saved per second is approximately 0.1-0.3 seconds -- well within noise. For most enterprise applications operating below 10K RPS, ext_authz is more than sufficient.

---

## 7. Maintenance / Developer Experience Deep Dive

### ext_authz (Current)

- **Language**: Go 1.25 -- one of the most popular systems languages. Large hiring pool.
- **Codebase**: 770 lines across 11 files. Clean architecture with `internal/` packages (`config`, `handler`, `jwt`, `middleware`, `store`).
- **Testing**: 25 unit tests using `go test`. Redis mocked with `miniredis`. HTTP handlers tested with `httptest`. Standard `go vet` and `golangci-lint` for static analysis.
- **Debugging**: Standard Go debugger (Delve). Printf debugging. Structured logs via `slog`.
- **CI/CD**: `docker build` + `kind load` + `kubectl apply`. Standard pipeline.
- **IDE Support**: Full support in GoLand, VS Code (gopls), Neovim, etc.

### Wasm Plugin (Alternative)

- **Language**: Rust recommended (best proxy-wasm SDK support). Go possible via TinyGo but with significant stdlib limitations:
  - No `net/http` (must use proxy-wasm host functions).
  - No `encoding/json` (must use a Wasm-compatible JSON library).
  - No `crypto/subtle` (timing-safe comparison would need a pure implementation).
  - No `log/slog` (must use `proxy_log()`).
- **Build chain**: `cargo build --target wasm32-wasi` -> OCI image wrapping the `.wasm` binary -> `WasmPlugin` CRD referencing the OCI image.
- **Testing**: No standard test framework for proxy-wasm filter logic. Unit tests require mocking the entire proxy-wasm ABI. Integration tests require a running Envoy instance with the Wasm module loaded.
- **Debugging**: No step debugger. Only `proxy_log()` statements and Envoy debug logs. To see the effect of a code change, you must rebuild the Wasm module, rebuild the OCI image, update the WasmPlugin CRD, and wait for Envoy to reload.
- **Redis from Wasm**: There is no Redis client library for Wasm. The `dispatch_http_call()` function is asynchronous and callback-based, making the code significantly more complex than a synchronous `go-redis` call.

---

## 8. When Would Wasm Be the Better Choice?

Wasm plugins are the better approach when:

- **Ultra-low-latency requirements** (sub-1ms total overhead) where every microsecond matters.
- **No external state needed**: The validation logic is purely header-based (e.g., checking a static header value, validating an HMAC signature) and does not require a Redis or database lookup.
- **Simple logic**: The filter performs a straightforward check (e.g., verify a signed cookie, check an IP allowlist) without complex business logic.
- **Rust/Wasm expertise already exists**: The team has developers experienced with the proxy-wasm SDK and the Wasm build toolchain.
- **Extremely high RPS** (more than 100K) where eliminating the 2-5ms network hop per request creates measurable capacity gains.
- **Desire to eliminate a deployment**: Fewer pods, fewer K8s objects, simpler operational footprint -- at the cost of coupling to Envoy's lifecycle.

For the BookStore platform, none of these conditions apply. The CSRF logic requires Redis for stateful token storage, the team uses Go (not Rust), the RPS is well under 1K, and process isolation is valued for a security-critical component.

---

## 9. Industry Patterns and Precedents

### ext_authz Adoption

- **Open Policy Agent (OPA)**: One of the most widely adopted ext_authz implementations. OPA runs as a sidecar or standalone service, evaluating Rego policies for every request. Production-proven at thousands of organizations including Netflix, Atlassian, and Goldman Sachs.
- **Ory Oathkeeper**: Identity and access proxy deployed as an ext_authz sidecar. Handles authentication, authorization, and credential issuance.
- **Authzed / SpiceDB**: Fine-grained authorization (Google Zanzibar-inspired) exposed via ext_authz. Processes relationship-based access control checks at the gateway.
- **AWS API Gateway**: Uses a similar external authorizer pattern (Lambda authorizers) for custom authentication/authorization logic.
- **Istio Documentation**: Recommends ext_authz as the primary pattern for custom authorization at the gateway.

### Wasm Plugin Adoption

- **Istio Telemetry**: Uses Wasm plugins internally for metadata exchange and stats collection. These are stateless operations (no Redis calls).
- **Istio WASM Extensions**: The `istio-proxy` ships with built-in Wasm extensions for telemetry. Custom Wasm plugins are documented but explicitly noted as more complex to develop and debug.
- **Cloudflare Workers**: A conceptually similar approach (JavaScript/Wasm running at the edge) but in Cloudflare's proprietary runtime, not Envoy. They have custom Redis integration (Cloudflare KV / Durable Objects) that does not translate to the Envoy Wasm ABI.
- **Solo.io / Gloo Edge**: Supports Wasm plugins but primarily recommends ext_authz for auth-related use cases.

### Key Observation

The industry consensus is clear: ext_authz is the standard pattern for external authorization at the Envoy gateway. Wasm plugins are used for lightweight, stateless request/response transformations and telemetry. No major project uses Wasm for stateful CSRF validation with external storage.

---

## 10. Verdict and Recommendation

**Recommendation: Keep ext_authz (current approach).**

### Weighted Scorecard

| Criterion | Weight | ext_authz | Wasm |
|-----------|--------|-----------|------|
| Security | 25% | 9/10 | 7/10 |
| Resilience | 20% | 9/10 | 6/10 |
| Reliability | 15% | 9/10 | 7/10 |
| High Traffic | 10% | 8/10 | 9/10 |
| Maintenance | 15% | 9/10 | 4/10 |
| Developer Experience | 10% | 9/10 | 5/10 |
| Resource Efficiency | 5% | 6/10 | 9/10 |
| **Weighted Total** | **100%** | **8.8/10** | **6.3/10** |

Calculation:
- ext_authz: (0.25 x 9) + (0.20 x 9) + (0.15 x 9) + (0.10 x 8) + (0.15 x 9) + (0.10 x 9) + (0.05 x 6) = 2.25 + 1.80 + 1.35 + 0.80 + 1.35 + 0.90 + 0.30 = **8.75 (rounded to 8.8)**
- Wasm: (0.25 x 7) + (0.20 x 6) + (0.15 x 7) + (0.10 x 9) + (0.15 x 4) + (0.10 x 5) + (0.05 x 9) = 1.75 + 1.20 + 1.05 + 0.90 + 0.60 + 0.50 + 0.45 = **6.45 (rounded to 6.3)**

The ext_authz approach wins on every dimension except raw latency and resource efficiency -- both of which are negligible for the BookStore platform's scale (sub-1K RPS, sub-100m CPU total overhead).

### The Only Scenario Where Wasm Would Be Recommended

If the organization has strong Rust expertise, requires sub-millisecond CSRF overhead, AND the CSRF validation does not need Redis (e.g., uses HMAC-based stateless double-submit cookies where the token is cryptographically verified without a database lookup), then a Wasm plugin would be a reasonable choice. For the BookStore platform, none of these conditions hold.
