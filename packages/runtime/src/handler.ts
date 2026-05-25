import { ToolRegistry, builtins } from "@blackrock-ai/agent-tools";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { plan } from "./planner";
import { execute } from "./executor";
import { synthesize } from "./synthesizer";
import { critique } from "./critic";
import { loadTenantContext } from "./context";
import { formatSse } from "./events";
import type { AgentEvent } from "./events";
import {
  finalizeRun,
  recordMessage,
  recordRunStart,
  recordToolResults,
} from "./persistence";
import type { AgentResult, RunContext, TaskGraph, ToolResult, TokenUsage } from "./types";
import { authorizeRuntimeTenant, decodeJwtClaimsFromAuthHeader } from "./auth";
import { checkRateLimit } from "./rate-limiter";
import { AuditBatch } from "./audit";
import { loadQuotaState } from "./quota";
import { AGENT_CORE_SCHEMA } from "./constants";

declare const Deno: { env: { get(name: string): string | undefined } };

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-agent-core-impersonate-tenant, x-forwarded-for",
  "access-control-allow-methods": "POST, OPTIONS",
};

export const RUN_BUDGET = {
  MAX_TASKS_PER_GRAPH: 20,
  MAX_TOOL_CALLS_PER_RUN: 30,
  MAX_TOKENS_PER_RUN: 100_000,
  MAX_COST_PER_RUN_USD: 1.0,
  MAX_RUN_WALL_TIME_MS: 45_000,
} as const;

const SSE_HEADERS: Record<string, string> = {
  ...CORS,
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

export interface HandlerOptions {
  loadTenantContext?: (
    tenantId: string,
    model: string
  ) => Promise<Omit<RunContext, "registry">>;
  registry?: ToolRegistry;
  planner?: typeof plan;
  executor?: typeof execute;
  synthesizer?: typeof synthesize;
  critic?: typeof critique;
  recordRunStart?: typeof recordRunStart;
  recordMessage?: typeof recordMessage;
  recordToolResults?: (runId: string, tenantId: string, results: ToolResult[]) => Promise<number>;
  finalizeRun?: (input: {
    runId: string;
    tenantId: string;
    status: "completed" | "failed";
    usage: TokenUsage;
    taskGraph?: TaskGraph;
    error?: string;
  }) => Promise<boolean>;
}

function defaultRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of builtins) r.register(t);
  return r;
}

function readEnv(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(n: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  return g.Deno?.env.get(name) ?? g.process?.env?.[name];
}

// any: schema-parameterized SupabaseClient type from createClient is wider than
// the imported default SupabaseClient alias in this file.
let cachedSupabase: any = null;
function getServiceSupabase(): SupabaseClient | null {
  if (cachedSupabase) return cachedSupabase;
  const url = readEnv("SUPABASE_URL");
  const key = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  cachedSupabase = createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: AGENT_CORE_SCHEMA },
  });
  return cachedSupabase;
}

async function devEnvLoadContext(
  tenantId: string,
  model: string
): Promise<Omit<RunContext, "registry">> {
  const provider =
    (Deno.env.get("AGENT_MODEL_PROVIDER") as "anthropic" | "openai") ?? "anthropic";
  const apiKey = Deno.env.get(provider === "anthropic" ? "ANTHROPIC_KEY" : "OPENAI_KEY") ?? "";
  return {
    tenantId,
    model: model || Deno.env.get("AGENT_MODEL") || "claude-sonnet-4-5",
    modelProvider: provider,
    apiKey,
  };
}

function randomRunId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  (globalThis.crypto as Crypto).getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function firstForwardedIp(req: Request): string {
  const raw = req.headers.get("x-forwarded-for");
  if (!raw) return "unknown";
  return raw.split(",")[0]?.trim() || "unknown";
}

export function createAgentHandler(opts: HandlerOptions = {}) {
  const customLoad = opts.loadTenantContext;
  const registry = opts.registry ?? defaultRegistry();
  const planner = opts.planner ?? plan;
  const executor = opts.executor ?? execute;
  const synthesizer = opts.synthesizer ?? synthesize;
  const critic = opts.critic ?? critique;
  const persistRunStart = opts.recordRunStart ?? recordRunStart;
  const persistMessage = opts.recordMessage ?? recordMessage;
  const persistToolResults = opts.recordToolResults ?? recordToolResults;
  const persistFinalizeRun = opts.finalizeRun ?? finalizeRun;

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

    let tenantId: string;
    let message: string;
    let model = "";
    try {
      const rawBody = await req.arrayBuffer();
      if (rawBody.byteLength > 256 * 1024) {
        return jsonResponse({ error: "payload too large" }, 413);
      }
      const parsed = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
      const bodyTenantId = typeof parsed.tenantId === "string" ? parsed.tenantId : "";
      if (!bodyTenantId) return jsonResponse({ error: "tenantId and message are required" }, 400);
      if (typeof parsed.message !== "string") return jsonResponse({ error: "message must be a string" }, 400);
      message = parsed.message;
      if (parsed.model !== undefined && typeof parsed.model !== "string") return jsonResponse({ error: "model must be a string" }, 400);
      model = typeof parsed.model === "string" ? parsed.model : "";
      const tenantAuth = authorizeRuntimeTenant(bodyTenantId, req.headers);
      if (!tenantAuth.ok) return jsonResponse({ error: tenantAuth.error }, tenantAuth.status);
      tenantId = tenantAuth.tenantId;
      if (message.length > 100_000) return jsonResponse({ error: "message too long" }, 400);
      if (model.length > 64) return jsonResponse({ error: "model too long" }, 400);
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }

    const supabase = getServiceSupabase();

    const claims = decodeJwtClaimsFromAuthHeader(req.headers.get("authorization"));
    const subjectTenant = `tenant:${tenantId}`;
    const subjectUser = `user:${claims?.sub ?? "unknown"}`;
    const subjectIp = `ip:${firstForwardedIp(req)}`;
    if (supabase) {
      const rateChecks = await Promise.allSettled([
        checkRateLimit({ supabase, tenantId, subject: subjectTenant, windowSecs: 60, limit: 60 }),
        checkRateLimit({ supabase, tenantId, subject: subjectUser, windowSecs: 60, limit: 30 }),
        checkRateLimit({ supabase, tenantId, subject: subjectIp, windowSecs: 60, limit: 100 }),
      ]);

      const denied = rateChecks
        .map((r, idx) => ({ r, subject: [subjectTenant, subjectUser, subjectIp][idx]! }))
        .find((entry) => entry.r.status === "fulfilled" && entry.r.value.ok === false);

      if (denied && denied.r.status === "fulfilled") {
        await supabase.rpc("record_audit_event", {
          p_tenant: tenantId,
          p_event: "rate_limit_triggered",
          p_severity: "warn",
          p_subject: denied.subject,
          p_meta: { retry_after_sec: denied.r.value.retryAfterSec ?? 1 },
        });
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: {
            ...CORS,
            "content-type": "application/json",
            "Retry-After": String(denied.r.value.retryAfterSec ?? 1),
          },
        });
      }
    }

    const ctxBasePre = await (customLoad
      ? customLoad(tenantId, model)
      : Deno.env.get("AGENT_ENV") === "dev"
        ? devEnvLoadContext(tenantId, model)
        : loadTenantContext(tenantId, model));

    if (supabase) {
      const quotaStatePre = await loadQuotaState(supabase, tenantId);
      if (quotaStatePre.paused) {
        await supabase.rpc("record_audit_event", {
          p_tenant: tenantId,
          p_event: "tenant_paused_request_denied",
          p_severity: "warn",
          p_subject: subjectTenant,
          p_meta: {},
        });
        return jsonResponse({ error: "tenant paused" }, 503);
      }

      if (!quotaStatePre.ok) {
        await supabase.rpc("record_audit_event", {
          p_tenant: tenantId,
          p_event: "quota_exceeded",
          p_severity: "warn",
          p_subject: subjectTenant,
          p_meta: { limited_by: quotaStatePre.limitedBy },
        });
        return jsonResponse({ error: `quota: ${quotaStatePre.limitedBy ?? "unknown"}` }, 429);
      }
    }

    const runId = randomRunId();
    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: AgentEvent) => {
          if (closed) return;
          controller.enqueue(encoder.encode(formatSse(event)));
        };

        let tokensIn = 0;
        let tokensOut = 0;
        let cost = 0;
        let toolCallCount = 0;
        const runStartedAt = Date.now();
        let finalGraph: AgentResult["taskGraph"] | undefined;
        let runStatus: "completed" | "failed" = "failed";
        let runError: string | undefined;
        const auditBatch = supabase ? new AuditBatch(supabase) : null;

        try {
          emit({ type: "start", runId, tenantId });

          const ctx: RunContext = { ...ctxBasePre, registry };

          await persistRunStart({
            runId,
            tenantId,
            model: ctx.model,
            modelProvider: ctx.modelProvider,
            userMessage: message,
          });

          const failBudget = (reason: string): false => {
            runStatus = "failed";
            runError = reason;
            emit({ type: "error", message: reason });
            return false;
          };

          const checkBudget = (): boolean => {
            if (Date.now() - runStartedAt > RUN_BUDGET.MAX_RUN_WALL_TIME_MS) return failBudget("run budget: wall time exceeded");
            if (toolCallCount > RUN_BUDGET.MAX_TOOL_CALLS_PER_RUN) return failBudget("run budget: too many tool calls");
            if (tokensIn + tokensOut > RUN_BUDGET.MAX_TOKENS_PER_RUN) return failBudget("run budget: token cap exceeded");
            if (cost > RUN_BUDGET.MAX_COST_PER_RUN_USD) return failBudget("run budget: cost cap exceeded");
            return true;
          };

          const addUsage = (u: { tokensIn: number; tokensOut: number; cost: number }): boolean => {
            tokensIn += u.tokensIn;
            tokensOut += u.tokensOut;
            cost += u.cost;
            return checkBudget();
          };

          if (!checkBudget()) return;
          const planned = await planner(ctx, message);
          if (!addUsage(planned.usage)) return;

          let graph: TaskGraph = planned.graph;
          if (graph.tasks.length > RUN_BUDGET.MAX_TASKS_PER_GRAPH) {
            graph = { ...graph, tasks: graph.tasks.slice(0, RUN_BUDGET.MAX_TASKS_PER_GRAPH) };
            emit({ type: "plan_truncated", original: planned.graph.tasks.length, kept: RUN_BUDGET.MAX_TASKS_PER_GRAPH });
          }
          finalGraph = graph;
          emit({ type: "plan", graph });

          await persistMessage({
            runId,
            tenantId,
            role: "assistant",
            content: { kind: "plan", graph, usage: planned.usage },
          });

          const results = await executor(ctx, graph, {
            onEvent: emit,
            onWaveComplete: (completedCount) => {
              toolCallCount = completedCount;
              return checkBudget();
            },
          });
          if (runStatus === "failed") return;

          await persistToolResults(runId, tenantId, results);

          const drafted = await synthesizer(ctx, message, results);
          if (!addUsage(drafted.usage)) return;
          let answer = drafted.text;
          emit({ type: "answer", text: answer });

          const verdict = await critic(ctx, message, answer, results);
          if (!addUsage(verdict.usage)) return;
          emit({ type: "critic", ok: verdict.ok, notes: verdict.notes });

          if (!verdict.ok) {
            const corrected = await synthesizer(ctx, `${message}\n\nVerifier feedback to address: ${verdict.notes}`, results);
            if (!addUsage(corrected.usage)) return;
            answer = corrected.text;
            emit({ type: "answer", text: answer });
          }

          const result: AgentResult = {
            answer,
            verified: verdict.ok,
            criticNotes: verdict.notes,
            taskGraph: graph,
            results,
            usage: { tokensIn, tokensOut, cost },
          };

          emit({
            type: "final",
            result,
            budget_used: {
              tokens: tokensIn + tokensOut,
              cost,
              tool_calls: toolCallCount,
              duration_ms: Date.now() - runStartedAt,
            },
          });

          runStatus = "completed";
        } catch (e) {
          console.error("agent-handler error:", e);
          runStatus = "failed";
          runError = redactSecrets(e instanceof Error ? e.message : String(e));
          emit({ type: "error", message: "internal error" });
        } finally {
          await persistFinalizeRun({
            runId,
            tenantId,
            status: runStatus,
            usage: { tokensIn, tokensOut, cost },
            taskGraph: finalGraph,
            error: runError,
          });
          await auditBatch?.flush();
          closed = true;
          controller.close();
        }
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  };
}

function redactSecrets(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_API_KEY]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/access_token/gi, "[REDACTED_TOKEN]")
    .replace(/refresh_token/gi, "[REDACTED_TOKEN]")
    .slice(0, 500);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}
