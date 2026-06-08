# Registry Model

The base NFT metadata is immutable on IPFS. The backend registry should only store optional owner customizations.

## Token Visual State

Each saved state belongs to one token:

- `token_id`
- `owner_address`
- `overlay_json`
- `color_json`
- `version`
- `signature`
- `signed_message`
- `updated_at`

The signed message should include:

- MotorHeads contract address
- Token ID
- Wallet address
- Edit payload hash
- Nonce or timestamp
- Chain ID `1`

## Agent Profile

Agent state is separate from the base traits:

- `token_id`
- `agent_name`
- `mood`
- `memory_json`
- `awakened_at`
- `updated_at`

This lets us evolve the website experience without corrupting OpenSea rarity traits.

## Important Rule

Do not overwrite base NFT traits. Custom visuals and agent state are a second layer. That keeps the mint clean, while still giving holders a living machine later.

