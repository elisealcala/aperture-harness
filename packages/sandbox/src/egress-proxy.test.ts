import dns from 'node:dns';
import { request as httpRequest, createServer as createHttpServer, type IncomingHttpHeaders, type Server as HttpServer } from 'node:http';
import { connect, createServer, isIP, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EgressProxy, egressAllowed, isNonPublicAddress, type EgressDecision, type EgressProxyOptions } from './egress-proxy.ts';

describe('egressAllowed', () => {
  it.each([
    [['studio.example.workers.dev:443'], 'studio.example.workers.dev', 443],
    [['studio.example.workers.dev'], 'studio.example.workers.dev', 443],
    [['api.example.com:8443'], 'api.example.com', 8443],
    [['*.example.com'], 'a.example.com', 443],
    [['*.example.com'], 'deep.a.example.com', 443],
    [['*.example.com:8080'], 'a.example.com', 8080],
    [['API.Example.COM'], 'api.example.com', 443],
    [['api.example.com'], 'API.EXAMPLE.COM', 443],
    [['api.example.com'], 'api.example.com.', 443],
    [['other.example.org', 'api.example.com'], 'api.example.com', 443],
  ])('allows %j -> %s:%d', (rules, host, port) => {
    expect(egressAllowed(rules, host, port)).toEqual({ allowed: true });
  });

  it.each([
    [['api.example.com'], 'api.example.com', 80, 'a portless rule only covers 443'],
    [['api.example.com:8443'], 'api.example.com', 443, 'port mismatch'],
    [['*.example.com'], 'example.com', 443, 'wildcard does not match the apex'],
    [['*.example.com'], 'evilexample.com', 443, 'wildcard requires a dot boundary'],
    [['api.example.com'], 'api.example.com.evil.net', 443, 'suffix attack'],
    [['api.example.com'], 'sub.api.example.com', 443, 'exact rule does not match subdomains'],
    [[], 'api.example.com', 443, 'empty allowlist'],
  ])('denies %j -> %s:%d (%s)', (rules, host, port) => {
    expect(egressAllowed(rules, host, port)).toEqual({ allowed: false, reason: 'host is not in the contract allowlist' });
  });

  it.each(['127.0.0.1', '10.0.0.8', '169.254.169.254', '::1', '[::1]', '[2001:db8::1]'])('refuses the IP literal %s even under a matching rule', (host) => {
    expect(egressAllowed([`${host.replace(/^\[|\]$/g, '')}:443`, '*.example.com'], host, 443)).toEqual({ allowed: false, reason: 'IP literals are not allowed' });
  });

  it.each(['localhost', 'LOCALHOST', 'app.localhost', 'localhost.'])('refuses %s even when allowlisted', (host) => {
    expect(egressAllowed(['localhost:443', 'app.localhost:443', '*.localhost'], host, 443)).toEqual({ allowed: false, reason: 'localhost is not allowed' });
  });

  it('throws on a malformed rule rather than allowing everything', () => {
    expect(() => egressAllowed(['bad host:x'], 'api.example.com', 443)).toThrow(/invalid egress host rule/);
  });
});

// ---- EgressProxy over real loopback sockets ------------------------------------------------

/** A loopback TCP "upstream" that records every connection and echoes `pong:<data>`. */
async function echoUpstream(): Promise<{ server: Server; port: number; connections: number; received: string[] }> {
  const state = { server: undefined as unknown as Server, port: 0, connections: 0, received: [] as string[] };
  state.server = createServer((socket) => {
    state.connections++;
    socket.on('data', (d) => {
      state.received.push(String(d));
      socket.end(`pong:${String(d)}`);
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', () => resolve()));
  state.port = (state.server.address() as { port: number }).port;
  return state;
}

/** Sends `CONNECT target` to the proxy; resolves with the status line and, if 200, the tunnel echo. */
function connectThrough(proxyPort: number, target: string, payload = 'ping'): Promise<{ status: string; echoed?: string }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = '';
    let status: string | undefined;
    socket.on('data', (d) => {
      buf += String(d);
      if (status === undefined && buf.includes('\r\n\r\n')) {
        status = buf.slice(0, buf.indexOf('\r\n'));
        buf = buf.slice(buf.indexOf('\r\n\r\n') + 4);
        if (/ 200 /.test(status)) socket.write(payload);
      }
    });
    socket.on('end', () => resolve({ status: status ?? '', ...(status && / 200 /.test(status) ? { echoed: buf } : {}) }));
    socket.on('error', reject);
  });
}

/** Absolute-form plain-HTTP request through the proxy. */
function httpThrough(proxyPort: number, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: new URL(url).host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += String(d)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const ALLOWED = 'allowed.example.test';
const ALSO_LOCAL = 'evil.example.test';

describe('EgressProxy', () => {
  let proxy: EgressProxy;
  let decisions: EgressDecision[];
  let upstream: Awaited<ReturnType<typeof echoUpstream>>;
  let lookups: string[];
  let systemLookups: string[];

  /** Hermetic resolver: both test names resolve to the loopback upstream; any other name fails. */
  const resolveToLoopback = async (host: string): Promise<string[]> => {
    lookups.push(host);
    if (host === ALLOWED || host === ALSO_LOCAL) return ['127.0.0.1'];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  };

  beforeEach(async () => {
    upstream = await echoUpstream();
    decisions = [];
    lookups = [];
    systemLookups = [];
    // Nothing may fall back to the system resolver: the proxy resolves through `resolve` and then
    // connects to the checked IP (pinned), so any name reaching dns.lookup is a bug.
    const realLookup = dns.lookup as (...args: unknown[]) => void;
    vi.spyOn(dns, 'lookup').mockImplementation(((host: string, options: unknown, callback?: unknown) => {
      // server.listen('127.0.0.1') also goes through dns.lookup; IP literals pass through.
      if (isIP(host) !== 0) return realLookup(host, options, callback);
      const cb = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
      systemLookups.push(host);
      return cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' }));
    }) as typeof dns.lookup);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await proxy?.stop();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  /** Defaults to the loopback resolver with non-public addresses allowed (the hermetic upstream is on 127.0.0.1). */
  async function startProxy(rules: string[], onDecision?: (d: EgressDecision) => void, options: EgressProxyOptions = { resolve: resolveToLoopback, allowNonPublicAddresses: true }): Promise<number> {
    proxy = new EgressProxy(rules, onDecision ?? ((d) => decisions.push(d)), options);
    return proxy.start();
  }

  it('binds to a random loopback port', async () => {
    const port = await startProxy([`${ALLOWED}:443`]);
    expect(port).toBeGreaterThan(0);
  });

  describe('CONNECT', () => {
    it('tunnels to an allowlisted host and reports the decision (AT-17)', async () => {
      const port = await startProxy([`${ALLOWED}:${upstream.port}`]);
      const result = await connectThrough(port, `${ALLOWED}:${upstream.port}`);
      expect(result.status).toBe('HTTP/1.1 200 Connection Established');
      expect(result.echoed).toBe('pong:ping');
      expect(upstream.received).toEqual(['ping']);
      expect(decisions).toEqual([{ host: ALLOWED, port: upstream.port, method: 'CONNECT', allowed: true }]);
    });

    it('refuses a host outside the allowlist with 403 and sends no bytes upstream (AT-18)', async () => {
      const port = await startProxy([`${ALLOWED}:${upstream.port}`]);
      const result = await connectThrough(port, `${ALSO_LOCAL}:${upstream.port}`);
      expect(result.status).toBe('HTTP/1.1 403 Forbidden');
      expect(decisions).toEqual([{ host: ALSO_LOCAL, port: upstream.port, method: 'CONNECT', allowed: false, reason: 'host is not in the contract allowlist' }]);
      expect(upstream.connections).toBe(0);
      expect(lookups).not.toContain(ALSO_LOCAL);
    });

    it('refuses the allowlisted host on a different port', async () => {
      const port = await startProxy([`${ALLOWED}:${upstream.port}`]);
      expect((await connectThrough(port, `${ALLOWED}:443`)).status).toBe('HTTP/1.1 403 Forbidden');
      expect(decisions[0]).toMatchObject({ host: ALLOWED, port: 443, allowed: false });
      expect(upstream.connections).toBe(0);
    });

    it.each([
      ['127.0.0.1', 'IP literals are not allowed'],
      ['[::1]', 'IP literals are not allowed'],
      ['localhost', 'localhost is not allowed'],
    ])('refuses a direct %s target (AT-18)', async (host, reason) => {
      const port = await startProxy([`${ALLOWED}:${upstream.port}`]);
      const result = await connectThrough(port, `${host}:${upstream.port}`);
      expect(result.status).toBe('HTTP/1.1 403 Forbidden');
      expect(decisions).toEqual([expect.objectContaining({ allowed: false, port: upstream.port, method: 'CONNECT', reason })]);
      expect(upstream.connections).toBe(0);
    });

    it('refuses a malformed CONNECT target without a decision', async () => {
      const port = await startProxy([`${ALLOWED}:${upstream.port}`]);
      expect((await connectThrough(port, ALLOWED)).status).toBe('HTTP/1.1 403 Forbidden');
      expect(decisions).toEqual([]);
      expect(upstream.connections).toBe(0);
    });

    it('refuses an allowlisted name that does not resolve', async () => {
      const port = await startProxy(['unresolvable.example.test:443']);
      const result = await connectThrough(port, 'unresolvable.example.test:443');
      expect(result.status).toBe('HTTP/1.1 403 Forbidden');
      expect(decisions).toEqual([{ host: 'unresolvable.example.test', port: 443, method: 'CONNECT', allowed: false, reason: 'host did not resolve' }]);
      expect(lookups).toEqual(['unresolvable.example.test']);
    });

    it('answers 502 when an allowed, resolved address cannot be reached', async () => {
      const closed = await echoUpstream();
      await new Promise<void>((resolve) => closed.server.close(() => resolve()));
      const port = await startProxy([`${ALLOWED}:${closed.port}`]);
      const result = await connectThrough(port, `${ALLOWED}:${closed.port}`);
      expect(result.status).toBe('HTTP/1.1 502 Bad Gateway');
      expect(decisions).toEqual([{ host: ALLOWED, port: closed.port, method: 'CONNECT', allowed: true }]);
    });

    it('pins the tunnel to the first checked address instead of resolving the name again', async () => {
      const port = await startProxy([`${ALLOWED}:${upstream.port}`], undefined, {
        resolve: async (host) => (lookups.push(host), ['127.0.0.1', '192.0.2.1']),
        allowNonPublicAddresses: true,
      });
      expect((await connectThrough(port, `${ALLOWED}:${upstream.port}`)).echoed).toBe('pong:ping');
      expect(lookups).toEqual([ALLOWED]);
      expect(systemLookups).toEqual([]);
      expect(upstream.connections).toBe(1);
    });
  });

  describe('plain HTTP (absolute-form)', () => {
    let web: HttpServer;
    let webPort: number;
    let seen: Array<{ url?: string; headers: IncomingHttpHeaders }>;

    beforeEach(async () => {
      seen = [];
      web = createHttpServer((req, res) => {
        seen.push({ ...(req.url !== undefined ? { url: req.url } : {}), headers: req.headers });
        res.end(`hello from ${req.url}`);
      });
      await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', () => resolve()));
      webPort = (web.address() as { port: number }).port;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => web.close(() => resolve()));
    });

    it('forwards an allowlisted request and strips proxy credentials (AT-17)', async () => {
      const port = await startProxy([`${ALLOWED}:${webPort}`]);
      const res = await httpThrough(port, `http://${ALLOWED}:${webPort}/status?x=1`, { 'proxy-authorization': 'Basic c2VjcmV0', 'proxy-connection': 'keep-alive' });
      expect(res).toEqual({ status: 200, body: 'hello from /status?x=1' });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers['proxy-authorization']).toBeUndefined();
      expect(seen[0]!.headers['proxy-connection']).toBeUndefined();
      expect(decisions).toEqual([{ host: ALLOWED, port: webPort, method: 'HTTP', allowed: true }]);
    });

    it('connects to the checked address but keeps the original Host header', async () => {
      const port = await startProxy([`${ALLOWED}:${webPort}`]);
      expect((await httpThrough(port, `http://${ALLOWED}:${webPort}/pinned`)).status).toBe(200);
      expect(seen).toEqual([expect.objectContaining({ url: '/pinned', headers: expect.objectContaining({ host: `${ALLOWED}:${webPort}` }) })]);
      expect(lookups).toEqual([ALLOWED]);
      expect(systemLookups).toEqual([]);
    });

    it('refuses an allowlisted name resolving to loopback (DNS rebinding) and never contacts it', async () => {
      const port = await startProxy([`${ALLOWED}:${webPort}`], undefined, { resolve: resolveToLoopback });
      expect((await httpThrough(port, `http://${ALLOWED}:${webPort}/`)).status).toBe(403);
      expect(seen).toEqual([]);
      expect(decisions).toEqual([{ host: ALLOWED, port: webPort, method: 'HTTP', allowed: false, reason: 'host resolves to a non-public address' }]);
    });

    it('refuses a host outside the allowlist with 403 and never contacts it (AT-18)', async () => {
      const port = await startProxy([`${ALLOWED}:${webPort}`]);
      expect((await httpThrough(port, `http://${ALSO_LOCAL}:${webPort}/`)).status).toBe(403);
      expect(seen).toEqual([]);
      expect(decisions).toEqual([{ host: ALSO_LOCAL, port: webPort, method: 'HTTP', allowed: false, reason: 'host is not in the contract allowlist' }]);
    });

    it('uses port 80 when the URL has none (so a portless rule, which means 443, does not match)', async () => {
      const port = await startProxy([ALLOWED]);
      expect((await httpThrough(port, `http://${ALLOWED}/`)).status).toBe(403);
      expect(decisions).toEqual([expect.objectContaining({ host: ALLOWED, port: 80, allowed: false })]);
    });

    it('refuses a direct IP literal (AT-18)', async () => {
      const port = await startProxy([`${ALLOWED}:${webPort}`]);
      expect((await httpThrough(port, `http://127.0.0.1:${webPort}/`)).status).toBe(403);
      expect(seen).toEqual([]);
      expect(decisions).toEqual([expect.objectContaining({ host: '127.0.0.1', allowed: false, reason: 'IP literals are not allowed' })]);
    });

    it('answers 400 to an origin-form request (not a proxy request)', async () => {
      const port = await startProxy([`${ALLOWED}:${webPort}`]);
      const res = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/relative' }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      expect(res).toBe(400);
      expect(decisions).toEqual([]);
    });
  });

  it('keeps enforcing when the decision callback throws', async () => {
    const port = await startProxy([`${ALLOWED}:${upstream.port}`], () => {
      throw new Error('event store unavailable');
    });
    expect((await connectThrough(port, `${ALSO_LOCAL}:${upstream.port}`)).status).toBe('HTTP/1.1 403 Forbidden');
    expect((await connectThrough(port, `${ALLOWED}:${upstream.port}`)).echoed).toBe('pong:ping');
    expect(upstream.connections).toBe(1);
  });

  it('stop() closes the listener and open tunnels; stopping twice is harmless', async () => {
    const port = await startProxy([`${ALLOWED}:${upstream.port}`]);
    await proxy.stop();
    await proxy.stop();
    await expect(connectThrough(port, `${ALLOWED}:${upstream.port}`)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  describe('resolved address checks (default: public addresses only)', () => {
    const resolveWith = (answer: (host: string) => Promise<string[]>): EgressProxyOptions => ({
      resolve: async (host) => {
        lookups.push(host);
        return answer(host);
      },
    });

    it('refuses an allowlisted name that resolves to 127.0.0.1 (DNS rebinding) without connecting upstream', async () => {
      const port = await startProxy([`${ALLOWED}:${upstream.port}`], undefined, resolveWith(async () => ['127.0.0.1']));
      const result = await connectThrough(port, `${ALLOWED}:${upstream.port}`);
      expect(result.status).toBe('HTTP/1.1 403 Forbidden');
      expect(decisions).toEqual([{ host: ALLOWED, port: upstream.port, method: 'CONNECT', allowed: false, reason: 'host resolves to a non-public address' }]);
      expect(lookups).toEqual([ALLOWED]);
      expect(upstream.connections).toBe(0);
    });

    it.each([
      [['93.184.216.34', '10.0.0.1'], 'public then private'],
      [['127.0.0.1', '93.184.216.34'], 'loopback then public'],
      [['2606:4700::1111', 'fe80::1'], 'public then link-local IPv6'],
      [['93.184.216.34', '::ffff:127.0.0.1'], 'public then IPv4-mapped loopback'],
    ])('refuses mixed answers %j (%s)', async (addresses) => {
      const port = await startProxy([`${ALLOWED}:${upstream.port}`], undefined, resolveWith(async () => addresses));
      expect((await connectThrough(port, `${ALLOWED}:${upstream.port}`)).status).toBe('HTTP/1.1 403 Forbidden');
      expect(decisions).toEqual([expect.objectContaining({ host: ALLOWED, allowed: false, reason: 'host resolves to a non-public address' })]);
      expect(upstream.connections).toBe(0);
    });

    it('refuses with "host did not resolve" when the resolver throws', async () => {
      const port = await startProxy([`${ALLOWED}:${upstream.port}`], undefined, resolveWith(async () => Promise.reject(Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }))));
      expect((await connectThrough(port, `${ALLOWED}:${upstream.port}`)).status).toBe('HTTP/1.1 403 Forbidden');
      expect(decisions).toEqual([{ host: ALLOWED, port: upstream.port, method: 'CONNECT', allowed: false, reason: 'host did not resolve' }]);
      expect(upstream.connections).toBe(0);
    });

    it('refuses with "host did not resolve" when the resolver returns no addresses', async () => {
      const port = await startProxy([`${ALLOWED}:${upstream.port}`], undefined, resolveWith(async () => []));
      expect((await connectThrough(port, `${ALLOWED}:${upstream.port}`)).status).toBe('HTTP/1.1 403 Forbidden');
      expect(decisions).toEqual([expect.objectContaining({ allowed: false, reason: 'host did not resolve' })]);
      expect(upstream.connections).toBe(0);
    });

    it('does not resolve names that the allowlist already refuses', async () => {
      const port = await startProxy([`${ALLOWED}:${upstream.port}`], undefined, resolveWith(async () => ['127.0.0.1']));
      await connectThrough(port, `${ALSO_LOCAL}:${upstream.port}`);
      expect(decisions).toEqual([expect.objectContaining({ host: ALSO_LOCAL, reason: 'host is not in the contract allowlist' })]);
      expect(lookups).toEqual([]);
    });

    it('uses the system resolver (all addresses) by default and applies the same check', async () => {
      const lookup = vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '192.168.1.20', family: 4 }] as never);
      const port = await startProxy([`${ALLOWED}:${upstream.port}`], undefined, {});
      expect((await connectThrough(port, `${ALLOWED}:${upstream.port}`)).status).toBe('HTTP/1.1 403 Forbidden');
      expect(lookup).toHaveBeenCalledWith(ALLOWED, expect.objectContaining({ all: true }));
      expect(decisions).toEqual([expect.objectContaining({ host: ALLOWED, allowed: false, reason: 'host resolves to a non-public address' })]);
      expect(upstream.connections).toBe(0);
    });

    it('refuses with "host did not resolve" when the system resolver fails', async () => {
      vi.spyOn(dns.promises, 'lookup').mockRejectedValue(Object.assign(new Error(`getaddrinfo ENOTFOUND ${ALLOWED}`), { code: 'ENOTFOUND' }));
      const port = await startProxy([`${ALLOWED}:${upstream.port}`], undefined, {});
      expect((await connectThrough(port, `${ALLOWED}:${upstream.port}`)).status).toBe('HTTP/1.1 403 Forbidden');
      expect(decisions).toEqual([expect.objectContaining({ allowed: false, reason: 'host did not resolve' })]);
    });
  });
});

describe('isNonPublicAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback /8'],
    ['10.0.0.1', 'RFC 1918 10/8'],
    ['10.255.255.255', 'RFC 1918 10/8 upper bound'],
    ['172.16.0.1', 'RFC 1918 172.16/12'],
    ['172.31.255.255', 'RFC 1918 172.16/12 upper bound'],
    ['192.168.1.1', 'RFC 1918 192.168/16'],
    ['169.254.169.254', 'link-local (cloud metadata)'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.255', 'CGNAT upper bound'],
    ['0.0.0.0', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast upper'],
    ['255.255.255.255', 'broadcast / reserved'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fc00::1', 'IPv6 unique local'],
    ['fd12:3456::1', 'IPv6 unique local (fd)'],
    ['fe80::1', 'IPv6 link-local'],
    ['ff02::1', 'IPv6 multicast'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::FFFF:10.0.0.1', 'IPv4-mapped private (upper case)'],
    ['not-an-ip', 'not an address'],
  ])('%s is non-public (%s)', (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each([
    ['93.184.216.34', 'public IPv4'],
    ['8.8.8.8', 'public IPv4'],
    ['172.32.0.1', 'just above 172.16/12'],
    ['100.128.0.1', 'just above CGNAT'],
    ['2606:4700::1111', 'public IPv6'],
    ['::ffff:93.184.216.34', 'IPv4-mapped public'],
  ])('%s is public (%s)', (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });
});
