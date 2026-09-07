import { CHAINS, HOME_CHAIN } from './src/config.mjs';
import { loadAccount } from './src/chain.mjs';
import { deployRemote, isDeployedOn } from './src/launch.mjs';
const T='0xfd36511d0bce22426a12f0b40e5cac3d34d10360';
const meta={ name:'stacc wif omni', symbol:'SWO', tagline:'nine chains, one CA, one hat',
  logoURI:'https://j29nuoxbt8ta9e9v.public.blob.vercel-storage.com/omni/logo/2aa4e59d0978a37d.png' };
const me=loadAccount();
for (const c of CHAINS.filter(x=>x.id!==HOME_CHAIN)) {
  if (await isDeployedOn(c,T)) { console.log(`${c.short.padEnd(5)} already deployed`); continue; }
  try {
    const r=await deployRemote({ chainId:c.id, creator:me.address, ...meta });
    console.log(`${c.short.padEnd(5)} deploy requested ${r.skipped?'(skipped)':''} ${r.hash??''} ${r.address??''}`);
  } catch(e) { console.log(`${c.short.padEnd(5)} ${e.message.slice(0,120)}`); }
}
console.log('\n--- code check after deploys ---');
for (const c of CHAINS) console.log(`  ${c.short.padEnd(5)} ${await isDeployedOn(c,T)?'YES':'no'}`);
