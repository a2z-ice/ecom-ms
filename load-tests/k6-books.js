import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '15s', target: 10 },
    { duration: '30s', target: 10 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.get('https://api.service.net:30000/ecom/books', {
    insecureSkipTLSVerify: true,
  });
  check(res, {
    'status is 200': (r) => r.status === 200,
    'has books': (r) => {
      try { return JSON.parse(r.body).length > 0; }
      catch { return false; }
    },
  });
  sleep(0.5);
}
