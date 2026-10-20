# Herdr Pi integration patch

`herdr-pi-state-v9.patch` is a reviewed patch for Herdr's managed Pi integration
version 9 (Herdr 0.9.x). `herdr-agent-state-v9.ts` is the exact unpatched
upstream fixture used to derive and test it (SHA-256
`2c5272d732b475bbf91a027203b1f98d25fe43d2c1402530a442b288aeaca1e4`, from the
`v0.9.5` tag).

Apply it only with `../bin/apply-herdr-pi-state-patch.py` (normally through
`just herdr-setup`). Running `herdr integration install pi` manually overwrites
the managed integration and therefore this patch; always follow it with `just
herdr-setup`. `apply-herdr-pi-state-patch.py --check` (also run by `just
pi-doctor`) verifies the exact patched SHA without modifying files and reports
the required remediation for a stock, mismatched, or absent integration.

The patcher checks the managed header and the complete source fingerprint
before creating a timestamped local backup and replacing anything. It also
recognizes prior reviewed patched fingerprints (the outputs in
`../tests/fixtures/`) for a one-time migration: it backs up that exact file, then
builds the replacement from this unpatched fixture and the current reviewed patch. `--check` reports
that migration as required and directs the user to `just herdr-setup`. Any
other changed Herdr integration fails closed; do not edit its installed copy or
relax the fingerprint. Refresh this fixture and patch only after reviewing the
new upstream integration and extending the tests.
