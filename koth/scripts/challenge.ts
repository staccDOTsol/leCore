/** A challenge from the command line (dry run unless the chain is configured). Usage: challenge <mint> <pitch...> */
import { Connection } from '@solana/web3.js';
import { boot, loadKeypair } from './_env.js';
import { MasterChain, MemoryChain } from '../src/chain.js';
import { FreeEntry, Hill, MemoryStore } from '../src/hill.js';
import { Judge, MockJudge } from '../src/judge.js';
import { OpenzooClient } from '../src/openzoo.js';
import { MemoryUriProvider } from '../src/uri.js';

const { cfg } = boot();
const [mint, ...rest] = process.argv.slice(2);
if (!mint || !rest.length) { console.error('usage: challenge <mint> <pitch...>'); process.exit(2); }
const live = Boolean(cfg.masterMint && cfg.keypairPath) && process.env.KOTH_DRY_RUN !== '1';
const chain = live && cfg.masterMint
  ? new MasterChain(new Connection(cfg.rpcUrl, 'confirmed'), loadKeypair(cfg.keypairPath), cfg.masterMint, { birdeyeApiKey: cfg.birdeyeApiKey })
  : new MemoryChain({ name: 'Master Shill', symbol: 'SHILL', uri: 'memory://genesis' });
const judge = process.env.KOTH_MOCK_JUDGE === '1' ? new MockJudge() : new Judge(new OpenzooClient({ baseUrl: cfg.openzooBaseUrl, model: cfg.model }));
const hill = new Hill({ judge, chain, uri: new MemoryUriProvider(), entry: new FreeEntry(), store: new MemoryStore(), log: console.log });
const out = await hill.challenge({ mint, pitch: rest.join(' '), author: 'cli', surface: 'cli' });
console.log(JSON.stringify({ result: out.record.result, oneLiner: out.oneLiner, commentary: out.commentary, king: out.king && { reign: out.king.reign, name: out.king.name, master: out.king.master }, usage: out.record.usage }, null, 2));
