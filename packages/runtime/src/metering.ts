import type { SupabaseClient } from "@supabase/supabase-js";

export interface CostCalcInput {
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCachedRead?: number;
  tokensCachedWrite?: number;
  at?: Date;
}

export interface CostCalcResult {
  costUsd: number;
  breakdown: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface PriceRow {
  input_per_million_usd: number;
  output_per_million_usd: number;
  cache_read_per_million_usd: number | null;
  cache_write_per_million_usd: number | null;
}

const priceCache = new Map<string, PriceRow | null>();

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

async function getCurrentPrice(
  supabase: SupabaseClient,
  provider: string,
  model: string,
  atIso: string
): Promise<PriceRow | null> {
  const key = `${provider}:${model}`;
  if (priceCache.has(key)) return priceCache.get(key) ?? null;

  const { data, error } = await supabase
    .from("model_prices")
    .select("input_per_million_usd,output_per_million_usd,cache_read_per_million_usd,cache_write_per_million_usd")
    .eq("provider", provider)
    .eq("model", model)
    .lte("effective_from", atIso)
    .or(`effective_to.is.null,effective_to.gt.${atIso}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) {
    priceCache.set(key, null);
    return null;
  }

  const row: PriceRow = {
    input_per_million_usd: toNumber((data as Record<string, unknown>).input_per_million_usd),
    output_per_million_usd: toNumber((data as Record<string, unknown>).output_per_million_usd),
    cache_read_per_million_usd:
      (data as Record<string, unknown>).cache_read_per_million_usd == null
        ? null
        : toNumber((data as Record<string, unknown>).cache_read_per_million_usd),
    cache_write_per_million_usd:
      (data as Record<string, unknown>).cache_write_per_million_usd == null
        ? null
        : toNumber((data as Record<string, unknown>).cache_write_per_million_usd),
  };
  priceCache.set(key, row);
  return row;
}

export async function computeCost(
  supabase: SupabaseClient,
  input: CostCalcInput
): Promise<CostCalcResult> {
  const atIso = (input.at ?? new Date()).toISOString();
  const tokensCachedRead = input.tokensCachedRead ?? 0;
  const tokensCachedWrite = input.tokensCachedWrite ?? 0;

  try {
    const row = await getCurrentPrice(supabase, input.provider, input.model, atIso);
    if (row) {
      const inputCost = (input.tokensIn * row.input_per_million_usd) / 1_000_000;
      const outputCost = (input.tokensOut * row.output_per_million_usd) / 1_000_000;
      const cacheRead = (tokensCachedRead * (row.cache_read_per_million_usd ?? 0)) / 1_000_000;
      const cacheWrite = (tokensCachedWrite * (row.cache_write_per_million_usd ?? 0)) / 1_000_000;
      const costUsd = Number((inputCost + outputCost + cacheRead + cacheWrite).toFixed(6));
      return { costUsd, breakdown: { input: inputCost, output: outputCost, cacheRead, cacheWrite } };
    }

    const rpc = await supabase.rpc("compute_cost", {
      p_provider: input.provider,
      p_model: input.model,
      p_at: atIso,
      p_tokens_in: input.tokensIn,
      p_tokens_out: input.tokensOut,
      p_cached_read: tokensCachedRead,
      p_cached_write: tokensCachedWrite,
    });
    if (rpc.error) throw rpc.error;
    const costUsd = toNumber(rpc.data);
    if (costUsd === 0) {
      console.warn("metering: compute_cost returned zero", {
        provider: input.provider,
        model: input.model,
      });
    }
    return { costUsd, breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  } catch (e) {
    console.warn("metering: computeCost failed; defaulting to zero", e);
    return { costUsd: 0, breakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }
}

export async function recordLlmCall(
  supabase: SupabaseClient,
  args: {
    runId: string;
    tenantId: string;
    stepLabel: string;
    provider: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    tokensCachedRead?: number;
    tokensCachedWrite?: number;
    startedAt: Date;
    finishedAt: Date;
    error?: string;
  }
): Promise<void> {
  const cost = await computeCost(supabase, {
    provider: args.provider,
    model: args.model,
    tokensIn: args.tokensIn,
    tokensOut: args.tokensOut,
    tokensCachedRead: args.tokensCachedRead ?? 0,
    tokensCachedWrite: args.tokensCachedWrite ?? 0,
    at: args.finishedAt,
  });

  const { error } = await supabase.from("run_llm_calls").insert({
    run_id: args.runId,
    tenant_id: args.tenantId,
    step_label: args.stepLabel,
    provider: args.provider,
    model: args.model,
    tokens_in: args.tokensIn,
    tokens_out: args.tokensOut,
    tokens_cached_read: args.tokensCachedRead ?? 0,
    tokens_cached_write: args.tokensCachedWrite ?? 0,
    cost_usd: cost.costUsd,
    started_at: args.startedAt.toISOString(),
    finished_at: args.finishedAt.toISOString(),
    error: args.error ?? null,
  });
  if (error) {
    console.warn("metering: recordLlmCall insert failed", error);
  }
}

export async function recordToolInvocation(
  supabase: SupabaseClient,
  args: {
    runId: string;
    tenantId: string;
    toolKey: string;
    startedAt: Date;
    finishedAt: Date;
    externalUnits?: number;
    externalCostUsd?: number;
    ok: boolean;
    error?: string;
  }
): Promise<void> {
  const { error } = await supabase.from("tool_invocations").insert({
    run_id: args.runId,
    tenant_id: args.tenantId,
    tool_key: args.toolKey,
    started_at: args.startedAt.toISOString(),
    finished_at: args.finishedAt.toISOString(),
    external_units: args.externalUnits ?? null,
    external_cost_estimate_usd: args.externalCostUsd ?? null,
    ok: args.ok,
    error: args.error ?? null,
  });
  if (error) {
    console.warn("metering: recordToolInvocation insert failed", error);
  }
}
