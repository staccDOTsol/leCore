import { describe, expect, it } from 'vitest';
import { TelegramSurface, inlineKeyboard } from '../src/surfaces/telegram.js';
import type { Commands, Ctx, Reply } from '../src/commands.js';

type Call = { method: string; body: Record<string, unknown> };
function fakeApi(updates: unknown[][]): { f: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let id = 100;
  const f = (async (url: unknown, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body });
    let result: unknown = { message_id: ++id };
    if (method === 'getUpdates') result = updates.shift() ?? [];
    if (method === 'answerCallbackQuery') result = true;
    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

describe('inline keyboards', () => {
  it('maps url, copy and callback buttons', () => {
    const kb = inlineKeyboard([[{ label: 'Copy', copy: 'ADDR' }, { label: 'Paid', data: 'paid:q1' }], [{ label: 'Solscan', url: 'https://x' }]]);
    expect(kb?.inline_keyboard[0][0]).toEqual({ text: 'Copy', copy_text: { text: 'ADDR' } });
    expect(kb?.inline_keyboard[0][1]).toEqual({ text: 'Paid', callback_data: 'paid:q1' });
    expect(kb?.inline_keyboard[1][0]).toEqual({ text: 'Solscan', url: 'https://x' });
    expect(inlineKeyboard([])).toBeUndefined();
  });
});

describe('telegram surface', () => {
  const seen: Ctx[] = [];
  const commands = {
    handle: async (ctx: Ctx): Promise<Reply | null> => {
      seen.push(ctx);
      if (ctx.text === 'king') return { rich: (f) => `${f.b('KING')} <x>`, image: 'https://img/king.png', buttons: [[{ label: 'Hall', data: 'cmd:hall' }]] };
      if (ctx.text === 'cmd:fee') return { rich: () => 'fee is 0.25' };
      if (ctx.text === 'paid:q1') {
        await ctx.progress?.(() => 'step 1');
        await ctx.progress?.(() => 'step 1\nstep 2');
        return { rich: () => 'won', announce: () => 'NEW KING', announceButtons: [[{ label: 'Challenge', data: 'cmd:challenge' }]] };
      }
      return null;
    },
  } as unknown as Commands;

  it('sends photos with HTML captions and keyboards, answers callbacks, edits progress, announces to the group', async () => {
    const { f, calls } = fakeApi([
      [{ update_id: 1, message: { message_id: 5, text: 'king', chat: { id: 42, type: 'group' }, from: { id: 7, username: 'alice' } } }],
      [{ update_id: 2, callback_query: { id: 'cb1', from: { id: 7, username: 'alice' }, data: 'cmd:fee', message: { message_id: 6, chat: { id: 42, type: 'group' } } } }],
      [{ update_id: 3, message: { message_id: 8, text: 'paid:q1', chat: { id: 7, type: 'private' }, from: { id: 7, username: 'alice' } } }],
    ]);
    const tg = new TelegramSurface(commands, { token: 'T', chatId: '-100', fetchImpl: f });
    expect(await tg.pollOnce(0)).toBe(1);
    expect([...tg.chats]).toEqual(['-100', '42']);
    expect(seen[0]).toMatchObject({ surface: 'telegram', author: '@alice', authorId: 'tg:7', text: 'king' });
    const photo = calls.find((c) => c.method === 'sendPhoto')!;
    expect(photo.body).toMatchObject({ chat_id: 42, photo: 'https://img/king.png', parse_mode: 'HTML', reply_to_message_id: 5 });
    expect(photo.body.caption).toBe('<b>KING</b> <x>');
    expect((photo.body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard[0][0]).toEqual({ text: 'Hall', callback_data: 'cmd:hall' });
    expect(calls[0].body).toMatchObject({ offset: 0, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });

    expect(await tg.pollOnce(0)).toBe(1);
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.body).toEqual({ callback_query_id: 'cb1' });
    expect(calls.filter((c) => c.method === 'sendMessage').at(-1)?.body).toMatchObject({ chat_id: 42, text: 'fee is 0.25', parse_mode: 'HTML' });
    expect(calls.filter((c) => c.method === 'getUpdates').at(-1)?.body.offset).toBe(2);

    expect(await tg.pollOnce(0)).toBe(1);
    const edits = calls.filter((c) => c.method === 'editMessageText');
    expect(edits).toHaveLength(1);
    expect(edits[0].body).toMatchObject({ chat_id: 7, text: 'step 1\nstep 2' });
    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends.find((c) => c.body.text === 'step 1')?.body.chat_id).toBe(7);
    expect(sends.find((c) => c.body.text === 'won')?.body.chat_id).toBe(7);
    // the takeover is announced to every known chat except the DM it happened in
    const anns = sends.filter((c) => c.body.text === 'NEW KING');
    expect(anns.map((c) => c.body.chat_id).sort()).toEqual(['-100', '42']);
    expect((anns[0].body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard[0][0]).toEqual({ text: 'Challenge', callback_data: 'cmd:challenge' });
  });

  it('remembers chats it is added to, forgets ones it leaves, and registers its command menu', async () => {
    const { f, calls } = fakeApi([
      [{ update_id: 9, my_chat_member: { chat: { id: -555, type: 'supergroup', title: 'Shillers' }, new_chat_member: { status: 'member' } } }],
      [{ update_id: 10, my_chat_member: { chat: { id: -555, type: 'supergroup', title: 'Shillers' }, new_chat_member: { status: 'kicked' } } }],
    ]);
    const tg = new TelegramSurface(commands, { token: 'T', fetchImpl: f });
    await tg.start();
    expect(calls.find((c) => c.method === 'setMyCommands')?.body).toMatchObject({ commands: expect.arrayContaining([expect.objectContaining({ command: 'shill' })]) });
    await tg.pollOnce(0);
    expect([...tg.chats]).toEqual(['-555']);
    await tg.broadcast('hello everyone');
    expect(calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.chat_id)).toEqual(['-555']);
    await tg.pollOnce(0);
    expect(tg.chats.size).toBe(0);
  });

  it('falls back to plain text when Telegram rejects the HTML', async () => {
    const calls: Call[] = [];
    let n = 0;
    const f = (async (url: unknown, init?: RequestInit) => {
      const method = String(url).split('/').pop()!;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ method, body });
      n += 1;
      if (method === 'sendMessage' && n === 1) return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }) as typeof fetch;
    const tg = new TelegramSurface(commands, { token: 'T', fetchImpl: f });
    await tg.send(1, { rich: (fm) => fm.b('x') });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.text).toBe('x');
    expect(calls[1].body.parse_mode).toBeUndefined();
  });
});
