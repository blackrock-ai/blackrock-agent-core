import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const PARK = "[PARKED — verify-rate-limits needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY]";

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

  const tenantId = randomUUID();
  await service.from("tenants").insert({ id: tenantId, slug: `verify-rl-${tenantId.slice(0, 8)}`, display_name: "verify" });

  try {
    const subject = `tenant:${tenantId}`;
    const windowSecs = 2;
    const limit = 2;

    const first = await service.rpc("check_rate_limit", { p_tenant: tenantId, p_subject: subject, p_window_secs: windowSecs, p_limit: limit });
    const second = await service.rpc("check_rate_limit", { p_tenant: tenantId, p_subject: subject, p_window_secs: windowSecs, p_limit: limit });
    const third = await service.rpc("check_rate_limit", { p_tenant: tenantId, p_subject: subject, p_window_secs: windowSecs, p_limit: limit });
    if (first.data !== true || second.data !== true || third.data !== false) fail("invariant 1: limit window behavior failed");
    ok("invariant 1: check_rate_limit enforces window cap");

    const anonCall = await anon.rpc("check_rate_limit", { p_tenant: tenantId, p_subject: subject, p_window_secs: 60, p_limit: 1 });
    if (!anonCall.error || anonCall.error.code !== "42501") fail("invariant 2: anon should be denied check_rate_limit");
    ok("invariant 2: anon denied definer RPC");

    await new Promise((r) => setTimeout(r, (windowSecs + 1) * 1000));
    const reset = await service.rpc("check_rate_limit", { p_tenant: tenantId, p_subject: subject, p_window_secs: windowSecs, p_limit: limit });
    if (reset.data !== true) fail("invariant 3: window reset failed");
    ok("invariant 3: counter resets after window");

    const sweep = await service.rpc("sweep_rate_limit_counters");
    if (sweep.error) fail(`invariant 4: sweep failed (${sweep.error.message})`);
    ok("invariant 4: sweep_rate_limit_counters callable and completes");
  } finally {
    await service.from("tenants").delete().eq("id", tenantId);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/fetch|network|ENOTFOUND|ECONNREFUSED/i.test(msg)) park(msg);
  fail(msg);
});
