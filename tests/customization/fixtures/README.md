# Customization integration fixtures

`token-1.json` and `token-3.json` are exact read-only copies of the recovered
Phase 2A holder-placement manifests from website commit
`62109522015d28053248b6b63cee10eee49bbfe4`.

They are deliberately small in count, not synthetic in content:

- token 1 provides authoritative protected-region rejection cases;
- token 3 provides an authoritative valid `rightSidePanel` placement case.

The tests verify their token IDs, source layout hashes, catalog version, and
placement-manifest version before using them. Regenerate them only from the
versioned website manifest output; do not hand-edit these JSON fixtures.
