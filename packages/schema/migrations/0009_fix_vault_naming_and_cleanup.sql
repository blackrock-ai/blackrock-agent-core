-- Agent Core — migration 0009 — vault naming collision fix, stale secret cleanup,
-- and search_path pinning hardening.

create or replace function agent_core.current_tenant() returns uuid
  language sql stable
  set search_path = agent_core
as $$
  select nullif(auth.jwt() ->> 'tenant_id', '')::uuid
$$;

create or replace function agent_core.store_tenant_credential(
  p_tenant   uuid,
  p_provider text,
  p_secret   text,
  p_meta     jsonb default '{}'::jsonb
) returns uuid
  language plpgsql
  security definer
  set search_path = agent_core, vault
as $$
declare
  v_secret_name text := format('agent-core:%s:%s:%s', p_tenant, p_provider, gen_random_uuid()::text);
  v_secret_ref  uuid;
  v_row_id      uuid;
  v_old_secret_ref uuid;
begin
  select tc.secret_ref
    into v_old_secret_ref
    from agent_core.tenant_credentials tc
   where tc.tenant_id = p_tenant
     and tc.provider = p_provider;

  v_secret_ref := vault.create_secret(p_secret, v_secret_name, '');

  insert into agent_core.tenant_credentials (tenant_id, provider, secret_ref, meta)
  values (p_tenant, p_provider, v_secret_ref, coalesce(p_meta, '{}'::jsonb))
  on conflict (tenant_id, provider) do update
    set secret_ref = excluded.secret_ref,
        meta       = excluded.meta
  returning id into v_row_id;

  delete from vault.secrets
   where id = v_old_secret_ref
     and v_old_secret_ref is not null
     and v_old_secret_ref <> v_secret_ref;

  return v_row_id;
end;
$$;

revoke all on function agent_core.store_tenant_credential(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function agent_core.store_tenant_credential(uuid, text, text, jsonb)
  to service_role;

create or replace function agent_core.store_tenant_connection(
  p_tenant         uuid,
  p_provider       text,
  p_account_label  text,
  p_access_token   text,
  p_refresh_token  text,
  p_scopes         text[],
  p_expires_at     timestamptz,
  p_meta           jsonb default '{}'::jsonb
) returns uuid
  language plpgsql
  security definer
  set search_path = agent_core, vault
as $$
declare
  v_access_name  text;
  v_refresh_name text;
  v_access_ref   uuid;
  v_refresh_ref  uuid;
  v_old_access_ref uuid;
  v_old_refresh_ref uuid;
  v_row_id       uuid;
begin
  select tc.secret_ref, tc.refresh_secret_ref
    into v_old_access_ref, v_old_refresh_ref
    from agent_core.tenant_connections tc
   where tc.tenant_id = p_tenant
     and tc.provider = p_provider
     and tc.account_label = p_account_label;

  v_access_name := format('agent-core:conn:%s:%s:%s:access:%s', p_tenant, p_provider, p_account_label, gen_random_uuid()::text);
  v_refresh_name := format('agent-core:conn:%s:%s:%s:refresh:%s', p_tenant, p_provider, p_account_label, gen_random_uuid()::text);

  if p_access_token is not null and length(p_access_token) > 0 then
    v_access_ref := vault.create_secret(p_access_token, v_access_name, '');
  end if;
  if p_refresh_token is not null and length(p_refresh_token) > 0 then
    v_refresh_ref := vault.create_secret(p_refresh_token, v_refresh_name, '');
  end if;

  insert into agent_core.tenant_connections
    (tenant_id, provider, account_label, secret_ref, refresh_secret_ref,
     scopes, expires_at, status, meta, updated_at)
  values
    (p_tenant, p_provider, p_account_label, v_access_ref, v_refresh_ref,
     coalesce(p_scopes, '{}'), p_expires_at, 'active',
     coalesce(p_meta, '{}'::jsonb), now())
  on conflict (tenant_id, provider, account_label) do update
    set secret_ref         = coalesce(excluded.secret_ref,         agent_core.tenant_connections.secret_ref),
        refresh_secret_ref = coalesce(excluded.refresh_secret_ref, agent_core.tenant_connections.refresh_secret_ref),
        scopes             = excluded.scopes,
        expires_at         = excluded.expires_at,
        status             = 'active',
        meta               = excluded.meta,
        updated_at         = now()
  returning id into v_row_id;

  delete from vault.secrets
   where id in (v_old_access_ref, v_old_refresh_ref)
     and id is not null
     and (v_access_ref is null or id <> v_access_ref)
     and (v_refresh_ref is null or id <> v_refresh_ref);

  return v_row_id;
end;
$$;

revoke all on function agent_core.store_tenant_connection(uuid, text, text, text, text, text[], timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function agent_core.store_tenant_connection(uuid, text, text, text, text, text[], timestamptz, jsonb)
  to service_role;

create or replace function agent_core.update_tenant_connection_tokens(
  p_connection_id   uuid,
  p_access_token    text,
  p_refresh_token   text,
  p_expires_at      timestamptz
) returns void
  language plpgsql
  security definer
  set search_path = agent_core, vault
as $$
declare
  v_tenant   uuid;
  v_provider text;
  v_label    text;
  v_access_name  text;
  v_refresh_name text;
  v_access_ref   uuid;
  v_refresh_ref  uuid;
  v_old_access_ref uuid;
  v_old_refresh_ref uuid;
begin
  select tc.tenant_id, tc.provider, tc.account_label, tc.secret_ref, tc.refresh_secret_ref
    into v_tenant, v_provider, v_label, v_old_access_ref, v_old_refresh_ref
    from agent_core.tenant_connections tc
   where tc.id = p_connection_id;

  if v_tenant is null then
    raise exception 'connection % not found', p_connection_id;
  end if;

  v_access_name := format('agent-core:conn:%s:%s:%s:access:%s', v_tenant, v_provider, v_label, gen_random_uuid()::text);
  v_refresh_name := format('agent-core:conn:%s:%s:%s:refresh:%s', v_tenant, v_provider, v_label, gen_random_uuid()::text);

  if p_access_token is not null and length(p_access_token) > 0 then
    v_access_ref := vault.create_secret(p_access_token, v_access_name, '');
  end if;
  if p_refresh_token is not null and length(p_refresh_token) > 0 then
    v_refresh_ref := vault.create_secret(p_refresh_token, v_refresh_name, '');
  end if;

  update agent_core.tenant_connections
     set secret_ref         = coalesce(v_access_ref,  secret_ref),
         refresh_secret_ref = coalesce(v_refresh_ref, refresh_secret_ref),
         expires_at         = p_expires_at,
         status             = 'active',
         updated_at         = now()
   where id = p_connection_id;

  delete from vault.secrets
   where id in (v_old_access_ref, v_old_refresh_ref)
     and id is not null
     and (v_access_ref is null or id <> v_access_ref)
     and (v_refresh_ref is null or id <> v_refresh_ref);
end;
$$;

revoke all on function agent_core.update_tenant_connection_tokens(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function agent_core.update_tenant_connection_tokens(uuid, text, text, timestamptz)
  to service_role;
