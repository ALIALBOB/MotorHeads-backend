# API

Base path is the Worker URL, for example:

```text
https://motorheads-backend.<account>.workers.dev
```

## Health

`GET /health`

Returns service status and API version.

## Config

`GET /v1/config`

Returns contract address, max supply, mainnet chain info, and current IPFS CIDs.

## Parts

`GET /v1/parts`

Returns the starter part library used by the future owner editor.

## Token Visual State

`GET /v1/tokens/:tokenId/state`

Returns a default state when no custom state is saved.

`PUT /v1/tokens/:tokenId/state`

Future endpoint for owner-signed custom visual saves. Required headers:

```text
X-Wallet-Address
X-Signature
X-Signed-Message
```

This route is locked in production until signature verification and token ownership checks are connected.

## Agent Profile

`GET /v1/agent/:tokenId`

Returns the awaken/agent profile for a token, or a default sleeping profile.

`POST /v1/agent/:tokenId/awaken`

Future endpoint for owner-signed awaken actions. It uses the same signature headers as visual state writes.

## Wallet Tokens

`GET /v1/wallet/:address/tokens`

Reserved for a future indexer. The website currently scans the contract through the connected wallet.

