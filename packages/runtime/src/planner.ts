import { callModel, extractJson } from "./model";
import type { RunContext, TaskGraph, TokenUsage } from "./types";

const SYSTEM = `You are the Agent Core planner. Decompose the user request into a
task graph the executor can run. Respond with STRICT JSON only, no prose:
{"rationale": string, "tasks": [{"id": string, "tool": string, "input": object, "dependsOn": string[]}]}
Use only these tools: {{TOOLS}}.
If the request needs no tool, return {"rationale": "...", "tasks": []}.`;

export interface PlanResult {
  graph: TaskGraph;
  usage: TokenUsage;
}

export async function plan(ctx: RunContext, message: string): Promise<PlanResult> {
  const tools = ctx.registry
    .list()
    .map((t) => `${t.key} (${t.description})`)
    .join("; ");
  const system = SYSTEM.replace("{{TOOLS}}", tools || "none");

  try {
    const call = await callModel({
      provider: ctx.modelProvider,
      apiKey: ctx.apiKey,
      model: ctx.model,
      system,
      prompt: message,
    });
    const parsed = extractJson(call.text) as any;
    return {
      graph: {
        rationale: parsed.rationale,
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      },
      usage: {
        tokensIn: call.tokensIn,
        tokensOut: call.tokensOut,
        cost: call.cost,
      },
    };
  } catch {
    return {
      graph: {
        rationale: "Planner produced no structured graph; answering directly.",
        tasks: [],
      },
      usage: { tokensIn: 0, tokensOut: 0, cost: 0 },
    };
  }
}
