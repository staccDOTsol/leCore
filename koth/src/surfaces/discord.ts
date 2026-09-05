/** Discord: discord.js gateway client. Commands in any channel the bot can read; announcements to one channel. */
import { Client, GatewayIntentBits, type TextChannel } from 'discord.js';
import type { Commands, Reply } from '../commands.js';

export type DiscordOpts = { token: string; channelId?: string; log?: (s: string) => void };

export class DiscordSurface {
  readonly client: Client;
  constructor(private commands: Commands, private o: DiscordOpts) {
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });
  }

  private payload(reply: Reply): { content: string; files?: string[] } {
    const content = reply.text.slice(0, 2000);
    return reply.image && /^https?:\/\//.test(reply.image) ? { content, files: [reply.image] } : { content };
  }

  async broadcast(text: string, image?: string | null): Promise<void> {
    if (!this.o.channelId) return;
    const ch = await this.client.channels.fetch(this.o.channelId).catch(() => null);
    if (ch && ch.isTextBased()) await (ch as TextChannel).send(this.payload({ text, image }));
  }

  async start(): Promise<void> {
    this.client.on('messageCreate', async (m) => {
      if (m.author.bot) return;
      const mentioned = this.client.user ? m.mentions.has(this.client.user) : false;
      if (!m.content.startsWith('/') && !mentioned && !/^(king|hall|fee|shill|paid|help)\b/i.test(m.content)) return;
      const reply = await this.commands.handle({ surface: 'discord', author: m.author.username, authorId: `dc:${m.author.id}`, text: m.content });
      if (!reply) return;
      await m.reply(this.payload(reply)).catch((e) => this.o.log?.(`discord reply failed: ${e}`));
      if (reply.announce && this.o.channelId && m.channelId !== this.o.channelId) await this.broadcast(reply.announce, reply.image);
    });
    await this.client.login(this.o.token);
    this.o.log?.(`discord: logged in as ${this.client.user?.tag}`);
  }

  stop(): void { this.client.destroy(); }
}
