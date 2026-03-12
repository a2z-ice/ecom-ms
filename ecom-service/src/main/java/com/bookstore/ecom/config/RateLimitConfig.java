package com.bookstore.ecom.config;

import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.Bucket;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Rate-limiting servlet filter using Bucket4j token-bucket algorithm with
 * circuit breaker pattern for graceful degradation.
 *
 * <p>Uses in-memory ConcurrentHashMap for bucket storage. Each replica maintains
 * independent rate counters (effective per-replica limits). For truly distributed
 * rate limiting, switch to {@code LettuceBasedProxyManager} from {@code bucket4j-redis}.
 *
 * <p>Circuit breaker pattern: if rate-limit resolution fails (e.g., internal error),
 * traffic is allowed through rather than blocking users. The circuit opens after
 * {@value #CB_FAILURE_THRESHOLD} failures within {@value #CB_WINDOW_MS}ms and
 * auto-resets after {@value #CB_RESET_MS}ms.
 *
 * <p>Rate limit tiers (per user/IP per replica):
 * <ul>
 *   <li>{@code /ecom/checkout} — 10 requests/minute</li>
 *   <li>{@code /ecom/cart} — 60 requests/minute</li>
 *   <li>{@code /ecom/admin/**} — 30 requests/minute</li>
 *   <li>{@code /ecom/books/**} — 200 requests/minute</li>
 * </ul>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RateLimitConfig extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(RateLimitConfig.class);

    // Circuit breaker settings
    private static final int CB_FAILURE_THRESHOLD = 5;
    private static final long CB_WINDOW_MS = 60_000;
    private static final long CB_RESET_MS = 30_000;

    private final JwtDecoder jwtDecoder;
    private final Map<String, Bucket> buckets = new ConcurrentHashMap<>();

    // Circuit breaker state
    private final AtomicInteger failureCount = new AtomicInteger(0);
    private final AtomicLong firstFailureTime = new AtomicLong(0);
    private final AtomicLong circuitOpenTime = new AtomicLong(0);

    public RateLimitConfig(JwtDecoder jwtDecoder) {
        this.jwtDecoder = jwtDecoder;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain)
            throws ServletException, IOException {

        String path = request.getRequestURI();

        RateTier tier = resolveTier(path);
        if (tier == null) {
            filterChain.doFilter(request, response);
            return;
        }

        // Circuit breaker: if open, allow traffic through (degrade gracefully)
        if (isCircuitOpen()) {
            filterChain.doFilter(request, response);
            return;
        }

        try {
            String identity = resolveIdentity(request);
            String bucketKey = tier.name() + ":" + identity;

            Bucket bucket = buckets.computeIfAbsent(bucketKey, k -> createBucket(tier));

            if (bucket.tryConsume(1)) {
                resetCircuitBreaker();
                filterChain.doFilter(request, response);
            } else {
                response.setStatus(429);
                response.setHeader("Retry-After", "60");
                response.setContentType("application/json");
                response.getWriter().write(
                        "{\"type\":\"about:blank\",\"title\":\"Too Many Requests\","
                        + "\"status\":429,\"detail\":\"Rate limit exceeded. Try again later.\"}"
                );
            }
        } catch (Exception e) {
            log.warn("Rate limiter error — allowing request through: {}", e.getMessage());
            recordFailure();
            filterChain.doFilter(request, response);
        }
    }

    private boolean isCircuitOpen() {
        long openTime = circuitOpenTime.get();
        if (openTime == 0) return false;
        if (System.currentTimeMillis() - openTime > CB_RESET_MS) {
            // Half-open: reset and allow next attempt
            circuitOpenTime.set(0);
            failureCount.set(0);
            log.info("Rate limiter circuit breaker reset to CLOSED");
            return false;
        }
        return true;
    }

    private void recordFailure() {
        long now = System.currentTimeMillis();
        long firstFail = firstFailureTime.get();
        if (firstFail == 0 || now - firstFail > CB_WINDOW_MS) {
            firstFailureTime.set(now);
            failureCount.set(1);
        } else {
            int count = failureCount.incrementAndGet();
            if (count >= CB_FAILURE_THRESHOLD) {
                circuitOpenTime.set(now);
                log.warn("Rate limiter circuit breaker OPEN — bypassing rate limits for {}ms", CB_RESET_MS);
            }
        }
    }

    private void resetCircuitBreaker() {
        if (failureCount.get() > 0) {
            failureCount.set(0);
            firstFailureTime.set(0);
        }
    }

    private RateTier resolveTier(String path) {
        if (path.startsWith("/ecom/checkout")) {
            return RateTier.CHECKOUT;
        } else if (path.startsWith("/ecom/admin")) {
            return RateTier.ADMIN;
        } else if (path.startsWith("/ecom/cart")) {
            return RateTier.CART;
        } else if (path.startsWith("/ecom/books")) {
            return RateTier.BOOKS;
        }
        return null;
    }

    private String resolveIdentity(HttpServletRequest request) {
        String authHeader = request.getHeader("Authorization");
        if (authHeader != null && authHeader.startsWith("Bearer ")) {
            try {
                Jwt jwt = jwtDecoder.decode(authHeader.substring(7));
                String subject = jwt.getSubject();
                if (subject != null) {
                    return "user:" + subject;
                }
            } catch (JwtException e) {
                // Fall through to IP-based identity
            }
        }
        return "ip:" + getClientIp(request);
    }

    private String getClientIp(HttpServletRequest request) {
        String xff = request.getHeader("X-Forwarded-For");
        if (xff != null && !xff.isBlank()) {
            return xff.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }

    private Bucket createBucket(RateTier tier) {
        return Bucket.builder()
                .addLimit(Bandwidth.builder().capacity(tier.capacity).refillGreedy(tier.capacity, Duration.ofMinutes(1)).build())
                .build();
    }

    private enum RateTier {
        CHECKOUT(10),
        CART(60),
        ADMIN(30),
        BOOKS(200);

        final long capacity;

        RateTier(long capacity) {
            this.capacity = capacity;
        }
    }
}
