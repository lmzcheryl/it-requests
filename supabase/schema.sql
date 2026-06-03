-- Run this once in your Supabase SQL editor

CREATE TABLE requests (
  id           BIGSERIAL PRIMARY KEY,
  requestor    TEXT        NOT NULL,
  request_text TEXT        NOT NULL,
  priority     TEXT,
  complexity   TEXT,
  status       TEXT        NOT NULL DEFAULT 'New',
  remarks      TEXT,
  requested_date DATE      NOT NULL DEFAULT CURRENT_DATE,
  completed_date TIMESTAMPTZ,
  chat_id      BIGINT      NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE bot_state (
  chat_id     BIGINT PRIMARY KEY,
  state_json  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
