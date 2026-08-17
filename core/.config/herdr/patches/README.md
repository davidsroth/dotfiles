# Herdr Pi integration patch

`herdr-pi-state-v8.patch` is a reviewed patch for Herdr's managed Pi integration
version 8. `herdr-agent-state-v8.ts` is the exact unpatched upstream/installed
fixture used to derive and test it (SHA-256
`9b1c41cd72520fc2abe5f2a2aec995c12a926cce844df472c7fd5fcae4f4dbfa`).

Apply it only with `../bin/apply-herdr-pi-state-patch.py` (normally through
`just herdr-setup`). Running `herdr integration install pi` manually overwrites
the managed integration and therefore this patch; always follow it with `just
herdr-setup`. `apply-herdr-pi-state-patch.py --check` (also run by `just
pi-doctor`) verifies the exact patched SHA without modifying files and reports
the required remediation for a stock, mismatched, or absent integration.

The patcher checks the managed header and the complete source fingerprint
before creating a timestamped local backup and replacing anything. It also
recognizes the one prior reviewed patched fingerprint
`74244056a82a5bc3b217c28940a1f6a43922e72922d0301065f4925d1cdeb8a0` for a
one-time migration: it backs up that exact file, then builds the replacement
from this unpatched fixture and the current reviewed patch. `--check` reports
that migration as required and directs the user to `just herdr-setup`. Any
other changed Herdr integration fails closed; do not edit its installed copy or
relax the fingerprint. Refresh this fixture and patch only after reviewing the
new upstream integration and extending the tests.
