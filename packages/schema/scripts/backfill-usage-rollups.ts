import { createClient } from "@supabase/supabase-js";

const PARK = "[PARKED — backfill-usage-rollups needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY]";

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
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) park("missing env");

  // any: no generated DB types for scripts.
  const supabase = createClient<any, "agent_core">(url, key, {
    db: { schema: "agent_core" },
    auth: { persistSession: false },
  });

  const tenants = await supabase.from("tenants").select("id");
  if (tenants.error) fail(`load tenants: ${tenants.error.message}`);

  let inserted = 0;
  for (const t of tenants.data ?? []) {
    const tenantId = String((t as { id: unknown }).id ?? "");
    if (!tenantId) continue;

    const runs = await supabase
      .from("agent_runs")
      .select("id, tenant_id, model_provider, model, tokens_in, tokens_out, cost_estimate, created_at, completed_at")
      .eq("tenant_id", tenantId);
    if (runs.error) fail(`load runs for ${tenantId}: ${runs.error.message}`);

    for (const r of runs.data ?? []) {
      const row = r as Record<string, unknown>;
      const runId = String(row.id ?? "");
      if (!runId) continue;

      const exists = await supabase
        .from("run_llm_calls")
        .select("id")
        .eq("run_id", runId)
        .limit(1)
        .maybeSingle();
      if (exists.error) fail(`check llm_call exists for ${runId}: ${exists.error.message}`);
      if (exists.data) continue;

      const payload = {
        run_id: runId,
        tenant_id: String(row.tenant_id ?? tenantId),
        step_label: "backfill",
        provider: String(row.model_provider ?? "unknown"),
        model: String(row.model ?? "unknown"),
        tokens_in: Number(row.tokens_in ?? 0),
        tokens_out: Number(row.tokens_out ?? 0),
        tokens_cached_read: 0,
        tokens_cached_write: 0,
        cost_usd: Number(row.cost_estimate ?? 0),
        started_at: String(row.created_at ?? new Date().toISOString()),
        finished_at: String(row.completed_at ?? row.created_at ?? new Date().toISOString()),
      };
      const ins = await supabase.from("run_llm_calls").insert(payload);
      if (ins.error) fail(`insert backfill row for run ${runId}: ${ins.error.message}`);
      inserted += 1;
    }
  }

  const refreshed = await supabase.rpc("refresh_usage_rollup_daily", { p_days: 99999 });
  if (refreshed.error) fail(`refresh_usage_rollup_daily: ${refreshed.error.message}`);

  ok(`backfill complete: inserted ${inserted} synthetic run_llm_calls rows`);
  ok(`usage rollup refreshed (rows touched: ${String(refreshed.data ?? 0)})`);
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/fetch|network|ENOTFOUND|ECONNREFUSED/i.test(msg)) park(msg);
  fail(msg);
});
