/**
 * Amendment A1 §21.1: controlled egress for check commands (AT-17, AT-18) and hosted-check secrets
 * (AT-19). Hermetic: the "internet" is a loopback echo server, and the proxy's DNS lookups are
 * stubbed so the allowlisted test names resolve to it (any other name fails to resolve). Because the
 * proxy refuses names resolving to non-public addresses, the allow path is exercised with
 * `allowLoopbackUpstream()`, which turns on the proxy's tests-only `allowNonPublicAddresses`.
 */
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { connect, createServer, isIP, type Server } from 'node:net';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractInput } from '../../packages/contracts/src/index.ts';
import { NonInteractive, Orchestrator } from '../../packages/core/src/index.ts';
import type { ToolGateway, ToolOutcome } from '../../packages/gateway/src/index.ts';
import { detectIsolation, EgressProxy, type EgressProxyOptions } from '../../packages/sandbox/src/index.ts';
import type { RunRecord } from '../../packages/storage/src/index.ts';
import { createHarnessFixture, fixtureContract, type HarnessFixture } from '../helpers/harness.ts';
import { DONE, lastToolResults, patchTurn, scriptedModel } from '../helpers/model.ts';
import { SESSION_METADATA_PATCH } from '../helpers/repo.ts';
import { TempDirs } from '../helpers/tmp.ts';

const ALLOWED = 'studio.example.test';
const DENIED = 'evil.example.test';
const SECRET_ENV = 'APERTURE_TEST_STUDIO_OWNER_TOKEN';
const SECRET = 'owner-token-5f1c9a7e2b3d4c6a8e0f';
const seatbeltAvailable = detectIsolation() === 'macos-seatbelt';

/** Speaks HTTP CONNECT to $HTTPS_PROXY for argv host:port, sends "ping" and prints what comes back. */
const CONNECT_SCRIPT = String.raw`
const net = require('node:net');
const target = process.argv[1] + ':' + process.argv[2];
if (!process.env.HTTPS_PROXY) { console.log('no proxy configured'); process.exit(5); }
const u = new URL(process.env.HTTPS_PROXY);
const s = net.connect(Number(u.port), u.hostname, () => s.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n\r\n'));
let buf = '', status;
s.on('data', (d) => {
  buf += d;
  if (status === undefined && buf.includes('\r\n\r\n')) {
    status = buf.slice(0, buf.indexOf('\r\n'));
    buf = buf.slice(buf.indexOf('\r\n\r\n') + 4);
    console.log('proxy: ' + status);
    if (/ 200 /.test(status)) s.write('ping'); else { s.destroy(); process.exit(3); }
  }
});
s.on('end', () => { console.log('upstream: ' + buf); process.exit(/ 200 /.test(status || '') ? 0 : 3); });
s.on('error', (e) => { console.log('error: ' + e.code); process.exit(4); });
`;

/** Connects straight to argv host:port, bypassing the proxy. */
const DIRECT_SCRIPT = String.raw`
const s = require('node:net').connect(Number(process.argv[2]), process.argv[1], () => { console.log('connected'); s.end(); process.exit(0); });
s.on('error', (e) => { console.log('error: ' + e.code); process.exit(4); });
`;

/** Reports whether the hosted-check token arrived, echoes it (to be redacted) and a digest prefix. */
const HOSTED_SCRIPT = String.raw`
const t = process.env.STUDIO_OWNER_TOKEN || '';
console.log('token-set=' + (t.length > 0));
console.log('token-sha=' + require('node:crypto').createHash('sha256').update(t).digest('hex').slice(0, 16));
console.log('token=' + t);
console.log('base=' + process.env.STUDIO_BASE_URL);
console.log('public=' + process.env.PUBLIC_ID);
console.error('stderr token ' + t);
`;

const PROBE_SCRIPT = String.raw`console.log('probe token-set=' + Boolean(process.env.STUDIO_OWNER_TOKEN) + ' base=' + (process.env.STUDIO_BASE_URL || 'unset'));`;

type ResultOutcome = Extract<ToolOutcome, { kind: 'result' }>;
function asResult(outcome: ToolOutcome): ResultOutcome {
  if (outcome.kind !== 'result') throw new Error(`expected a result outcome, got ${JSON.stringify(outcome)}`);
  return outcome;
}

const tmp = new TempDirs();
let fx: HarnessFixture;
let upstream: { server: Server; port: number; connections: number; received: string[] };

/** Loopback "internet": counts connections and answers `pong:<data>`. */
async function startUpstream(): Promise<typeof upstream> {
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

let resolved: string[];

beforeEach(async () => {
  upstream = await startUpstream();
  resolved = [];
  // The proxy resolves allowlisted names itself (system resolver, all addresses). Both names point
  // at the loopback upstream, so a wrongly allowed connection would be counted.
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async (host: string) => {
    resolved.push(host);
    if (isIP(host) !== 0) return [{ address: host, family: isIP(host) }];
    if (host === ALLOWED || host === DENIED) return [{ address: '127.0.0.1', family: 4 }];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  }) as unknown as typeof dns.promises.lookup);
});

/**
 * The gateway builds its proxy without options; let it reach the loopback upstream as if the
 * allowlisted name were public (EgressProxyOptions.allowNonPublicAddresses, tests only).
 */
function allowLoopbackUpstream(): void {
  const start = EgressProxy.prototype.start;
  vi.spyOn(EgressProxy.prototype, 'start').mockImplementation(function (this: EgressProxy) {
    (this as unknown as { options: EgressProxyOptions }).options = { allowNonPublicAddresses: true };
    return start.call(this);
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  fx?.harness.close();
  await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  tmp.cleanup();
});

const reachCommands = (port: number) => ({
  'reach-allowed': { exec: 'node', args: ['-e', CONNECT_SCRIPT, ALLOWED, String(port)], timeoutSeconds: 30 },
  'reach-denied': { exec: 'node', args: ['-e', CONNECT_SCRIPT, DENIED, String(port)], timeoutSeconds: 30 },
  'reach-ip': { exec: 'node', args: ['-e', CONNECT_SCRIPT, '127.0.0.1', String(port)], timeoutSeconds: 30 },
  'reach-wrong-port': { exec: 'node', args: ['-e', CONNECT_SCRIPT, ALLOWED, '443'], timeoutSeconds: 30 },
  direct: { exec: 'node', args: ['-e', DIRECT_SCRIPT, '127.0.0.1', String(port)], timeoutSeconds: 30 },
  'print-proxy': { exec: 'node', args: ['-e', "console.log('proxy=' + (process.env.HTTPS_PROXY || 'unset'))"], timeoutSeconds: 30 },
});

function egressContract(port: number, network: 'allowlist' | 'deny' = 'allowlist'): ContractInput {
  const commands = reachCommands(port);
  return fixtureContract({
    extraCommands: commands,
    extraChecks: Object.keys(commands).map((id) => ({ id, commandId: id, required: false })),
    mutate: (c) => {
      if (network === 'allowlist') c.spec.permissions = { network: { mode: 'allowlist', hosts: [`${ALLOWED}:${port}`] } };
    },
  });
}

async function prepare(contract: ContractInput, isolation: 'reduced' | 'required', env?: NodeJS.ProcessEnv): Promise<{ run: RunRecord; gateway: ToolGateway }> {
  fx = createHarnessFixture(tmp, contract, env ? { env } : {});
  const ingested = await fx.harness.ingest(fx.contractPath, { repoPath: fx.repo.path, isolation, questionMode: 'noninteractive' });
  fx.harness.approvePending(ingested.runId, 'alice');
  fx.harness.transition(ingested.runId, 'PREPARING', 'contract approved');
  const run = await fx.harness.prepare(ingested.runId);
  return { run, gateway: fx.harness.createGateway(run) };
}

async function check(gateway: ToolGateway, checkId: string): Promise<ResultOutcome> {
  return asResult(await gateway.execute({ id: `toolu_${checkId.replace(/\W/g, '_')}_${Math.random().toString(36).slice(2, 8)}`, name: 'run_check', input: { checkId } }));
}

function networkEvents(runId: string): Array<{ type: string; payload: Record<string, unknown> }> {
  return fx.harness.events.list(runId, { types: ['network.allowed', 'network.denied'] }).map((e) => ({ type: e.type, payload: e.payload }));
}

function lastCheckRunId(runId: string, checkId: string): string {
  return String(fx.harness.events.list(runId, { types: ['check.started'] }).filter((e) => e.payload.checkId === checkId).at(-1)!.payload.checkRunId);
}

// ---- AT-17 / AT-18 under reduced isolation (proxy behavior on every platform) ------------------

describe('AT-17/AT-18: per-check egress proxy (reduced isolation)', () => {
  it('AT-17: reaches an allowlisted host through the proxy and logs network.allowed', async () => {
    allowLoopbackUpstream();
    const { run, gateway } = await prepare(egressContract(upstream.port), 'reduced');
    const out = await check(gateway, 'reach-allowed');
    expect(out.isError).toBe(false);
    expect(out.content).toMatch(/^check reach-allowed: PASS/);
    expect(out.content).toContain('proxy: HTTP/1.1 200 Connection Established');
    expect(out.content).toContain('upstream: pong:ping');
    expect(upstream.received).toEqual(['ping']);
    expect(networkEvents(run.runId)).toEqual([{ type: 'network.allowed', payload: { checkRunId: lastCheckRunId(run.runId, 'reach-allowed'), checkId: 'reach-allowed', host: ALLOWED, port: upstream.port, method: 'CONNECT' } }]);
    expect(resolved).toEqual([ALLOWED]);
  });

  it('refuses an allowlisted name that resolves to loopback (DNS rebinding), logs the reason and sends no bytes', async () => {
    const { run, gateway } = await prepare(egressContract(upstream.port), 'reduced');
    const out = await check(gateway, 'reach-allowed');
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/^check reach-allowed: FAIL/);
    expect(out.content).toContain('proxy: HTTP/1.1 403 Forbidden');
    expect(out.content).not.toContain('pong');
    expect(upstream.connections).toBe(0);
    expect(resolved).toEqual([ALLOWED]);
    expect(networkEvents(run.runId)).toEqual([
      { type: 'network.denied', payload: { checkRunId: lastCheckRunId(run.runId, 'reach-allowed'), checkId: 'reach-allowed', host: ALLOWED, port: upstream.port, method: 'CONNECT', reason: 'host resolves to a non-public address' } },
    ]);
  });

  it.each([
    ['reach-denied', DENIED, () => upstream.port, 'host is not in the contract allowlist'],
    ['reach-ip', '127.0.0.1', () => upstream.port, 'IP literals are not allowed'],
    ['reach-wrong-port', ALLOWED, () => 443, 'host is not in the contract allowlist'],
  ])('AT-18: %s fails with 403, logs network.denied and sends no bytes', async (checkId, host, port, reason) => {
    const { run, gateway } = await prepare(egressContract(upstream.port), 'reduced');
    const out = await check(gateway, checkId);
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(new RegExp(`^check ${checkId}: FAIL`));
    expect(out.content).toContain('proxy: HTTP/1.1 403 Forbidden');
    expect(upstream.connections).toBe(0);
    expect(resolved).toEqual([]);
    expect(networkEvents(run.runId)).toEqual([{ type: 'network.denied', payload: { checkRunId: lastCheckRunId(run.runId, checkId), checkId, host, port: port(), method: 'CONNECT', reason } }]);
  });

  it('starts a fresh proxy per check and stops it when the check ends', async () => {
    const { gateway } = await prepare(egressContract(upstream.port), 'reduced');
    const first = /proxy=(http:\/\/127\.0\.0\.1:(\d+))/.exec((await check(gateway, 'print-proxy')).content);
    const second = /proxy=(http:\/\/127\.0\.0\.1:(\d+))/.exec((await check(gateway, 'print-proxy')).content);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    for (const port of [first![2], second![2]]) {
      await expect(
        new Promise((resolve, reject) => {
          const s = connect(Number(port), '127.0.0.1', () => {
            s.destroy();
            resolve('connected');
          });
          s.on('error', reject);
        }),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    }
  });

  it('starts no proxy and logs nothing when the contract keeps network denied', async () => {
    const { run, gateway } = await prepare(egressContract(upstream.port, 'deny'), 'reduced');
    expect((await check(gateway, 'print-proxy')).content).toContain('proxy=unset');
    const out = await check(gateway, 'reach-allowed');
    expect(out.content).toContain('no proxy configured');
    expect(networkEvents(run.runId)).toEqual([]);
    expect(upstream.connections).toBe(0);
  });

  it('never puts request or response bodies in network events', async () => {
    allowLoopbackUpstream();
    const { run, gateway } = await prepare(egressContract(upstream.port), 'reduced');
    await check(gateway, 'reach-allowed');
    await check(gateway, 'reach-denied');
    const serialized = JSON.stringify(networkEvents(run.runId));
    expect(serialized).not.toMatch(/ping|pong/);
  });
});

// ---- AT-17 / AT-18 under the macOS seatbelt ---------------------------------------------------

describe.skipIf(!seatbeltAvailable)('AT-17/AT-18: seatbelt allows only the proxy port (macOS)', () => {
  it('blocks a direct connection to a non-proxy local port even with egress allowlisted', async () => {
    const { run, gateway } = await prepare(egressContract(upstream.port), 'required');
    expect(fx.harness.isolationMode(run)).toBe('macos-seatbelt');
    const out = await check(gateway, 'direct');
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/error: (EPERM|EACCES)/);
    expect(out.content).not.toMatch(/^connected$/m);
    expect(upstream.connections).toBe(0);
  });

  it('reaches the proxy port: allowlisted host passes, others are denied by the proxy', async () => {
    allowLoopbackUpstream();
    const { run, gateway } = await prepare(egressContract(upstream.port), 'required');
    const allowed = await check(gateway, 'reach-allowed');
    expect(allowed.content).toMatch(/^check reach-allowed: PASS/);
    expect(allowed.content).toContain('upstream: pong:ping');
    const denied = await check(gateway, 'reach-denied');
    expect(denied.content).toContain('proxy: HTTP/1.1 403 Forbidden');
    expect(networkEvents(run.runId).map((e) => `${e.type}:${String(e.payload.host)}`)).toEqual([`network.allowed:${ALLOWED}`, `network.denied:${DENIED}`]);
    expect(upstream.connections).toBe(1);
  });

  it('blocks all IP egress when the contract denies network', async () => {
    const { gateway } = await prepare(egressContract(upstream.port, 'deny'), 'required');
    const out = await check(gateway, 'direct');
    expect(out.content).toMatch(/error: (EPERM|EACCES)/);
    expect(upstream.connections).toBe(0);
  });
});

// ---- AT-19 ------------------------------------------------------------------------------------

function hostedContract(): ContractInput {
  return fixtureContract({
    extraCommands: {
      hosted: { exec: 'node', args: ['-e', HOSTED_SCRIPT], timeoutSeconds: 30 },
      'env-probe': { exec: 'node', args: ['-e', PROBE_SCRIPT], timeoutSeconds: 30 },
    },
    extraChecks: [
      { id: 'hosted', commandId: 'hosted', required: false },
      { id: 'env-probe', commandId: 'env-probe', required: false },
    ],
    mutate: (c) => {
      c.spec.commands!.hosted!.env = {
        STUDIO_BASE_URL: { value: 'https://studio.example.test' },
        STUDIO_OWNER_TOKEN: { fromEnv: SECRET_ENV, secret: true },
        PUBLIC_ID: { fromEnv: 'APERTURE_TEST_PUBLIC_ID', secret: false },
      };
    },
  });
}

const SECRET_SHA = createHash('sha256').update(SECRET).digest('hex').slice(0, 16);
const HARNESS_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, [SECRET_ENV]: SECRET, APERTURE_TEST_PUBLIC_ID: 'public-id-1234' });

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((rel) => join(dir, rel))
    .filter((p) => statSync(p).isFile());
}

describe('AT-19: hosted-check secrets', () => {
  it('injects the secret only into its command and redacts it from logs, events, tool results and prompts', async () => {
    fx = createHarnessFixture(tmp, hostedContract(), { env: HARNESS_ENV() });
    const ingested = await fx.harness.ingest(fx.contractPath, { repoPath: fx.repo.path, isolation: 'reduced', questionMode: 'noninteractive' });
    const { provider, executor } = scriptedModel([
      {
        toolCalls: [
          { id: 'toolu_hosted', name: 'run_check', input: { checkId: 'hosted' } },
          { id: 'toolu_probe', name: 'run_check', input: { checkId: 'env-probe' } },
        ],
      },
      patchTurn('src/api/session.ts', SESSION_METADATA_PATCH, ['R1', 'R2'], 'toolu_meta'),
      DONE,
    ]);
    const final = await new Orchestrator(fx.harness).drive(ingested.runId, { executor, interaction: new NonInteractive('alice', { approveContracts: true }) });
    expect(final.state).toBe('READY_FOR_REVIEW');
    const runId = final.runId;

    // The value reached the command (digest matches) while the printed value is redacted.
    const [hosted, probe] = lastToolResults(provider.requests[1]!);
    expect(hosted!.tool_use_id).toBe('toolu_hosted');
    expect(hosted!.content).toMatch(/^check hosted: PASS/);
    expect(hosted!.content).toContain('token-set=true');
    expect(hosted!.content).toContain(`token-sha=${SECRET_SHA}`);
    expect(hosted!.content).toContain('token=[REDACTED]');
    expect(hosted!.content).toContain('stderr token [REDACTED]');
    expect(hosted!.content).toContain('base=https://studio.example.test');
    // secret: false values are injected verbatim.
    expect(hosted!.content).toContain('public=public-id-1234');
    // Another command of the same run does not receive it.
    expect(probe!.content).toContain('probe token-set=false base=unset');

    // Never in any prompt sent to the model.
    expect(JSON.stringify(provider.requests)).not.toContain(SECRET);

    // Check log artifacts and check.completed events are redacted.
    const hostedLogs = filesUnder(join(fx.harness.layout.runDir(runId), 'checks')).filter((p) => p.includes('hosted-'));
    expect(hostedLogs.length).toBeGreaterThanOrEqual(1);
    for (const log of hostedLogs) {
      const text = readFileSync(log, 'utf8');
      expect(text).toContain('token=[REDACTED]');
      expect(text).not.toContain(SECRET);
    }
    const completed = fx.harness.events.list(runId, { types: ['check.completed'] }).filter((e) => e.payload.checkId === 'hosted');
    expect(completed.length).toBeGreaterThanOrEqual(1);
    for (const e of completed) expect(String(e.payload.outputTail)).toContain('token=[REDACTED]');
    expect(fx.harness.store.getToolOp('toolu_hosted')!.resultJson).toContain('token=[REDACTED]');

    // The contract names the variable but never holds its value.
    const contractRecord = fx.harness.store.getContract(final.contractId!)!;
    expect(contractRecord.canonicalJson).toContain(SECRET_ENV);
    expect(contractRecord.canonicalJson).not.toContain(SECRET);
    expect(readFileSync(join(fx.harness.layout.runDir(runId), 'contract.v1.json'), 'utf8')).toContain(`"fromEnv": "${SECRET_ENV}"`);
    const proposed = fx.harness.events.list(runId, { types: ['contract.proposed'] })[0]!.payload.findings as Array<{ code: string; message: string }>;
    expect(proposed).toContainEqual(expect.objectContaining({ code: 'SECRET_ENV', message: expect.stringContaining(SECRET_ENV) }));

    // Nothing persisted anywhere under the storage dir (db, WAL, events.jsonl, artifacts) holds it.
    for (const file of filesUnder(fx.storageDir)) {
      expect({ file, leaked: readFileSync(file).includes(SECRET) }).toEqual({ file, leaked: false });
    }
  });

  it.each([
    ['unset', (env: NodeJS.ProcessEnv) => delete env[SECRET_ENV]],
    ['empty', (env: NodeJS.ProcessEnv) => (env[SECRET_ENV] = '')],
  ])('reports ERROR without running the command when the fromEnv variable is %s', async (_label, edit) => {
    const env = HARNESS_ENV();
    edit(env);
    const { run, gateway } = await prepare(hostedContract(), 'reduced', env);
    const out = await check(gateway, 'hosted');
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/^check hosted: ERROR \(exit 127/);
    expect(out.content).toContain(`unusable environment variable(s) for this check: ${SECRET_ENV}`);
    expect(out.content).not.toMatch(/^token-set=/m);
    const completed = fx.harness.events.list(run.runId, { types: ['check.completed'] }).at(-1)!;
    expect(completed.payload).toMatchObject({ checkId: 'hosted', status: 'ERROR', exitCode: 127 });
  });

  it.each([
    ['1 character', 'x'],
    ['7 characters', 'tok1234'],
  ])('refuses a secret of %s (cannot be redacted safely) without running the command', async (_label, short) => {
    const { run, gateway } = await prepare(hostedContract(), 'reduced', { ...HARNESS_ENV(), [SECRET_ENV]: short });
    const out = await check(gateway, 'hosted');
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/^check hosted: ERROR \(exit 127/);
    expect(out.content).toContain(`${SECRET_ENV} (secret shorter than 8 characters cannot be redacted safely)`);
    expect(out.content).not.toMatch(/^(token-set|token|public|base)=/m);
    if (short.length > 1) expect(out.content).not.toContain(short);
    const completed = fx.harness.events.list(run.runId, { types: ['check.completed'] }).at(-1)!;
    expect(completed.payload).toMatchObject({ checkId: 'hosted', status: 'ERROR', exitCode: 127 });
    expect(fx.harness.store.checksForRun(run.runId)).toEqual([expect.objectContaining({ checkId: 'hosted', status: 'ERROR', exitCode: 127 })]);
  });

  it('accepts and redacts a secret of exactly 8 characters', async () => {
    const eight = 'tok12345';
    const { gateway } = await prepare(hostedContract(), 'reduced', { ...HARNESS_ENV(), [SECRET_ENV]: eight });
    const out = await check(gateway, 'hosted');
    expect(out.content).toMatch(/^check hosted: PASS/);
    expect(out.content).toContain('token-set=true');
    expect(out.content).toContain('token=[REDACTED]');
    expect(out.content).not.toContain(eight);
  });

  it('injects a short value that is not marked secret', async () => {
    const { gateway } = await prepare(hostedContract(), 'reduced', { ...HARNESS_ENV(), APERTURE_TEST_PUBLIC_ID: 'p1' });
    const out = await check(gateway, 'hosted');
    expect(out.content).toMatch(/^check hosted: PASS/);
    expect(out.content).toContain('public=p1');
  });
});
