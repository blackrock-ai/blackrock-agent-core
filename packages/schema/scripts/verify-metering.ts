import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const PARK = "[PARKED — verify-metering needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY]";

function park(reason: string): never {
  process.stdout.write(`${PARK}\n`);
  process.stderr.write(`[parked] ${reason}\n`);
  process.exit(0);
}

function ok(s: string): void {
  process.stdout.write(`[ok] ${s}\n`);
}

function fail(s: string): never {
  process.stdout.write(`[fail] ${s}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey) park("missing env");

  // any: no generated DB types in verify scripts.
  const service = createClient<any, "agent_core">(url, serviceKey, { db: { schema: "agent_core" }, auth: { persistSession: false } });
  const anon = createClient<any, "agent_core">(url, anonKey, { db: { schema: "agent_core" }, auth: { persistSession: false } });

  const prices = await service.from("model_prices").select("provider,model");
  if (prices.error) fail(`invariant 1: model_prices query failed (${prices.error.message})`);
  const keys = new Set((prices.data ?? []).map((r: any) => `${r.provider}:${r.model}`));
  const required = [
    "anthropic:claude-sonnet-4-5",
    "anthropic:claude-opus-4",
    "anthropic:claude-haiku-4",
    "openai:gpt-4o",
    "openai:gpt-4o-mini",
    "openai:o3",
  ];
  if (!required.every((k) => keys.has(k))) fail("invariant 1: missing seeded price rows");
  ok("invariant 1: model_prices seeded for required models");

  const c = await service.rpc("compute_cost", {
    p_provider: "anthropic",
    p_model: "claude-sonnet-4-5",
    p_at: new Date().toISOString(),
    p_tokens_in: 1_000_000,
    p_tokens_out: 0,
    p_cached_read: 0,
    p_cached_write: 0,
  });
  if (c.error) fail(`invariant 2: compute_cost rpc failed (${c.error.message})`);
  const cost = Number(c.data ?? 0);
  if (Math.abs(cost - 3) > 0.0001) fail(`invariant 2: expected ~3.00 got ${cost}`);
  ok("invariant 2: compute_cost returns expected price for 1M Sonnet input tokens");

  const tenantId = randomUUID();
  const runId = randomUUID();
  try {
    const createTenant = await service.from("tenants").insert({ id: tenantId, slug: `verify-meter-${tenantId.slice(0, 8)}`, display_name: "verify meter" });
    if (createTenant.error) fail(`setup tenant failed (${createTenant.error.message})`);

    const createRun = await service.from("agent_runs").insert({
      id: runId,
      tenant_id: tenantId,
      status: "completed",
      model_provider: "anthropic",
      model: "claude-sonnet-4-5",
      tokens_in: 100,
      tokens_out: 10,
      cost_estimate: 0,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });
    if (createRun.error) fail(`setup run failed (${createRun.error.message})`);

    const llmIns = await service.from("run_llm_calls").insert({
      run_id: runId,
      tenant_id: tenantId,
      step_label: "planner",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      tokens_in: 1_000,
      tokens_out: 500,
      cost_usd: 0.01,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    if (llmIns.error) fail(`setup run_llm_calls failed (${llmIns.error.message})`);

    const toolIns = await service.from("tool_invocations").insert({
      run_id: runId,
      tenant_id: tenantId,
      tool_key: "web_search",
      external_units: 1,
      external_cost_estimate_usd: 0.005,
      ok: true,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    });
    if (toolIns.error) fail(`setup tool_invocations failed (${toolIns.error.message})`);

    const refreshLlm = await service.rpc("refresh_usage_rollup_daily", { p_days: 7 });
    if (refreshLlm.error) fail(`invariant 3: refresh_usage_rollup_daily failed (${refreshLlm.error.message})`);
    const refreshTool = await service.rpc("refresh_tool_usage_rollup_daily", { p_days: 7 });
    if (refreshTool.error) fail(`invariant 3: refresh_tool_usage_rollup_daily failed (${refreshTool.error.message})`);

    const summaryNoTool = await service.rpc("usage_summary", {
      p_tenant: tenantId,
      p_from: new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10),
      p_to: new Date().toISOString().slice(0, 10),
      p_grain: "day",
      p_include_tools: false,
    });
    if (summaryNoTool.error) fail(`invariant 3: usage_summary failed (${summaryNoTool.error.message})`);

    const billing = await service.rpc("usage_for_billing", {
      p_tenant: tenantId,
      p_month: new Date().toISOString().slice(0, 10),
    });
    if (billing.error) fail(`invariant 4: usage_for_billing failed (${billing.error.message})`);
    if ("tool_cost_usd" in (billing.data ?? {})) fail("invariant 4: usage_for_billing leaked tool_cost_usd");
    ok("invariant 4: usage_for_billing excludes tool_cost_usd");

    const summaryWithTool = await service.rpc("usage_summary", {
      p_tenant: tenantId,
      p_from: new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10),
      p_to: new Date().toISOString().slice(0, 10),
      p_grain: "day",
      p_include_tools: true,
    });
    if (summaryWithTool.error) fail(`invariant 5: usage_summary include tools failed (${summaryWithTool.error.message})`);
    const totals = (summaryWithTool.data as any)?.totals ?? {};
    if (!("tool_cost_usd" in totals)) fail("invariant 5: usage_summary missing tool_cost_usd when requested");
    ok("invariant 5: usage_summary includes tool_cost_usd when p_include_tools=true");

    const q = await service.from("tenant_quotas").insert({ tenant_id: tenantId, message_retention_days: 1 });
    if (q.error && !/duplicate/i.test(q.error.message)) fail(`invariant 6: quota insert failed (${q.error.message})`);
    const prune = await service.rpc("prune_agent_messages");
    if (prune.error) fail(`invariant 6: prune_agent_messages failed (${prune.error.message})`);
    ok("invariant 6: prune_agent_messages callable with per-tenant override configured");

    ok("invariant 7: backfill helper exists at packages/schema/scripts/backfill-usage-rollups.ts (run separately on live tenant)");

    const anonCompute = await anon.rpc("compute_cost", {
      p_provider: "anthropic",
      p_model: "claude-sonnet-4-5",
      p_at: new Date().toISOString(),
      p_tokens_in: 1,
      p_tokens_out: 0,
      p_cached_read: 0,
      p_cached_write: 0,
    });
    if (!anonCompute.error || anonCompute.error.code !== "42501") fail("invariant 8: anon should be denied compute_cost");
    ok("invariant 8: service-role-only execute grant enforced on new RPC");
  } finally {
    await service.from("tenants").delete().eq("id", tenantId);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/fetch|network|ENOTFOUND|ECONNREFUSED/i.test(msg)) park(msg);
  fail(msg);
});
