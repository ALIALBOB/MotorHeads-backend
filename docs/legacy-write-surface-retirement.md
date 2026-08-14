# Legacy Write Surface Retirement

Status: locked, retained, and isolated during Phase 3A.1

## Current State

The original backend still contains header-shaped mutation handlers for:

- `PUT /v1/tokens/:tokenId/state`;
- `POST /v1/agent/:tokenId/awaken`.

They inspect `X-Wallet-Address`, `X-Signature`, and `X-Signed-Message`, but
committed configuration keeps:

```text
ALLOW_UNVERIFIED_WRITES=false
```

With that lock in place, the legacy mutation handlers return
`501 signature_verifier_pending` before registry mutation. The existing read
and chain-state routes are unchanged.

## Customization Isolation

The website-only customization API does not reuse this surface. Its PUT and
DELETE routes require:

- `CUSTOMIZATION_WRITES_ENABLED=true`;
- `CUSTOMIZATION_AUTH_ENABLED=true`;
- an exact allowed Origin;
- a valid opaque session cookie created by SIWE verification;
- a fresh successful `ownerOf(tokenId)` check;
- server-side placement validation.

Legacy wallet/signature headers do not create a customization session and
cannot authorize customization writes. Regression coverage verifies that the
legacy write feature stays locked and a session cookie remains mandatory.

## Why It Is Not Reused

The legacy shape does not provide the reviewed nonce, session, replay,
configuration, ownership, validation, revision, and history guarantees required
for `SAVE TO ARCHIVE`. Sharing the paths would blur independent safety models
and increase the chance of enabling the wrong mutation surface.

## Future Retirement

Removal requires a separate approved phase:

1. inventory all live and local callers;
2. confirm no pinned animation or production client depends on the read shape;
3. migrate any approved caller to a reviewed replacement;
4. observe a deprecation period;
5. remove only the unused mutation handlers and associated headers;
6. rerun chain-state, animation, and compatibility tests.

No legacy route is removed or enabled in Phase 3A.1.
