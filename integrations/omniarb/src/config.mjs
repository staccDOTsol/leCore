// Chain + contract map for omnichain.family, lifted from the live app bundle
// (_next/static/chunks) and verified against each chain's RPC.
//
// Every launched token uses the SAME contract address on all nine chains
// ("same CA ser"): supply moves between chains through the Portal's 1:1
// burn/mint bridge, it is never wrapped.

export const NATIVE = '0x0000000000000000000000000000000000000000';
export const ETH_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** Home chain: the bonding curve ("the pad") only exists here. */
export const HOME_CHAIN = 8453;

/** Same address on every chain. */
export const PORTAL = '0xa3324d514708049883167ad817db97aefe29c96c';
export const FACTORY = '0xcf8c621000514043bc7adfd3afd2fcf391fc761e';
/** Bonding curve / launchpad, Base only. */
export const PAD = '0xd21cff13e2d2d9a39e450e97e29dd930108a327c';

export const API = 'https://omnichain.family';

/** Uniswap v4 pool parameters every omnichain pool is created with. */
export const POOL_FEE = 3000;
export const POOL_TICK_SPACING = 60;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
/** Uniswap v4 PoolManager `_pools` mapping slot, for extsload reads. */
export const POOLS_SLOT = 6n;

/** OMNI token ERC20 storage layout (all launched tokens share one implementation). */
export const TOKEN_BALANCE_SLOT = 5n;
export const TOKEN_ALLOWANCE_SLOT = 6n;

export const CHAINS = [
  {
    id: 4663, name: 'Robinhood', short: 'RH', nativeSymbol: 'ETH', priceId: 'ethereum',
    rpcs: ['https://rpc.mainnet.chain.robinhood.com'],
    explorer: 'https://rh-scan.com',
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    hook: '0x816b4043fe55b9a982c2baefb746c9f541c380cc',
    router: '0x514f4489af1f1f8e5646a79063703eb9681baf8e',
    launcher: '0x62b0bc3ae794fc6a4d7a3809063bf777a9947345',
    factoryFromBlock: 55377450n,
  },
  {
    id: 8453, name: 'Base', short: 'Base', nativeSymbol: 'ETH', priceId: 'ethereum',
    rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    explorer: 'https://basescan.org',
    poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b',
    hook: '0xce5d52c0c2345260502872b6108d0ce2559280cc',
    router: '0xe80335474e278fbb84155daaad6042e659fd86d8',
    launcher: '0xe3dcd4b6fe0b7b86234036e6d37bf5d2f2bdb857',
    factoryFromBlock: 50927698n,
  },
  {
    id: 1, name: 'Ethereum', short: 'ETH', nativeSymbol: 'ETH', priceId: 'ethereum',
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://cloudflare-eth.com'],
    explorer: 'https://etherscan.io',
    poolManager: '0x000000000004444c5dc75cb358380d2e3de08a90',
    hook: '0xf1233150d60d96f4f9086a535738b53625a980cc',
    router: '0x7fd50b16aaf927359091e80a458282d14a55cb52',
    launcher: null,
    factoryFromBlock: 25913286n,
  },
  {
    id: 42161, name: 'Arbitrum', short: 'Arb', nativeSymbol: 'ETH', priceId: 'ethereum',
    rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    explorer: 'https://arbiscan.io',
    poolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32',
    hook: '0x552658e4dcb00c069ab97244489c830a87b380cc',
    router: '0xf9b44eb5c2e9d2f799686b4cb265fa2195cc5f8e',
    launcher: null,
    factoryFromBlock: 502103226n,
  },
  {
    id: 56, name: 'BNB', short: 'BNB', nativeSymbol: 'BNB', priceId: 'binancecoin',
    rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'],
    explorer: 'https://bscscan.com',
    poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
    hook: '0x2e119e43217cee9ba42bb153c4f8a81226d400cc',
    router: '0x58477a34b692e4d2fb4fdd980985c28b39820afd',
    launcher: null,
    factoryFromBlock: 120168189n,
  },
  {
    id: 137, name: 'Polygon', short: 'Pol', nativeSymbol: 'POL', priceId: 'polygon-ecosystem-token',
    rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'],
    explorer: 'https://polygonscan.com',
    poolManager: '0x67366782805870060151383f4bbff9dab53e5cd6',
    hook: '0xd14b20a40b605879d250902b024cc41b677500cc',
    router: '0xc7d0ac9b81c588a0a39b926ec0a30b0b0900f89a',
    launcher: null,
    factoryFromBlock: 93288779n,
  },
  {
    id: 480, name: 'World', short: 'Wld', nativeSymbol: 'ETH', priceId: 'ethereum',
    rpcs: ['https://worldchain-mainnet.g.alchemy.com/public'],
    explorer: 'https://worldscan.org',
    poolManager: '0xb1860d529182ac3bc1f51fa2abd56662b7d13f33',
    hook: '0x03f4051e621ee3f3652adef2c453458a777e40cc',
    router: '0xa609492856d183ed523b9876d2d61ac14575040e',
    launcher: null,
    factoryFromBlock: 34651246n,
  },
  {
    id: 59144, name: 'Linea', short: 'Lin', nativeSymbol: 'ETH', priceId: 'ethereum',
    rpcs: ['https://linea-rpc.publicnode.com', 'https://rpc.linea.build'],
    explorer: 'https://lineascan.build',
    poolManager: '0x248083fb965359d82b06c1f5322480dcfc1ad857',
    hook: '0xb8dd684f503c3386595d4a8886f29e0388b100cc',
    router: '0x6045be984284b77545ffe80cc898eb598c613054',
    launcher: null,
    factoryFromBlock: 31944078n,
  },
  {
    id: 143, name: 'Monad', short: 'Mon', nativeSymbol: 'MON', priceId: 'monad',
    rpcs: ['https://rpc.monad.xyz'],
    explorer: 'https://monadvision.com',
    poolManager: '0x188d586ddcf52439676ca21a244753fa19f9ea8e',
    hook: '0xe89ab12a7dca7b4cb269002826dab40b04d440cc',
    router: '0xf2a932a2eb170ee9ce6550b43316fa13209d1521',
    launcher: null,
    factoryFromBlock: 102273109n,
  },
];

export const chainById = (id) => CHAINS.find((c) => c.id === Number(id));

/**
 * Ordered RPC endpoints for a chain, tried in sequence.
 *
 * Public endpoints here drop requests often enough to matter — a missed
 * getLogs silently costs a venue, and a missed eth_call silently costs a
 * quote — so each chain lists a fallback and the client fails over rather
 * than treating one bad response as the truth. PublicNode is preferred
 * where it carries the chain; Robinhood, World and Monad have no second
 * public endpoint, so they run single-homed.
 *
 * RPC_<chainId> in the environment is tried before all of them.
 */
export const rpcsFor = (c) => {
  const override = process.env[`RPC_${c.id}`];
  return override ? [override, ...c.rpcs] : [...c.rpcs];
};

/** Primary endpoint, for display and for anything that needs a single URL. */
export const rpcFor = (c) => rpcsFor(c)[0];

/** ARB_<chainId> points at an already-deployed OmniArb helper. */
export const arbHelperFor = (c) => process.env[`ARB_${c.id}`] || null;

// ------------------------------------------------------------------- ABIs

/** omnichain.family's own router: only ever trades the pool carrying `hook`. */
export const ROUTER_ABI = [
  { type: 'function', name: 'buy', stateMutability: 'payable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'hook', type: 'address' },
      { name: 'minAmountOut', type: 'uint256' }, { name: 'recipient', type: 'address' },
      { name: 'deadline', type: 'uint256' }],
    outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { type: 'function', name: 'sell', stateMutability: 'payable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'hook', type: 'address' },
      { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' },
      { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint256' }],
    outputs: [{ name: 'amountOut', type: 'uint256' }] },
  { type: 'function', name: 'poolManager', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'error', name: 'TooLittleOut', inputs: [{ type: 'uint256' }, { type: 'uint256' }] },
  { type: 'error', name: 'Expired', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'TransferFailed', inputs: [] },
];

/** The Base bonding curve. `currentCurvePrice == 0` means the curve graduated. */
export const PAD_ABI = [
  { type: 'function', name: 'buy', stateMutability: 'payable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'minTokensOut', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'sell', stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'tokenAmount', type: 'uint256' },
      { name: 'minEthOut', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'quoteBuy', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }, { name: 'valueWei', type: 'uint256' }],
    outputs: [{ name: 'tokensOut', type: 'uint256' }, { name: 'totalCostWei', type: 'uint256' }] },
  { type: 'function', name: 'quoteSell', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }, { name: 'tokenAmount', type: 'uint256' }],
    outputs: [{ name: 'ethOut', type: 'uint256' }] },
  { type: 'function', name: 'currentCurvePrice', stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'CURVE_SUPPLY', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'SUPPLY', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

/** Portal: burn on the source chain, relayer mints the same amount at the same CA. */
export const PORTAL_ABI = [
  { type: 'function', name: 'bridgeOut', stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'destChainId', type: 'uint64' },
      { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: 'messageId', type: 'bytes32' }] },
  { type: 'function', name: 'bridgeIn', stateMutability: 'nonpayable',
    inputs: [{ name: 'srcChainId', type: 'uint64' }, { name: 'token', type: 'address' },
      { name: 'sender', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }, { name: 'srcNonce', type: 'uint256' }],
    outputs: [{ name: 'messageId', type: 'bytes32' }] },
  { type: 'function', name: 'relayer', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'minted', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'burned', stateMutability: 'view', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'processed', stateMutability: 'view', inputs: [{ name: 'messageId', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'event', name: 'BridgeOut', inputs: [
      { name: 'messageId', type: 'bytes32', indexed: true }, { name: 'token', type: 'address', indexed: true },
      { name: 'sender', type: 'address', indexed: true }, { name: 'destChainId', type: 'uint64' },
      { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }] },
  { type: 'event', name: 'BridgeIn', inputs: [
      { name: 'messageId', type: 'bytes32', indexed: true }, { name: 'token', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true }, { name: 'amount', type: 'uint256' }] },
];

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

export const POOL_MANAGER_ABI = [
  { type: 'function', name: 'extsload', stateMutability: 'view', inputs: [{ name: 'slot', type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
];

/** Uniswap v4 pool creation, used to discover every pool that exists for a CA. */
export const V4_INITIALIZE_EVENT = {
  type: 'event', name: 'Initialize', inputs: [
    { name: 'id', type: 'bytes32', indexed: true },
    { name: 'currency0', type: 'address', indexed: true },
    { name: 'currency1', type: 'address', indexed: true },
    { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' }, { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick', type: 'int24' }],
};

/** Emitted by the launcher when a new token is created. */
export const OMNI_LAUNCHED_EVENT = {
  type: 'event', name: 'OmniLaunched', inputs: [
    { name: 'token', type: 'address', indexed: true },
    { name: 'caller', type: 'address', indexed: true },
    { name: 'salt', type: 'bytes32' }, { name: 'initialBuyTokens', type: 'uint256' },
    { name: 'targetRaiseWei', type: 'uint96' }, { name: 'creatorBuyWei', type: 'uint256' }],
};
