# Aperture Harness — MVP implementation plan

Source of truth: [`docs/system-design.md`](./system-design.md) (spec v0.1). This plan maps the spec's
Phase 1–4 (§17) onto commits. Phase 5 (evaluation set) is outside the MVP.

## Cross-cutting decisions

| Topic | Decision | Spec ref |
|---|---|---|
| Layout | pnpm workspace; `apps/cli` + `packages/*`, each package exports TypeScript source directly (`exports: ./src/index.ts`), run with `tsx`, no build step | §5 |
| Typecheck / lint / test | one root `tsconfig.json` (strict, `noEmit`), ESLint flat config + typescript-eslint, Vitest | — |
| State of record | SQLite through Node's built-in `node:sqlite` (no native addon). WAL mode, transactions around transitions. JSONL `events.jsonl` is a rebuildable projection | §11, ADR-006 |
| Isolation | macOS: `sandbox-exec` profile (writes limited to worktree + run tmp, no IP network, sensitive home dirs unreadable, minimal env). Linux: `bwrap` when present. Otherwise fail closed unless the user opts into `--reduced-security` | §9, ADR-005 |
| Command policy | `run_check` maps a contract `commandId` to a fixed `{exec, args[]}` from the approved contract (`spec.commands`) or the trusted user config (`commands:`); the model never supplies a command string | §9 |
| Patch application | `git apply --check` then `git apply` in the worktree, after every diff header path is validated by the path policy; binary, rename, mode-change, and symlink hunks are rejected. Each patch is an operation row (`started` → `applied`); on resume a `started` row is reconciled with `git apply --reverse --check`, never blindly replayed | §6, §7, AT-07 |
| Model loop | Manual streaming loop over `@anthropic-ai/sdk` (`messages.stream` + `finalMessage`), behind a `ModelProvider` interface so tests use a scripted provider. Full assistant content (incl. thinking blocks) is persisted and replayed append-only | §8 |
| Prompt caching | explicit `cache_control` breakpoint on the stable system/contract/context prefix + top-level automatic caching for the growing message history; ttl from config (`5m` default) | §8 |
| Budget | pricing table is config data; ledger charges actual `usage`; preflight estimate = conservative input tokens × input price + `max_tokens` × output price; requests that do not fit the remaining stage budget minus reserve are refused | §8, AT-10 |
| Contract drafting | deterministic compiler (acceptance-criteria/checkbox extraction, backticked repo paths) → proposed contract → user approval (or `$EDITOR` edit). Vague tickets stay in `NEEDS_CONTRACT_REVIEW` | §6, AT-05 |
| Commit policy | worktree changes stay uncommitted until PR publish approval; the publisher commits, pushes, and opens a draft PR | §19.7 |
| GitHub / Linear | thin `fetch` clients with injectable transport; GitHub token from `GITHUB_TOKEN` or `gh auth token` (publisher process only); Linear from `LINEAR_API_KEY` | §13, §19 |

## Stage 1 — Contract and sandbox (first vertical slice)

1. **Scaffold** — workspace, tooling, package skeletons, this plan, sample fixtures.
2. **contracts** — Zod schema for `ExecutionContract`, YAML/JSON loading, canonical JSON + SHA-256, immutable approval record, user config schema (rejects unknown privileged keys).
3. **storage + events** — SQLite migrations for all §11 tables (+ conversation/tool-operation tables needed for recovery), event store with monotonic sequence, JSONL projection, secret redaction.
4. **sources (yaml)** — normalized task model + local YAML contract source.
5. **sandbox** — git worktree manager (baseline SHA, file hashes snapshot) and sandboxed process runner (sandbox-exec / bwrap / reduced mode).
6. **gateway** — typed tool protocol (7 tools), path policy (normalization, traversal, symlink escape, case-folding, denied-wins), `read_file`, `search_code`, `propose_patch`, `run_check`.
7. **core + CLI** — state machine with the §7 transition table, run creation/approval, a basic text event stream; `aperture init|run|status|logs|diff`.
8. **Tests + verification** — unit tests and the adversarial exit test: an attempt to patch `package.json` is denied and logged while a permitted patch and check succeed.

## Stage 2 — Sonnet execution and recovery

1. **models** — model registry + pricing config, cost ledger, preflight estimator, Anthropic streaming adapter (`claude-sonnet-5-5`) with cache instrumentation, scripted provider for tests.
2. **context** — stable prefix (system rules, tool definitions, contract summary, bounded code snapshot) + dynamic messages.
3. **orchestrator tool loop** — bounded turns/patch attempts/wall clock/budget, tool dispatch through the gateway, persisted conversation, `budget.warning|exhausted`.
4. **questions and scope changes** — `ask_user` / `request_scope_change` persistence, `WAITING_FOR_USER`, interactive answers, contract revision on approved scope change, non-interactive → `BLOCKED` + nonzero exit.
5. **verifier** — scope/diff checks, required checks, requirement evidence matrix, failure-signature stall detection, bounded fix loop, `verification.json`, `report.md`.
6. **recovery** — `resume`, `cancel`, `answer`, `usage`, `review` commands; reconcile `started` patch operations.
7. **Tests + verification** — resume without duplicate patch, budget/iteration stop, verification gating (AT-06..AT-11, AT-16).

## Stage 3 — Ticket integrations and richer TUI

1. **GitHub issue source** — `github:owner/repo#N`, snapshot pinning (`updated_at` + content hash), drift detection.
2. **Linear source** — `linear:ENG-123` via GraphQL, optional repository mapping.
3. **contract compiler + interactive approval** — shared for all sources; `NEEDS_CONTRACT_REVIEW` for vague tickets; edit via `$EDITOR`.
4. **Ink TUI** — overview, activity (filters, `--show-model-text`), diff, checks, costs, questions panels; `attach` tails SQLite.
5. **Tests + verification** — same normalized workflow for GitHub, Linear and YAML (AT-01, AT-02, AT-05, AT-15).

## Stage 4 — Haiku PR publishing

1. **PR draft** — evidence packet, `claude-haiku-5-5` structured draft, validation/redaction, independent PR budget, deterministic fallback template.
2. **PR publish** — review-pinned diff hash, explicit approval, commit + push with a publisher-scoped credential helper, existing-PR lookup by head branch before create, draft PR by default, `pr-publication.json`.
3. **Tests + verification** — AT-12, AT-13, AT-14.

## Stage 5 — Amendment A1: egress, dependencies, workspaces (proposed)

Design: [`system-design.md` §21](./system-design.md). Status: awaiting go-ahead on the workspace default.

1. **Egress policy schema** — `permissions.network: deny | { mode: allowlist, hosts, phases }`, command `env` with `value` / `fromEnv` + `secret`; static analysis rejects bare `*`, IP literals and http-only secrets.
2. **Egress proxy** — per-run HTTP/CONNECT proxy with host allowlist, `network.allowed|denied` events, seatbelt profile allowing only the proxy port; Linux fails closed unless a supported bridge exists.
3. **Hosted-check secrets** — resolve `fromEnv` at execution, inject per command, add to redaction literals.
4. **Dependency provisioning** — `link` (read-only links from the source clone) and `install` (setup command with registry-only egress, scripts off) in PREPARING.
5. **Ticket workspaces** — workspace + branch keyed by ticket and reused across runs; `aperture cleanup`; optional `workspace: in-place` with clean-tree guard, lock and branch restore.
6. **Compiler adjustments** — new expected files writable, read-only mentions readable, hosted-verification note.
7. **Tests + verification** — AT-17…AT-22 and a re-run of the #108 dry run.

## Definition of done for the MVP

All Stage 1–4 commits land, `pnpm typecheck && pnpm lint && pnpm test` passes, and the §18 acceptance tests
AT-01…AT-16 each have an automated test (network/API calls faked at the transport boundary).
