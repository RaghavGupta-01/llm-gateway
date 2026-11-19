CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  budget_micro  BIGINT NOT NULL CHECK (budget_micro >= 0),
  spent_micro   BIGINT NOT NULL DEFAULT 0 CHECK (spent_micro >= 0),
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id          BIGSERIAL PRIMARY KEY,
  key_id      UUID NOT NULL REFERENCES api_keys(id),
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  tokens_in   INT NOT NULL DEFAULT 0,
  tokens_out  INT NOT NULL DEFAULT 0,
  cost_micro  BIGINT NOT NULL DEFAULT 0,
  status      TEXT NOT NULL,   -- 'ok' | 'fallback_ok' | 'failed'
  latency_ms  INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_logs_key_time ON usage_logs (key_id, created_at DESC);

