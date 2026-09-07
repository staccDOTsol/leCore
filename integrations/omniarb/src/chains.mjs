// Candidate addresses from 7819a31dee086ffe128668533af5121ae205f315,
// integrations/omniarb/live-config.json. A scraped address is NOT verification.
const rows = [
  [4663, 'Robinhood', 'ETH', 'https://rpc.mainnet.chain.robinhood.com', '0x8366a39cc670b4001a1121b8f6a443a643e40951', '0x816b4043fe55b9a982c2baefb746c9f541c380cc', '0xca60e703598ae645fc2a99456004096c1577084c'],
  [8453, 'Base', 'ETH', 'https://mainnet.base.org', '0x498581ff718922c3f8e6a244956af099b2652b2b', '0xce5d52c0c2345260502872b6108d0ce2559280cc', '0x3ec4d75f9fe806155f10b75ad8787d09fab81229'],
  [1, 'Ethereum', 'ETH', 'https://ethereum-rpc.publicnode.com', '0x000000000004444c5dc75cb358380d2e3de08a90', '0xf1233150d60d96f4f9086a535738b53625a980cc', '0x40622206731b1ae558e2de70a0144ba77e23a082'],
  [42161, 'Arbitrum', 'ETH', 'https://arb1.arbitrum.io/rpc', '0x360e68faccca8ca495c1b759fd9eee466db9fb32', '0x552658e4dcb00c069ab97244489c830a87b380cc', '0x184ff6d1601dc1a8b2f42acb37959519b3313c75'],
  [56, 'BNB', 'BNB', 'https://bsc-rpc.publicnode.com', '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df', '0x2e119e43217cee9ba42bb153c4f8a81226d400cc', '0x074c69eda671f05fc89c130be78b5e4b8e8a65c9'],
  [137, 'Polygon', 'POL', 'https://polygon-bor-rpc.publicnode.com', '0x67366782805870060151383f4bbff9dab53e5cd6', '0xd14b20a40b605879d250902b024cc41b677500cc', '0x78ff5ac7987096faa0e161c0445c0a9b5a86272f'],
  [480, 'World', 'ETH', 'https://worldchain-mainnet.g.alchemy.com/public', '0xb1860d529182ac3bc1f51fa2abd56662b7d13f33', '0x03f4051e621ee3f3652adef2c453458a777e40cc', '0x028f91f642cb4e1cbe0f5b6361356b55b843e918'],
  [59144, 'Linea', 'ETH', 'https://rpc.linea.build', '0x248083fb965359d82b06c1f5322480dcfc1ad857', '0xb8dd684f503c3386595d4a8886f29e0388b100cc', '0xcff35fad62b292108817d572f231a190b309dca9'],
  [143, 'Monad', 'MON', 'https://rpc.monad.xyz', '0x188d586ddcf52439676ca21a244753fa19f9ea8e', '0xe89ab12a7dca7b4cb269002826dab40b04d440cc', '0x11494b3f427f9d36b220878f0d6a2cef7c6bdb9c'],
];

export const CHAINS = rows.map(([id, name, nativeSymbol, rpc, poolManager, hook, router]) =>
  Object.freeze({ id, name, nativeSymbol, rpc, poolManager, hook, router,
    // Capability, not a claim that a curve is deployed or live on this chain.
    nativeDecimals: 18, hasCurve: true,
    l1DataFeeRequired: [8453, 42161, 480, 59144, 4663].includes(id),
    verification: 'unverified' }));

export const DEFAULT_TOKEN = '0x9a5baa12664c89cfbf5cfcd9d0d4805bdcab29e8';
export const ALCHEMY_NETWORK = {
  1: 'eth-mainnet', 8453: 'base-mainnet', 42161: 'arb-mainnet',
  56: 'bnb-mainnet', 137: 'polygon-mainnet', 480: 'worldchain-mainnet',
  59144: 'linea-mainnet', 143: 'monad-mainnet',
};

export function endpoints(chain, env = process.env) {
  const network = ALCHEMY_NETWORK[chain.id];
  const key = env.ALCHEMY_API_KEY;
  const base = key && network ? `${network}.g.alchemy.com/v2/${encodeURIComponent(key)}` : null;
  return {
    http: env[`RPC_${chain.id}`] || (base ? `https://${base}` : chain.rpc),
    ws: chain.id === 4663 ? null : env[`WS_RPC_${chain.id}`] || (base ? `wss://${base}` : null),
  };
}
