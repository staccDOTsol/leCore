// The Portal bridge.
//
// bridgeOut() burns on the source chain and emits BridgeOut with a nonce.
// bridgeIn() on the destination is relayer-gated (`NotRelayer`), so the bot
// cannot mint for itself — it asks omnichain.family's relayer to, exactly the
// way the site's own bridge form does. Supply is conserved 1:1 and the token
// keeps the same address on the far side.

import { decodeEventLog, parseAbiItem } from 'viem';
import { API, PORTAL, PORTAL_ABI, ERC20_ABI } from './config.mjs';
import { publicClient, walletClient } from './chain.mjs';

/** Burn `amount` on `src`, addressed to `to` on `dst`. Returns the tx hash and nonce. */
export async function bridgeOut({ src, account, token, dstChainId, to, amount }) {
  const pc = publicClient(src);
  const wc = walletClient(src, account);

  const held = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });
  if (held < amount) throw new Error(`holding ${held} on ${src.name}, cannot bridge ${amount}`);

  const hash = await wc.writeContract({
    address: PORTAL, abi: PORTAL_ABI, functionName: 'bridgeOut',
    args: [token, BigInt(dstChainId), to ?? account.address, amount],
  });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`bridgeOut reverted on ${src.name} (${hash})`);

  let nonce = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== PORTAL.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: PORTAL_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === 'BridgeOut') { nonce = ev.args.nonce; break; }
    } catch { /* not our event */ }
  }
  if (nonce === null) throw new Error('bridgeOut produced no BridgeOut event — not requesting a mint');
  return { hash, nonce, receipt };
}

/**
 * Ask the relayer to mint on the destination. This is the same POST the site's
 * bridge page makes; there is no other way in, since bridgeIn is permissioned.
 */
export async function requestMint({ srcChainId, dstChainId, srcTxHash, token, sender, to, amount, srcNonce }) {
  const res = await fetch(`${API}/api/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'bridgeIn', chainId: Number(dstChainId), srcChainId: Number(srcChainId),
      srcTxHash, token, sender, to, amount: amount.toString(), srcNonce: srcNonce.toString(),
    }),
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`relayer refused the mint (HTTP ${res.status}): ${body.slice(0, 200)}`);
  return body;
}

/** Poll the destination until the balance rises by `amount`, or time out. */
export async function waitForMint({ dst, token, to, amount, timeoutMs = 300_000, pollMs = 5_000 }) {
  const pc = publicClient(dst);
  const before = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [to] });
  const target = before + amount;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, pollMs));
    const now = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [to] }).catch(() => null);
    if (now !== null && now >= target) return { arrived: true, balance: now };
  }
  return { arrived: false, balance: null };
}

/** Full one-way move, burn through to confirmed mint. */
export async function bridge({ src, dst, account, token, amount, to = null, wait = true }) {
  const dest = to ?? account.address;
  const { hash, nonce } = await bridgeOut({ src, account, token, dstChainId: dst.id, to: dest, amount });
  await requestMint({
    srcChainId: src.id, dstChainId: dst.id, srcTxHash: hash, token,
    sender: account.address, to: dest, amount, srcNonce: nonce,
  });
  if (!wait) return { hash, nonce, arrived: null };
  const r = await waitForMint({ dst, token, to: dest, amount });
  return { hash, nonce, ...r };
}
