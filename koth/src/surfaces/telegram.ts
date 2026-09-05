/**
 * Telegram: Bot API long polling, no library. The first surface, and the one the design was drawn
 * for: HTML-formatted messages, inline keyboards (buttons send commands; "Copy address" uses the
 * native copy_text button), the king's card as a photo with a caption, and a settlement message
 * that edits itself as each step lands. Commands come from groups or DMs; takeovers and the master
 * shillbot's cadence posts are announced to the configured group.
 */
import { html, plain, type Button, type Commands, type Reply, type Rich } from '../commands.js';

export type TelegramOpts = { token: string; chatId?: string; log?: (s: string) => void; fetchImpl?: typeof fetch };

type TgUser = { id: number; username?: string; first_name?: string };
type TgMessage = { message_id: number; text?: string; chat: { id: number; type: string }; from?: TgUser };
type TgUpdate = { update_id: number; message?: TgMessage; callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string } };

const CAPTION_MAX = 1024;
const TEXT_MAX = 4096;

export function inlineKeyboard(buttons?: Button[][]): { inline_keyboard: Record<string, unknown>[][] } | undefined {
  if (!buttons?.length) return undefined;
  return {
    inline_keyboard: buttons.map((row) => row.map((b) =>
      b.url ? { text: b.label, url: b.url }
        : b.copy ? { text: b.label, copy_text: { text: b.copy } }
          : { text: b.label, callback_data: (b.data ?? b.label).slice(0, 64) })),
  };
}

export class TelegramSurface {
  private offset = 0;
  private stopped = false;
  private f: typeof fetch;
  constructor(private commands: Commands, private o: TelegramOpts) { this.f = o.fetchImpl ?? fetch; }

  async api(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
    const r = await this.f(`https://api.telegram.org/bot${this.o.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(70_000),
    });
    return (await r.json()) as { ok: boolean; result?: unknown; description?: string };
  }

  private author(u: TgUser): { author: string; authorId: string } {
    return { author: u.username ? `@${u.username}` : u.first_name ?? String(u.id), authorId: `tg:${u.id}` };
  }

  /** Send a reply: photo + caption when there is an image, else a text message. Returns the message id. */
  async send(chatId: string | number, reply: Reply, replyTo?: number): Promise<number | undefined> {
    const text = html(reply.rich);
    const reply_markup = inlineKeyboard(reply.buttons);
    const common = { chat_id: chatId, parse_mode: 'HTML', ...(reply_markup ? { reply_markup } : {}), ...(replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {}) };
    if (reply.image && /^https?:\/\//.test(reply.image)) {
      const caption = text.length <= CAPTION_MAX ? text : text.slice(0, CAPTION_MAX - 1) + '…';
      const r = await this.api('sendPhoto', { ...common, photo: reply.image, caption });
      if (r.ok) {
        const id = (r.result as TgMessage).message_id;
        if (text.length > CAPTION_MAX) await this.api('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: text.slice(CAPTION_MAX - 1, TEXT_MAX), disable_web_page_preview: true });
        return id;
      }
      this.o.log?.(`telegram sendPhoto failed (${r.description}); sending text`);
    }
    let r = await this.api('sendMessage', { ...common, text: text.slice(0, TEXT_MAX), disable_web_page_preview: true });
    if (!r.ok && /parse/i.test(r.description ?? '')) {
      r = await this.api('sendMessage', { chat_id: chatId, text: plain(reply.rich).slice(0, TEXT_MAX), ...(reply_markup ? { reply_markup } : {}), disable_web_page_preview: true });
    }
    if (!r.ok) this.o.log?.(`telegram sendMessage failed: ${r.description}`);
    return r.ok ? (r.result as TgMessage).message_id : undefined;
  }

  async edit(chatId: string | number, messageId: number, rich: Rich): Promise<void> {
    const r = await this.api('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', text: html(rich).slice(0, TEXT_MAX), disable_web_page_preview: true });
    if (!r.ok && !/not modified/i.test(r.description ?? '')) this.o.log?.(`telegram edit failed: ${r.description}`);
  }

  /** Post to the configured group: takeover announcements and the master shillbot's cadence posts. */
  async broadcast(text: string | Rich, image?: string | null, buttons?: Button[][]): Promise<void> {
    if (!this.o.chatId) return;
    const rich: Rich = typeof text === 'string' ? (f) => f.esc(text) : text;
    await this.send(this.o.chatId, { rich, image, buttons });
  }

  private async dispatch(chatId: number, u: TgUser, text: string, replyTo?: number): Promise<void> {
    let statusId: number | undefined;
    const progress = async (rich: Rich) => {
      if (statusId === undefined) statusId = await this.send(chatId, { rich }, replyTo);
      else await this.edit(chatId, statusId, rich);
    };
    const reply = await this.commands.handle({ surface: 'telegram', ...this.author(u), text, progress });
    if (!reply) return;
    await this.send(chatId, reply, replyTo);
    if (reply.announce && this.o.chatId && String(chatId) !== String(this.o.chatId)) {
      await this.send(this.o.chatId, { rich: reply.announce, image: reply.image, buttons: reply.announceButtons });
    } else if (reply.announce && this.o.chatId && reply.announceButtons) {
      await this.send(this.o.chatId, { rich: reply.announce, image: reply.image, buttons: reply.announceButtons });
    }
  }

  /** One getUpdates round. Exposed so tests can drive it. */
  async pollOnce(timeout = 50): Promise<number> {
    const r = await this.api('getUpdates', { offset: this.offset, timeout, allowed_updates: ['message', 'callback_query'] });
    const updates = (r.result as TgUpdate[] | undefined) ?? [];
    for (const u of updates) {
      this.offset = u.update_id + 1;
      try {
        if (u.callback_query) {
          const cq = u.callback_query;
          await this.api('answerCallbackQuery', { callback_query_id: cq.id });
          if (cq.data && cq.message) await this.dispatch(cq.message.chat.id, cq.from, cq.data, cq.message.message_id);
        } else if (u.message?.text && u.message.from) {
          await this.dispatch(u.message.chat.id, u.message.from, u.message.text, u.message.chat.type === 'private' ? undefined : u.message.message_id);
        }
      } catch (e) {
        this.o.log?.(`telegram update ${u.update_id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    return updates.length;
  }

  async poll(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (e) {
        this.o.log?.(`telegram poll error: ${e instanceof Error ? e.message : e}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop(): void { this.stopped = true; }
}
