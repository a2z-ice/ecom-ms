import { test, expect } from '@playwright/test';

test.describe('Istio Gateway routing', () => {
  test('UI route serves the React app', async ({ page }) => {
    await page.goto('http://myecom.net:30000/');
    await expect(page).toHaveTitle(/BookStore|Book Store/i);
  });

  test('ecom /books route returns books JSON', async ({ request }) => {
    const res = await request.get('http://api.service.net:30000/ecom/books');
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Endpoint returns Spring Page: { content: [...], totalElements: N, ... }
    const books = Array.isArray(body) ? body : body.content;
    expect(Array.isArray(books)).toBe(true);
    expect(books.length).toBeGreaterThan(0);
  });

  test('inventory /health route returns ok', async ({ request }) => {
    const res = await request.get('http://api.service.net:30000/inven/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('Keycloak OIDC discovery route is reachable', async ({ request }) => {
    const res = await request.get(
      'http://idp.keycloak.net:30000/realms/bookstore/.well-known/openid-configuration'
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.issuer).toContain('bookstore');
  });

  test('cart endpoint enforces JWT (mTLS proxy passes, JWT rejected)', async ({ request }) => {
    // mTLS works at Istio layer; JWT enforcement happens at Spring Security
    // 401 proves: gateway routed correctly + Istio passed request + JWT validation fires
    const res = await request.get('http://api.service.net:30000/ecom/cart');
    expect(res.status()).toBe(401);
  });

  test('/inven/stock/{id} is publicly reachable through gateway', async ({ request }) => {
    // Inventory seed data uses fixed sequential UUIDs (see alembic 002_seed_inventory)
    // These are independent of the ecom-service book UUIDs
    const knownInventoryBookId = '00000000-0000-0000-0000-000000000001';
    const res = await request.get(`http://api.service.net:30000/inven/stock/${knownInventoryBookId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('quantity');
  });
});
