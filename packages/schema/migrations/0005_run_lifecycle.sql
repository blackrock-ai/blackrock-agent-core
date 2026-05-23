-- Agent Core — migration 0005 — agent_runs lifecycle columns.
-- The base agent_runs table from migration 0001 captures token counts and a
-- `status` text field but lacks the lifecycle metadata needed to answer
-- operational questions cheaply: "when did the run finish?", "did it error
-- out, and why?", "which model variant was actually used?".
--
-- This migration is additive only: new columns are nullable so existing rows
-- remain valid, and the existing `status` text field keeps the same
-- semantics. The handler/persistence layer can backfill these columns as
-- it wires through the orchestrator pipeline.

alter table agent_runs
  add column if not exists model         text,
  add column if not exists updated_at    timestamptz not null default now(),
  add column if not exists completed_at  timestamptz,
  add column if not exists error         text;

-- Keep updated_at honest on every row change. The runtime always writes
-- through the service-role connection so a trigger here is fine; RLS still
-- gates row visibility for non-service callers.
create or replace function agent_runs_touch_updated_at() returns trigger
  language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists agent_runs_touch_updated_at on agent_runs;
create trigger agent_runs_touch_updated_at
  before update on agent_runs
  for each row execute function agent_runs_touch_updated_at();

-- Index for the common observability query "all my recent runs" — already
-- exists from 0001 on (tenant_id, created_at desc). Add one on completed_at
-- so we can cheaply page through "all runs that finished in window".
create index if not exists idx_agent_runs_tenant_completed
  on agent_runs(tenant_id, completed_at desc) where completed_at is not null;

-- [PART 1 COMPLETE]
