import http from 'k6/http';
import { check, sleep } from 'k6';

const KEYCLOAK_URL = 'https://idp.keycloak.net:30000/realms/bookstore/protocol/openid-connect/token';
const API_URL = 'https://api.service.net:30000/ecom';

function getToken() {
  const res = http.post(
    KEYCLOAK_URL,
    {
      grant_type: 'password',
      client_id: 'ui-client',
      username: 'user1',
      password: 'CHANGE_ME',
    },
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      insecureSkipTLSVerify: true,
    }
  );
  if (res.status !== 200) {
    console.error(`Token request failed: ${res.status}`);
    return null;
  }
  return JSON.parse(res.body).access_token;
}

export const options = {
  stages: [
    { duration: '10s', target: 3 },
    { duration: '20s', target: 3 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.05'],
  },
};

export function setup() {
  const token = getToken();
  if (!token) throw new Error('Failed to get auth token');
  return { token };
}

export default function (data) {
  const headers = {
    Authorization: `Bearer ${data.token}`,
    'Content-Type': 'application/json',
  };
  const tlsOpts = { insecureSkipTLSVerify: true };

  // Add item to cart
  const cartRes = http.post(
    `${API_URL}/cart`,
    JSON.stringify({ bookId: '00000000-0000-0000-0000-000000000001', quantity: 1 }),
    { headers, ...tlsOpts }
  );
  check(cartRes, { 'cart add 2xx': (r) => r.status >= 200 && r.status < 300 });

  // View cart
  const viewRes = http.get(`${API_URL}/cart`, { headers, ...tlsOpts });
  check(viewRes, { 'cart view 200': (r) => r.status === 200 });

  sleep(1);
}
