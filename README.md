# MotorHeads Backend

Registry and agent API scaffold for the MotorHeads 5,555 Ethereum collection.

This repo is intentionally separate from the NFT generator and the public website. It is the place for owner-edited visuals, part placements, awaken/agent state, and later IPFS/registry workflows.

## What It Does Now

- Exposes collection config, CIDs, contract address, and the metal sticker catalog.
- Returns default visual state for any token from 1 to 5,555.
- Provides safe, signature-gated endpoints for future custom visual saves.
- Provides safe, signature-gated endpoints for future agent awakening.
- Includes a Cloudflare D1 schema for persistent state.

Write endpoints are locked by default. Do not enable persistent writes until wallet signature verification and token ownership checks are wired into the website/editor flow.

## Commands

```bash
npm run check
npm test
npm run dev:node
npm run dev
npm run deploy
```

`npm run dev:node` starts a dependency-free local Worker wrapper at:

```text
http://127.0.0.1:8787
```

Use that URL in the website Owner Lab backend field, or open the website with:

```text
http://localhost:5173/?api=http://127.0.0.1:8787
```

## Production Shape

- Website: reads wallet/NFT data directly from Ethereum for the owner lab.
- Backend: stores optional custom state after a holder signs an edit message.
- D1: stores custom overlays, colors, and agent state.
- IPFS/Filebase: remains the immutable base art and metadata layer.
