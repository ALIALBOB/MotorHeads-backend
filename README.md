# MotorHeads Backend

Registry and agent API scaffold for the MotorHeads 5,555 Ethereum collection.

This repo is intentionally separate from the NFT generator and the public website. It is the place for owner-edited visuals, part placements, awaken/agent state, and later IPFS/registry workflows.

## What It Does Now

- Exposes collection config, CIDs, contract address, and the metal sticker catalog.
- Returns default visual state for any token from 1 to 5,555.
- Returns default chain state for any token, plus cached chain summary once the indexer is configured.
- Provides safe, signature-gated endpoints for future custom visual saves.
- Provides safe, signature-gated endpoints for future agent awakening.
- Includes a Cloudflare D1 schema for persistent visual, agent, chain, and indexer state.

Write endpoints are locked by default. Do not enable persistent writes until wallet signature verification and token ownership checks are wired into the website/editor flow.

Public chain-state reads do not need wallet signatures. The backend writes those values from Ethereum logs and cached RPC data.

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

Use that URL in the website Operator Lab backend field, or open the website with:

```text
http://localhost:5173/?api=http://127.0.0.1:8787
```

## Production Shape

- Website: reads wallet/NFT data directly from Ethereum for the owner lab.
- Backend: stores optional custom state after a holder signs an edit message.
- Chain indexer: scans MotorHeads `Transfer` logs from the deploy block, then only scans new blocks on a cron schedule.
- D1: stores custom overlays, colors, agent state, cached gas/block data, transfer counts, sale counts, owners, and holder-age checkpoints.
- IPFS/Filebase: remains the immutable base art and metadata layer.

## Chain-State API

```text
GET /v1/chain/summary
GET /v1/tokens/:tokenId/chain-state
POST /v1/indexer/run
```

`POST /v1/indexer/run` is locked with `X-Indexer-Token` and is only for manual backfill/repair. Cloudflare Cron runs the same indexer automatically when deployed.

The chain indexer needs:

```text
ETH_RPC_URL
MOTORHEADS_DEPLOY_BLOCK
INDEXER_ADMIN_TOKEN
```

NFT metadata is not rewritten when transfer/sale counts change. The animation/site reads this API and draws the current counter/scar/evolution state from cached backend data.
