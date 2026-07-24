export const MOTORHEADS_CONTRACT = "0x0a5008550fc1402bb567a3ba38d9433e6199ceb1";
export const TREASURY_WALLET = "0x95A6fB3087b3469Ed777120052E0ac3f262c81C1";

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
