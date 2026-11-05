import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';

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

/**
 * Per-check forward proxy (HTTP CONNECT for HTTPS, absolute-form for plain HTTP) bound to
 * 127.0.0.1. The sandbox only lets commands reach this port, so every outbound connection is
 * checked against the approved allowlist and reported; nothing else leaves the machine.
 */
export class EgressProxy {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly rules: readonly string[],
    private readonly onDecision: (decision: EgressDecision) => void = () => undefined,
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

  private decide(host: string, port: number, method: EgressDecision['method']): boolean {
    const verdict = egressAllowed(this.rules, host, port);
    try {
      this.onDecision({ host, port, method, allowed: verdict.allowed, ...(verdict.reason ? { reason: verdict.reason } : {}) });
    } catch {
      // Logging must not affect enforcement.
    }
    return verdict.allowed;
  }

  private handleConnect(req: IncomingMessage, client: Socket, head: Buffer): void {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => client.destroy());
    const target = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(req.url ?? '');
    if (!target || !this.decide(target[1]!, Number(target[2]), 'CONNECT')) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connect(Number(target[2]), target[1]!, () => {
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
    if (url.protocol !== 'http:' || !this.decide(url.hostname, port, 'HTTP')) {
      res.writeHead(403).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = httpRequest({ host: url.hostname, port, method: req.method, path: `${url.pathname}${url.search}`, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }
}
