/**
 * Meteora Dynamic Bonding Curve: the launchpad for the master shill token.
 *
 * Why DBC: its config carries `tokenAuthorityOption`. With `CreatorUpdateAuthority` the program
 * creates the token's metadata as mutable and transfers the update authority to the pool creator
 * inside `initialize_virtual_pool`, before any trade happens -- so the wallet that launches the
 * token can rewrite name/symbol/uri from day one (see metadata.ts). With `PartnerUpdateAuthority`
 * the config's feeClaimer gets it instead; both are supported here.
 *
 * Two on-chain steps, both built by the official SDK:
 *   1. createConfig  -- a partner config keypair holding the curve + fee + authority settings
 *   2. createPool    -- the master token mint + its virtual pool, from that config
 */
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint } from '@solana/spl-token';
import {
  ActivationType, BaseFeeMode, CollectFeeMode, DynamicBondingCurveClient, MigrationFeeOption,
  MigrationOption, TokenAuthorityOption, TokenDecimal, TokenType, buildCurve, deriveDbcPoolAddress,
  type ConfigParameters, type PoolConfig, type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { assertMetadataLimits, type MetadataFields } from './metadata.js';

export const NATIVE_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
/** openzoo's $TOKEN (Token-2022, 6 decimals): the curve is QUOTED in it, by directive. */
export const ZOO_TOKEN_MINT = new PublicKey('EVULoNF4DeMBN4dGiZiDfpiiTfNZgoCvXWWgaV3epump');
/** "you need 100 million to bond": the quote raised on the curve before it graduates to DAMM v2. */
export const BOND_THRESHOLD_TOKEN = 100_000_000;

export type MasterCurveOptions = {
  /** SPLToken (Metaplex metadata) by default: every wallet and indexer reads it. */
  tokenType?: TokenType;
  /** Who may rewrite metadata after launch: the pool creator (default) or the config's feeClaimer. */
  authority?: 'creator' | 'partner';
  totalTokenSupply?: number;
  /** Percent of supply that migrates to the AMM at graduation. */
  percentageSupplyOnMigration?: number;
  /** Quote raised on the curve before graduation (100M $TOKEN by directive). */
  migrationQuoteThreshold?: number;
  /** Decimals of the quote mint ($TOKEN has 6). */
  quoteDecimals?: TokenDecimal;
  /** Flat trading fee on the curve, in bps. */
  feeBps?: number;
  /** Share of trading fees paid to the pool creator, 0..100. */
  creatorTradingFeePercentage?: number;
  migrationOption?: MigrationOption;
};

export const MASTER_CURVE_DEFAULTS: Required<MasterCurveOptions> = {
  tokenType: TokenType.SPLToken,
  authority: 'creator',
  totalTokenSupply: 1_000_000_000,
  percentageSupplyOnMigration: 20,
  migrationQuoteThreshold: BOND_THRESHOLD_TOKEN,
  quoteDecimals: TokenDecimal.SIX,
  feeBps: 100,
  creatorTradingFeePercentage: 50,
  migrationOption: MigrationOption.MET_DAMM_V2,
};

export function authorityOption(authority: 'creator' | 'partner'): TokenAuthorityOption {
  return authority === 'partner'
    ? TokenAuthorityOption.PartnerUpdateAuthority
    : TokenAuthorityOption.CreatorUpdateAuthority;
}

/** The curve + config parameters for the master token. Pure: no chain access. */
export function masterCurveParams(opts: MasterCurveOptions = {}): ConfigParameters {
  const o = { ...MASTER_CURVE_DEFAULTS, ...opts };
  return buildCurve({
    token: {
      tokenType: o.tokenType,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: o.quoteDecimals,
      tokenAuthorityOption: authorityOption(o.authority),
      totalTokenSupply: o.totalTokenSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: o.feeBps, endingFeeBps: o.feeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: o.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: o.migrationOption,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 0,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
      totalVestingDuration: 0, cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: o.percentageSupplyOnMigration,
    migrationQuoteThreshold: o.migrationQuoteThreshold,
  });
}

export function dbcClient(connection: Connection): DynamicBondingCurveClient {
  return new DynamicBondingCurveClient(connection, 'confirmed');
}

/** Decimals of a mint whichever token program owns it (the quote mint is Token-2022). */
export async function mintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  if (mint.equals(NATIVE_SOL_MINT)) return 9;
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  return (await getMint(connection, mint, 'confirmed', program)).decimals;
}

/**
 * Step 1: create the partner config. `payer` also becomes feeClaimer + leftoverReceiver unless given.
 * The quote mint defaults to $TOKEN; its decimals are read from chain so the curve math is right.
 */
export async function createMasterConfig(
  connection: Connection, payer: Keypair,
  opts: MasterCurveOptions & { feeClaimer?: PublicKey; leftoverReceiver?: PublicKey; quoteMint?: PublicKey } = {},
): Promise<{ config: PublicKey; quoteMint: PublicKey; signature: string }> {
  const client = dbcClient(connection);
  const configKp = Keypair.generate();
  const quoteMint = opts.quoteMint ?? ZOO_TOKEN_MINT;
  const quoteDecimals = (opts.quoteDecimals ?? (await mintDecimals(connection, quoteMint))) as TokenDecimal;
  const tx = await client.partner.createConfig({
    config: configKp.publicKey,
    feeClaimer: opts.feeClaimer ?? payer.publicKey,
    leftoverReceiver: opts.leftoverReceiver ?? payer.publicKey,
    quoteMint,
    payer: payer.publicKey,
    ...masterCurveParams({ ...opts, quoteDecimals }),
  });
  const signature = await sendAndConfirmTransaction(connection, tx, [payer, configKp], { commitment: 'confirmed' });
  return { config: configKp.publicKey, quoteMint, signature };
}

/**
 * Step 2: mint the master token and open its curve. `poolCreator` (default: payer) is the wallet
 * that receives metadata update authority under CreatorUpdateAuthority -- keep that key.
 */
export async function launchMasterToken(
  connection: Connection, payer: Keypair, config: PublicKey, fields: MetadataFields,
  opts: { poolCreator?: Keypair; baseMint?: Keypair; quoteMint?: PublicKey } = {},
): Promise<{ baseMint: PublicKey; pool: PublicKey; signature: string }> {
  assertMetadataLimits(fields);
  const client = dbcClient(connection);
  const baseMint = opts.baseMint ?? Keypair.generate();
  const poolCreator = opts.poolCreator ?? payer;
  const tx = await client.creator.createPool({
    ...fields,
    payer: payer.publicKey,
    poolCreator: poolCreator.publicKey,
    config,
    baseMint: baseMint.publicKey,
  });
  const signers = [payer, baseMint];
  if (!poolCreator.publicKey.equals(payer.publicKey)) signers.push(poolCreator);
  const signature = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
  const pool = deriveDbcPoolAddress(opts.quoteMint ?? ZOO_TOKEN_MINT, baseMint.publicKey, config);
  return { baseMint: baseMint.publicKey, pool, signature };
}

export async function getMasterPool(connection: Connection, baseMint: PublicKey): Promise<{ pool: PublicKey; state: VirtualPool; config: PoolConfig } | null> {
  const client = dbcClient(connection);
  const found = await client.state.getPoolByBaseMint(baseMint);
  if (!found) return null;
  const config = await client.state.getPoolConfig(found.account.poolState.config);
  if (!config) return null;
  return { pool: found.publicKey, state: found.account, config };
}

/**
 * Who the DBC program handed metadata update authority to. Mirrors the program's
 * `TokenAuthorityOption::get_update_authority(creator, fee_claimer)` so an operator can preflight
 * "can this wallet actually rewrite the master token?" without sending a transaction.
 */
export function expectedUpdateAuthority(state: VirtualPool, config: PoolConfig): PublicKey | null {
  switch (config.tokenUpdateAuthority as TokenAuthorityOption) {
    case TokenAuthorityOption.CreatorUpdateAuthority:
    case TokenAuthorityOption.CreatorUpdateAndMintAuthority:
      return state.poolState.creator;
    case TokenAuthorityOption.PartnerUpdateAuthority:
    case TokenAuthorityOption.PartnerUpdateAndMintAuthority:
      return config.feeClaimer;
    default:
      return null;
  }
}
