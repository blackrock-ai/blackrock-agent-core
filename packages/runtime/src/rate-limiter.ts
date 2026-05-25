import type { SupabaseClient } from "@supabase/supabase-js";

export interface RateLimitCheckResult {
  ok: boolean;
  retryAfterSec?: number;
}

export interface RateLimitContext {
  supabase: SupabaseClient;
  tenantId: string;
  subject: string;
  windowSecs: number;
  limit: number;
}

function currentWindowStartSecs(windowSecs: number): number {
  const nowSecs = Math.floor(Date.now() / 1000);
  return nowSecs - (nowSecs % windowSecs);
}

export async function checkRateLimit(ctx: RateLimitContext): Promise<RateLimitCheckResult> {
  try {
    const { data, error } = await ctx.supabase.rpc("check_rate_limit", {
      p_tenant: ctx.tenantId,
      p_subject: ctx.subject,
      p_window_secs: ctx.windowSecs,
      p_limit: ctx.limit,
    });

    if (error) {
      console.warn("rate limiter RPC failed (fail-open):", error.message);
      return { ok: true };
    }

    if (data === true) return { ok: true };

    const nowSecs = Math.floor(Date.now() / 1000);
    const windowStartSecs = currentWindowStartSecs(ctx.windowSecs);
    const elapsed = Math.max(0, nowSecs - windowStartSecs);
    const retryAfterSec = Math.max(1, ctx.windowSecs - elapsed);
    return { ok: false, retryAfterSec };
  } catch (error) {
    console.warn("rate limiter threw (fail-open):", error);
    return { ok: true };
  }
}
