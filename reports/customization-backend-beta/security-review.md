# Phase 3A Security Review

Date: 2026-07-13
Scope: local website-only customization backend
Release decision: local beta passes; production enablement is not approved

## Controls Implemented

### Authentication and secrets

- SIWE messages are parsed and cryptographically recovered with exact domain,
  URI, Ethereum mainnet chain ID, statement, issued-at, expiration, and optional
  not-before checks.
- Nonces use 128 bits from Web Crypto and sessions use 256 bits.
- D1 stores SHA-256 nonce and session hashes, never raw values.
- Nonces are one-time, bounded to roughly ten minutes, and consumed in the same
  D1 transactional batch that inserts the replacement session and optionally
  revokes the prior session.
- Session insertion failure rolls back nonce consumption and leaves a prior
  session valid. Concurrent verification permits one winner and replay fails.
- Failed EOA recovery is classified with read-only `eth_getCode`: bad EOAs,
  detected contract wallets, and wallet-type RPC failure receive distinct safe
  responses. EIP-1271 is intentionally not partially implemented.
- Production cookies are `__Host-`, Secure, HttpOnly, SameSite=Lax, Path=/, and
  host-only. Development uses a separate cookie name.
- Reauthentication rotates and revokes the prior request session; logout revokes
  the current session.
- Application code and generated reports do not log or persist test private
  keys, raw cookies, nonce values, session tokens, or signatures.

### Authorization

- Only the MotorHeads contract and token IDs 1-5555 are accepted.
- Every PUT and DELETE performs a fresh mainnet `ownerOf(tokenId)` call.
- Session address, client JSON, OpenSea data, and `ownerAtSave` are never used as
  substitutes for current ownership.
- Ownership RPC failure and malformed responses fail closed without mutation.
- State remains token-bound across transfer; the previous owner loses mutation
  access and the new owner can update or reset inherited state.

### Input and validation

- Request bodies are streamed with a 32 KiB ceiling before JSON parsing.
- Exact object keys, own prototypes, maximum depth, array counts, finite numbers,
  and bounded strings are validated before ownership RPC work.
- Prototype keys, arbitrary URLs, images, SVG, HTML, custom text, executable
  fields, unsupported collections, and invalid token IDs are rejected.
- The server reruns the versioned Holder Auto Fit validator and normalization.
- Golden Traits, badges, pets, pending items, and unknown items are not saveable.
- Only a null background is accepted in this beta.
- Selected-token placement responses are streamed with a 1 MiB ceiling even if
  `Content-Length` is missing, then schema/version/source validated.
- Manifest failure never falls back to unrestricted placement.

### Integrity and concurrency

- Hash input is the server-normalized closed schema, not raw client JSON.
- State hash is 0x-prefixed Keccak-256 over deterministic canonical JSON.
- Optimistic `expectedRevision` prevents silent overwrite.
- The D1 history revision trigger, history primary key, current-row conditional
  update, and transactional `batch()` preserve ordered state/history changes.
- Reset appends a tombstone revision and marks current state inactive; it does
  not delete history or reuse a revision.

### Browser and HTTP policy

- Auth/write routes use an exact origin allowlist, credentials, and `Vary:
  Origin`; wildcard authenticated CORS is impossible.
- Missing or unknown Origin is rejected for authenticated operations.
- Public reads use wildcard CORS without credentials.
- Public state excludes `ownerAtSave`, `savedBy`, auth history, and request
  identity data. Those owner fields remain internal D1 audit records.
- Existing state uses a 15-second public cache with 30-second
  stale-while-revalidate and a revision/state-hash ETag. Missing state uses five
  seconds; matching `If-None-Match` receives `304`.
- Auth/write responses and every structured error use `Cache-Control: no-store`.
- Customization errors expose exactly `code`, `message`, and `retryable`;
  internal details, SQL, paths, RPC URLs, hashes, cookies, and signatures are
  not serialized.
- Safe JSON content type, `nosniff`, and `no-referrer` headers are applied.
- The legacy public chain-state route is isolated from customization routing.

### Abuse and deployment locks

- Nonce, verify, and write limits use hashed D1 fixed-window buckets, not mutable
  Worker globals.
- A local-only bounded cleanup removes at most 500 expired nonce, session, and
  rate-limit rows per table while never targeting customization state/history.
- Reads, writes, and auth all default false in committed configuration examples.
- The placement base URL is empty in `wrangler.toml`.
- Missing D1/RPC/origin/SIWE/chain/contract/placement configuration fails closed
  on the relevant customization scope without affecting legacy chain-state.
- Legacy wallet headers cannot authorize customization PUT/DELETE; the old
  mutation feature remains locked by `ALLOW_UNVERIFIED_WRITES=false`.
- No production migration, domain, secret, deploy, push, or feature enablement
  occurred.

## Confirmed Test Evidence

- Authentication: PASS 11/11
- Ownership and transfer: PASS 4/4
- API, validation, revision, hashing, and rate limits: PASS 10/10
- Pre-commit hardening: PASS 12/12
- Legacy regression: PASS 6/6
- Aggregate customization matrix: PASS 43/43
- D1 migration parity: PASS
- Local proof: PASS 12/12, five owner calls, zero transactions
- Local bounded cleanup: PASS
- Validator artifact fingerprint: PASS
- `npm audit --audit-level=high`: PASS, zero known vulnerabilities

## Remaining Risks and Production Gates

1. EIP-1271 contract-wallet SIWE is not supported. This beta authenticates EOAs
   only; Safe and other contract wallets need a later reviewed phase.
2. Ownership and wallet-type checks use one configured RPC endpoint and
   `latest`. Production needs provider monitoring, a reviewed availability
   strategy, and a deliberate finality decision. No quorum/fallback is claimed.
3. The future same-site API domain, production SIWE context, secure cookie path,
   DNS, TLS, and exact CORS values are not configured or live-tested.
4. Production D1 has not received the migration. The staging-only backup,
   dry-run, verification, and restore runbook must be exercised first.
5. D1 application rate limits are not a billing hard stop. Cloudflare edge
   limits, usage alerts, and a tested operational kill switch remain release
   gates.
6. Cleanup is local-only and unscheduled. A reviewed observable production
   schedule is required before sustained public use; it must not replace or
   change the existing indexer cron.
7. IPv6 prefix bucketing is intentionally simple and is not a substitute for
   Cloudflare edge abuse controls.
8. The placement source is not production-configured. It needs versioned,
   immutable delivery, availability monitoring, and cache/version procedures.
9. The copied validator must remain reproducible. Every update requires sync,
   fingerprint verification, full tests, and source-commit review.
10. `compatibility_date = "2026-06-08"` was retained to avoid changing the
    legacy Worker runtime in this local phase. Review it in staging.
11. The repository is JavaScript and has no generated binding types. Production
    would benefit from explicit binding/type validation.
12. No customization-specific production metrics, alerts, audit events, or
    support runbook is live.
13. The frontend is not integrated. CSRF/CORS/session behavior needs real-browser
    same-site staging tests before flags are enabled.
14. The legacy mutation surface remains in the codebase, although locked and
    regression-tested. Its eventual removal requires a separate caller audit and
    approval.

## Required Release Sequence

Before any production enablement:

1. review and commit this local branch;
2. create an isolated staging Worker and D1 database;
3. configure a versioned placement source and reviewed RPC binding;
4. apply the migration to staging only;
5. test same-site domain cookies and browser CORS/CSRF behavior;
6. add edge limits, billing alerts, telemetry, and an operational runbook;
7. add and review a bounded production cleanup schedule;
8. run the entire test/proof matrix against staging with synthetic accounts;
9. keep all production flags false until a separate explicit approval.

No item in this review authorizes deployment, migration, CID work, contract
transactions, metadata changes, or OpenSea changes.
