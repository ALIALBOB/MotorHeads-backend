# Deployment

This backend is designed for Cloudflare Workers plus Cloudflare D1.

## 1. Create D1

```bash
npx wrangler d1 create motorheads_registry
```

Copy the returned `database_id` into `wrangler.toml`.

## 2. Migrate D1

```bash
npm run db:migrate:prod
```

For local testing:

```bash
npm run db:migrate:local
```

## 3. Configure Vars

Update `wrangler.toml`:

```toml
CORS_ORIGIN = "https://your-motorheads-site.pages.dev"
ALLOW_UNVERIFIED_WRITES = "false"
MOTORHEADS_DEPLOY_BLOCK = "replace-with-contract-deploy-block"
INDEXER_CONFIRMATIONS = "6"
INDEXER_MAX_BLOCK_RANGE = "1000"
INDEXER_MAX_LOGS_PER_RUN = "50"
GAS_LOW_GWEI = "15"
GAS_MEDIUM_GWEI = "45"
GAS_HIGH_GWEI = "90"
EMERGENCY_READ_ONLY = "false"
INDEXER_ENABLED = "true"
SAFETY_MAX_INDEXER_RUNS_PER_DAY = "320"
SAFETY_MAX_RPC_CALLS_PER_DAY = "5000"
SAFETY_MAX_REGISTRY_WRITES_PER_DAY = "1000"
```

Keep `ALLOW_UNVERIFIED_WRITES` false for production until real wallet signature verification and ownership checks are enabled.

Safety switches:

- `EMERGENCY_READ_ONLY=true` stops cron indexing, manual indexer runs, and registry writes while cached public reads keep working for the live NFT animations.
- `INDEXER_ENABLED=false` stops only the chain indexer.
- `SAFETY_MAX_INDEXER_RUNS_PER_DAY`, `SAFETY_MAX_RPC_CALLS_PER_DAY`, and `SAFETY_MAX_REGISTRY_WRITES_PER_DAY` are soft daily guards stored in D1. When a guard is exhausted, protected work returns a safety error instead of continuing.
- Public read routes are intentionally not safety-blocked. Pinned NFT animations must keep rendering even if chain data is stale or missing.

Cloudflare budget alerts are still required for billing warnings. These Worker switches are an application brake, not a billing-system hard cap.
Set or change them in Cloudflare under Workers & Pages -> motorheads-backend -> Settings -> Variables, then save/deploy the Worker.

Set these as Worker secrets, not public repo values:

```bash
npx wrangler secret put ETH_RPC_URL
npx wrangler secret put INDEXER_ADMIN_TOKEN
```

`ETH_RPC_URL` should be an Ethereum mainnet RPC URL from Alchemy, Infura, QuickNode, or another provider. `MOTORHEADS_DEPLOY_BLOCK` should be the block where the MotorHeads contract was deployed.

## 4. Deploy

```bash
npm run deploy
```

## 5. Website Integration Later

The website should call:

- `GET /v1/config`
- `GET /v1/parts`
- `GET /v1/tokens/:tokenId/state`
- `GET /v1/tokens/:tokenId/chain-state`
- `GET /v1/chain/summary`
- `GET /v1/agent/:tokenId`

When the owner editor is ready, the wallet signs an edit message. The backend verifies it, confirms token ownership, and then saves custom positions/colors.

## 6. Chain Indexer

The Worker has a cron trigger in `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

Every run scans only new confirmed blocks since `chain_indexer_checkpoint.indexed_to_block`. It does not rescan all 5,555 tokens each day.

To manually run one batch after deployment:

```bash
curl -X POST https://your-worker-url/v1/indexer/run \
  -H "X-Indexer-Token: your-secret-token"
```

The first backfill may need multiple runs because `INDEXER_MAX_BLOCK_RANGE` keeps each request small enough for Worker/RPC limits.
The indexer also respects `INDEXER_MAX_LOGS_PER_RUN` and checkpoints after complete blocks, so quiet ranges can move fast while busy
sale/transfer ranges stay safer for the Cloudflare Free D1 query budget. Keep cron at every 5 minutes unless live checkpoints
show repeated deferred logs; increasing the log budget is cheaper than increasing Worker invocations.
When one block contains more logs than the per-run budget, the checkpoint payload stores a log-index cursor and resumes inside that
same block on the next cron run instead of skipping unprocessed events.
