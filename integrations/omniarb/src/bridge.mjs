// The Portal bridge.
//
// bridgeOut() burns on the source chain and emits BridgeOut with a nonce.
// bridgeIn() on the destination is relayer-gated (`NotRelayer`), so the bot
// cannot mint for itself — it asks omnichain.family's relayer to, exactly the
// way the site's own bridge form does. Supply is conserved 1:1 and the token
// keeps the same address on the far side.

import { readFileSync, writeFileSync } from 'node:fs';
import { decodeEventLog } from 'viem';
import { API, PORTAL, PORTAL_ABI, ERC20_ABI } from './config.mjs';
import { publicClient, walletClient } from './chain.mjs';
import { getLogsChunked } from './discovery.mjs';

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
  const claim = {
    srcChainId: src.id, dstChainId: dst.id, srcTxHash: hash, token,
    sender: account.address, to: dest, amount: amount.toString(), srcNonce: nonce.toString(),
  };
  try {
    await requestMint({ ...claim, amount, srcNonce: nonce });
  } catch (e) {
    // The burn already happened. Write it down before rethrowing, or the tokens
    // are gone with no record that a mint is still owed.
    recordPendingMint(claim);
    throw new Error(`${e.message} — burn recorded, retry with "omniarb mints --retry"`);
  }
  if (!wait) return { hash, nonce, arrived: null };
  const r = await waitForMint({ dst, token, to: dest, amount });
  return { hash, nonce, ...r };
}

// ------------------------------------------------------------ pending mints
//
// bridgeOut burns immediately; the mint is a separate, permissioned call the
// relayer makes on our behalf. So a relayer that is down, out of gas, or simply
// refusing leaves value burned on the source with nothing on the destination —
// which is exactly what "gas required exceeds allowance" from /api/relay means.
//
// Those burns are recoverable: the Portal guards each message by id, so a mint
// that never happened can be re-requested later with the same arguments. What
// must not happen is forgetting it was owed.

const STORE = new URL('../pending-mints.json', import.meta.url);

export function pendingMints() {
  try { return JSON.parse(readFileSync(STORE, 'utf8')); } catch { return []; }
}

function writePending(list) {
  writeFileSync(STORE, `${JSON.stringify(list, null, 2)}\n`);
}

export function recordPendingMint(entry) {
  const list = pendingMints();
  const key = (e) => `${e.srcChainId}:${e.srcTxHash}:${e.srcNonce}`;
  if (list.some((e) => key(e) === key(entry))) return;
  list.push({ ...entry, recordedAt: new Date().toISOString() });
  writePending(list);
}

export function clearPendingMint(entry) {
  const key = (e) => `${e.srcChainId}:${e.srcTxHash}:${e.srcNonce}`;
  writePending(pendingMints().filter((e) => key(e) !== key(entry)));
}

/** True once the destination Portal has processed this message. */
export async function mintProcessed(dst, messageId) {
  try {
    return await publicClient(dst).readContract({
      address: PORTAL, abi: PORTAL_ABI, functionName: 'processed', args: [messageId] });
  } catch { return false; }
}

/**
 * Find burns on `src` addressed to `dst` that the destination never processed.
 *
 * Reads the chain rather than trusting the local record, so mints lost before
 * anything was written down — a crash, or a loop that died mid-route — are
 * still recoverable.
 */
export async function findUnmintedBurns({ src, dst, address, lookbackBlocks = 50_000n }) {
  const pc = publicClient(src);
  const latest = await pc.getBlockNumber();
  const from = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;

  const logs = await getLogsChunked(pc, {
    address: PORTAL,
    event: PORTAL_ABI.find((x) => x.type === 'event' && x.name === 'BridgeOut'),
    args: { sender: address },
    fromBlock: from, toBlock: latest,
  });

  const out = [];
  for (const l of logs) {
    const a = l.args;
    if (Number(a.destChainId) !== dst.id) continue;
    if (await mintProcessed(dst, a.messageId)) continue;
    out.push({
      messageId: a.messageId, srcChainId: src.id, dstChainId: dst.id,
      srcTxHash: l.transactionHash, token: a.token, sender: address,
      to: a.to, amount: a.amount.toString(), srcNonce: a.nonce.toString(),
      blockNumber: l.blockNumber.toString(),
    });
  }
  return out;
}

/** Re-ask the relayer to mint one recorded burn. */
export async function retryMint(entry) {
  await requestMint({
    srcChainId: entry.srcChainId, dstChainId: entry.dstChainId,
    srcTxHash: entry.srcTxHash, token: entry.token, sender: entry.sender,
    to: entry.to, amount: BigInt(entry.amount), srcNonce: BigInt(entry.srcNonce),
  });
}

/**
 * Can the relayer actually mint on this chain right now?
 *
 * bridgeOut burns unconditionally, but the mint is the relayer's transaction
 * paid from the relayer's own wallet. When that wallet is dry the burn still
 * succeeds and the mint is refused, so the tokens sit burned until someone
 * refills it — a one-way loss of exactly the kind a loop will repeat forever.
 * Checked before every bridged route rather than discovered afterwards.
 */
export async function relayerCanMint(dst, { gasUnits = 200_000n } = {}) {
  try {
    const pc = publicClient(dst);
    const relayer = await pc.readContract({
      address: PORTAL, abi: PORTAL_ABI, functionName: 'relayer' });
    const [bal, gp] = await Promise.all([
      pc.getBalance({ address: relayer }), pc.getGasPrice()]);
    return { ok: bal >= gasUnits * gp, relayer, balance: bal, needed: gasUnits * gp };
  } catch {
    return { ok: true, relayer: null, balance: null, needed: null }; // unknown: don't block
  }
}
