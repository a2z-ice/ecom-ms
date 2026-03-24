package com.bookstore.ecom.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.UUID;

/**
 * Redis-backed CSRF token store. Tokens are keyed by JWT user ID ({@code sub} claim)
 * and expire after 30 minutes. TTL is refreshed on each successful validation.
 *
 * <p>Fail-open on Redis errors — JWT is the primary authentication mechanism,
 * CSRF is defense-in-depth. If Redis is unavailable, requests are allowed through
 * with a warning log.
 */
@Service
public class CsrfTokenService {

    private static final Logger log = LoggerFactory.getLogger(CsrfTokenService.class);
    private static final String KEY_PREFIX = "csrf:";
    private static final Duration TOKEN_TTL = Duration.ofMinutes(30);

    private final StringRedisTemplate redisTemplate;

    public CsrfTokenService(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    /**
     * Generate a new CSRF token for the given user, store it in Redis with TTL.
     * If the user already has a token, it is replaced.
     */
    public String generateToken(String userId) {
        String token = UUID.randomUUID().toString();
        try {
            redisTemplate.opsForValue().set(KEY_PREFIX + userId, token, TOKEN_TTL);
        } catch (Exception e) {
            log.warn("Failed to store CSRF token in Redis for user {}: {}", userId, e.getMessage());
        }
        return token;
    }

    /**
     * Validate the submitted token against the stored token for this user.
     * On success, refreshes the TTL. On Redis failure, fails open (returns true).
     */
    public boolean validateAndRefresh(String userId, String token) {
        if (token == null || token.isBlank()) {
            return false;
        }
        try {
            String stored = redisTemplate.opsForValue().get(KEY_PREFIX + userId);
            if (stored != null && stored.equals(token)) {
                redisTemplate.expire(KEY_PREFIX + userId, TOKEN_TTL);
                return true;
            }
            return false;
        } catch (Exception e) {
            log.warn("Redis error during CSRF validation for user {} — failing open: {}", userId, e.getMessage());
            return true;
        }
    }
}
