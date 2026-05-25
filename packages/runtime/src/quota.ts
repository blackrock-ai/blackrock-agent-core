import type { SupabaseClient } from "@supabase/supabase-js";

export interface QuotaState {
  paused: boolean;
  ok: boolean;
  limitedBy: "paused" | "runs" | "tokens" | "cost" | null;
  runs_today?: number;
  max_runs_per_day?: number | null;
  tokens_today?: number;
  max_tokens_per_day?: number | null;
  cost_today_usd?: number;
  max_cost_per_day_usd?: number | null;
}

export async function loadQuotaState(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<QuotaState> {
  try {
    const { data, error } = await supabase.rpc("check_quota", { p_tenant: tenantId });
    if (error) {
      console.warn("quota RPC failed (fail-open):", error.message);
      return { paused: false, ok: true, limitedBy: null };
    }

    const row = (data ?? {}) as Record<string, unknown>;
    return {
      paused: row.paused === true,
      ok: row.ok !== false,
      limitedBy:
        row.limited_by === "paused" ||
        row.limited_by === "runs" ||
        row.limited_by === "tokens" ||
        row.limited_by === "cost"
          ? row.limited_by
          : null,
      runs_today: typeof row.runs_today === "number" ? row.runs_today : 0,
      max_runs_per_day: typeof row.max_runs_per_day === "number" ? row.max_runs_per_day : null,
      tokens_today: typeof row.tokens_today === "number" ? row.tokens_today : 0,
      max_tokens_per_day:
        typeof row.max_tokens_per_day === "number" ? row.max_tokens_per_day : null,
      cost_today_usd: typeof row.cost_today_usd === "number" ? row.cost_today_usd : 0,
      max_cost_per_day_usd:
        typeof row.max_cost_per_day_usd === "number" ? row.max_cost_per_day_usd : null,
    };
  } catch (error) {
    console.warn("quota check threw (fail-open):", error);
    return { paused: false, ok: true, limitedBy: null };
  }
}
