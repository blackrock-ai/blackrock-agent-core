import type { ModelProvider } from "./types";

/**
 * What `callModel` returns. Beyond the text response, we surface the token
 * counts reported by the IdP so the orchestrator can accumulate per-run
 * usage and write it into agent_runs.
 *
 * `cost` is a rough per-call estimate in USD using a fixed price table —
 * good enough for back-of-envelope dashboards, not authoritative. Callers
 * that need precise billing should source costs from the IdP invoice.
 */
export interface ModelCallResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

interface ModelPriceRow {
  input: number;
  output: number;
}

// Rough USD-per-token pricing. Tighten as needed; ANY model not in the table
// gets a default of zero so we never invent dollar figures.
const PRICE_PER_TOKEN: Record<string, ModelPriceRow> = {
  // Anthropic — Claude 4.x families.
  "claude-opus-4-7": { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  "claude-opus-4-6": { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  "claude-sonnet-4-6": { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  "claude-sonnet-4-5": { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  "claude-haiku-4-5": { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  // OpenAI — common families.
  "gpt-4o": { input: 5 / 1_000_000, output: 15 / 1_000_000 },
  "gpt-4o-mini": { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 },
  "o1": { input: 15 / 1_000_000, output: 60 / 1_000_000 },
  "o1-mini": { input: 3 / 1_000_000, output: 12 / 1_000_000 },
  "o3": { input: 60 / 1_000_000, output: 240 / 1_000_000 },
};

function estimateCost(
  model: string,
  tokensIn: number,
  tokensOut: number
): number {
  // Walk the price table picking the LONGEST prefix that matches — so
  // "claude-sonnet-4-5-20251022" still resolves to "claude-sonnet-4-5".
  let bestKey = "";
  for (const key of Object.keys(PRICE_PER_TOKEN)) {
    if (model.startsWith(key) && key.length > bestKey.length) bestKey = key;
  }
  const row = bestKey ? PRICE_PER_TOKEN[bestKey] : undefined;
  if (!row) return 0;
  return tokensIn * row.input + tokensOut * row.output;
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
    return {
      text,
      tokensIn,
      tokensOut,
      cost: estimateCost(opts.model, tokensIn, tokensOut),
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
    cost: estimateCost(opts.model, tokensIn, tokensOut),
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
