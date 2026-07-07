# Save Registry Roadmap

Status date: 2026-07-07

This note records the agreed save plan for MotorHeads owner customization so we do not lose the thread later.

## Core Decision

Start with signed website saves, not on-chain transactions.

The first production save flow should be:

1. Owner connects wallet on the website.
2. Owner edits parts, stickers, badges, positions, scale, rotation, mirror state, colors, and animation preview locally.
3. Website builds a visual-state payload.
4. Owner signs one message with the connected wallet.
5. Backend verifies the signature and current token ownership.
6. Backend stores the approved visual state in D1.
7. Website loads the base NFT plus saved overlay state.

This version has no gas cost and does not touch the live NFT base metadata, base URI, image CID, animation CID, or locked base traits.

The website should keep true on-chain save labeled as coming soon until the registry contract exists.

## Why Signed Registry First

- It is safer for launch.
- It is reversible while the editor is still growing.
- It avoids asking users to pay gas for every visual experiment.
- It keeps the live collection metadata stable.
- It lets us ship wallet-secured owner saves before committing to permanent on-chain state.

## What Already Exists

- Cloudflare Worker backend is deployed.
- D1 registry binding exists.
- `GET /v1/tokens/:tokenId/state` returns default or saved visual state.
- `PUT /v1/tokens/:tokenId/state` exists as the future save endpoint.
- Write routes are locked in production.
- Chain state/indexer reads are separate from custom visual saves.

Important: writes must stay locked until real signature verification, ownership checks, nonce checks, and payload validation are complete.

## Phase 1: Signed D1 Save

Backend must add:

- Signature recovery for the signed save message.
- Current `ownerOf(tokenId)` verification against the MotorHeads contract.
- Nonce or expiration field to prevent replayed signatures.
- Strict payload validation.
- Stable saved-state versioning.
- CORS locked to the real website domain once the domain is ready.

Suggested signed message fields:

- Project name: `MotorHeads`
- Chain ID: `1`
- MotorHeads contract address
- Token ID
- Wallet address
- Visual payload hash
- Nonce or timestamp
- Expiration time
- Action: `save_visual_state`

Suggested saved overlay fields:

- `partId`
- `x`
- `y`
- `scale`
- `rotation`
- `mirrored`
- `z`
- `color`
- `animation`
- `group`

## Phase 2: Locked Badges And Stickers

Some badges, stickers, and parts may unlock only when the connected wallet holds another collection.

Best approach:

1. Store unlock rules in the backend part catalog.
2. Website can show locked/unlocked state for UX.
3. Backend must verify unlock rules again during save.

Example rule shape:

```json
{
  "partId": "badge-example",
  "unlock": {
    "type": "erc721_balance",
    "chainId": 1,
    "contract": "0x...",
    "minBalance": 1
  }
}
```

For ERC-721 collections, use `balanceOf(wallet)`.
For ERC-1155 collections, use `balanceOf(wallet, tokenId)`.

To keep calls under control, cache collection unlock checks briefly, but never trust only the frontend during save.

## Phase 3: Optional On-Chain Registry

Later, we can deploy a separate registry contract that stores a permanent pointer or hash for each token.

Possible shape:

```solidity
mapping(uint256 => string) public tokenStateCid;
mapping(uint256 => bytes32) public tokenStateHash;
```

The registry contract should:

- Point to the existing MotorHeads NFT contract.
- Allow only the current token owner, or approved operator, to update that token state.
- Store a CID, state hash, or both.
- Emit an event when state changes.
- Never modify base NFT metadata.

The actual visual JSON can live on IPFS/Filebase/R2, and the contract stores the pointer/hash.

## Metadata Rule

No new base metadata is required for the website save flow.

The base NFT remains:

- Same NFT contract.
- Same base metadata.
- Same image CID.
- Same animation CID.
- Same locked traits.

The website reads the custom state as a second layer.

New metadata would only be needed if we later require marketplaces to discover a new custom-state URL directly from metadata, or if the existing animation package cannot read the external registry/backend path we choose.

## Website Copy

Until Phase 3 exists, use copy like:

- `Local Preview`
- `Signed Save Coming Soon`
- `On-Chain Save Coming Soon`

Do not promise on-chain saves until the registry contract is deployed and tested.

## Safety Checklist Before Enabling Writes

- Signature recovery tested.
- Wrong-wallet save rejected.
- Non-owner save rejected.
- Replayed signature rejected.
- Expired signature rejected.
- Unknown part rejected.
- Locked badge rejected when wallet does not hold required collection.
- Valid owner save accepted.
- Saved state loads back into Room 05.
- Transfer behavior decided: new owner sees base by default unless they choose to adopt or overwrite prior overlay.

