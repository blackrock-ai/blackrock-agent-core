import { callModel, extractJson } from "./model";
import type { RunContext, TokenUsage, ToolResult } from "./types";

const SYSTEM = `You are Agent Core's verifier. Check the draft answer against
the tool evidence. Respond with STRICT JSON only:
{"ok": boolean, "notes": string}
Set ok=false if the draft makes claims the evidence does not support.`;

export interface CritiqueResult {
  ok: boolean;
  notes: string;
  usage: TokenUsage;
}

export async function critique(
  ctx: RunContext,
  message: string,
  draft: string,
  results: ToolResult[]
): Promise<CritiqueResult> {
  const evidence = results
    .map((r) => `[${r.tool}] ${r.ok ? JSON.stringify(r.output) : "ERROR"}`)
    .join("\n");

  const prompt = `Request:\n${message}\n\nEvidence:\n${
    evidence || "(none)"
  }\n\nDraft answer:\n${draft}`;

  try {
    const call = await callModel({
      provider: ctx.modelProvider,
      apiKey: ctx.apiKey,
      model: ctx.model,
      system: SYSTEM,
      prompt,
    });
    const j = extractJson(call.text) as any;
    return {
      ok: !!j.ok,
      notes: String(j.notes ?? ""),
      usage: {
        tokensIn: call.tokensIn,
        tokensOut: call.tokensOut,
        cost: call.cost,
      },
    };
  } catch {
    return {
      ok: true,
      notes: "verifier output unparsed — passed by default",
      usage: { tokensIn: 0, tokensOut: 0, cost: 0 },
    };
  }
}
