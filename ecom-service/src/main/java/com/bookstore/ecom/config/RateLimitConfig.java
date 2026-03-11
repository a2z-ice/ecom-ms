package com.bookstore.ecom.config;

import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.Bucket;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
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

/**
 * Rate-limiting servlet filter using Bucket4j token-bucket algorithm.
 *
 * <p>Uses in-memory ConcurrentHashMap for bucket storage. This works correctly for
 * a single replica deployment (which this POC uses). For multi-replica production,
 * switch to {@code LettuceBasedProxyManager} from {@code bucket4j-redis} with the
 * existing Redis + Lettuce dependencies already in pom.xml.</p>
 *
 * <p>Rate limit tiers (per user/IP):
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

    private final JwtDecoder jwtDecoder;
    private final Map<String, Bucket> buckets = new ConcurrentHashMap<>();

    public RateLimitConfig(JwtDecoder jwtDecoder) {
        this.jwtDecoder = jwtDecoder;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain)
            throws ServletException, IOException {

        String path = request.getRequestURI();

        // Determine rate limit tier based on path (context path /ecom is included in URI)
        RateTier tier = resolveTier(path);
        if (tier == null) {
            // No rate limiting for actuator, swagger, etc.
            filterChain.doFilter(request, response);
            return;
        }

        String identity = resolveIdentity(request);
        String bucketKey = tier.name() + ":" + identity;

        Bucket bucket = buckets.computeIfAbsent(bucketKey, k -> createBucket(tier));

        if (bucket.tryConsume(1)) {
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
                .addLimit(Bandwidth.simple(tier.capacity, Duration.ofMinutes(1)))
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
