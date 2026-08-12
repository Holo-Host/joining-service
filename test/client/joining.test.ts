import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JoiningClient, JoinSession, JoiningError } from '../../src/client/joining.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(code: string, message: string, status: number) {
  return jsonResponse({ error: { code, message } }, status);
}

const TEST_BASE_URL = 'https://joining.example.com/v1';

const MOCK_INFO = {
  happ: { id: 'test-app', name: 'Test App' },
  auth_methods: ['open'] as const,
  linker_info: { selection_mode: 'assigned' as const },
  happ_bundle_url: 'https://example.com/test.happ',
};

describe('JoiningClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('discover', () => {
    it('discovers joining service from well-known endpoint', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          joining_service_url: TEST_BASE_URL,
          happ_id: 'test-app',
          version: '1.0',
        }),
      );

      const client = await JoiningClient.discover('app.example.com');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://app.example.com/.well-known/holo-joining',
      );
      expect(client.url).toBe(TEST_BASE_URL);
    });

    it('handles explicit https:// in domain', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          joining_service_url: TEST_BASE_URL,
          happ_id: 'test-app',
          version: '1.0',
        }),
      );

      await JoiningClient.discover('https://app.example.com');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://app.example.com/.well-known/holo-joining',
      );
    });

    it('throws JoiningError on discovery failure', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      await expect(JoiningClient.discover('no-service.example.com')).rejects.toThrow(
        JoiningError,
      );
    });
  });

  describe('fromUrl', () => {
    it('creates client from explicit URL', () => {
      const client = JoiningClient.fromUrl(TEST_BASE_URL);
      expect(client.url).toBe(TEST_BASE_URL);
    });

    it('strips trailing slash', () => {
      const client = JoiningClient.fromUrl(TEST_BASE_URL + '/');
      expect(client.url).toBe(TEST_BASE_URL);
    });
  });

  describe('getInfo', () => {
    it('fetches and returns service info', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_INFO));

      const client = JoiningClient.fromUrl(TEST_BASE_URL);
      const info = await client.getInfo();

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_BASE_URL}/info`);
      expect(info.happ.id).toBe('test-app');
      expect(info.auth_methods).toEqual(['open']);
    });

    it('caches info after first call', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(MOCK_INFO));

      const client = JoiningClient.fromUrl(TEST_BASE_URL);
      await client.getInfo();
      await client.getInfo();

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('join', () => {
    it('joins with open auth and gets ready status', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ session: 'js_abc', status: 'ready' }, 201),
      );

      const client = JoiningClient.fromUrl(TEST_BASE_URL);
      const session = await client.join('uhCAkTestAgent');

      expect(mockFetch).toHaveBeenCalledWith(`${TEST_BASE_URL}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_key: 'uhCAkTestAgent' }),
      });
      expect(session.status).toBe('ready');
      expect(session.sessionToken).toBe('js_abc');
    });

    it('joins with claims and gets pending status', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          {
            session: 'js_pending',
            status: 'pending',
            challenges: [
              {
                id: 'ch_email_1',
                type: 'email_code',
                description: 'Enter code sent to t***@example.com',
              },
            ],
            poll_interval_ms: 2000,
          },
          201,
        ),
      );

      const client = JoiningClient.fromUrl(TEST_BASE_URL);
      const session = await client.join('uhCAkTestAgent', {
        email: 'test@example.com',
      });

      expect(session.status).toBe('pending');
      expect(session.challenges).toHaveLength(1);
      expect(session.challenges![0].type).toBe('email_code');
      expect(session.pollIntervalMs).toBe(2000);
    });

    it('throws JoiningError on 409 agent_already_joined', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse('agent_already_joined', 'Already joined', 409),
      );

      const client = JoiningClient.fromUrl(TEST_BASE_URL);
      try {
        await client.join('uhCAkDuplicate');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(JoiningError);
        expect((e as JoiningError).code).toBe('agent_already_joined');
        expect((e as JoiningError).httpStatus).toBe(409);
      }
    });

    it('throws JoiningError on 400 invalid_agent_key', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse('invalid_agent_key', 'Bad key', 400),
      );

      const client = JoiningClient.fromUrl(TEST_BASE_URL);
      await expect(client.join('bad')).rejects.toThrow(JoiningError);
    });
  });

  describe('reconnect', () => {
    it('sends signed timestamp and returns updated URLs', async () => {
      const mockSignature = new Uint8Array([1, 2, 3, 4]);
      const signCallback = vi.fn().mockResolvedValue(mockSignature);

      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          linker_urls: [{ url: 'wss://new-linker.example.com:8090', expires_at: '2026-03-01T00:00:00Z' }],
        }),
      );

      const client = JoiningClient.fromUrl(TEST_BASE_URL);
      const result = await client.reconnect('uhCAkAgent', signCallback);

      expect(signCallback).toHaveBeenCalledTimes(1);
      // The callback receives an ISO timestamp string
      const timestamp = signCallback.mock.calls[0][0];
      expect(typeof timestamp).toBe('string');
      expect(new Date(timestamp).getTime()).not.toBeNaN();

      expect(result.linker_urls).toEqual([{ url: 'wss://new-linker.example.com:8090', expires_at: '2026-03-01T00:00:00Z' }]);
    });

    it('throws on agent_not_joined', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse('agent_not_joined', 'Not joined', 403),
      );

      const client = JoiningClient.fromUrl(TEST_BASE_URL);
      const signCallback = vi.fn().mockResolvedValue(new Uint8Array(64));

      try {
        await client.reconnect('uhCAkUnknown', signCallback);
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(JoiningError);
        expect((e as JoiningError).code).toBe('agent_not_joined');
      }
    });
  });
});

describe('JoinSession', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('verify', () => {
    it('submits verification and returns new session with ready status', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ready' }));

      const session = new JoinSession(TEST_BASE_URL, 'js_test', 'pending', [
        { id: 'ch_1', type: 'email_code', description: 'Enter code' },
      ]);

      const updated = await session.verify('ch_1', '123456');

      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_BASE_URL}/join/js_test/verify`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge_id: 'ch_1', response: '123456' }),
        },
      );
      expect(updated.status).toBe('ready');
      expect(updated.sessionToken).toBe('js_test');
      // Original session unchanged (immutable)
      expect(session.status).toBe('pending');
    });

    it('returns pending when challenges remain', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          status: 'pending',
          challenges_remaining: [
            { id: 'ch_2', type: 'sms_code', description: 'Enter SMS code' },
          ],
          poll_interval_ms: 2000,
        }),
      );

      const session = new JoinSession(TEST_BASE_URL, 'js_multi', 'pending');
      const updated = await session.verify('ch_1', '123456');

      expect(updated.status).toBe('pending');
      expect(updated.challenges).toHaveLength(1);
      expect(updated.challenges![0].id).toBe('ch_2');
    });

    it('throws on verification_failed', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse('verification_failed', 'Wrong code', 422),
      );

      const session = new JoinSession(TEST_BASE_URL, 'js_fail', 'pending');
      try {
        await session.verify('ch_1', '000000');
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(JoiningError);
        expect((e as JoiningError).code).toBe('verification_failed');
      }
    });
  });

  describe('pollStatus', () => {
    it('returns current session status', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          status: 'pending',
          challenges: [
            { id: 'ch_1', type: 'email_code', description: 'Enter code', completed: false },
          ],
          poll_interval_ms: 2000,
        }),
      );

      const session = new JoinSession(TEST_BASE_URL, 'js_poll', 'pending');
      const updated = await session.pollStatus();

      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_BASE_URL}/join/js_poll/status`,
      );
      expect(updated.status).toBe('pending');
      expect(updated.sessionToken).toBe('js_poll');
    });

    it('detects transition to ready', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: 'ready' }));

      const session = new JoinSession(TEST_BASE_URL, 'js_ready', 'pending');
      const updated = await session.pollStatus();

      expect(updated.status).toBe('ready');
    });

    it('preserves rejection reason when polling returns rejected status', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          status: 'rejected',
          reason: 'Agent blocked by administrator',
        }),
      );

      const session = new JoinSession(TEST_BASE_URL, 'js_rejected', 'pending');
      const updated = await session.pollStatus();

      expect(updated.status).toBe('rejected');
      expect(updated.reason).toBe('Agent blocked by administrator');
    });
  });

  describe('getProvision', () => {
    it('returns provision when ready', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          linker_urls: [{ url: 'wss://linker.example.com:8090', expires_at: '2026-03-01T00:00:00Z' }],
          membrane_proofs: { 'uhC0kDna1': 'base64proof' },
          happ_bundle_url: 'https://example.com/test.happ',
        }),
      );

      const session = new JoinSession(TEST_BASE_URL, 'js_creds', 'ready');
      const provision = await session.getProvision();

      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_BASE_URL}/join/js_creds/provision`,
      );
      expect(provision.linker_urls).toEqual([{ url: 'wss://linker.example.com:8090', expires_at: '2026-03-01T00:00:00Z' }]);
      expect(provision.membrane_proofs).toEqual({ 'uhC0kDna1': 'base64proof' });
    });

    it('throws not_ready when session is pending', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse('not_ready', 'Session is pending', 403),
      );

      const session = new JoinSession(TEST_BASE_URL, 'js_notready', 'pending');
      await expect(session.getProvision()).rejects.toThrow(JoiningError);
    });
  });
});

describe('JoiningError', () => {
  it('has correct properties', () => {
    const err = new JoiningError('test_code', 'Test message', 400, {
      field: 'value',
    });
    expect(err.name).toBe('JoiningError');
    expect(err.code).toBe('test_code');
    expect(err.message).toBe('Test message');
    expect(err.httpStatus).toBe(400);
    expect(err.details).toEqual({ field: 'value' });
    expect(err).toBeInstanceOf(Error);
  });
});
