/** Telegram: Bot API long polling, no library. Commands come from groups or DMs; takeovers are announced to the group. */
import type { Commands, Reply } from '../commands.js';

export type TelegramOpts = { token: string; chatId?: string; log?: (s: string) => void; fetchImpl?: typeof fetch };

export class TelegramSurface {
  private offset = 0;
  private stopped = false;
  private f: typeof fetch;
  constructor(private commands: Commands, private o: TelegramOpts) { this.f = o.fetchImpl ?? fetch; }

  private api(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.f(`https://api.telegram.org/bot${this.o.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(70_000),
    }).then(async (r) => (await r.json()) as Record<string, unknown>);
  }

  async send(chatId: string | number, reply: Reply): Promise<void> {
    if (reply.image && /^https?:\/\//.test(reply.image)) {
      const r = await this.api('sendPhoto', { chat_id: chatId, photo: reply.image, caption: reply.text.slice(0, 1024) });
      if (r.ok) { if (reply.text.length > 1024) await this.api('sendMessage', { chat_id: chatId, text: reply.text.slice(1024, 4096) }); return; }
    }
    await this.api('sendMessage', { chat_id: chatId, text: reply.text.slice(0, 4096), disable_web_page_preview: true });
  }

  /** Post to the configured group (takeover announcements, the master shillbot's cadence posts). */
  async broadcast(text: string, image?: string | null): Promise<void> {
    if (!this.o.chatId) return;
    await this.send(this.o.chatId, { text, image });
  }

  async poll(): Promise<void> {
    while (!this.stopped) {
      try {
        const r = await this.api('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message'] });
        for (const u of (r.result as { update_id: number; message?: { text?: string; chat: { id: number }; from?: { id: number; username?: string; first_name?: string } } }[]) ?? []) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m?.text || !m.from) continue;
          const author = m.from.username ? `@${m.from.username}` : m.from.first_name ?? String(m.from.id);
          const reply = await this.commands.handle({ surface: 'telegram', author, authorId: `tg:${m.from.id}`, text: m.text });
          if (!reply) continue;
          await this.send(m.chat.id, reply);
          if (reply.announce && this.o.chatId && String(m.chat.id) !== String(this.o.chatId)) await this.broadcast(reply.announce, reply.image);
        }
      } catch (e) {
        this.o.log?.(`telegram poll error: ${e instanceof Error ? e.message : e}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop(): void { this.stopped = true; }
}
