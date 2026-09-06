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
