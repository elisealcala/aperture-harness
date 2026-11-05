/**
 * Ordered schema migrations. Never edit an applied migration; append a new one.
 * Tables follow §11 of the design, plus the recovery tables the orchestrator needs
 * (`conversation`, `tool_operations`, `questions`).
 */
export const MIGRATIONS: readonly string[] = [
  /* 1 */ `
  CREATE TABLE tasks (
    task_id         TEXT PRIMARY KEY,
    source_type     TEXT NOT NULL,
    source_ref      TEXT NOT NULL,
    repository      TEXT,
    title           TEXT NOT NULL,
    snapshot_json   TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE contracts (
    contract_id     TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL REFERENCES tasks(task_id),
    version         INTEGER NOT NULL,
    canonical_json  TEXT NOT NULL,
    sha256          TEXT NOT NULL,
    schema_version  INTEGER NOT NULL,
    source_revision TEXT,
    status          TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'superseded')),
    approved_by     TEXT,
    approved_at     TEXT,
    created_at      TEXT NOT NULL,
    UNIQUE (task_id, version)
  );

  CREATE TABLE runs (
    run_id                 TEXT PRIMARY KEY,
    task_id                TEXT NOT NULL REFERENCES tasks(task_id),
    contract_id            TEXT REFERENCES contracts(contract_id),
    state                  TEXT NOT NULL,
    model_id               TEXT NOT NULL,
    repo_path              TEXT NOT NULL,
    worktree_path          TEXT,
    branch                 TEXT,
    baseline_ref           TEXT NOT NULL,
    baseline_sha           TEXT,
    isolation              TEXT NOT NULL,
    question_mode          TEXT NOT NULL,
    turns                  INTEGER NOT NULL DEFAULT 0,
    patch_attempts         INTEGER NOT NULL DEFAULT 0,
    verification_attempts  INTEGER NOT NULL DEFAULT 0,
    last_failure_signature TEXT,
    review_diff_sha256     TEXT,
    review_approved_at     TEXT,
    terminal_reason        TEXT,
    started_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    executing_since        TEXT,
    executing_ms           INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE events (
    run_id       TEXT NOT NULL REFERENCES runs(run_id),
    sequence     INTEGER NOT NULL,
    event_id     TEXT NOT NULL UNIQUE,
    type         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    timestamp    TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
  );

  CREATE TABLE questions (
    question_id  TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(run_id),
    tool_call_id TEXT,
    kind         TEXT NOT NULL CHECK (kind IN ('question', 'scope_change')),
    payload_json TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('open', 'answered', 'canceled')),
    created_at   TEXT NOT NULL,
    answered_at  TEXT
  );

  CREATE TABLE decisions (
    decision_id      TEXT PRIMARY KEY,
    run_id           TEXT NOT NULL REFERENCES runs(run_id),
    question_id      TEXT,
    kind             TEXT NOT NULL,
    answer_json      TEXT NOT NULL,
    actor            TEXT NOT NULL,
    contract_version INTEGER NOT NULL,
    created_at       TEXT NOT NULL
  );

  CREATE TABLE model_usage (
    request_id   TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES runs(run_id),
    phase        TEXT NOT NULL CHECK (phase IN ('implementation', 'pr_draft', 'contract_draft')),
    model_id     TEXT NOT NULL,
    input        INTEGER NOT NULL,
    output       INTEGER NOT NULL,
    cache_write  INTEGER NOT NULL,
    cache_read   INTEGER NOT NULL,
    cost_usd     REAL NOT NULL,
    estimated_usd REAL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE checks (
    check_run_id  TEXT PRIMARY KEY,
    check_id      TEXT NOT NULL,
    run_id        TEXT NOT NULL REFERENCES runs(run_id),
    attempt       INTEGER NOT NULL,
    status        TEXT NOT NULL,
    exit_code     INTEGER,
    artifact_path TEXT,
    output_sha256 TEXT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT
  );

  CREATE TABLE artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(run_id),
    type        TEXT NOT NULL,
    path        TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE pr_publications (
    run_id       TEXT PRIMARY KEY REFERENCES runs(run_id),
    operation_id TEXT NOT NULL,
    repository   TEXT NOT NULL,
    branch       TEXT NOT NULL,
    base_branch  TEXT NOT NULL,
    head_sha     TEXT,
    status       TEXT NOT NULL CHECK (status IN ('approved', 'pushed', 'created', 'failed')),
    pr_number    INTEGER,
    pr_url       TEXT,
    approved_at  TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE conversation (
    run_id       TEXT NOT NULL REFERENCES runs(run_id),
    seq          INTEGER NOT NULL,
    role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content_json TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );

  CREATE TABLE tool_operations (
    op_id         TEXT PRIMARY KEY,
    run_id        TEXT NOT NULL REFERENCES runs(run_id),
    tool          TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('started', 'applied', 'completed', 'rejected', 'failed')),
    input_json    TEXT NOT NULL,
    input_sha256  TEXT NOT NULL,
    result_json   TEXT,
    result_sha256 TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );

  CREATE INDEX idx_runs_task ON runs(task_id);
  CREATE INDEX idx_usage_run ON model_usage(run_id, phase);
  CREATE INDEX idx_checks_run ON checks(run_id, attempt);
  CREATE INDEX idx_questions_run ON questions(run_id, status);
  CREATE INDEX idx_toolops_run ON tool_operations(run_id, status);
  `,
  /* 2 */ `
  ALTER TABLE runs ADD COLUMN workspace TEXT NOT NULL DEFAULT 'worktree';
  CREATE INDEX idx_runs_repo ON runs(repo_path, workspace, state);
  `,
];
