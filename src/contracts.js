export const MOTORHEADS_CONTRACT = "0x0a5008550fc1402bb567a3ba38d9433e6199ceb1";
export const TREASURY_WALLET = "0x95A6fB3087b3469Ed777120052E0ac3f262c81C1";

// Partner collections whose holders unlock gated collab traits in the workshop.
// Normies (ERC-721, Ethereum mainnet) — https://opensea.io/collection/thenormies
export const NORMIES_CONTRACT = "0x9eb6e2025b64f340691e424b7fe7022ffde12438";
// DDG (ERC-721, Ethereum mainnet) — skull/skeleton collection
export const DDG_CONTRACT = "0x9c51a3cb5094b26aa1dcb380f3dc7e1a7c681c2d";

// Partner-collection holder checks surfaced on /v1/auth/holdings, keyed by the flag
// the frontend reads (e.g. `normies`, `ddg`). Each is a generic ERC-721 balanceOf.
export const PARTNER_COLLECTIONS = Object.freeze([
  { key: "normies", contract: NORMIES_CONTRACT },
  { key: "ddg", contract: DDG_CONTRACT }
]);

export const NETWORK = {
  name: "Ethereum Mainnet",
  chainId: 1,
  hexChainId: "0x1"
};

export const COLLECTION = {
  name: "MotorHeads",
  symbol: "MOTOR",
  maxSupply: 5555,
  goldenTotal: 55,
  treasuryGoldenCount: 10,
  contractAddress: MOTORHEADS_CONTRACT,
  treasuryWallet: TREASURY_WALLET,
  provenanceHash: "0x95ff6e7da1d0bc64862ded046c786433cf1af2852fbc8f408020b323728bc996"
};

// Must match the live on-chain tokenURI/baseURI. Verified against tokenURI(1) on 2026-07-24.
export const CIDS = {
  baseUri: "ipfs://bafybeieu7bnbl7tiuim6x6gz7pcdfhkq6bh4eas3jteea7sx7kowobe6jy/",
  images: "bafybeihodojvhdsjn6d2romph3jo2u5yexzqidiitnlwshej3u4oaqklxq",
  animations: "bafybeif6hwm5lfl7cmmw2leit5t76t57k5olsx6lrxso22ojbkoh2xcyyq",
  contractMetadata: "bafybeicgckcmtjt63iwxgbkr3jouzcabpxncs5qcp4vunlfiirlgeb344a"
};
