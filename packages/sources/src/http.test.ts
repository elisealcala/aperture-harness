import { describe, expect, it } from 'vitest';
import { FakeFetch } from '../../../tests/helpers/fetch.ts';
import { requestJson, resolveGitHubToken, type FetchLike } from './http.ts';
import { SourceError } from './types.ts';

const URL_ = 'https://api.example.test/things/1';

function respond(status: number, text: string): FakeFetch {
  return new FakeFetch(() => ({ status, text }));
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(SourceError);
    return (err as SourceError).code;
  }
}

describe('requestJson', () => {
  it('GETs by default with an accept header and parses the JSON body', async () => {
    const fake = respond(200, '{"a":1}');
    const result = await requestJson<{ a: number }>(fake.fetch, URL_, { headers: { 'x-extra': 'yes' } });
    expect(result).toEqual({ status: 200, data: { a: 1 } });
    expect(fake.calls).toEqual([{ url: URL_, method: 'GET', headers: { accept: 'application/json', 'x-extra': 'yes' } }]);
  });

  it('serializes a body as JSON with a content-type for POST', async () => {
    const fake = respond(201, '{"ok":true}');
    await requestJson(fake.fetch, URL_, { method: 'POST', headers: {}, body: { title: 't' } });
    expect(fake.calls[0]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { title: 't' } });
  });

  it('passes an abort signal to the transport', async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      signal = init.signal;
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => '{}' };
    };
    await requestJson(fetchImpl, URL_, { headers: {} });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('maps 401 and 403 to AUTH', async () => {
    expect(await codeOf(requestJson(respond(401, '{"message":"Bad credentials"}').fetch, URL_, { headers: {} }))).toBe('AUTH');
    expect(await codeOf(requestJson(respond(403, '{}').fetch, URL_, { headers: {} }))).toBe('AUTH');
  });

  it('maps 404 to NOT_FOUND', async () => {
    expect(await codeOf(requestJson(respond(404, '{"message":"Not Found"}').fetch, URL_, { headers: {} }))).toBe('NOT_FOUND');
  });

  it('maps other non-2xx statuses to TRANSPORT but returns 422 bodies to the caller', async () => {
    expect(await codeOf(requestJson(respond(500, '{}').fetch, URL_, { headers: {} }))).toBe('TRANSPORT');
    await expect(requestJson(respond(422, '{"message":"Validation Failed"}').fetch, URL_, { headers: {} })).resolves.toEqual({ status: 422, data: { message: 'Validation Failed' } });
  });

  it('rejects invalid JSON as INVALID_CONTENT', async () => {
    expect(await codeOf(requestJson(respond(200, '<html>oops</html>').fetch, URL_, { headers: {} }))).toBe('INVALID_CONTENT');
  });

  it('rejects oversized responses as INVALID_CONTENT before inspecting the status', async () => {
    const huge = `"${'x'.repeat(2_000_001)}"`;
    expect(await codeOf(requestJson(respond(200, huge).fetch, URL_, { headers: {} }))).toBe('INVALID_CONTENT');
    expect(await codeOf(requestJson(respond(401, huge).fetch, URL_, { headers: {} }))).toBe('INVALID_CONTENT');
  });

  it('returns null data for an empty body', async () => {
    await expect(requestJson(respond(204, '').fetch, URL_, { headers: {} })).resolves.toEqual({ status: 204, data: null });
  });

  it('wraps transport failures as TRANSPORT naming only the host', async () => {
    const failing: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(requestJson(failing, `${URL_}?token=secret`, { headers: {} })).rejects.toMatchObject({
      code: 'TRANSPORT',
      message: 'request to api.example.test failed: ECONNREFUSED',
    });
  });
});

describe('resolveGitHubToken', () => {
  it('prefers the configured env var', async () => {
    await expect(resolveGitHubToken({ MY_TOKEN: 'from-config', GH_TOKEN: 'from-gh' }, { tokenEnv: 'MY_TOKEN', useGhCli: true })).resolves.toBe('from-config');
  });

  it('falls back to GH_TOKEN', async () => {
    await expect(resolveGitHubToken({ GH_TOKEN: 'from-gh' }, { tokenEnv: 'MY_TOKEN', useGhCli: true })).resolves.toBe('from-gh');
  });

  it('returns undefined without env vars when the gh CLI is disabled', async () => {
    await expect(resolveGitHubToken({}, { tokenEnv: 'MY_TOKEN', useGhCli: false })).resolves.toBeUndefined();
  });

  it('returns undefined when the gh CLI cannot be run', async () => {
    await expect(resolveGitHubToken({ PATH: '/nonexistent-aperture-path', HOME: '/nonexistent' }, { tokenEnv: 'MY_TOKEN', useGhCli: true })).resolves.toBeUndefined();
  });
});
