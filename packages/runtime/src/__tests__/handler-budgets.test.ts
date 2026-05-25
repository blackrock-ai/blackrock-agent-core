import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "@blackrock-ai/agent-tools";
import { createAgentHandler, RUN_BUDGET } from "../handler";
import { parseSseChunk, type AgentEvent } from "../events";
import type { TaskGraph, ToolResult } from "../types";

function jwtForTenant(tenantId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    .toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ tenant_id: tenantId, role: "authenticated", sub: "u1" }),
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function collectEvents(res: Response): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const reader = res.body?.getReader();
  if (!reader) return events;

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  buffer += decoder.decode();

  const parsed = parseSseChunk(buffer);
  events.push(...parsed.events);
  if (parsed.remainder.trim()) {
    const tail = parseSseChunk(`${parsed.remainder}\n\n`);
    events.push(...tail.events);
  }

  return events;
}

function buildGraph(taskCount: number): TaskGraph {
  return {
    rationale: "budget test graph",
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      id: `t${i + 1}`,
      tool: "noop",
      input: { i: i + 1 },
    })),
  };
}

describe("handler run budget caps", () => {
  test("truncates oversized plan and emits plan_truncated", async () => {
    const tenantId = "11111111-1111-1111-1111-111111111111";
    let finalizedStatus: "completed" | "failed" | null = null;

    const handler = createAgentHandler({
      registry: new ToolRegistry(),
      loadTenantContext: async () => ({
        tenantId,
        model: "test-model",
        modelProvider: "anthropic",
        apiKey: "test-key",
      }),
      planner: async () => ({
        graph: buildGraph(50),
        usage: { tokensIn: 10, tokensOut: 5, cost: 0.01 },
      }),
      executor: async (_ctx, graph, opts) => {
        await opts?.onWaveComplete?.(graph.tasks.length);
        return graph.tasks.map(
          (t): ToolResult => ({ taskId: t.id, tool: t.tool, ok: true, output: { ok: true } }),
        );
      },
      synthesizer: async () => ({
        text: "ok",
        usage: { tokensIn: 1, tokensOut: 1, cost: 0.01 },
      }),
      critic: async () => ({ ok: true, notes: "", usage: { tokensIn: 1, tokensOut: 1, cost: 0.01 } }),
      recordRunStart: async () => true,
      recordMessage: async () => true,
      recordToolResults: async () => 0,
      finalizeRun: async (input) => {
        finalizedStatus = input.status;
        return true;
      },
    });

    const req = new Request("http://localhost/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${jwtForTenant(tenantId)}`,
      },
      body: JSON.stringify({ tenantId, message: "hello" }),
    });

    const res = await handler(req);
    const events = await collectEvents(res);

    const truncation = events.find((e) => e.type === "plan_truncated");
    expect(truncation).toEqual({
      type: "plan_truncated",
      original: 50,
      kept: RUN_BUDGET.MAX_TASKS_PER_GRAPH,
    });

    const planEvent = events.find((e) => e.type === "plan");
    expect(planEvent && planEvent.type === "plan" ? planEvent.graph.tasks.length : 0).toBe(20);
  });

  test("fails run when token cap is exceeded mid-stream", async () => {
    const tenantId = "22222222-2222-2222-2222-222222222222";
    let finalizedStatus: "completed" | "failed" | null = null;

    const handler = createAgentHandler({
      registry: new ToolRegistry(),
      loadTenantContext: async () => ({
        tenantId,
        model: "test-model",
        modelProvider: "anthropic",
        apiKey: "test-key",
      }),
      planner: async () => ({
        graph: buildGraph(1),
        usage: { tokensIn: 60_000, tokensOut: 40_001, cost: 0.01 },
      }),
      executor: async (_ctx, graph, opts) => {
        await opts?.onWaveComplete?.(graph.tasks.length);
        return graph.tasks.map(
          (t): ToolResult => ({ taskId: t.id, tool: t.tool, ok: true, output: { ok: true } }),
        );
      },
      synthesizer: async () => ({
        text: "should not be emitted",
        usage: { tokensIn: 0, tokensOut: 0, cost: 0 },
      }),
      critic: async () => ({ ok: true, notes: "", usage: { tokensIn: 0, tokensOut: 0, cost: 0 } }),
      recordRunStart: async () => true,
      recordMessage: async () => true,
      recordToolResults: async () => 0,
      finalizeRun: async (input) => {
        finalizedStatus = input.status;
        return true;
      },
    });

    const req = new Request("http://localhost/agent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${jwtForTenant(tenantId)}`,
      },
      body: JSON.stringify({ tenantId, message: "hello" }),
    });

    const res = await handler(req);
    const events = await collectEvents(res);

    const errorEvent = events.find(
      (e) => e.type === "error" && e.message === "run budget: token cap exceeded",
    );
    expect(errorEvent !== undefined).toBe(true);
    expect(finalizedStatus === "failed").toBe(true);
  });
});
