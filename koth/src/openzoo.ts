/**
 * openzoo (openzoo.fun) is the ONLY inference lane, by directive.
 *
 * openzoo is an OpenAI-compatible gateway paid per call over x402. The normal deployment runs the
 * local proxy (`npx openzoo`) which settles each 402 from a burner wallet and re-serves the answer,
 * so this client is nothing more than chat-completions against OPENZOO_BASE_URL. `openzoo/auto`
 * lets the zoo pick the model; the receipt it returns (model routed, USD billed) is kept so every
 * attempt's inference cost is on the ledger -- the loser pays it, per the game's rules.
 */
import { z } from 'zod';

export type OpenzooOptions = {
  /** `http://localhost:8402/v1` is the local x402-paying proxy. */
  baseUrl?: string;
  /** Any value works at the proxy: the zoo takes payment, not keys. */
  apiKey?: string;
  model?: string;
  /** Optional leCore context id (X-HRR-Context) so the zoo recalls prior threads. */
  contextId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type Usage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** What the zoo billed for the call, when it said; otherwise our own estimate. */
  usd: number;
  billed: boolean;
};

export type ChatResult = { text: string; usage: Usage; raw: Record<string, unknown> };

/** USD per million tokens, used only when the zoo did not put a price on the answer. */
export const FALLBACK_PRICES: Record<string, { input: number; output: number }> = {
  'anthropic/claude-opus-5': { input: 5, output: 25 },
  'anthropic/claude-sonnet-5': { input: 2, output: 10 },
  'anthropic/claude-haiku-4-5': { input: 1, output: 5 },
  'x-ai/grok-4.6': { input: 3, output: 15 },
  'openzoo/auto': { input: 2, output: 10 },
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Pull the routed model, token counts and billed USD out of a zoo/OpenAI-shaped completion. */
export function receiptOf(json: Record<string, unknown>, requested: string): Usage {
  const usage = (json.usage ?? {}) as Record<string, unknown>;
  const model = String(json.model ?? requested);
  const inputTokens = num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? 0;
  const outputTokens = num(usage.completion_tokens) ?? num(usage.output_tokens) ?? 0;
  const nests = [json, (json.openzoo ?? {}) as Record<string, unknown>, (json.receipt ?? {}) as Record<string, unknown>,
    (json.x402 ?? {}) as Record<string, unknown>, usage];
  let billed: number | null = null;
  for (const n of nests) {
    billed = num(n.billedUsd) ?? num(n.billed_usd) ?? num(n.costUsd) ?? num(n.cost) ?? billed;
    if (billed !== null) break;
  }
  if (billed !== null) return { model, inputTokens, outputTokens, usd: billed, billed: true };
  const p = FALLBACK_PRICES[model] ?? FALLBACK_PRICES['openzoo/auto'];
  return { model, inputTokens, outputTokens, usd: (inputTokens * p.input + outputTokens * p.output) / 1e6, billed: false };
}

export function sumUsage(list: Usage[]): Usage {
  return list.reduce((a, b) => ({
    model: b.model, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    usd: a.usd + b.usd, billed: a.billed && b.billed,
  }), { model: list[0]?.model ?? '', inputTokens: 0, outputTokens: 0, usd: 0, billed: list.length > 0 });
}

/** Find the JSON object in a model reply that may be wrapped in prose or code fences. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in reply');
  return JSON.parse(body.slice(start, end + 1));
}

export class OpenzooClient {
  readonly baseUrl: string;
  readonly model: string;
  private apiKey: string;
  private contextId: string;
  private timeoutMs: number;
  private f: typeof fetch;

  constructor(opts: OpenzooOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OPENZOO_BASE_URL ?? 'http://localhost:8402/v1').replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? process.env.OPENZOO_API_KEY ?? 'sk-openzoo';
    this.model = opts.model ?? process.env.KOTH_MODEL ?? 'openzoo/auto';
    this.contextId = opts.contextId ?? process.env.OPENZOO_CONTEXT ?? '';
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.OPENZOO_TIMEOUT_MS ?? 420_000);
    this.f = opts.fetchImpl ?? fetch;
  }

  async chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; json?: boolean } = {}): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.model, messages, max_tokens: opts.maxTokens ?? 1200, stream: false,
    };
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.json) body.response_format = { type: 'json_object' };
    const res = await this.f(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...(this.contextId ? { 'x-hrr-context': this.contextId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`openzoo ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    const choices = (json.choices ?? []) as { message?: { content?: unknown } }[];
    const content = choices[0]?.message?.content;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('')
      : '';
    return { text: text.trim(), usage: receiptOf(json, this.model), raw: json };
  }

  /** Ask for JSON matching `schema`; retries once with the validation error quoted back. */
  async chatJson<T>(messages: ChatMessage[], schema: z.ZodType<T>, opts: { maxTokens?: number } = {}): Promise<{ value: T; usage: Usage }> {
    const first = await this.chat(messages, { ...opts, json: true, temperature: 0.7 });
    const usages = [first.usage];
    let problem = '';
    try {
      return { value: schema.parse(extractJson(first.text)), usage: sumUsage(usages) };
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
    const retry = await this.chat([
      ...messages,
      { role: 'assistant', content: first.text },
      { role: 'user', content: `That was not valid JSON for the schema (${problem.slice(0, 300)}). Reply with ONLY the JSON object, no prose.` },
    ], { ...opts, json: true, temperature: 0.2 });
    usages.push(retry.usage);
    return { value: schema.parse(extractJson(retry.text)), usage: sumUsage(usages) };
  }
}
