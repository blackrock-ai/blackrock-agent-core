-- Agent Core — migration 0008 — surgical fix for over-broad function execute grants.
--
-- 0007 granted EXECUTE ON ALL FUNCTIONS IN SCHEMA agent_core TO authenticated,
-- which unintentionally reopened SECURITY DEFINER RPC access that earlier
-- migrations explicitly revoked. This migration re-locks the known SECURITY
-- DEFINER functions to service_role-only and removes the default future grant.

revoke execute on function agent_core.store_tenant_credential(uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function agent_core.store_tenant_credential(uuid, text, text, jsonb)
  to service_role;

revoke execute on function agent_core.resolve_tenant_secret(uuid, text)
  from public, anon, authenticated;
grant execute on function agent_core.resolve_tenant_secret(uuid, text)
  to service_role;

revoke execute on function agent_core.store_artifact(uuid, uuid, text, text, text, bigint, text, jsonb)
  from public, anon, authenticated;
grant execute on function agent_core.store_artifact(uuid, uuid, text, text, text, bigint, text, jsonb)
  to service_role;

revoke execute on function agent_core.list_artifacts(uuid, uuid, int)
  from public, anon, authenticated;
grant execute on function agent_core.list_artifacts(uuid, uuid, int)
  to service_role;

revoke execute on function agent_core.read_tenant_table(uuid, text, text[], jsonb, int)
  from public, anon, authenticated;
grant execute on function agent_core.read_tenant_table(uuid, text, text[], jsonb, int)
  to service_role;

revoke execute on function agent_core.store_tenant_connection(uuid, text, text, text, text, text[], timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function agent_core.store_tenant_connection(uuid, text, text, text, text, text[], timestamptz, jsonb)
  to service_role;

revoke execute on function agent_core.resolve_tenant_connection(uuid, text, text)
  from public, anon, authenticated;
grant execute on function agent_core.resolve_tenant_connection(uuid, text, text)
  to service_role;

revoke execute on function agent_core.update_tenant_connection_tokens(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function agent_core.update_tenant_connection_tokens(uuid, text, text, timestamptz)
  to service_role;

alter default privileges in schema agent_core
  revoke execute on functions from authenticated;
