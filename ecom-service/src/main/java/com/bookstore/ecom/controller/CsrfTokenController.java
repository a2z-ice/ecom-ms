package com.bookstore.ecom.controller;

import com.bookstore.ecom.config.CsrfTokenService;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Issues CSRF tokens for authenticated users. The token must be included
 * as {@code X-CSRF-Token} header on all subsequent mutating requests.
 */
@RestController
public class CsrfTokenController {

    private final CsrfTokenService csrfTokenService;

    public CsrfTokenController(CsrfTokenService csrfTokenService) {
        this.csrfTokenService = csrfTokenService;
    }

    @GetMapping("/csrf-token")
    public Map<String, String> getCsrfToken(JwtAuthenticationToken auth) {
        String userId = auth.getToken().getSubject();
        String token = csrfTokenService.generateToken(userId);
        return Map.of("token", token);
    }
}
