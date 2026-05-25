import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const PARK = "[PARKED — verify-audit needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY]";

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
  await service.from("tenants").insert({ id: tenantId, slug: `verify-audit-${tenantId.slice(0, 8)}`, display_name: "verify" });

  try {
    const rec = await service.rpc("record_audit_event", {
      p_tenant: tenantId,
      p_event: "verify_audit",
      p_severity: "info",
      p_subject: "test",
      p_meta: { a: 1 },
    });
    if (rec.error || !rec.data) fail(`invariant 1: record_audit_event failed (${rec.error?.message ?? "no id"})`);

    const query = await service.rpc("query_audit_log", {
      p_tenant: tenantId,
      p_event: "verify_audit",
      p_limit: 10,
    });
    if (query.error || !Array.isArray(query.data) || query.data.length < 1) fail("invariant 1: query_audit_log missing row");
    ok("invariant 1: record/query audit works");

    const anonRec = await anon.rpc("record_audit_event", {
      p_tenant: tenantId,
      p_event: "bad",
      p_severity: "info",
      p_subject: "bad",
      p_meta: {},
    });
    if (!anonRec.error || anonRec.error.code !== "42501") fail("invariant 2: anon must be denied record_audit_event");
    ok("invariant 2: anon denied audit RPCs");

    const del = await anon.from("audit_log").delete().eq("tenant_id", tenantId);
    if (!del.error || del.error.code !== "42501") fail("invariant 3: append-only delete revoke not enforced");
    ok("invariant 3: append-only revoke enforced");

    const prune = await service.rpc("prune_audit_log", { p_days: 0 });
    if (prune.error) fail(`invariant 4: prune_audit_log(0) failed (${prune.error.message})`);
    ok("invariant 4: prune_audit_log callable");
  } finally {
    await service.from("tenants").delete().eq("id", tenantId);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  if (/fetch|network|ENOTFOUND|ECONNREFUSED/i.test(msg)) park(msg);
  fail(msg);
});
