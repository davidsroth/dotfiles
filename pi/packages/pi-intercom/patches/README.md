# Portable aside patch

`aside-v0.9.2.patch` is the standalone aside feature commit based directly on
stock [`pi-intercom@0.9.2`](https://github.com/nicobailon/pi-intercom/releases/tag/v0.9.2)
(commit `63fb02eda4fbb847814d592617c83b3fd5e6cdf7`). It does not include David's
fork-only picker or hardening commits.

Apply it to a clean upstream checkout:

```bash
git clone https://github.com/nicobailon/pi-intercom.git
cd pi-intercom
git checkout v0.9.2
git am /path/to/aside-v0.9.2.patch
npm ci
npm test
```

Aside support is capability-negotiated. Patched clients refuse to send an aside
to an unpatched broker or recipient rather than silently degrading it into an
interrupting normal ask.

For teams adapting a separate Tailnet-intercom implementation, see the
[`aside-integration-kit`](aside-integration-kit/README.md). It contains the wire
contract, bridge recipe, acceptance tests, and a ready-to-paste coding-agent
prompt.
