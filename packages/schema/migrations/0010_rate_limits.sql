-- Agent Core — migration 0010 — tenant-scoped rate limit counters + sweeper cron.

create table if not exists agent_core.rate_limit_counters (
  tenant_id uuid not null references agent_core.tenants(id) on delete cascade,
  subject text not null,
  window_start timestamptz not null,
  window_secs int not null check (window_secs > 0),
  count int not null default 1,
  primary key (tenant_id, subject, window_start, window_secs)
);

create index if not exists idx_rate_limit_counters_window
  on agent_core.rate_limit_counters (window_start);

alter table agent_core.rate_limit_counters enable row level security;

drop policy if exists tenant_isolation on agent_core.rate_limit_counters;
create policy tenant_isolation on agent_core.rate_limit_counters
  for all
  using (tenant_id = agent_core.current_tenant())
  with check (tenant_id = agent_core.current_tenant());

create or replace function agent_core.check_rate_limit(
  p_tenant uuid,
  p_subject text,
  p_window_secs int,
  p_limit int
) returns boolean
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_window_start timestamptz;
  v_count int;
begin
  if p_tenant is null then
    raise exception 'check_rate_limit: tenant required';
  end if;
  if p_subject is null or length(p_subject) = 0 then
    raise exception 'check_rate_limit: subject required';
  end if;
  if p_window_secs is null or p_window_secs <= 0 then
    raise exception 'check_rate_limit: window_secs must be > 0';
  end if;
  if p_limit is null or p_limit <= 0 then
    raise exception 'check_rate_limit: limit must be > 0';
  end if;

  v_window_start := date_trunc('second', now())
    - ((extract(epoch from now())::int % p_window_secs) * interval '1 second');

  insert into agent_core.rate_limit_counters (tenant_id, subject, window_start, window_secs, count)
  values (p_tenant, p_subject, v_window_start, p_window_secs, 1)
  on conflict (tenant_id, subject, window_start, window_secs)
  do update set count = agent_core.rate_limit_counters.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke execute on function agent_core.check_rate_limit(uuid, text, int, int)
  from public, anon, authenticated;
grant execute on function agent_core.check_rate_limit(uuid, text, int, int)
  to service_role;

create or replace function agent_core.sweep_rate_limit_counters()
returns int
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_deleted int := 0;
begin
  delete from agent_core.rate_limit_counters
   where window_start + (window_secs * interval '1 second') < now();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function agent_core.sweep_rate_limit_counters()
  from public, anon, authenticated;
grant execute on function agent_core.sweep_rate_limit_counters()
  to service_role;

select cron.unschedule(j.jobid)
  from cron.job j
 where j.jobname = 'agent_core_sweep_rate_limit_counters';

select cron.schedule(
  'agent_core_sweep_rate_limit_counters',
  '*/5 * * * *',
  $$select agent_core.sweep_rate_limit_counters();$$
);
