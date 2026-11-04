# Aperture Harness

Budget-controlled, contract-driven coding execution for small, atomic tasks. The task contract owns
scope, acceptance criteria, budget and completion; the model is a replaceable worker whose every
action passes through a deterministic policy gateway.

- Design: [`docs/system-design.md`](docs/system-design.md)
- Implementation plan: [`docs/PLAN.md`](docs/PLAN.md)

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm aperture --help
```

Requires Node.js ≥ 22.12 (uses the built-in `node:sqlite`) and git.
