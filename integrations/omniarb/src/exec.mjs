// Execution. Everything here is gated: the bot simulates immediately before it
// signs, refuses to send when the edge has moved against it, and passes a
// non-zero minProfit into the contract so a stale opportunity reverts on chain
// instead of settling at a loss.

import { formatEther } from 'viem';
import { publicClient, walletClient, loadAccount } from './chain.mjs';
import { ARTIFACT, helperFor } from './quote.mjs';
import { simulateAtomic } from './arb.mjs';

/** Deploy the OmniArb helper on one chain. Needed only for hookless-pool trades. */
export async function deployHelper(c, account) {
  const pc = publicClient(c);
  const wc = walletClient(c, account);
  const hash = await wc.deployContract({ abi: ARTIFACT.abi, bytecode: ARTIFACT.bytecode, args: [] });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`deploy reverted on ${c.name}`);
  return { address: receipt.contractAddress, hash, gasUsed: receipt.gasUsed };
}

/**
 * Send one atomic same-chain arb.
 *
 * `minProfitBps` is enforced by the contract, not just by this process: if the
 * pools move between simulation and inclusion, the transaction reverts and the
 * only loss is gas.
 */
export async function executeAtomic(opp, account, { minProfitBps = 5000n, dryRun = true } = {}) {
  const c = opp.chain;
  const h = helperFor(c);
  if (!h.deployed) {
    throw new Error(
      `OmniArb is not deployed on ${c.name}. Run "omniarb deploy --chain ${c.short}" and export ARB_${c.id}=<address>.`);
  }

  // Re-simulate against current state; never act on the scan's numbers.
  const fresh = await simulateAtomic(c, opp.token, opp.buy, opp.sell, opp.sizeIn);
  if (!fresh) throw new Error('opportunity no longer simulates — aborting');

  const gasCost = opp.gas ?? 0n;
  const freshNet = fresh.profit - gasCost;
  if (freshNet <= 0n) {
    throw new Error(`edge gone: gross ${formatEther(fresh.profit)} does not cover gas ${formatEther(gasCost)}`);
  }

  // Floor the on-chain guard at a fraction of what we just simulated.
  const minProfit = (fresh.profit * minProfitBps) / 10000n;
  const args = [...fresh.args];
  args[args.length - 1] = minProfit;

  const plan = {
    chain: c.name, fn: fresh.fn, sizeIn: opp.sizeIn,
    simulatedGross: fresh.profit, gasCost, net: freshNet, minProfitOnChain: minProfit,
    helper: h.address,
  };
  if (dryRun) return { ...plan, sent: false, dryRun: true };

  const pc = publicClient(c);
  const wc = walletClient(c, account);

  const bal = await pc.getBalance({ address: account.address });
  if (bal < opp.sizeIn + gasCost) {
    throw new Error(`insufficient ${c.name} balance: have ${formatEther(bal)}, need ${formatEther(opp.sizeIn + gasCost)}`);
  }

  const hash = await wc.writeContract({
    address: h.address, abi: ARTIFACT.abi, functionName: fresh.fn, args, value: opp.sizeIn,
  });
  const receipt = await pc.waitForTransactionReceipt({ hash });
  return {
    ...plan, sent: true, dryRun: false, hash,
    status: receipt.status, gasUsed: receipt.gasUsed,
    explorer: `${c.explorer}/tx/${hash}`,
  };
}

/** Guard rails applied to every opportunity before it is allowed to execute. */
export function passesGuards(opp, limits) {
  const reasons = [];
  if (opp.net < limits.minNetWei) reasons.push(`net ${formatEther(opp.net)} below floor ${formatEther(limits.minNetWei)}`);
  if (opp.sizeIn > limits.maxSizeWei) reasons.push(`size ${formatEther(opp.sizeIn)} above cap ${formatEther(limits.maxSizeWei)}`);
  if (opp.type === 'cross-chain' && !limits.allowCrossChain) reasons.push('cross-chain disabled (not atomic)');
  if (opp.type === 'same-chain-two-step' && !limits.allowTwoStep) reasons.push('two-step disabled (not atomic)');
  return { ok: reasons.length === 0, reasons };
}

export { loadAccount };

// --------------------------------------------------------- non-atomic routes

import { ROUTER_ABI, PAD, PAD_ABI, ERC20_ABI } from './config.mjs';
import { deadline } from './chain.mjs';
import { quoteBuy, quoteSell } from './quote.mjs';
import { bridge } from './bridge.mjs';

const MAX_UINT256 = (1n << 256n) - 1n;

/** Wait for `blocks` new blocks, so a just-observed balance is settled everywhere. */
async function settle(c, blocks = 2, timeoutMs = 60_000) {
  const pc = publicClient(c);
  const start = await pc.getBlockNumber();
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await pc.getBlockNumber().catch(() => start);
    if (now >= start + BigInt(blocks)) return;
  }
}

/** Buy `token` with `nativeIn` on one venue. Returns tokens actually received. */
export async function buyOnVenue(c, account, token, venue, nativeIn, { slippageBps = 1000n } = {}) {
  const pc = publicClient(c);
  const wc = walletClient(c, account);

  const quoted = await quoteBuy(c, token, venue, nativeIn);
  if (!quoted || quoted === 0n) throw new Error(`no buy quote on ${c.name}`);
  const minOut = (quoted * (10000n - slippageBps)) / 10000n;

  let hash;
  if (venue.kind === 'curve') {
    hash = await wc.writeContract({ address: PAD, abi: PAD_ABI, functionName: 'buy', args: [token, minOut], value: nativeIn });
  } else if (venue.viaOmniRouter) {
    hash = await wc.writeContract({
      address: c.router, abi: ROUTER_ABI, functionName: 'buy',
      args: [token, c.hook, minOut, account.address, deadline(900)], value: nativeIn });
  } else {
    // Hookless pool: omnichain's router refuses it, so go through our helper.
    // Native is currency0 on every omnichain pool, so buying is zeroForOne.
    const h = helperFor(c);
    if (!h.deployed) {
      throw new Error(`hookless buy on ${c.name} needs the helper — run "omniarb deploy --chain ${c.short} --live"`);
    }
    hash = await wc.writeContract({
      address: h.address, abi: ARTIFACT.abi, functionName: 'swapV4',
      args: [c.poolManager, venue.key, true, nativeIn, minOut], value: nativeIn });
  }

  const rec = await pc.waitForTransactionReceipt({ hash });
  if (rec.status !== 'success') throw new Error(`buy reverted on ${c.name} (${hash})`);

  // Measure across the block the buy landed in, not with wall-clock reads.
  // Behind a failover transport the two reads can come from nodes at different
  // heights, which reports a filled buy as "0 tokens" — and the route then
  // aborts on top of tokens it already owns.
  const [pre, post] = await Promise.all([
    pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf',
      args: [account.address], blockNumber: rec.blockNumber - 1n }),
    pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf',
      args: [account.address], blockNumber: rec.blockNumber }),
  ]);
  return { hash, received: post - pre, quoted, explorer: `${c.explorer}/tx/${hash}` };
}

/** Sell `amount` of `token` on one venue. Returns native actually received. */
export async function sellOnVenue(c, account, token, venue, amount, { slippageBps = 1500n } = {}) {
  const pc = publicClient(c);
  const wc = walletClient(c, account);

  // Confirm the tokens are actually spendable at the current head before doing
  // anything else. A bridged balance can look present on one node a moment
  // before it is, and selling into that gap fails inside the router as
  // TransferFailed rather than as anything self-explanatory.
  const held = await pc.readContract({
    address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address], blockTag: 'latest' });
  if (held < amount) throw new Error(`only ${held} spendable on ${c.name}, need ${amount} — balance has not settled`);

  const quoted = await quoteSell(c, token, venue, amount);
  if (!quoted || quoted === 0n) throw new Error(`no sell quote on ${c.name}`);
  const minOut = (quoted * (10000n - slippageBps)) / 10000n;

  const helper = venue.kind !== 'curve' && !venue.viaOmniRouter ? helperFor(c) : null;
  if (helper && !helper.deployed) {
    throw new Error(`hookless sell on ${c.name} needs the helper — run "omniarb deploy --chain ${c.short} --live"`);
  }
  const spender = venue.kind === 'curve' ? PAD : (helper ? helper.address : c.router);
  const allowance = await pc.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, spender] });
  if (allowance < amount) {
    const ah = await wc.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, MAX_UINT256] });
    await pc.waitForTransactionReceipt({ hash: ah });
  }

  // Preflight the real call, not just the view quote. The pad's quoteSell can
  // return a price for a sell its state-changing path then rejects, and finding
  // that out by broadcasting costs gas and strands the tokens mid-route.
  let call;
  if (venue.kind === 'curve') {
    call = { address: PAD, abi: PAD_ABI, functionName: 'sell', args: [token, amount, minOut] };
  } else if (helper) {
    // Selling the token side of a hookless pool is oneForZero.
    call = { address: helper.address, abi: ARTIFACT.abi, functionName: 'swapV4',
      args: [c.poolManager, venue.key, false, amount, minOut] };
  } else {
    call = { address: c.router, abi: ROUTER_ABI, functionName: 'sell',
      args: [token, c.hook, amount, minOut, account.address, deadline(900)] };
  }
  try {
    await pc.simulateContract({ ...call, account: account.address });
  } catch (e) {
    throw new Error(`sell would revert on ${c.name} (${venue.kind}): ${String(e.shortMessage || e.message).split('\n')[0]}`);
  }

  const hash = await wc.writeContract(call);

  const rec = await pc.waitForTransactionReceipt({ hash });
  if (rec.status !== 'success') throw new Error(`sell reverted on ${c.name} (${hash})`);

  // Settle P&L against the block the sell landed in rather than wall-clock
  // reads: with a failover transport the before/after reads can come from
  // nodes at different heights, which reports a real gain as zero.
  const [pre, post] = await Promise.all([
    pc.getBalance({ address: account.address, blockNumber: rec.blockNumber - 1n }),
    pc.getBalance({ address: account.address, blockNumber: rec.blockNumber }),
  ]);
  const gasPaid = rec.gasUsed * rec.effectiveGasPrice;
  return {
    hash, quoted, gasPaid,
    delta: post - pre,
    received: post - pre + gasPaid,
    explorer: `${c.explorer}/tx/${hash}`,
  };
}

/**
 * Run a non-atomic route: buy, optionally bridge, sell.
 *
 * There is no revert to fall back on here. Each leg is quoted again immediately
 * before it is sent and carries its own slippage floor, and the function reports
 * exactly which legs completed — if the sell fails the tokens are simply sitting
 * on the destination chain, recoverable with `bag`.
 */
export async function executeRoute(route, account, { dryRun = true, onStep = () => {} } = {}) {
  const { src, dst, buy, sell, sizeIn, token } = route;
  const bridged = src.id !== dst.id;

  if (dryRun) {
    return { dryRun: true, sent: false, plan: { src: src.name, dst: dst.name, sizeIn, bridged,
      buy: buy.kind, sell: sell.kind } };
  }

  const done = { legs: [] };

  onStep(`buying on ${src.name} (${buy.kind})`);
  const b = await buyOnVenue(src, account, token, buy, sizeIn);
  done.legs.push({ leg: 'buy', ...b });
  onStep(`  got ${b.received} raw tokens — ${b.explorer}`);

  let amount = b.received;
  if (amount === 0n) throw new Error('buy produced no tokens');

  if (bridged) {
    onStep(`bridging ${src.name} -> ${dst.name}`);
    const br = await bridge({ src, dst, account, token, amount });
    done.legs.push({ leg: 'bridge', ...br });
    if (!br.arrived) throw new Error(`relayer has not minted on ${dst.name} yet (burn tx ${br.hash}) — retry the sell later`);
    onStep(`  minted on ${dst.name}, letting it settle`);
    await settle(dst, 2);
  }

  onStep(`selling on ${dst.name} (${sell.kind})`);
  const s = await sellOnVenue(dst, account, token, sell, amount);
  done.legs.push({ leg: 'sell', ...s });
  onStep(`  ${s.explorer}`);

  return { dryRun: false, sent: true, ...done };
}
