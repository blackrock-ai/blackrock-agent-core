import { callModel } from "./model";
import type { RunContext, TokenUsage, ToolResult } from "./types";

const SYSTEM = `You are Agent Core's writer. Using only the tool evidence,
answer the user clearly and concisely. Do not claim anything the evidence does
not support. Write like a knowledgeable operator — never like a chatbot.`;

export interface SynthesizeResult {
  text: string;
  usage: TokenUsage;
}

export async function synthesize(
  ctx: RunContext,
  message: string,
  results: ToolResult[]
): Promise<SynthesizeResult> {
  const evidence = results
    .map(
      (r) =>
        `[${r.tool}] ${r.ok ? JSON.stringify(r.output) : "ERROR: " + r.error}`
    )
    .join("\n");

  const prompt = `User request:\n${message}\n\nTool evidence:\n${
    evidence || "(no tools were run)"
  }\n\nWrite the answer.`;

  const call = await callModel({
    provider: ctx.modelProvider,
    apiKey: ctx.apiKey,
    model: ctx.model,
    system: SYSTEM,
    prompt,
  });
  return {
    text: call.text,
    usage: {
      tokensIn: call.tokensIn,
      tokensOut: call.tokensOut,
      tokensCachedRead: call.tokensCachedRead ?? 0,
      tokensCachedWrite: call.tokensCachedWrite ?? 0,
      cost: 0,
    },
  };
}
