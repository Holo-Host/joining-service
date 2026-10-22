import type { DiditConfig } from '../../src/didit/client.js';
import type { ServiceConfig } from '../../src/config.js';

export const SUBJECT_KEY = 'ab'.repeat(32);
export const WORKFLOW_ID = '11111111-2222-4333-8444-555555555555';

export const DIDIT_CONFIG: DiditConfig = {
  api_key: 'didit-test-key',
  subject_key: SUBJECT_KEY,
  workflow_id: WORKFLOW_ID,
  environment: 'sandbox',
};

export const BASE_URL = 'https://join.example.com';

export const DIDIT_SERVICE: Partial<ServiceConfig> = {
  auth_methods: ['didit_with_email'],
  email: { provider: 'file', output_dir: '/tmp/test-emails' },
  base_url: BASE_URL,
  didit: DIDIT_CONFIG,
};
