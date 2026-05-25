-- Agent Core — migration 0012 — oauth_states expiry sweeper.

create or replace function agent_core.sweep_oauth_states()
returns int
  language plpgsql
  security definer
  set search_path = agent_core
as $$
declare
  v_deleted int := 0;
begin
  delete from agent_core.oauth_states
   where expires_at < now();

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function agent_core.sweep_oauth_states()
  from public, anon, authenticated;
grant execute on function agent_core.sweep_oauth_states()
  to service_role;

select cron.unschedule(j.jobid)
  from cron.job j
 where j.jobname = 'agent_core_sweep_oauth_states';

select cron.schedule(
  'agent_core_sweep_oauth_states',
  '*/5 * * * *',
  $$select agent_core.sweep_oauth_states();$$
);
