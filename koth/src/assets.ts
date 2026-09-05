/**
 * Game assets: the picture of a king. A token that already has an image keeps it (the king's
 * metadata is duped, image included). One that has none gets a card drawn from its stats -- an SVG
 * from this file, or a rendered creature from leCore (koth/render_asset.py) when Python and the
 * engine are available, which is the "monster rancher" half of the idea: the same numbers that made
 * the stats grow the body.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Card } from './cards.js';

const ELEMENT_COLOR: Record<Card['element'], string> = { fire: '#e0521f', water: '#2666cc', earth: '#7a5c36', air: '#bfc7d6', void: '#3b2450' };
const RARITY_COLOR: Record<Card['rarity'], string> = { common: '#9aa0a6', uncommon: '#3ab54a', rare: '#2f80ed', epic: '#9b51e0', legendary: '#f2b134' };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** A 600x840 trading card. Deterministic: same card, same bytes. */
export function cardSvg(card: Card): string {
  const el = ELEMENT_COLOR[card.element], rc = RARITY_COLOR[card.rarity];
  const bars = (['hp', 'atk', 'def', 'spd', 'luck'] as const).map((k, i) => {
    const v = card.stats[k], y = 560 + i * 44;
    return `<text x="60" y="${y + 18}" class="lbl">${k.toUpperCase()}</text><rect x="130" y="${y}" width="400" height="24" rx="6" fill="#1a1d24"/>` +
      `<rect x="130" y="${y}" width="${4 * v}" height="24" rx="6" fill="${el}"/><text x="545" y="${y + 18}" class="val">${v}</text>`;
  }).join('');
  const traits = card.traits.slice(0, 4).map((t, i) => `<text x="60" y="${470 + i * 22}" class="trait">• ${esc(t)}</text>`).join('');
  const body = creatureGlyph(card, el);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840" viewBox="0 0 600 840">
<style>.t{font:700 34px sans-serif;fill:#fff}.s{font:600 20px monospace;fill:${el}}.lbl{font:700 16px monospace;fill:#cfd3da}.val{font:700 16px monospace;fill:#fff}.trait{font:16px sans-serif;fill:#e6e8ec}.r{font:700 14px sans-serif;fill:#0d0f14;letter-spacing:2px}.p{font:700 40px monospace;fill:#fff}</style>
<rect width="600" height="840" rx="28" fill="#0d0f14"/><rect x="14" y="14" width="572" height="812" rx="22" fill="none" stroke="${rc}" stroke-width="6"/>
<rect x="40" y="40" width="520" height="360" rx="16" fill="#151922"/>${body}
<rect x="40" y="40" width="150" height="30" rx="8" fill="${rc}"/><text x="115" y="61" text-anchor="middle" class="r">${card.rarity.toUpperCase()}</text>
<text x="500" y="90" text-anchor="middle" class="p">${card.power}</text><text x="500" y="112" text-anchor="middle" class="lbl">POWER</text>
<text x="60" y="440" class="t">${esc(card.name.slice(0, 22))}</text><text x="60" y="462" class="s">$${esc(card.symbol.slice(0, 10))} · ${card.element}</text>
${traits}${bars}
<text x="60" y="800" class="lbl">KING OF THE HILL · seed ${card.seed.slice(0, 12)}</text>
</svg>`;
}

/** A blobby procedural body from the creature spec: a spine of ellipses plus limb strokes. */
function creatureGlyph(card: Card, color: string): string {
  const c = card.creature, segs = c.spine.segments, len = 380 * (c.spine.length / 2.2);
  const x0 = 300 - len / 2, y0 = 240;
  const parts: string[] = [];
  for (let i = 0; i < segs; i++) {
    const t = i / Math.max(1, segs - 1), r = 26 + 30 * Math.sin(Math.PI * t) + card.stats.hp / 8;
    const x = x0 + t * len, y = y0 - c.spine.curve * 120 * Math.sin(Math.PI * t);
    parts.push(`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${(r * 1.1).toFixed(1)}" ry="${r.toFixed(1)}" fill="${color}" opacity="0.92"/>`);
  }
  for (const l of c.limbs) {
    const x = x0 + l.at * len, ll = 150 * l.length, w = 40 * l.radius * 25;
    for (const s of [-1, 1]) {
      parts.push(`<path d="M${x.toFixed(1)} ${y0} l${(s * 18).toFixed(1)} ${(ll * 0.6).toFixed(1)} l${(s * 12).toFixed(1)} ${(ll * 0.5).toFixed(1)}" stroke="${color}" stroke-width="${w.toFixed(1)}" fill="none" stroke-linecap="round"/>`);
    }
  }
  const hx = x0 + len + 10, hr = 20 + c.head.radius * 180;
  parts.push(`<circle cx="${hx.toFixed(1)}" cy="${(y0 - 10).toFixed(1)}" r="${hr.toFixed(1)}" fill="${color}"/>`);
  parts.push(`<circle cx="${(hx + hr * 0.3).toFixed(1)}" cy="${(y0 - 18).toFixed(1)}" r="${(hr * 0.22).toFixed(1)}" fill="#fff"/><circle cx="${(hx + hr * 0.36).toFixed(1)}" cy="${(y0 - 18).toFixed(1)}" r="${(hr * 0.1).toFixed(1)}" fill="#000"/>`);
  if (c.pattern !== 'plain') {
    for (let i = 0; i < 7; i++) {
      const t = (i + 0.5) / 7, x = x0 + t * len, y = y0 - c.spine.curve * 120 * Math.sin(Math.PI * t);
      parts.push(c.pattern === 'spots'
        ? `<circle cx="${x.toFixed(1)}" cy="${(y - 8).toFixed(1)}" r="7" fill="#0d0f14" opacity="0.5"/>`
        : `<rect x="${(x - 3).toFixed(1)}" y="${(y - 36).toFixed(1)}" width="6" height="72" fill="#0d0f14" opacity="0.45"/>`);
    }
  }
  return parts.join('');
}

export interface ImageProvider {
  image(card: Card, reign: number): Promise<string | null>;
}

/**
 * Writes `<dir>/assets/<reign>.svg` (and a leCore PNG when `python` is on) and returns its public url.
 * The PNG path shells out to koth/render_asset.py with the card as JSON; any failure falls back to SVG.
 */
export class FileImageProvider implements ImageProvider {
  constructor(private dir: string, private publicUrl: string, private opts: { python?: boolean; pythonBin?: string; timeoutMs?: number } = {}) {}

  async image(card: Card, reign: number): Promise<string | null> {
    const assets = path.join(this.dir, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    const base = this.publicUrl.replace(/\/+$/, '');
    if (this.opts.python) {
      const png = path.join(assets, `${reign}.png`);
      if (await renderCreaturePng(card, png, this.opts)) return `${base}/assets/${reign}.png`;
    }
    fs.writeFileSync(path.join(assets, `${reign}.svg`), cardSvg(card));
    return `${base}/assets/${reign}.svg`;
  }
}

/** Render a creature with leCore. Resolves false (never throws) when Python or the engine is missing. */
export function renderCreaturePng(card: Card, out: string, opts: { pythonBin?: string; timeoutMs?: number } = {}): Promise<boolean> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.resolve(here, '..', 'render_asset.py');
  if (!fs.existsSync(script)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(opts.pythonBin ?? 'python3', [script, out], {
      cwd: path.resolve(here, '..', '..'),
      env: { ...process.env, PYTHONHASHSEED: '0', MPLBACKEND: 'Agg' },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, opts.timeoutMs ?? 180_000);
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { if (process.env.KOTH_DEBUG) console.error(err.slice(-800)); resolve(false); return; }
      resolve(fs.existsSync(out));
    });
    child.stdin.end(JSON.stringify(card));
  });
}
