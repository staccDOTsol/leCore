import { formatUnits } from 'viem';
import { CHAINS, HOME_CHAIN, chainById } from './src/config.mjs';
import { loadAccount } from './src/chain.mjs';
import { isDeployedOn } from './src/launch.mjs';
import { findUnmintedBurns, retryMint } from './src/bridge.mjs';
const T='0xfd36511d0bce22426a12f0b40e5cac3d34d10360';
const me=loadAccount(); const src=chainById(HOME_CHAIN);
let ok=0, pending=[];
for (const dst of CHAINS.filter(c=>c.id!==HOME_CHAIN)) {
  const has = await isDeployedOn(dst,T);
  const burns = await findUnmintedBurns({src,dst,address:me.address,lookbackBlocks:20000n}).catch(()=>[]);
  const mine = burns.filter(b=>b.token.toLowerCase()===T);
  if (!mine.length) { console.log(`${dst.short.padEnd(5)} no unminted burns found`); continue; }
  for (const b of mine) {
    if (!has) { console.log(`${dst.short.padEnd(5)} ${formatUnits(BigInt(b.amount),18)} waiting — token not deployed yet`); pending.push(dst.short); continue; }
    try { await retryMint(b); ok++; console.log(`${dst.short.padEnd(5)} minted ${formatUnits(BigInt(b.amount),18)}`); }
    catch(e) { console.log(`${dst.short.padEnd(5)} ${e.message.split('\n')[0].slice(0,110)}`); pending.push(dst.short); }
  }
}
console.log(`\n${ok} mint(s) accepted; still pending: ${[...new Set(pending)].join(', ')||'none'}`);
