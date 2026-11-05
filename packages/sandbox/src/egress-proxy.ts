import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { promises as dnsPromises } from 'node:dns';
import { BlockList, connect, isIP, type Socket } from 'node:net';

export interface EgressDecision {
  host: string;
  port: number;
  method: 'CONNECT' | 'HTTP';
  allowed: boolean;
  reason?: string;
}

interface HostRule {
  wildcard: boolean;
  host: string;
  port: number | null;
}

function parseRule(rule: string): HostRule {
  const m = /^(\*\.)?([^:]+)(?::(\d+))?$/.exec(rule.trim().toLowerCase());
  if (!m) throw new Error(`invalid egress host rule ${rule}`);
  return { wildcard: Boolean(m[1]), host: m[2]!, port: m[3] ? Number(m[3]) : null };
}

/**
 * Host allowlist matching. A rule without a port allows only 443 (HTTPS); `*.example.com` matches
 * subdomains but not `example.com` itself. IP literals and localhost are never allowed.
 */
export function egressAllowed(rules: readonly string[], host: string, port: number): { allowed: boolean; reason?: string } {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isIP(h) !== 0) return { allowed: false, reason: 'IP literals are not allowed' };
  if (h === 'localhost' || h.endsWith('.localhost')) return { allowed: false, reason: 'localhost is not allowed' };
  for (const rule of rules.map(parseRule)) {
    const hostOk = rule.wildcard ? h.endsWith(`.${rule.host}`) : h === rule.host;
    const portOk = rule.port === null ? port === 443 : port === rule.port;
    if (hostOk && portOk) return { allowed: true };
  }
  return { allowed: false, reason: 'host is not in the contract allowlist' };
}

const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv6');
}

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isNonPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return NON_PUBLIC.check(mapped[1]!, 'ipv4');
  const family = isIP(address);
  if (family === 0) return true;
  return NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export interface EgressProxyOptions {
  /** Resolves a host name to IP addresses (default: the system resolver, all addresses). */
  resolve?: (host: string) => Promise<string[]>;
  /** Tests only: allow names that resolve to loopback/private addresses. */
  allowNonPublicAddresses?: boolean;
}

const defaultResolve = async (host: string): Promise<string[]> => (await dnsPromises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Per-check forward proxy (HTTP CONNECT for HTTPS, absolute-form for plain HTTP) bound to
 * 127.0.0.1. The sandbox only lets commands reach this port, so every outbound connection is
 * checked against the approved allowlist and reported; nothing else leaves the machine. Allowed names
 * are resolved by the proxy and refused when any address is non-public (DNS rebinding / SSRF into the
 * host or LAN); the connection is pinned to the checked address.
 */
export class EgressProxy {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly rules: readonly string[],
    private readonly onDecision: (decision: EgressDecision) => void = () => undefined,
    private readonly options: EgressProxyOptions = {},
  ) {}

  async start(): Promise<number> {
    const server = createServer((req, res) => this.handleHttp(req, res));
    server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => this.handleConnect(req, client, head));
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('egress proxy failed to bind');
    return address.port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Returns the address to connect to, or undefined when the request is refused. */
  private async decide(host: string, port: number, method: EgressDecision['method']): Promise<string | undefined> {
    let verdict = egressAllowed(this.rules, host, port);
    let address: string | undefined;
    if (verdict.allowed) {
      try {
        const addresses = await (this.options.resolve ?? defaultResolve)(host);
        if (addresses.length === 0) verdict = { allowed: false, reason: 'host did not resolve' };
        else if (!this.options.allowNonPublicAddresses && addresses.some(isNonPublicAddress)) verdict = { allowed: false, reason: 'host resolves to a non-public address' };
        else address = addresses[0];
      } catch {
        verdict = { allowed: false, reason: 'host did not resolve' };
      }
    }
    try {
      this.onDecision({ host, port, method, allowed: verdict.allowed, ...(verdict.reason ? { reason: verdict.reason } : {}) });
    } catch {
      // Logging must not affect enforcement.
    }
    return verdict.allowed ? address : undefined;
  }

  private handleConnect(req: IncomingMessage, client: Socket, head: Buffer): void {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => client.destroy());
    const target = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(req.url ?? '');
    client.pause();
    void (async () => {
      const address = target ? await this.decide(target[1]!, Number(target[2]), 'CONNECT') : undefined;
      if (!target || !address) {
        client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.tunnel(client, head, address, Number(target[2]));
    })();
  }

  private tunnel(client: Socket, head: Buffer, address: string, port: number): void {
    client.resume();
    const upstream = connect(port, address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    this.sockets.add(upstream);
    upstream.on('close', () => this.sockets.delete(upstream));
    upstream.on('error', () => {
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = url.port ? Number(url.port) : 80;
    if (url.protocol !== 'http:') {
      res.writeHead(403).end();
      return;
    }
    req.pause();
    void this.decide(url.hostname, port, 'HTTP').then((address) => {
      if (!address) {
        res.writeHead(403).end();
        return;
      }
      this.forward(req, res, url, address, port);
    });
  }

  private forward(req: IncomingMessage, res: ServerResponse, url: URL, address: string, port: number): void {
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: url.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = httpRequest({ host: address, port, method: req.method, path: `${url.pathname}${url.search}`, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
    req.resume();
  }
}
