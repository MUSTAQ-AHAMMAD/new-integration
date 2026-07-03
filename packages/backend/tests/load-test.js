/**
 * Load Test Script for Production Readiness Verification
 * 
 * Tests the system under realistic load using k6
 * 
 * Usage:
 *   k6 run tests/load-test.js
 *   k6 run --vus 50 --duration 5m tests/load-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export const options = {
  stages: [
    { duration: '1m', target: 10 },
    { duration: '5m', target: 50 },
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    errors: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const listResponse = http.get(`${BASE_URL}/store-config`);
  
  check(listResponse, {
    'status 200': (r) => r.status === 200,
  }) || errorRate.add(1);

  sleep(1);
}
