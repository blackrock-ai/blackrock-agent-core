import type { ModelProvider } from "./types";

/**
 * What `callModel` returns. Beyond text, we return raw usage and provider
 * metadata; metering persistence + billing logic is handled upstream.
 */
export interface ModelCallResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  tokensCachedRead?: number;
  tokensCachedWrite?: number;
  finishReason?: string;
  providerMetadata?: Record<string, unknown>;
}

/**
 * The single LLM integration point for the whole runtime.
 * Planner, synthesizer and critic all call through here.
 */
export async function callModel(opts: {
  provider: ModelProvider;
  apiKey: string;
  model: string;
  system: string;
  prompt: string;
}): Promise<ModelCallResult> {
  if (opts.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 4096,
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    const text = (data.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    const tokensIn = numberOr(data?.usage?.input_tokens, 0);
    const tokensOut = numberOr(data?.usage?.output_tokens, 0);
    const tokensCachedRead = numberOr(data?.usage?.cache_read_input_tokens, 0);
    const tokensCachedWrite = numberOr(data?.usage?.cache_creation_input_tokens, 0);
    return {
      text,
      tokensIn,
      tokensOut,
      tokensCachedRead,
      tokensCachedWrite,
      finishReason: typeof data?.stop_reason === "string" ? data.stop_reason : undefined,
      providerMetadata: { usage: data?.usage ?? null, id: data?.id ?? null },
    };
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  const tokensIn = numberOr(data?.usage?.prompt_tokens, 0);
  const tokensOut = numberOr(data?.usage?.completion_tokens, 0);
  return {
    text,
    tokensIn,
    tokensOut,
    tokensCachedRead: 0,
    tokensCachedWrite: 0,
    finishReason: typeof data?.choices?.[0]?.finish_reason === "string" ? data.choices[0].finish_reason : undefined,
    providerMetadata: { usage: data?.usage ?? null, id: data?.id ?? null },
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Pull the first JSON object out of a model response. */
export function extractJson(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON in response");
  return JSON.parse(raw.slice(start, end + 1));
}
