import http from 'k6/http';
import { check, sleep } from 'k6';

const BOOK_IDS = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-000000000005',
];

export const options = {
  stages: [
    { duration: '15s', target: 10 },
    { duration: '30s', target: 10 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const ids = BOOK_IDS.join(',');
  const res = http.get(
    `https://api.service.net:30000/inven/stock/bulk?book_ids=${ids}`,
    { insecureSkipTLSVerify: true }
  );
  check(res, {
    'status is 200': (r) => r.status === 200,
    'returns array': (r) => {
      try { return Array.isArray(JSON.parse(r.body)); }
      catch { return false; }
    },
  });
  sleep(0.5);
}
