package origin

import (
	"net/http/httptest"
	"testing"
)

func TestValidate_AllowedOrigin(t *testing.T) {
	v := NewValidator([]string{"https://myecom.net:30000", "https://localhost:30000"}, false)
	req := httptest.NewRequest("POST", "/", nil)
	req.Header.Set("Origin", "https://myecom.net:30000")
	r := v.Validate(req)
	if !r.Allowed {
		t.Error("expected allowed for myecom.net")
	}
	if r.Missing {
		t.Error("origin should not be missing")
	}
	if r.Origin != "https://myecom.net:30000" {
		t.Errorf("origin = %q, want https://myecom.net:30000", r.Origin)
	}
}

func TestValidate_RejectedOrigin(t *testing.T) {
	v := NewValidator([]string{"https://myecom.net:30000"}, false)
	req := httptest.NewRequest("POST", "/", nil)
	req.Header.Set("Origin", "https://evil.com")
	r := v.Validate(req)
	if r.Allowed {
		t.Error("expected rejected for evil.com")
	}
	if r.Origin != "https://evil.com" {
		t.Errorf("origin = %q, want https://evil.com", r.Origin)
	}
}

func TestValidate_MissingOrigin_Permissive(t *testing.T) {
	v := NewValidator([]string{"https://myecom.net:30000"}, false) // require=false
	req := httptest.NewRequest("POST", "/", nil)
	r := v.Validate(req)
	if !r.Allowed {
		t.Error("expected allowed when origin missing and require=false")
	}
	if !r.Missing {
		t.Error("expected missing=true")
	}
}

func TestValidate_MissingOrigin_Required(t *testing.T) {
	v := NewValidator([]string{"https://myecom.net:30000"}, true) // require=true
	req := httptest.NewRequest("POST", "/", nil)
	r := v.Validate(req)
	if r.Allowed {
		t.Error("expected rejected when origin missing and require=true")
	}
	if !r.Missing {
		t.Error("expected missing=true")
	}
}

func TestValidate_RefererFallback(t *testing.T) {
	v := NewValidator([]string{"https://myecom.net:30000"}, false)
	req := httptest.NewRequest("POST", "/", nil)
	req.Header.Set("Referer", "https://myecom.net:30000/catalog?page=2")
	r := v.Validate(req)
	if !r.Allowed {
		t.Error("expected allowed via Referer fallback")
	}
	if r.Missing {
		t.Error("origin resolved from Referer, should not be missing")
	}
	if r.Origin != "https://myecom.net:30000" {
		t.Errorf("origin = %q, want https://myecom.net:30000", r.Origin)
	}
}

func TestValidate_RefererRejected(t *testing.T) {
	v := NewValidator([]string{"https://myecom.net:30000"}, false)
	req := httptest.NewRequest("POST", "/", nil)
	req.Header.Set("Referer", "https://evil.com/phishing")
	r := v.Validate(req)
	if r.Allowed {
		t.Error("expected rejected via Referer")
	}
}

func TestValidate_OriginTakesPrecedence(t *testing.T) {
	v := NewValidator([]string{"https://myecom.net:30000"}, false)
	req := httptest.NewRequest("POST", "/", nil)
	req.Header.Set("Origin", "https://evil.com")
	req.Header.Set("Referer", "https://myecom.net:30000/page")
	r := v.Validate(req)
	if r.Allowed {
		t.Error("Origin header should take precedence over Referer")
	}
	if r.Origin != "https://evil.com" {
		t.Errorf("origin = %q, want https://evil.com", r.Origin)
	}
}
