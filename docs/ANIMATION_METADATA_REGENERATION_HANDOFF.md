# MotorHeads Animation and Metadata Handoff

Last updated: 2026-06-09

This note is the production checkpoint before regenerating MotorHeads animation files and metadata. Use it when a new chat/session needs to resume the work.

## Current Live State

- Collection: MotorHeads
- Supply: 5555
- Chain: Ethereum mainnet
- Contract: `0x0a5008550fc1402bb567a3ba38d9433e6199ceb1`
- Treasury/main wallet: `0x95A6fB3087b3469Ed777120052E0ac3f262c81C1`
- Current base URI on contract: `ipfs://bafybeidoduu5fudul2j46p2iefeaiwg7plkucwgsesih7gjsltbp44acma/`
- Current images CID: `bafybeihodojvhdsjn6d2romph3jo2u5yexzqidiitnlwshej3u4oaqklxq`
- Current animations CID: `bafybeibncy2oyrsodh4ctsh2lr4l5zvalzakt5isndtjsgtwdhlmazbakq`
- Current contract metadata CID: `bafybeicgckcmtjt63iwxgbkr3jouzcabpxncs5qcp4vunlfiirlgeb344a`
- Existing treasury mint: tokens `1` through `10`
- Treasury mint block: `25265980`
- Treasury mint tx: `0x688a118d5faed0cbd9969bed57487dc9f59da230259f32c7d88d74a07a23edf3`

## Prepared Smooth Animation CIDs

Prepared on 2026-06-10. These are uploaded and gateway-verified, but not on-chain until `setBaseURI` is called.

- Images CID reused: `bafybeihodojvhdsjn6d2romph3jo2u5yexzqidiitnlwshej3u4oaqklxq`
- Superseded smooth animations CID with assembly/cache bug: `bafybeieyhpb5ygv7bbq7yivdwhcg2au254foqakhhjkvgxe37h5qrfrgr4`
- Superseded metadata CID with assembly/cache bug: `bafybeigjy3a6akv53iudidtm43ogz6n3y3eqax6nc5q3yftk4j4hrchysa`
- Superseded corrected smooth animations CID with `v2` browser storage key: `bafybeiehpvube6l3unkneggk3icjv7cykbex7rm5jxe6coabwg2ecr4evy`
- Superseded corrected metadata CID with `v2` browser storage key: `bafybeidtaswxdemksiojw5voqe4hgaamu2t32mc2mnbbpqavfzi2yopjx4`
- Final v3 cache-reset animations CID: `bafybeidpnsa3roqyddqa7vkl3gagyae3kqgqbtwkbybtslkuj7d6vecygq`
- Final v3 cache-reset metadata CID: `bafybeibsirode2cuztk2zkzsze3wzaktrdn3fk2vkbpuxlf7cldlx53s6m`
- Final candidate base URI: `ipfs://bafybeibsirode2cuztk2zkzsze3wzaktrdn3fk2vkbpuxlf7cldlx53s6m/`
- Gateway check passed for:
  - `https://ipfs.filebase.io/ipfs/bafybeidpnsa3roqyddqa7vkl3gagyae3kqgqbtwkbybtslkuj7d6vecygq/2.html`
  - `https://ipfs.filebase.io/ipfs/bafybeidpnsa3roqyddqa7vkl3gagyae3kqgqbtwkbybtslkuj7d6vecygq/10.html`
  - `https://ipfs.filebase.io/ipfs/bafybeibsirode2cuztk2zkzsze3wzaktrdn3fk2vkbpuxlf7cldlx53s6m/2`
- OpenSea readiness passed with `0` warnings across `5555` metadata files and `5555` media slots.
- Do not mark these as the current live CIDs until the mainnet contract base URI has actually been updated.
- The v3 animation storage key is `lamOpenSeaAssembly:v3-cache-fix:...`; this intentionally ignores old token-specific `v2` localStorage that could keep broken assembled positions after a metadata refresh.

## Live Backend

- Worker URL: `https://motorheads-backend.zacbosugame.workers.dev`
- D1 database: `motorheads_registry`
- D1 database ID: `c34beb92-48c2-46ff-b01c-41b92b16a633`
- Cloudflare account ID: `8fbde9ea4860e7db2999dc8de3309680`
- Indexer cron: every 5 minutes
- ETH RPC secret currently set to `https://rpc.mevblocker.io`
- Manual indexer route: `POST /v1/indexer/run` with `X-Indexer-Token`
- Public chain summary: `GET /v1/chain/summary`
- Public token state: `GET /v1/tokens/:tokenId/chain-state`

Known good live checks:

```text
GET /v1/tokens/1/chain-state
owner = 0x95a6fb3087b3469ed777120052e0ac3f262c81c1
mintedAtBlock = 25265980
transferCount = 0
saleCount = 0
gasLevel = low
evolutionTier = one-day
source = indexer
```

## Repos and Workspaces

- Backend repo: `D:\MotorHeads-backend`
- Website repo: `D:\MotorHeads-5555`
- Generator/art workspace: `D:\MotorHeads-mechanical-canvas\mechanical-canvas-nft`
- The generator workspace is not currently a Git repo.
- Do not commit generated 5555 media, CAR files, local logs, `.env`, `.dev.vars`, or secrets.

## Before Regenerating Anything

Do these before creating new animation and metadata CIDs:

1. Confirm the backend still returns indexed data:
   - `GET https://motorheads-backend.zacbosugame.workers.dev/v1/chain/summary`
   - `GET https://motorheads-backend.zacbosugame.workers.dev/v1/tokens/1/chain-state`
2. Patch the animation generator in:
   - `D:\MotorHeads-mechanical-canvas\mechanical-canvas-nft\scripts\generate-animations.js`
3. The generated animation JS must fetch:
   - `https://motorheads-backend.zacbosugame.workers.dev/v1/tokens/${tokenId}/chain-state`
   - optionally `https://motorheads-backend.zacbosugame.workers.dev/v1/chain/summary`
4. Keep a deterministic fallback if backend fetch fails. OpenSea/IPFS iframes can block, timeout, or wake slowly.
5. Confirm the animation still starts in dismantled mode for first-time viewers.
6. Confirm only three corner buttons show in marketplace animation:
   - `D` dismantle
   - `A` assemble
   - `S/P` stop/start motion
7. Confirm browser-local assembly state still saves with `localStorage`.
8. Confirm the static image remains the first visual users see on OpenSea.
9. Confirm metadata keeps base DNA immutable:
   - `base_traits_mutable: false`
   - `locked_base_trait_hash`
   - `base_dna`
10. Confirm alive/customization metadata stays present for the future website:
    - `customization_enabled`
    - `editable_slots`
    - `custom_state_uri`
    - `alive`
    - `part_manifest_uri`
    - `palette_manifest_uri`

## Animation Performance Notes

The OpenSea animation feels heavy mostly because the art/renderer is heavy, not because it will magically become smoother with time.

Current generated animation shape:

- Token `1.html` is about 1.6 KB.
- Token `1.js` is about 89 KB because it embeds that token layout.
- `build/animations` has `11114` files: `.html` plus `.js` for every token.
- Total animation folder size is about 448 MB.
- Static image folder is about 520 MB.
- Metadata folder includes both `.json` and extensionless token URI files, about 96 MB total.

Why OpenSea may feel slow:

- Canvas redraws many transparent plates, gears, glow effects, particles, counters, scars, and mouse effects.
- Assembled preview mode renders up to 30 FPS.
- Marketplace iframes have less CPU/GPU budget than a normal browser tab.
- IPFS gateway cold loads can make first open feel worse.
- Every token has its own JS file, so caching shared runtime modules may not help as much as it could.

Recommended performance fixes before a new animation CID:

- Fetch backend state with a short timeout and cache the last successful result in memory.
- Poll backend slowly, not every frame. Suggested: chain state every 30-60 seconds, summary every 15-30 seconds.
- Keep first-open dismantled and low-motion.
- When assembled, cap OpenSea animation to 20-24 FPS unless dragging.
- Disable or reduce expensive cursor rings, glow bursts, and particle overlays when the mouse is idle.
- Avoid drawing snap hints unless a part is selected.
- Consider drawing static body/background to an offscreen canvas once, then only redraw moving overlays.
- Do not use direct Ethereum RPC from animation HTML. Use the Worker backend only.

## Backend Data Contract for Animation

Animation should map Worker data like this:

```js
const state = await fetch(`${BACKEND}/v1/tokens/${tokenId}/chain-state`).then((r) => r.json());
const chain = state.chainState;

chainState.gasPressure = chain.gasGwei;
chainState.baseFeeGwei = chain.gasGwei;
chainState.transferCount = chain.transferCount;
chainState.saleCount = chain.saleCount;
chainState.blockNumber = chain.latestBlock;
chainState.archiveAgeSeconds = chain.holderAgeDays * 86400;
chainState.holderBondSeconds = chain.holderAgeDays * 86400;
chainState.saleTier = chain.saleCount > 0 ? "Verified Sale" : "";
chainState.liveMode = true;
```

Use fallback values when any field is missing.

## Generation Commands

Run from:

```powershell
cd D:\MotorHeads-mechanical-canvas\mechanical-canvas-nft
```

Core generation scripts:

```powershell
npm run lam:collection
npm run lam:layouts
npm run lam:animations
npm run lam:metadata
npm run lam:contract-metadata
npm run lam:validate-opensea
```

CAR commands:

```powershell
npm run lam:car:images
npm run lam:car:animations
npm run lam:car:metadata
npm run lam:car:contract
```

Metadata environment variables must be set before `lam:metadata`:

```text
IMAGE_BASE_URI=ipfs://<new-images-cid>
ANIMATION_BASE_URI=ipfs://<new-animations-cid>
EXTERNAL_BASE_URL=<future website token URL>
CUSTOM_STATE_BASE_URI=https://motorheads-backend.zacbosugame.workers.dev/v1/tokens
PART_MANIFEST_URI=<future part manifest URI>
PALETTE_MANIFEST_URI=<future palette manifest URI>
ALIVE_REGISTRY_ADDRESS=TBD_AFTER_DEPLOY
```

Do not leave placeholders like `IMAGE_CID`, `ANIMATION_CID`, `example.com`, or `TBD_AFTER_DEPLOY` in production metadata unless that field is intentionally not launched yet and the validator is adjusted knowingly.

## OpenSea and Contract Update Checklist

Before calling `setBaseURI` again:

1. Generate a small sample first, not all 5555.
2. Open sample animation locally and verify:
   - D/A/S buttons work.
   - Dismantle and assemble work.
   - Drag still works.
   - Snap/magnet still feels acceptable.
   - No dev side panels or metadata browser UI appear.
   - Backend state appears after fetch.
   - No permanent blank screen if backend is down.
3. Capture sample images for visual review.
4. Generate all 5555 only after sample passes.
5. Upload animations to Filebase/IPFS.
6. Upload images if changed.
7. Regenerate metadata with final image/animation CIDs.
8. Upload metadata to Filebase/IPFS.
9. Validate metadata with `npm run lam:validate-opensea`.
10. Test `ipfs://<metadata-cid>/1` or gateway equivalent and confirm it resolves.
11. Call `setBaseURI("ipfs://<metadata-cid>/")` only after the metadata CID is final.
12. Refresh token `1` on OpenSea and verify image + animation.

## Important Warnings

- Do not change the base URI until the new animation CID is tested.
- The 10 already minted tokens can still update after `setBaseURI`, but bad metadata will show publicly immediately after refresh.
- Do not rely on OpenSea testnet. OpenSea discontinued dedicated testnet support.
- Do not make the animation fetch Ethereum RPC directly. Browser CORS, RPC rate limits, and marketplace iframe restrictions make it unreliable.
- Public RPC endpoints are fragile. The Worker currently works with `rpc.mevblocker.io`, but a paid Alchemy/Infura/QuickNode URL is safer before public mint.
- Current Worker CORS is `*` so IPFS animation iframes can fetch it. Lock this down later only after the final website/domain exists.
- Never commit `.env`, `.dev.vars`, Filebase keys, Pinata keys, private keys, generated CAR files, or full 5555 build output.

## Next Best Step

Patch `generate-animations.js` so every generated token animation reads `chain-state` from the Worker, with a timeout and fallback. Then generate 5-10 sample animations, test OpenSea-like iframe behavior locally, and only after that regenerate all 5555.

## 2026-06-09 Local Generator Patch

The local generator workspace has now been patched at:

```text
D:\MotorHeads-mechanical-canvas\mechanical-canvas-nft\scripts\generate-animations.js
```

Important: this generator workspace is not a Git repo, so the code change is local-only unless the workspace is later moved into a repository.

What changed:

- Generated animations now fetch token state from `https://motorheads-backend.zacbosugame.workers.dev/v1/tokens/:tokenId/chain-state`.
- Fetch is disabled in capture mode.
- Fetch has a timeout and deterministic fallback, so an IPFS/OpenSea iframe should never go permanently blank if the backend is slow.
- Polling is throttled to 45 seconds by default, with a minimum of 15 seconds.
- Animation defaults to `motion=marketplace`, which lowers CPU cost:
  - assembled preview is capped around 20 FPS instead of 30 FPS,
  - idle render is capped around 8 FPS instead of 12 FPS,
  - cursor glow rings are fewer and shorter.
- `motion=full` or `motion=studio` restores fuller local/studio motion.
- Debug-only body dataset markers were added:
  - `data-chain-source`
  - `data-chain-block`
  - `data-backend-online`
  - `data-backend-error`
- Optional test query params were added:
  - `start=assembled`
  - `start=dismantled`
  - `resetAssembly=1`
  - `play=0`
- Drag tuning patch added after browser testing:
  - dragged parts now follow the pointer directly instead of easing behind it,
  - selected-part render cap is raised to about 34 FPS in marketplace mode,
  - snap radius is widened to about `104-150px`, based on part size,
  - the dashed line from part to socket was removed,
  - cursor rings are darker smoky teal/black with a small warm metallic glow,
  - `drawMachine(..., { performanceMode: "drag" })` skips the expensive atmosphere/history/live overlays only while a part is being dragged.
- Smooth-motion patch added after browser testing:
  - the attempted high-FPS marketplace preview was reverted because it made weaker browsers feel heavier,
  - marketplace assembled preview is now balanced at about 24 FPS,
  - `motion=eco` or `eco=1` tests an ultra-light about 12 FPS mode,
  - baseline gear/wheel rotation speed was restored to visible motion after the too-slow eco pass made gears look frozen,
  - generated animations now pass real-time `motionTime` again; do not slow or cap the clock as a lag fix,
  - `performanceMode: "marketplace"` skips the heaviest atmosphere/history/live overlays and body life wobble during normal marketplace playback,
  - marketplace playback uses a cached static base layer so the renderer does not redraw the whole robot body/background every frame,
  - only dynamic layers are redrawn on top: gears/wheels, expression/eyes, gas readers, sale/block/transfer counters, and other chain readouts.
- Follow-up smoothness patch added after side-by-side testing:
  - marketplace playback now caches static art as z-ordered runs instead of one flat base, preserving plate/gear stacking closer to the original render,
  - a cheap whole-machine mouse lean is restored in marketplace mode,
  - a cheap whole-machine body bounce is restored in marketplace mode without per-part wobble, then slightly increased after testing so it reads visibly,
  - drag mode now uses its own cached still frame and redraws only the part in the pointer hand, reducing drag lag,
  - drag cache is invalidated by selected part ID, chain state, material/background state, and non-selected part positions.
- The renderer fast path is in:
  - `D:\MotorHeads-mechanical-canvas\mechanical-canvas-nft\web\src\renderer.js`

Local sample status:

- Regenerated token animation samples `1-5` only after the backend, drag tuning, static-run cache, body-bounce, and drag-cache patches.
- DOM test confirmed token `1` can reach the Worker:
  - `data-chain-source="indexer"`
  - `data-chain-block="25281028"` during test
  - `data-backend-online="true"`
- Static CORS check passed with `Access-Control-Allow-Origin: *`.
- Local assembled screenshot rendered successfully.
- Local static animation server used for browser testing:
  - `http://127.0.0.1:8799/living-archive/animations/1.html?resetAssembly=1`
  - the server command serves `D:\MotorHeads-mechanical-canvas\mechanical-canvas-nft\web\public`.

Do not regenerate all 5555 or upload a new animation CID until a manual browser pass confirms the token 1 sample feels good enough in normal Chrome, not only headless Chrome.
