-- Agent Core — migration 0011 — append-only audit log + query/prune RPCs.

create table if not exists agent_core.audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references agent_core.tenants(id) on delete cascade,
  event text not null,
  severity text not null check (severity in ('debug','info','warn','error','critical')),
  subject text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_log_tenant_created_at
  on agent_core.audit_log (tenant_id, created_at desc);

create index if not exists idx_audit_log_system_event_created_at
  on agent_core.audit_log (event, created_at desc)
  where tenant_id is null;

alter table agent_core.audit_log enable row level security;

drop policy if exists tenant_isolation on agent_core.audit_log;
create policy tenant_isolation on agent_core.audit_log
  for all
  using (tenant_id = agent_core.current_tenant() or tenant_id is null)
  with check (tenant_id = agent_core.current_tenant() or tenant_id is null);

revoke update, delete on agent_core.audit_log from public, anon, authenticated, service_role;

create or replace function agent_core.record_audit_event(
  p_tenant uuid,
  p_event text,
  p_severity text,
  p_subject text,
  p_meta jsonb
) returns uuid
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_id uuid;
begin
  insert into agent_core.audit_log (tenant_id, event, severity, subject, meta)
  values (
    p_tenant,
    p_event,
    p_severity,
    p_subject,
    coalesce(p_meta, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function agent_core.record_audit_event(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function agent_core.record_audit_event(uuid, text, text, text, jsonb)
  to service_role;

create or replace function agent_core.query_audit_log(
  p_tenant uuid,
  p_severity text default null,
  p_event text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit int default 100
) returns setof agent_core.audit_log
  language sql
  security definer
  set search_path = agent_core
as $$
  select a.*
    from agent_core.audit_log a
   where (
      (p_tenant is null and a.tenant_id is null)
      or (p_tenant is not null and a.tenant_id = p_tenant)
   )
     and (p_severity is null or a.severity = p_severity)
     and (p_event is null or a.event = p_event)
     and (p_from is null or a.created_at >= p_from)
     and (p_to is null or a.created_at <= p_to)
   order by a.created_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 1000));
$$;

revoke execute on function agent_core.query_audit_log(uuid, text, text, timestamptz, timestamptz, int)
  from public, anon, authenticated;
grant execute on function agent_core.query_audit_log(uuid, text, text, timestamptz, timestamptz, int)
  to service_role;

create or replace function agent_core.prune_audit_log(p_days int default 365)
returns int
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_deleted int := 0;
begin
  delete from agent_core.audit_log
   where created_at < now() - make_interval(days => greatest(0, coalesce(p_days, 365)));

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function agent_core.prune_audit_log(int)
  from public, anon, authenticated;
grant execute on function agent_core.prune_audit_log(int)
  to service_role;

select cron.unschedule(j.jobid)
  from cron.job j
 where j.jobname = 'agent_core_prune_audit_log';

select cron.schedule(
  'agent_core_prune_audit_log',
  '0 4 * * 0',
  $$select agent_core.prune_audit_log();$$
);
