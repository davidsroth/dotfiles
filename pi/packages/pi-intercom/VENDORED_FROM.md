# Vendored from

- Repository: https://github.com/nicobailon/pi-intercom
- Commit: `5caa4aa1bd060cf0aebbf1a5dfbb1abb6e23e457`
- Released as: `pi-intercom@0.6.0`
- Retrieved: 2026-05-04

Notes:
- `.git/`, `.github/`, and `node_modules/` were omitted from the vendored copy.
- This package has runtime dependencies (`tsx`, `typebox`) declared in
  `package.json`. Run `npm install` inside this directory once after vendoring
  (or after refreshing) so the broker spawn path can resolve `tsx`. The
  resulting `node_modules/` is gitignored by `packages/.gitignore`.
- `typebox` is technically bundled by pi as a peer dependency, but upstream
  lists it under `dependencies`; this is harmless since pi loads the package
  with a separate module root.
