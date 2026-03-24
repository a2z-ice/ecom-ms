package com.bookstore.ecom.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Set;

/**
 * Custom CSRF validation filter for stateless JWT APIs.
 *
 * <p>Validates the {@code X-CSRF-Token} header on mutating requests (POST, PUT,
 * DELETE, PATCH) against the Redis-backed {@link CsrfTokenService}. Safe methods
 * (GET, HEAD, OPTIONS, TRACE) are always exempt.
 *
 * <p>This filter runs after {@code BearerTokenAuthenticationFilter} in the
 * Spring Security chain so that the JWT is already parsed and available in
 * {@code SecurityContextHolder}.
 *
 * <p>Can be disabled via {@code csrf.enabled=false} (used in test profiles
 * where Redis is not available).
 */
public class CsrfValidationFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(CsrfValidationFilter.class);
    private static final String CSRF_HEADER = "X-CSRF-Token";
    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS", "TRACE");

    private final CsrfTokenService csrfTokenService;
    private final boolean enabled;

    public CsrfValidationFilter(CsrfTokenService csrfTokenService, boolean enabled) {
        this.csrfTokenService = csrfTokenService;
        this.enabled = enabled;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        if (!enabled) {
            return true;
        }
        if (SAFE_METHODS.contains(request.getMethod().toUpperCase())) {
            return true;
        }
        String path = request.getRequestURI();
        return path.startsWith("/ecom/actuator/") || path.startsWith("/ecom/swagger-ui")
                || path.startsWith("/ecom/v3/api-docs");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain)
            throws ServletException, IOException {

        Authentication auth = SecurityContextHolder.getContext().getAuthentication();

        // No authentication yet — let Spring Security's authorization layer reject it
        if (auth == null || !auth.isAuthenticated()) {
            filterChain.doFilter(request, response);
            return;
        }

        // Extract user ID from JWT sub claim
        if (auth instanceof JwtAuthenticationToken jwtAuth) {
            Jwt jwt = jwtAuth.getToken();
            String userId = jwt.getSubject();

            String csrfToken = request.getHeader(CSRF_HEADER);
            if (csrfTokenService.validateAndRefresh(userId, csrfToken)) {
                filterChain.doFilter(request, response);
                return;
            }

            log.debug("CSRF validation failed for user {} on {} {}", userId,
                    request.getMethod(), request.getRequestURI());
            response.setStatus(403);
            response.setContentType("application/json");
            response.getWriter().write(
                    "{\"type\":\"about:blank\",\"title\":\"Forbidden\","
                    + "\"status\":403,\"detail\":\"Invalid or missing CSRF token\"}"
            );
            return;
        }

        // Non-JWT authentication (shouldn't happen in this app) — pass through
        filterChain.doFilter(request, response);
    }
}
