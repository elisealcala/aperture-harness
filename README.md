# Aperture Harness

Budget-controlled, contract-driven coding execution for small, atomic tasks. The **task contract** owns
scope, acceptance criteria, budget and completion; the model (`claude-sonnet-5-5`) is a replaceable
worker whose every action passes through a deterministic policy gateway. PR text is drafted by
`claude-haiku-5-5` from verified evidence and published only after explicit approval.

- Design: [`docs/system-design.md`](docs/system-design.md)
- Implementation plan: [`docs/PLAN.md`](docs/PLAN.md)

## Quick start

```bash
pnpm install
pnpm aperture init                       # writes ~/.config/aperture/config.yaml
export ANTHROPIC_API_KEY=...             # or an `ant auth login` profile

# Local contract (preapproved with --no-interactive), GitHub issue, or Linear issue
pnpm aperture run ./tasks/ENG-123.yaml --repo ~/code/app --no-interactive
pnpm aperture run github:org/repo#142 --budget 0.50 --tui
pnpm aperture run linear:ENG-123 --cache 5m

pnpm aperture status <run-id>            # or `status` to list runs
pnpm aperture attach <run-id>            # live TUI: overview, activity, diff, checks, costs, questions
pnpm aperture logs <run-id> --format jsonl --follow
pnpm aperture answer <run-id> <question-id> "Reject with 400"   # or --choice 1 / --approve / --deny
pnpm aperture resume <run-id>
pnpm aperture review <run-id> --approve  # or --accept-local; --acknowledge-unverified when needed
pnpm aperture pr draft <run-id>
pnpm aperture pr create <run-id>         # asks for explicit approval (or --yes)
pnpm aperture usage <run-id>
```

Exit codes: `0` ready/completed, `1` error, `2` blocked/failed/canceled, `3` waiting for a decision.

## How a run works

1. **Ingest** a source (`github:`, `linear:`, or a contract YAML). Ticket text is untrusted data; it is
   snapshotted and pinned (`runs/<id>/source.snapshot.json`).
2. **Contract** — local YAML is the contract; tickets are compiled deterministically (acceptance
   criteria, existing paths named in the ticket, default deny list, configured checks). Missing details
   become `__EDIT_ME__` placeholders that block approval. Approval stores an immutable SHA-256-addressed
   revision.
3. **Prepare** a disposable `git worktree` on `aperture/<run>` at the pinned baseline, inside an OS
   sandbox (macOS `sandbox-exec`, Linux `bwrap`; otherwise fail closed unless `--reduced-security`).
4. **Execute** — Sonnet works through seven typed tools (`read_file`, `search_code`, `propose_patch`,
   `run_check`, `ask_user`, `request_scope_change`, `report_blocked`). The gateway enforces readable /
   writable / denied globs, refuses traversal and symlink writes, applies single-file patches with git,
   and maps check ids to fixed commands. Every request passes a budget gate first.
5. **Verify** independently: checks, scope (unauthorized/untracked/binary/mode/dependency changes) and a
   requirement → evidence matrix. Failures feed back for a bounded number of fix rounds; identical
   failures stop as stalled.
6. **Review** the exact diff, then optionally **draft** (Haiku, separate budget, validated against the
   evidence) and **publish** a draft PR after explicit approval.

Everything is persisted in SQLite (state of record) with a JSONL event projection, so a run can be
interrupted at any point and resumed without replaying a patch, push or PR POST.

## Configuration (`~/.config/aperture/config.yaml`)

See `aperture init` for the full template. Notable keys:

```yaml
commands:                 # trusted check commands, referenced by contract checks via commandId
  typecheck: { exec: pnpm, args: [exec, tsc, --noEmit], timeoutSeconds: 300 }
repositories:             # local clones for GitHub repositories
  org/repo: { path: ~/code/repo, baseBranch: main }
linear:
  teamRepositories: { ENG: org/repo }
models:
  registry: {}            # pricing overrides (USD / MTok); unknown models are refused
```

Secrets are read from environment variables only (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN` or `gh auth
token`, `LINEAR_API_KEY`); inline secrets in YAML are rejected, and secret values are redacted from logs.

## Development

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Requires Node.js ≥ 22.12 (built-in `node:sqlite`) and git. The CLI runs TypeScript sources via `tsx`.

## MVP notes and deviations

- Prices in `packages/models/src/models.default.json` come from the spec (§8) and are configuration
  data — refresh them before relying on budgets.
- State machine: the spec's edges plus cancel/fail before execution and abandoning a PR draft/approval.
  Unanswered questions in `--no-interactive` mode end the run `BLOCKED` (AT-16); rerun with `--answers`.
- The sandbox hides credential directories and the aperture store from check commands and confines
  writes to the worktree; it does not hide the whole home directory from reads.
- Refusal fallbacks to another model are intentionally not enabled: model ids must stay auditable.
