-- Agent Core — migration 0014 — metering, pricing, rollups, retention.

create table if not exists agent_core.model_prices (
  provider text not null,
  model text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  input_per_million_usd numeric(10,4) not null,
  output_per_million_usd numeric(10,4) not null,
  cache_read_per_million_usd numeric(10,4),
  cache_write_per_million_usd numeric(10,4),
  primary key (provider, model, effective_from)
);

create index if not exists idx_model_prices_current_lookup
  on agent_core.model_prices (provider, model, effective_to nulls last, effective_from desc);

insert into agent_core.model_prices (
  provider, model, effective_from, effective_to,
  input_per_million_usd, output_per_million_usd,
  cache_read_per_million_usd, cache_write_per_million_usd
) values
  ('anthropic', 'claude-sonnet-4-5', '2025-01-01', null, 3.0000, 15.0000, 0.3000, 3.7500),
  ('anthropic', 'claude-opus-4', '2025-01-01', null, 15.0000, 75.0000, 1.5000, 18.7500),
  ('anthropic', 'claude-haiku-4', '2025-01-01', null, 0.8000, 4.0000, 0.0800, 1.0000),
  ('openai', 'gpt-4o', '2025-01-01', null, 2.5000, 10.0000, null, null),
  ('openai', 'gpt-4o-mini', '2025-01-01', null, 0.1500, 0.6000, null, null),
  ('openai', 'o3', '2025-01-01', null, 2.0000, 8.0000, null, null)
on conflict (provider, model, effective_from) do nothing;

revoke all on table agent_core.model_prices from public, anon, authenticated;
grant select, insert, update on table agent_core.model_prices to service_role;

create table if not exists agent_core.run_llm_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_core.agent_runs(id) on delete cascade,
  tenant_id uuid not null references agent_core.tenants(id) on delete cascade,
  step_label text not null,
  provider text not null,
  model text not null,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  tokens_cached_read int not null default 0,
  tokens_cached_write int not null default 0,
  cost_usd numeric(10,6) not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text
);

create index if not exists idx_run_llm_calls_tenant_started
  on agent_core.run_llm_calls (tenant_id, started_at desc);
create index if not exists idx_run_llm_calls_run
  on agent_core.run_llm_calls (run_id);

alter table agent_core.run_llm_calls enable row level security;
drop policy if exists tenant_isolation on agent_core.run_llm_calls;
create policy tenant_isolation on agent_core.run_llm_calls
  for all
  using (tenant_id = agent_core.current_tenant())
  with check (tenant_id = agent_core.current_tenant());

revoke all on table agent_core.run_llm_calls from public, anon;
revoke all on table agent_core.run_llm_calls from authenticated;
grant all on table agent_core.run_llm_calls to service_role;
grant select on table agent_core.run_llm_calls to authenticated;

create table if not exists agent_core.tool_invocations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agent_core.agent_runs(id) on delete cascade,
  tenant_id uuid not null references agent_core.tenants(id) on delete cascade,
  tool_key text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  external_units int,
  external_cost_estimate_usd numeric(10,6),
  ok boolean not null default true,
  error text
);

create index if not exists idx_tool_invocations_tenant_started
  on agent_core.tool_invocations (tenant_id, started_at desc);
create index if not exists idx_tool_invocations_run
  on agent_core.tool_invocations (run_id);
create index if not exists idx_tool_invocations_tool_started
  on agent_core.tool_invocations (tool_key, started_at desc);

alter table agent_core.tool_invocations enable row level security;
drop policy if exists tenant_isolation on agent_core.tool_invocations;
create policy tenant_isolation on agent_core.tool_invocations
  for all
  using (tenant_id = agent_core.current_tenant())
  with check (tenant_id = agent_core.current_tenant());

revoke all on table agent_core.tool_invocations from public, anon;
revoke all on table agent_core.tool_invocations from authenticated;
grant all on table agent_core.tool_invocations to service_role;
grant select on table agent_core.tool_invocations to authenticated;

create table if not exists agent_core.usage_rollup_daily (
  tenant_id uuid not null references agent_core.tenants(id) on delete cascade,
  day date not null,
  provider text not null,
  model text not null,
  runs int not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  tokens_cached_read bigint not null default 0,
  tokens_cached_write bigint not null default 0,
  cost_usd numeric(14,6) not null default 0,
  primary key (tenant_id, day, provider, model)
);

create index if not exists idx_usage_rollup_daily_tenant_day
  on agent_core.usage_rollup_daily (tenant_id, day desc);

alter table agent_core.usage_rollup_daily enable row level security;
drop policy if exists tenant_isolation on agent_core.usage_rollup_daily;
create policy tenant_isolation on agent_core.usage_rollup_daily
  for all
  using (tenant_id = agent_core.current_tenant())
  with check (tenant_id = agent_core.current_tenant());

revoke all on table agent_core.usage_rollup_daily from public, anon;
revoke all on table agent_core.usage_rollup_daily from authenticated;
grant all on table agent_core.usage_rollup_daily to service_role;
grant select on table agent_core.usage_rollup_daily to authenticated;

create table if not exists agent_core.tool_usage_rollup_daily (
  tenant_id uuid not null references agent_core.tenants(id) on delete cascade,
  day date not null,
  tool_key text not null,
  invocations int not null default 0,
  external_units_total bigint,
  external_cost_usd numeric(14,6) not null default 0,
  errors int not null default 0,
  primary key (tenant_id, day, tool_key)
);

create index if not exists idx_tool_usage_rollup_daily_tenant_day
  on agent_core.tool_usage_rollup_daily (tenant_id, day desc);

alter table agent_core.tool_usage_rollup_daily enable row level security;
drop policy if exists tenant_isolation on agent_core.tool_usage_rollup_daily;
create policy tenant_isolation on agent_core.tool_usage_rollup_daily
  for all
  using (tenant_id = agent_core.current_tenant())
  with check (tenant_id = agent_core.current_tenant());

revoke all on table agent_core.tool_usage_rollup_daily from public, anon;
revoke all on table agent_core.tool_usage_rollup_daily from authenticated;
grant all on table agent_core.tool_usage_rollup_daily to service_role;
grant select on table agent_core.tool_usage_rollup_daily to authenticated;

alter table agent_core.tenant_quotas
  add column if not exists message_retention_days int;

create or replace function agent_core.compute_cost(
  p_provider text,
  p_model text,
  p_at timestamptz,
  p_tokens_in int,
  p_tokens_out int,
  p_cached_read int default 0,
  p_cached_write int default 0
) returns numeric
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_row agent_core.model_prices%rowtype;
  v_cost numeric(14,6) := 0;
begin
  select * into v_row
    from agent_core.model_prices mp
   where mp.provider = p_provider
     and mp.model = p_model
     and p_at >= mp.effective_from
     and (mp.effective_to is null or p_at < mp.effective_to)
   order by mp.effective_from desc
   limit 1;

  if not found then
    return 0;
  end if;

  v_cost := (
    coalesce(p_tokens_in, 0) * v_row.input_per_million_usd
    + coalesce(p_tokens_out, 0) * v_row.output_per_million_usd
    + coalesce(p_cached_read, 0) * coalesce(v_row.cache_read_per_million_usd, 0)
    + coalesce(p_cached_write, 0) * coalesce(v_row.cache_write_per_million_usd, 0)
  ) / 1000000.0;

  return coalesce(v_cost, 0);
end;
$$;

revoke execute on function agent_core.compute_cost(text, text, timestamptz, int, int, int, int)
  from public, anon, authenticated;
grant execute on function agent_core.compute_cost(text, text, timestamptz, int, int, int, int)
  to service_role;

create or replace function agent_core.refresh_usage_rollup_daily(p_days int default 7)
returns int
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_from timestamptz := now() - make_interval(days => greatest(p_days, 1));
  v_rows int := 0;
begin
  with agg as (
    select
      c.tenant_id,
      date_trunc('day', c.started_at)::date as day,
      c.provider,
      c.model,
      count(*)::int as runs,
      coalesce(sum(c.tokens_in), 0)::bigint as tokens_in,
      coalesce(sum(c.tokens_out), 0)::bigint as tokens_out,
      coalesce(sum(c.tokens_cached_read), 0)::bigint as tokens_cached_read,
      coalesce(sum(c.tokens_cached_write), 0)::bigint as tokens_cached_write,
      coalesce(sum(c.cost_usd), 0)::numeric(14,6) as cost_usd
    from agent_core.run_llm_calls c
    where c.started_at >= v_from
    group by 1, 2, 3, 4
  ), upserted as (
    insert into agent_core.usage_rollup_daily (
      tenant_id, day, provider, model, runs,
      tokens_in, tokens_out, tokens_cached_read, tokens_cached_write, cost_usd
    )
    select * from agg
    on conflict (tenant_id, day, provider, model)
    do update set
      runs = excluded.runs,
      tokens_in = excluded.tokens_in,
      tokens_out = excluded.tokens_out,
      tokens_cached_read = excluded.tokens_cached_read,
      tokens_cached_write = excluded.tokens_cached_write,
      cost_usd = excluded.cost_usd
    returning 1
  )
  select count(*)::int into v_rows from upserted;

  return v_rows;
end;
$$;

revoke execute on function agent_core.refresh_usage_rollup_daily(int)
  from public, anon, authenticated;
grant execute on function agent_core.refresh_usage_rollup_daily(int)
  to service_role;

create or replace function agent_core.refresh_tool_usage_rollup_daily(p_days int default 7)
returns int
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_from timestamptz := now() - make_interval(days => greatest(p_days, 1));
  v_rows int := 0;
begin
  with agg as (
    select
      t.tenant_id,
      date_trunc('day', t.started_at)::date as day,
      t.tool_key,
      count(*)::int as invocations,
      case when count(t.external_units) = 0 then null else coalesce(sum(t.external_units), 0)::bigint end as external_units_total,
      coalesce(sum(coalesce(t.external_cost_estimate_usd, 0)), 0)::numeric(14,6) as external_cost_usd,
      count(*) filter (where not t.ok)::int as errors
    from agent_core.tool_invocations t
    where t.started_at >= v_from
    group by 1, 2, 3
  ), upserted as (
    insert into agent_core.tool_usage_rollup_daily (
      tenant_id, day, tool_key, invocations, external_units_total, external_cost_usd, errors
    )
    select * from agg
    on conflict (tenant_id, day, tool_key)
    do update set
      invocations = excluded.invocations,
      external_units_total = excluded.external_units_total,
      external_cost_usd = excluded.external_cost_usd,
      errors = excluded.errors
    returning 1
  )
  select count(*)::int into v_rows from upserted;

  return v_rows;
end;
$$;

revoke execute on function agent_core.refresh_tool_usage_rollup_daily(int)
  from public, anon, authenticated;
grant execute on function agent_core.refresh_tool_usage_rollup_daily(int)
  to service_role;

create or replace function agent_core.usage_summary(
  p_tenant uuid,
  p_from date,
  p_to date,
  p_grain text default 'day',
  p_include_tools boolean default false
) returns jsonb
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_json jsonb;
begin
  if p_grain not in ('day', 'week', 'month') then
    raise exception 'usage_summary: invalid grain %', p_grain;
  end if;

  with llm as (
    select
      case
        when p_grain = 'week' then to_char(date_trunc('week', day::timestamp), 'YYYY-MM-DD')
        when p_grain = 'month' then to_char(date_trunc('month', day::timestamp), 'YYYY-MM')
        else to_char(day::timestamp, 'YYYY-MM-DD')
      end as bucket,
      sum(runs)::bigint as runs,
      sum(tokens_in)::bigint as tokens_in,
      sum(tokens_out)::bigint as tokens_out,
      sum(cost_usd)::numeric(14,6) as cost_usd
    from agent_core.usage_rollup_daily
    where tenant_id = p_tenant
      and day >= p_from
      and day <= p_to
    group by 1
  ), tools as (
    select
      case
        when p_grain = 'week' then to_char(date_trunc('week', day::timestamp), 'YYYY-MM-DD')
        when p_grain = 'month' then to_char(date_trunc('month', day::timestamp), 'YYYY-MM')
        else to_char(day::timestamp, 'YYYY-MM-DD')
      end as bucket,
      sum(external_cost_usd)::numeric(14,6) as tool_cost_usd
    from agent_core.tool_usage_rollup_daily
    where tenant_id = p_tenant
      and day >= p_from
      and day <= p_to
    group by 1
  ), joined as (
    select
      l.bucket,
      l.runs,
      l.tokens_in,
      l.tokens_out,
      l.cost_usd,
      case when p_include_tools then coalesce(t.tool_cost_usd, 0) else null end as tool_cost_usd
    from llm l
    left join tools t using (bucket)
  )
  select jsonb_build_object(
    'tenant_id', p_tenant,
    'from', p_from,
    'to', p_to,
    'grain', p_grain,
    'buckets', coalesce(jsonb_agg(
      case when p_include_tools then
        jsonb_build_object('bucket', bucket, 'runs', runs, 'tokens_in', tokens_in, 'tokens_out', tokens_out, 'cost_usd', cost_usd, 'tool_cost_usd', tool_cost_usd)
      else
        jsonb_build_object('bucket', bucket, 'runs', runs, 'tokens_in', tokens_in, 'tokens_out', tokens_out, 'cost_usd', cost_usd)
      end
      order by bucket
    ), '[]'::jsonb),
    'totals', (
      select case when p_include_tools then
        jsonb_build_object(
          'runs', coalesce(sum(runs), 0),
          'tokens_in', coalesce(sum(tokens_in), 0),
          'tokens_out', coalesce(sum(tokens_out), 0),
          'cost_usd', coalesce(sum(cost_usd), 0),
          'tool_cost_usd', coalesce(sum(tool_cost_usd), 0)
        )
      else
        jsonb_build_object(
          'runs', coalesce(sum(runs), 0),
          'tokens_in', coalesce(sum(tokens_in), 0),
          'tokens_out', coalesce(sum(tokens_out), 0),
          'cost_usd', coalesce(sum(cost_usd), 0)
        )
      end
      from joined
    )
  ) into v_json
  from joined;

  return coalesce(v_json, jsonb_build_object(
    'tenant_id', p_tenant,
    'from', p_from,
    'to', p_to,
    'grain', p_grain,
    'buckets', '[]'::jsonb,
    'totals', case when p_include_tools then
      jsonb_build_object('runs', 0, 'tokens_in', 0, 'tokens_out', 0, 'cost_usd', 0, 'tool_cost_usd', 0)
    else
      jsonb_build_object('runs', 0, 'tokens_in', 0, 'tokens_out', 0, 'cost_usd', 0)
    end
  ));
end;
$$;

revoke execute on function agent_core.usage_summary(uuid, date, date, text, boolean)
  from public, anon, authenticated;
grant execute on function agent_core.usage_summary(uuid, date, date, text, boolean)
  to service_role;

create or replace function agent_core.usage_for_billing(
  p_tenant uuid,
  p_month date
) returns jsonb
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_start date := date_trunc('month', p_month::timestamp)::date;
  v_end date := (date_trunc('month', p_month::timestamp) + interval '1 month')::date;
  v_runs bigint := 0;
  v_tokens_in bigint := 0;
  v_tokens_out bigint := 0;
  v_cost numeric(14,6) := 0;
begin
  select
    coalesce(sum(runs), 0),
    coalesce(sum(tokens_in), 0),
    coalesce(sum(tokens_out), 0),
    coalesce(sum(cost_usd), 0)
  into v_runs, v_tokens_in, v_tokens_out, v_cost
  from agent_core.usage_rollup_daily
  where tenant_id = p_tenant
    and day >= v_start
    and day < v_end;

  return jsonb_build_object(
    'tenant_id', p_tenant,
    'month', to_char(v_start, 'YYYY-MM'),
    'runs', v_runs,
    'tokens_in', v_tokens_in,
    'tokens_out', v_tokens_out,
    'cost_usd', v_cost
  );
end;
$$;

revoke execute on function agent_core.usage_for_billing(uuid, date)
  from public, anon, authenticated;
grant execute on function agent_core.usage_for_billing(uuid, date)
  to service_role;

create or replace function agent_core.usage_summary_by_user(
  p_tenant uuid,
  p_from date,
  p_to date
) returns table(
  user_id uuid,
  runs int,
  tokens_in bigint,
  tokens_out bigint,
  cost_usd numeric
)
  language sql
  security definer
  set search_path = agent_core
as $$
  select
    r.user_id,
    count(*)::int as runs,
    coalesce(sum(r.tokens_in), 0)::bigint as tokens_in,
    coalesce(sum(r.tokens_out), 0)::bigint as tokens_out,
    coalesce(sum(r.cost_estimate), 0)::numeric as cost_usd
  from agent_core.agent_runs r
  where r.tenant_id = p_tenant
    and r.created_at::date >= p_from
    and r.created_at::date <= p_to
  group by r.user_id;
$$;

revoke execute on function agent_core.usage_summary_by_user(uuid, date, date)
  from public, anon, authenticated;
grant execute on function agent_core.usage_summary_by_user(uuid, date, date)
  to service_role;

create or replace function agent_core.prune_agent_messages()
returns int
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_deleted int := 0;
begin
  with removed as (
    delete from agent_core.agent_messages m
    using agent_core.agent_runs r
    left join agent_core.tenant_quotas tq on tq.tenant_id = r.tenant_id
    where m.run_id = r.id
      and now() >= r.created_at + make_interval(days => coalesce(tq.message_retention_days, 90))
    returning 1
  )
  select count(*)::int into v_deleted from removed;

  return v_deleted;
end;
$$;

revoke execute on function agent_core.prune_agent_messages()
  from public, anon, authenticated;
grant execute on function agent_core.prune_agent_messages()
  to service_role;

create or replace function agent_core.retention_sweep_agent_runs(p_days int default 730)
returns int
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_deleted int := 0;
begin
  with removed as (
    delete from agent_core.agent_runs r
    where r.status in ('completed', 'failed')
      and r.created_at < now() - make_interval(days => greatest(p_days, 1))
    returning 1
  )
  select count(*)::int into v_deleted from removed;

  return v_deleted;
end;
$$;

revoke execute on function agent_core.retention_sweep_agent_runs(int)
  from public, anon, authenticated;
grant execute on function agent_core.retention_sweep_agent_runs(int)
  to service_role;

create or replace function agent_core.metering_daily_job()
returns void
  language plpgsql
  security definer
  set search_path = agent_core
as $$
begin
  perform agent_core.refresh_usage_rollup_daily(7);
  perform agent_core.refresh_tool_usage_rollup_daily(7);
  perform agent_core.prune_agent_messages();
  perform agent_core.retention_sweep_agent_runs(730);
end;
$$;

revoke execute on function agent_core.metering_daily_job()
  from public, anon, authenticated;
grant execute on function agent_core.metering_daily_job()
  to service_role;

create or replace function agent_core.metering_refresh_job()
returns void
  language plpgsql
  security definer
  set search_path = agent_core
as $$
begin
  perform agent_core.refresh_usage_rollup_daily(1);
  perform agent_core.refresh_tool_usage_rollup_daily(1);
end;
$$;

revoke execute on function agent_core.metering_refresh_job()
  from public, anon, authenticated;
grant execute on function agent_core.metering_refresh_job()
  to service_role;

select cron.unschedule(j.jobid)
  from cron.job j
 where j.jobname = 'agent_core_metering_daily';

select cron.schedule(
  'agent_core_metering_daily',
  '30 3 * * *',
  $$select agent_core.metering_daily_job();$$
);

select cron.unschedule(j.jobid)
  from cron.job j
 where j.jobname = 'agent_core_metering_refresh';

select cron.schedule(
  'agent_core_metering_refresh',
  '*/15 * * * *',
  $$select agent_core.metering_refresh_job();$$
);
