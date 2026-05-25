-- Agent Core — migration 0013 — tenant quotas + quota check RPC.

create table if not exists agent_core.tenant_quotas (
  tenant_id uuid primary key references agent_core.tenants(id) on delete cascade,
  max_runs_per_day int,
  max_tokens_per_day bigint,
  max_cost_per_day_usd numeric(10,4),
  paused boolean not null default false,
  notes text,
  updated_at timestamptz not null default now()
);

alter table agent_core.tenant_quotas enable row level security;

drop policy if exists tenant_isolation on agent_core.tenant_quotas;
create policy tenant_isolation on agent_core.tenant_quotas
  for all
  using (tenant_id = agent_core.current_tenant())
  with check (tenant_id = agent_core.current_tenant());

create or replace function agent_core.set_updated_at()
returns trigger
  language plpgsql
  set search_path = agent_core
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_tenant_quotas_updated_at on agent_core.tenant_quotas;
create trigger trg_tenant_quotas_updated_at
before update on agent_core.tenant_quotas
for each row execute function agent_core.set_updated_at();

create or replace function agent_core.check_quota(p_tenant uuid)
returns jsonb
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_start_utc timestamptz;
  v_runs_today int := 0;
  v_tokens_today bigint := 0;
  v_cost_today numeric(14,6) := 0;
  v_q agent_core.tenant_quotas%rowtype;
  v_ok boolean := true;
  v_limited_by text := null;
begin
  if p_tenant is null then
    raise exception 'check_quota: tenant required';
  end if;

  v_start_utc := date_trunc('day', now() at time zone 'utc') at time zone 'utc';

  select
    count(*)::int,
    coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::bigint,
    coalesce(sum(coalesce(cost_estimate, 0)), 0)::numeric(14,6)
  into v_runs_today, v_tokens_today, v_cost_today
  from agent_core.agent_runs
  where tenant_id = p_tenant
    and created_at >= v_start_utc;

  select * into v_q
    from agent_core.tenant_quotas
   where tenant_id = p_tenant;

  if not found then
    return jsonb_build_object(
      'paused', false,
      'runs_today', v_runs_today,
      'max_runs_per_day', null,
      'tokens_today', v_tokens_today,
      'max_tokens_per_day', null,
      'cost_today_usd', v_cost_today,
      'max_cost_per_day_usd', null,
      'ok', true,
      'limited_by', null
    );
  end if;

  if v_q.paused then
    v_ok := false;
    v_limited_by := 'paused';
  elsif v_q.max_runs_per_day is not null and v_runs_today > v_q.max_runs_per_day then
    v_ok := false;
    v_limited_by := 'runs';
  elsif v_q.max_tokens_per_day is not null and v_tokens_today > v_q.max_tokens_per_day then
    v_ok := false;
    v_limited_by := 'tokens';
  elsif v_q.max_cost_per_day_usd is not null and v_cost_today > v_q.max_cost_per_day_usd then
    v_ok := false;
    v_limited_by := 'cost';
  end if;

  return jsonb_build_object(
    'paused', v_q.paused,
    'runs_today', v_runs_today,
    'max_runs_per_day', v_q.max_runs_per_day,
    'tokens_today', v_tokens_today,
    'max_tokens_per_day', v_q.max_tokens_per_day,
    'cost_today_usd', v_cost_today,
    'max_cost_per_day_usd', v_q.max_cost_per_day_usd,
    'ok', v_ok,
    'limited_by', v_limited_by
  );
end;
$$;

revoke execute on function agent_core.check_quota(uuid)
  from public, anon, authenticated;
grant execute on function agent_core.check_quota(uuid)
  to service_role;
