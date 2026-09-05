import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OpenzooClient, isDoorFailure, isTransient, extractJson, receiptOf } from '../src/openzoo.js';
import { Judge, WEIGHTS, decide } from '../src/judge.js';
import { cardFromMetrics } from '../src/cards.js';
import { emptyMetrics } from '../src/metrics.js';

function completion(content: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'x', model: 'anthropic/claude-sonnet-5', choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 120, completion_tokens: 40 }, ...extra,
  };
}
function fakeFetch(replies: unknown[], calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = []): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    const r = replies.shift();
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('openzoo receipts', () => {
  it('trusts the zoo billed figure when present', () => {
    const u = receiptOf(completion('hi', { x402: { billedUsd: 0.0037, directUsd: 0.0118 } }), 'openzoo/auto');
    expect(u.usd).toBe(0.0037); expect(u.billed).toBe(true); expect(u.model).toBe('anthropic/claude-sonnet-5');
    expect(u.inputTokens).toBe(120); expect(u.outputTokens).toBe(40);
  });
  it('accepts usage.cost and falls back to a catalog estimate otherwise', () => {
    expect(receiptOf(completion('hi', { usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.5 } }), 'm').usd).toBe(0.5);
    const est = receiptOf(completion('hi'), 'openzoo/auto');
    expect(est.billed).toBe(false); expect(est.usd).toBeCloseTo((120 * 2 + 40 * 10) / 1e6, 9);
  });
  it('extracts JSON from prose and code fences', () => {
    expect(extractJson('sure:\n```json\n{"a":1}\n```\nthanks')).toEqual({ a: 1 });
    expect(extractJson('{"a":{"b":2}} trailing')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('nope')).toThrow();
  });
});

describe('openzoo client', () => {
  it('posts OpenAI-shaped chat completions to the proxy with the bearer and context header', async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const zoo = new OpenzooClient({ baseUrl: 'http://localhost:8402/v1/', model: 'openzoo/auto', contextId: 'ctx_1', fetchImpl: fakeFetch([completion('hello')], calls) });
    const r = await zoo.chat([{ role: 'user', content: 'hi' }], { maxTokens: 50 });
    expect(r.text).toBe('hello');
    expect(calls[0].url).toBe('http://localhost:8402/v1/chat/completions');
    expect(calls[0].body.model).toBe('openzoo/auto');
    expect(calls[0].body.max_tokens).toBe(50);
    expect(calls[0].headers.authorization).toBe('Bearer sk-openzoo');
    expect(calls[0].headers['x-hrr-context']).toBe('ctx_1');
  });
  it('retries transient failures with backoff and falls through to the auto router', async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const replies: [number, unknown][] = [
      [502, { error: { message: 'upstream hiccup' } }],
      [502, { error: { message: 'again' } }],
      [502, { error: { message: 'again' } }],
      [502, { error: { message: 'again' } }],
      [200, completion('routed fine')],
    ];
    const f = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
      const [status, r] = replies.shift()!;
      return new Response(JSON.stringify(r), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const slept: number[] = [];
    const zoo = new OpenzooClient({ model: 'claude-opus-5', fetchImpl: f, attempts: 4, sleep: async (ms) => { slept.push(ms); } });
    const r = await zoo.chat([{ role: 'user', content: 'hi' }]);
    expect(r.text).toBe('routed fine');
    expect(calls.map((c) => c.body.model)).toEqual(['claude-opus-5', 'claude-opus-5', 'claude-opus-5', 'claude-opus-5', 'openzoo/auto']);
    expect(slept).toEqual([1000, 2000, 4000]);
    expect(new OpenzooClient({ model: 'openzoo/auto', fetchImpl: f }).fallbacks).toEqual(['anthropic/claude-sonnet-5', 'openai/gpt-5.6-auto', 'google/gemini-3.6-flash', 'x-ai/grok-4.6', 'deepseek/deepseek-v4-pro']);
    expect(isTransient(402)).toBe(true); expect(isTransient(503)).toBe(true); expect(isTransient(400)).toBe(false);
  });
  it('does not pay twice for a door failure: one try per model, straight down the ladder', async () => {
    const models: string[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      const m = (JSON.parse(String(init?.body)) as { model: string }).model; models.push(m);
      return m === 'x-ai/grok-4.6' ? Response.json(completion('ok'))
        : Response.json({ error: { message: `x402 door for ${m} failed (503): no door quoted ${m}: https://token4u.ai: permit2; not falling back to OpenRouter`, code: 502 } }, { status: 502 });
    }) as typeof fetch;
    const zoo = new OpenzooClient({ model: 'openzoo/auto', fetchImpl: f, sleep: async () => {} });
    expect((await zoo.chat([{ role: 'user', content: 'hi' }])).text).toBe('ok');
    expect(models).toEqual(['openzoo/auto', 'anthropic/claude-sonnet-5', 'openai/gpt-5.6-auto', 'google/gemini-3.6-flash', 'x-ai/grok-4.6']);
    expect(isDoorFailure('upstream https://agent402.tools refused payment')).toBe(false);
  });
  it('does not retry a definitive refusal on the same model, but still tries the fallback', async () => {
    const models: string[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => {
      const m = (JSON.parse(String(init?.body)) as { model: string }).model; models.push(m);
      return m === 'openzoo/auto' ? Response.json(completion('ok')) : Response.json({ error: 'bad model' }, { status: 400 });
    }) as typeof fetch;
    const zoo = new OpenzooClient({ model: 'nope', fetchImpl: f, sleep: async () => {} });
    expect((await zoo.chat([{ role: 'user', content: 'hi' }])).text).toBe('ok');
    expect(models).toEqual(['nope', 'openzoo/auto']);
  });
  it('retries JSON once, quoting the validation problem', async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const zoo = new OpenzooClient({ fetchImpl: fakeFetch([completion('not json at all'), completion('{"n": 3}')], calls) });
    const r = await zoo.chatJson([{ role: 'user', content: 'q' }], z.object({ n: z.number() }));
    expect(r.value).toEqual({ n: 3 });
    expect(calls).toHaveLength(2);
    expect(String((calls[1].body.messages as { content: string }[]).at(-1)?.content)).toMatch(/not valid JSON/);
    expect(r.usage.inputTokens).toBe(240);
  });
});

describe('judge over openzoo', () => {
  const card = cardFromMetrics({ ...emptyMetrics('A'.repeat(32)), name: 'Bonk', symbol: 'BONK', liquidityUsd: 1e6, marketCapUsd: 1e8, fdvUsd: 1e8, volume24hUsd: 5e5, buys24h: 100, sells24h: 50 });
  const c = { card, shill: { mint: card.mint, pitch: 'bonk is love', author: 'a', surface: 'cli' as const }, offchain: null };
  it('returns a typed verdict and a clamped remix', async () => {
    const verdict = { winner: 'challenger', challenger: { persuasion: 80, originality: 70, coherence: 90, degeneracy: 60 }, incumbent: { persuasion: 40, originality: 30, coherence: 50, degeneracy: 20 }, commentary: 'wow', one_liner: 'Bonk takes it' };
    const remix = { name: 'KING BONK OF THE ETERNAL HILL FOREVER', symbol: '$kingbonkers', description: 'd', tagline: 't' };
    const zoo = new OpenzooClient({ fetchImpl: fakeFetch([completion('a shill'), completion(JSON.stringify(verdict), { x402: { billedUsd: 0.002 } }), completion('```json\n' + JSON.stringify(remix) + '\n```')]) });
    const j = new Judge(zoo);
    expect((await j.shillFor(c)).text).toBe('a shill');
    const v = await j.judge(c, c, 'the king pitch');
    expect(v.verdict.winner).toBe('challenger'); expect(v.usage.usd).toBe(0.002);
    // same card both sides: the 20 % cancels and the pitch (75 vs 35) decides
    expect(v.verdict.scores).toEqual({
      challenger: { pitch: 75, fundamentals: card.power, total: Math.round((0.8 * 75 + 0.2 * card.power) * 10) / 10 },
      incumbent: { pitch: 35, fundamentals: card.power, total: Math.round((0.8 * 35 + 0.2 * card.power) * 10) / 10 },
    });
    const r = await j.remixMetadata(c, { name: 'Master Shill', symbol: 'SHILL' });
    expect(Buffer.byteLength(r.fields.name)).toBeLessThanOrEqual(32);
    expect(r.fields.symbol).toBe('KINGBONKER');
  });
});

describe('decide: pitch 80 %, card 20 %', () => {
  const side = (p: number) => ({ persuasion: p, originality: p, coherence: p, degeneracy: p });
  const base = { commentary: '', one_liner: '', winner: 'challenger' as const };
  it('weights exactly 80/20 and overrides the model', () => {
    expect(WEIGHTS).toEqual({ pitch: 0.8, fundamentals: 0.2 });
    // a great pitch on a weak coin beats a flat pitch on a strong coin: 0.8*90+0.2*10 = 74 vs 0.8*50+0.2*100 = 60
    const v = decide({ ...base, winner: 'incumbent', challenger: side(90), incumbent: side(50) }, 10, 100);
    expect(v.winner).toBe('challenger');
    expect(v.scores).toEqual({ challenger: { pitch: 90, fundamentals: 10, total: 74 }, incumbent: { pitch: 50, fundamentals: 100, total: 60 } });
    // but a merely better pitch cannot outrun a huge card gap: 0.8*60+0.2*0 = 48 vs 0.8*50+0.2*100 = 70
    expect(decide({ ...base, challenger: side(60), incumbent: side(50) }, 0, 100).winner).toBe('incumbent');
  });
  it('gives ties to the king and clamps power into 0..100', () => {
    expect(decide({ ...base, challenger: side(50), incumbent: side(50) }, 50, 50).winner).toBe('incumbent');
    expect(decide({ ...base, challenger: side(50), incumbent: side(50) }, 500, 50).scores?.challenger.fundamentals).toBe(100);
  });
});
