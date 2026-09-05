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
  /** Models to try after `model` fails; default `openzoo/auto`. */
  fallbacks?: string[];
  /** Tries per model on transient failures; default 4 (1s, 2s, 4s backoff). */
  attempts?: number;
  log?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
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

/** Errors worth another try: the zoo or a door behind it hiccupped, or a payment door refused (402 upstream). */
export function isTransient(status: number): boolean {
  return status === 402 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * The gateway's "x402 door for <model> failed": it shopped every upstream door for that model and none
 * could be paid. That is deterministic for the model and, worse, the gateway settles our payment
 * before it finds out -- so retrying the same model only pays again for the same failure. Move on.
 */
export function isDoorFailure(message: string): boolean {
  return /x402 door for .+ failed|no door quoted/i.test(message);
}

/**
 * Where a completion goes when the configured model's doors cannot be paid: the auto router, then
 * one strong model per provider, so a dead door on one side of the zoo does not decide a fight.
 */
export const DEFAULT_FALLBACKS = ['openzoo/auto', 'anthropic/claude-sonnet-5', 'openai/gpt-5.6-auto', 'google/gemini-3.6-flash', 'x-ai/grok-4.6', 'deepseek/deepseek-v4-pro'];

export class OpenzooClient {
  readonly baseUrl: string;
  readonly model: string;
  /** Models to fall through to when `model` keeps failing; `openzoo/auto` lets the zoo route around a dead door. */
  readonly fallbacks: string[];
  private apiKey: string;
  private contextId: string;
  private timeoutMs: number;
  private attempts: number;
  private f: typeof fetch;
  private log: (s: string) => void;
  private sleep: (ms: number) => Promise<void>;

  constructor(opts: OpenzooOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OPENZOO_BASE_URL ?? 'http://localhost:8402/v1').replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? process.env.OPENZOO_API_KEY ?? 'sk-openzoo';
    this.model = opts.model ?? process.env.KOTH_MODEL ?? 'openzoo/auto';
    const fb = opts.fallbacks ?? (process.env.KOTH_MODEL_FALLBACKS ?? DEFAULT_FALLBACKS.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
    this.fallbacks = fb.filter((m) => m !== this.model);
    this.contextId = opts.contextId ?? process.env.OPENZOO_CONTEXT ?? '';
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.OPENZOO_TIMEOUT_MS ?? 420_000);
    this.attempts = opts.attempts ?? Number(process.env.OPENZOO_ATTEMPTS ?? 3);
    this.f = opts.fetchImpl ?? fetch;
    this.log = opts.log ?? (() => {});
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * One completion, however many tries it takes: `attempts` per model with backoff on transient
   * failures (5xx, 429, a 402 from a payment door, a dropped connection), then the same on each
   * fallback model. Only a definitive answer (2xx) or a non-transient refusal ends it early.
   */
  async chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; json?: boolean } = {}): Promise<ChatResult> {
    let last: Error = new Error('openzoo: no attempt made');
    for (const model of [this.model, ...this.fallbacks]) {
      for (let i = 1; i <= this.attempts; i++) {
        try {
          return await this.once(model, messages, opts);
        } catch (e) {
          last = e instanceof Error ? e : new Error(String(e));
          const status = (e as { status?: number }).status ?? 0;
          const transient = !isDoorFailure(last.message) && (status === 0 || isTransient(status));
          this.log(`openzoo ${model} attempt ${i}/${this.attempts} failed${transient ? '' : ' (not retrying this model)'}: ${last.message.slice(0, 200)}`);
          if (!transient) break;
          if (i < this.attempts) await this.sleep(Math.min(15_000, 1000 * 2 ** (i - 1)));
        }
      }
    }
    throw last;
  }

  private async once(model: string, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; json?: boolean }): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model, messages, max_tokens: opts.maxTokens ?? 1200, stream: false,
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
    if (!res.ok) throw Object.assign(new Error(`openzoo ${res.status}: ${JSON.stringify(json).slice(0, 300)}`), { status: res.status });
    const choices = (json.choices ?? []) as { message?: { content?: unknown } }[];
    const content = choices[0]?.message?.content;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('')
      : '';
    if (!text.trim()) throw Object.assign(new Error(`openzoo: empty reply from ${model}`), { status: 502 });
    return { text: text.trim(), usage: receiptOf(json, model), raw: json };
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
