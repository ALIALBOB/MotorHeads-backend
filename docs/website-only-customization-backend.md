# Website-Only Customization Backend

Status: Phase 3A local beta foundation

This backend stores a validated MotorHeads workshop layout for display on
`motorheadsonline.com`. It does not modify the original NFT, metadata, image,
animation, token URI, base URI, Filebase objects, IPFS CIDs, or OpenSea display.

The future user-facing action is `SAVE TO ARCHIVE`:

- the holder signs a Sign-In with Ethereum message;
- no transaction is sent and no gas is charged;
- the backend verifies current ownership and saves website-only state;
- the original MotorHead remains the fallback when customization is unavailable.

`SAVE ON-CHAIN` is a separate future phase and is not implemented here.

## Supported Scope

- Chain: Ethereum mainnet, chain ID `1`
- Collection: `0x0a5008550fc1402bb567a3ba38d9433e6199ceb1`
- Token IDs: `1` through `5555`
- State schema: `1`
- Maximum request body: 32 KiB
- Maximum saved items: 16
- Background: `null` only
- Disabled save categories: Golden Traits, badges, and pets

All three customization features default to disabled:

```text
CUSTOMIZATION_READS_ENABLED=false
CUSTOMIZATION_WRITES_ENABLED=false
CUSTOMIZATION_AUTH_ENABLED=false
```

## Request Flow

### Authentication

1. `POST /v1/auth/nonce` creates a 128-bit random nonce.
2. Only `SHA-256(nonce)` is stored in D1.
3. The wallet signs the EIP-4361-compatible SIWE message.
4. `POST /v1/auth/verify` validates signature, recovered address, nonce,
   domain, URI, chain ID, statement, issued-at, expiration, and optional
   not-before time.
5. A 256-bit opaque session token is generated and hashed.
6. One D1 transactional batch conditionally consumes the nonce, inserts the
   new session, and revokes an optional prior session during reauthentication.
7. A failed session insert rolls back nonce consumption and leaves a prior
   valid session untouched, so verification can be retried safely.
8. Only `SHA-256(sessionToken)` is stored in D1. The raw token is returned only
   in an HttpOnly cookie.

The implementation verifies EOA signatures through `viem`. If EOA recovery
fails, it checks the claimed address with read-only `eth_getCode`: an empty
result returns `401 INVALID_WALLET_SIGNATURE`, detected contract bytecode
returns `501 CONTRACT_WALLET_AUTH_UNSUPPORTED`, and an unavailable wallet-type
check returns retryable `503 WALLET_TYPE_CHECK_UNAVAILABLE`. EOA wallets only
are supported in this beta. Safe and other smart-contract wallets require a
later reviewed EIP-1271 phase.

### Session

Production cookie:

```text
__Host-mh_session=<opaque token>; Path=/; HttpOnly; SameSite=Lax; Secure
```

It has no `Domain` attribute. Local development uses the separate
`mh_session_dev` non-Secure cookie. Sessions expire after 24 hours by default,
are rotated on successful reauthentication, are revoked on logout, and store
only their hash.

### Save

`PUT /v1/customizations/:contract/:tokenId` performs this order:

1. require write and auth feature flags;
2. require an allowed Origin and valid session;
3. enforce the D1-backed write limit;
4. validate the supported contract and token ID;
5. call Ethereum `ownerOf(tokenId)` using `eth_call` at `latest`;
6. require the current owner to equal the session wallet;
7. fetch only the selected token placement manifest;
8. verify manifest schema, token, source hash, and versions;
9. run the versioned shared Holder Auto Fit validator;
10. normalize the state again on the server;
11. canonicalize and Keccak-256 hash normalized state;
12. enforce `expectedRevision`;
13. atomically append history and update current state with D1 `batch()`;
14. return the new revision and state hash.

The backend never trusts client ownership, client normalization, OpenSea owner
data, a wallet address in JSON, or an earlier ownership check.

### Reset

`DELETE /v1/customizations/:contract/:tokenId` repeats session, rate-limit, and
fresh `ownerOf` checks. It appends a `RESET` history revision and marks current
state inactive. It does not delete history or reuse revision numbers.

## API Endpoints

### `POST /v1/auth/nonce`

Authenticated CORS policy, but no existing session required. Optional body:

```json
{ "address": "0x..." }
```

Returns nonce context for the configured SIWE domain and URI.

### `POST /v1/auth/verify`

Body:

```json
{ "message": "...", "signature": "0x..." }
```

Returns the normalized wallet and sets the session cookie.

### `GET /v1/auth/session`

Returns authenticated wallet and expiration for a valid session.

### `POST /v1/auth/logout`

Revokes the current session and expires its cookie.

### `GET /v1/customizations/:contract/:tokenId`

Public, non-credentialed read. Active state returns:

```json
{
  "exists": true,
  "contractAddress": "0x...",
  "tokenId": 183,
  "revision": 4,
  "stateHash": "0x...",
  "state": {},
  "updatedAt": "...",
  "renderable": true
}
```

Missing or reset state returns `exists: false`, `state: null`, and the current
revision. Session, nonce, signature, RPC, and network identity data are never
returned. `ownerAtSave` and `savedBy` remain internal D1 audit fields and are
never exposed by the public endpoint. No public history route exists in this
beta.

### `PUT /v1/customizations/:contract/:tokenId`

Authenticated save with `{ expectedRevision, state }`. A stale revision returns
`409 CUSTOMIZATION_STATE_CONFLICT` with `currentRevision`.

### `DELETE /v1/customizations/:contract/:tokenId`

Authenticated reset with `{ expectedRevision }`. The tombstone revision is
preserved and must be used by the next save.

Errors use:

```json
{
  "error": {
    "code": "TOKEN_NOT_OWNED",
    "message": "The connected wallet does not currently own this MotorHead.",
    "retryable": false
  }
}
```

All error responses use `Cache-Control: no-store`.

## Shared Validator

The backend does not hand-copy placement logic. The sync script imports the
website's versioned, Worker-compatible pure validation artifact into:

```text
src/vendor/holder-validation/v1/
```

The artifact records:

- website source commit;
- validation version;
- catalog version;
- placement manifest version;
- artifact SHA-256.

Run this before review whenever the approved website artifact changes:

```powershell
node scripts/sync-holder-validation.mjs
node scripts/verify-holder-validation-artifact.mjs
```

The current copied artifact SHA-256 is
`b60342bc8b4e95b33d1404bf3ff0a177f612a5885e3c6227e3091e0d8df6c800`.
Version mismatch, source-layout mismatch, unknown items, pending items,
unsupported mount zones, protected-region violations, category conflicts, and
disabled categories fail closed.

## Placement Manifests

`HOLDER_PLACEMENT_BASE_URL` points to a versioned read-only source. The Worker
fetches only:

```text
{HOLDER_PLACEMENT_BASE_URL}/holder-placement/v1/tokens/{tokenId}.json
```

Valid responses may be cached for one hour in the Worker Cache API. The parser
enforces a 1 MiB streamed response limit even when `Content-Length` is absent.
Transient upstream failures are retried once. Invalid, unavailable, or version-
mismatched manifests never fall back to unrestricted placement and never alter
the current saved state.

## Canonical State Hash

Only the server-normalized state is hashed. Canonicalization is a deterministic,
RFC 8785-style subset implemented for this closed JSON schema:

- object keys are recursively sorted lexicographically;
- arrays retain normalized order;
- strings and booleans use JSON serialization;
- finite numbers use JSON number serialization;
- negative zero is normalized to zero;
- unsupported and non-finite values are rejected.

The EVM-compatible hash is:

```text
Keccak-256(UTF8(canonicalNormalizedState))
```

The normalized state binds schema, chain, contract, token, catalog version,
placement-manifest version, source-layout hash, null background, and validated
items.

## D1 Storage

Local migration: `migrations/0001_website_customization_beta.sql`.

- `mh_auth_nonces`: nonce hashes, bounded SIWE context, and the hash of the
  session created by the successful nonce consumption
- `mh_auth_sessions`: session hashes, wallet, expiration, revocation, and hashed
  request metadata
- `mh_customization_states`: current token-bound state and revision
- `mh_customization_history`: immutable ordered `SAVE`/`RESET` revisions
- `mh_rate_limits`: durable fixed-window counters

The history trigger requires the next revision to equal current revision plus
one. Current and history writes use D1 transactional `batch()` statements.
Authentication also uses one D1 transactional batch for conditional nonce
consumption, session insertion, and optional prior-session revocation.
The migration has only been exercised against local ephemeral D1 in this phase.

## Transfer Policy

Customization belongs to the token:

- state survives transfer;
- the new owner inherits the current website appearance;
- the previous owner immediately loses save/reset access;
- only a fresh `ownerOf` result authorizes each mutation;
- `ownerAtSave` is history, not authorization;
- RPC failure fails closed and preserves state.

## RPC Policy

The beta uses one configured Ethereum JSON-RPC endpoint. Every PUT and DELETE
performs a fresh `ownerOf(tokenId)` read with `eth_call` at `latest`; failed
EOA recovery uses `eth_getCode` only to distinguish unsupported contract
wallets from bad EOA signatures. RPC errors, malformed results, and timeouts
fail closed before customization state changes. RPC URLs are never returned or
logged by the customization error path.

Production still requires provider monitoring and a reviewed availability
strategy. A primary/fallback provider model may be added later, but no quorum,
fallback, or finality guarantee exists now. The launch finality policy must be
chosen deliberately and tested in staging.

## CORS and Response Policy

Public customization reads use wildcard CORS without credentials. Auth and
write routes use an exact configurable origin list, credentials, and
`Vary: Origin`; an absent or unknown Origin is rejected. Existing public
state uses `Cache-Control: public, max-age=15, stale-while-revalidate=30` and
a stable revision/state-hash ETag. Matching `If-None-Match` receives `304`.
Missing state uses `public, max-age=5`. Auth/write responses and all errors
use `Cache-Control: no-store`. The existing public chain-state route keeps its
prior behavior and schema.

Default allowed origins:

- `http://localhost:5173`
- `http://127.0.0.1:5173`
- `https://motorheadsonline.com`
- `https://www.motorheadsonline.com`

## Rate Limits

Default application limits are stored in D1, never Worker memory:

- nonce: 20 per 15 minutes per hashed IP bucket;
- verify: 10 per 15 minutes per hashed IP and wallet bucket;
- save/reset: 30 per hour per hashed session/wallet/request bucket.

These values are configurable. Production edge/WAF limits and billing alerts
are still recommended before enabling any public beta.

## Retention and Local Cleanup

Authentication and rate-limit rows have bounded, rerunnable cleanup:

- expired or old consumed nonces: retained for 7 days;
- expired or revoked sessions: retained for 30 days;
- expired rate-limit buckets: retained for 2 days;
- at most 500 rows are deleted from each table per run.

Cleanup never targets current customization state, customization history, or
revisions. It is local-only in this phase and has no Worker cron:

```powershell
npm run customization:cleanup:local
```

A production schedule requires separate review, staging migration verification,
observability, and explicit approval. It must invoke the same bounded operation
without changing the existing five-minute chain indexer cron.

## Legacy Write Surface

The older header-shaped mutation route remains separate and locked by
`ALLOW_UNVERIFIED_WRITES=false`. Customization routes ignore those legacy
headers and require the new opaque session cookie for PUT/DELETE. They do not
reuse, enable, or remove the old route. See
`docs/legacy-write-surface-retirement.md`.

## Configuration Locks

Reads require D1. Authentication additionally requires a valid Ethereum RPC
URL, exact non-wildcard origins, matching SIWE domain/URI, Ethereum chain ID 1,
and the supported MotorHeads contract. Writes also require a valid versioned
placement base URL. Missing configuration returns a safe
`503 CUSTOMIZATION_CONFIGURATION_INVALID` only on the customization surface;
it does not affect the legacy chain-state route or reveal secret values.

## Local Setup

The automated path is self-contained and uses Miniflare, ephemeral D1, mocked
`ownerOf`, selected-token manifest fixtures, and ephemeral test wallets:

```powershell
npm install
npm run check
npm run test:customization
npm run test:hardening
npm run customization:cleanup:local
npm test
npm run proof:customization
npm audit --audit-level=high
```

For manual local Worker work, first apply only the local schema:

```powershell
npm run db:migrate:local
npm run dev:customization
```

Configure a read-only local `HOLDER_PLACEMENT_BASE_URL` and an Ethereum RPC URL
outside committed files. Never use `db:migrate:prod` for this phase. Never put
RPC credentials, wallet keys, session tokens, signatures, or nonce values in
Git or reports.

## Future Production Domain

The planned API host is `api.motorheadsonline.com`. Keeping the website on
`motorheadsonline.com` and API on a same-site subdomain allows a Secure,
host-only HttpOnly cookie without depending on third-party cookie behavior for
the current `workers.dev` domain. No custom domain or production auth setting
is configured in Phase 3A.

## Failure Behavior

Customization is optional. If auth, D1, ownership RPC, manifest delivery, or
validation fails, the API returns a structured error and does not mutate state.
The frontend must fall back to the original pinned MotorHead. The original NFT
image and animation do not depend on this customization service.

## Explicit Non-Goals

Phase 3A does not include:

- frontend `SAVE TO ARCHIVE` integration;
- background selection;
- Golden Trait, final badge, or final pet saving;
- an on-chain registry, relayer, or EIP-712 registry authorization;
- Filebase upload, pin, unpin, replacement, or new CID;
- metadata, image, animation, token URI, or base URI changes;
- OpenSea refresh or display changes;
- production D1 migration, secrets, domains, flag enablement, deployment, push,
  or contract transaction.
