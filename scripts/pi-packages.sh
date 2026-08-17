#!/usr/bin/env bash
# Discover and operate on every local Pi package listed in settings.base.json.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SETTINGS="$REPO_ROOT/pi/.pi/agent/settings.base.json"
EXTENSIONS="$REPO_ROOT/pi/.pi/agent/extensions"

usage() {
  echo "Usage: $0 {list|verify|install-runtime|install-dev|typecheck|load|test|check}" >&2
  exit 2
}

[[ -f "$SETTINGS" ]] || { echo "Missing $SETTINGS" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required" >&2; exit 1; }

# Keep the package source alongside its resolved directory so errors identify
# the setting to fix rather than only a derived path. NUL delimiters keep the
# shell boundary safe even if an invalid JSON string contains whitespace.
packages=()
package_sources=()
package_specs="$(mktemp)"
trap 'rm -f "$package_specs"' EXIT
if ! python3 - "$SETTINGS" "$REPO_ROOT" > "$package_specs" <<'PY'
import json
import pathlib
import sys

settings = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2]).resolve()
prefix = "../../dotfiles/pi/packages/"

try:
    data = json.loads(settings.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as error:
    raise SystemExit(f"Could not read Pi package settings: {error}")

specs = data.get("packages", [])
if not isinstance(specs, list):
    raise SystemExit("Pi package settings field 'packages' must be an array")

for index, spec in enumerate(specs):
    if isinstance(spec, str):
        source = spec
    elif isinstance(spec, dict):
        source = spec.get("source")
        if not isinstance(source, str) or not source:
            raise SystemExit(
                f"Malformed Pi package spec at packages[{index}]: "
                "object source must be a non-empty string"
            )
    else:
        raise SystemExit(
            f"Malformed Pi package spec at packages[{index}]: "
            "expected a string or an object with a string source"
        )

    if not source:
        raise SystemExit(f"Malformed Pi package spec at packages[{index}]: source must not be empty")
    if "\0" in source:
        raise SystemExit(f"Malformed Pi package spec at packages[{index}]: source must not contain a NUL byte")
    if source.startswith("npm:"):
        # Registry packages have no repository directory to inventory.
        continue
    if not source.startswith(prefix):
        raise SystemExit(f"Unsupported local Pi package source at packages[{index}]: {source!r}")

    name = source[len(prefix):]
    if not name or "/" in name or name in {".", ".."}:
        raise SystemExit(f"Unsafe local Pi package source at packages[{index}]: {source!r}")

    path = root / "pi" / "packages" / name
    sys.stdout.buffer.write(source.encode("utf-8") + b"\0" + str(path).encode("utf-8") + b"\0")
PY
then
  exit 1
fi
while IFS= read -r -d '' source && IFS= read -r -d '' package; do
  package_sources+=("$source")
  packages+=("$package")
done < "$package_specs"
[[ ${#packages[@]} -gt 0 ]] || { echo "No local Pi packages configured" >&2; exit 1; }

has_script() {
  node -e 'const p=require(process.argv[1]); process.exit(p.scripts?.[process.argv[2]] ? 0 : 1)' "$1/package.json" "$2"
}

has_runtime_dependencies() {
  node -e 'const p=require(process.argv[1]); process.exit(p.dependencies && Object.keys(p.dependencies).length ? 0 : 1)' "$1/package.json"
}

verify_inventory() {
  local index package source
  for index in "${!packages[@]}"; do
    package="${packages[$index]}"
    source="${package_sources[$index]}"
    [[ -f "$package/package.json" ]] || {
      echo "Configured Pi package '$source' missing package.json (resolved: $package)" >&2
      return 1
    }
    [[ -f "$package/package-lock.json" ]] || {
      echo "Configured Pi package '$source' missing tracked lockfile (resolved: $package)" >&2
      return 1
    }
  done
  [[ -f "$EXTENSIONS/package.json" && -f "$EXTENSIONS/package-lock.json" ]] || {
    echo "Hand-written Pi extensions require package.json and package-lock.json" >&2
    return 1
  }

  local discovered discovered_dir configured=false
  for discovered in "$REPO_ROOT"/pi/packages/*/package.json; do
    discovered_dir="$(cd "$(dirname "$discovered")" && pwd -P)"
    configured=false
    for package in "${packages[@]}"; do
      [[ "$discovered_dir" == "$package" ]] && configured=true && break
    done
    [[ "$configured" == true ]] || { echo "Unconfigured Pi package directory: $discovered_dir" >&2; return 1; }
  done
}

run_script() {
  local script="$1" index package source
  for index in "${!packages[@]}"; do
    package="${packages[$index]}"
    source="${package_sources[$index]}"
    if has_script "$package" "$script"; then
      echo "==> $source: npm run $script"
      (cd "$package" && npm run "$script")
    else
      echo "==> $source: no $script script (skipped)"
    fi
  done
}

verify_loads() {
  local sdk_root jiti_path
  sdk_root="$(npm root -g)/@earendil-works/pi-coding-agent"
  jiti_path="$sdk_root/node_modules/jiti/lib/jiti.mjs"
  [[ -f "$jiti_path" ]] || { echo "Pi's bundled jiti not found: $jiti_path" >&2; return 1; }
  node --input-type=module - -- "$jiti_path" "${packages[@]}" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const jitiPath = process.argv[3];
const { createJiti } = await import(pathToFileURL(jitiPath).href);
for (const dir of process.argv.slice(4)) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  for (const relativeEntry of manifest.pi?.extensions ?? []) {
    const entry = path.resolve(dir, relativeEntry);
    const jiti = createJiti(entry, { tryNative: false });
    const loaded = await jiti.import(entry, { default: true });
    if (typeof loaded !== "function") throw new Error(`${entry}: default export is ${typeof loaded}, expected function`);
    console.log(`==> loaded ${path.relative(process.cwd(), entry)}`);
  }
}
NODE
}

action="${1:-}"
case "$action" in
  list)
    printf '%s\n' "$EXTENSIONS" "${packages[@]}"
    ;;
  verify)
    verify_inventory
    echo "Pi package inventory verified (${#packages[@]} local packages)."
    ;;
  install-runtime)
    verify_inventory
    for package in "${packages[@]}"; do
      if has_runtime_dependencies "$package"; then
        echo "==> $(basename "$package"): installing locked runtime dependencies"
        (cd "$package" && npm ci --omit=dev --legacy-peer-deps --ignore-scripts --no-audit --no-fund)
      fi
    done
    ;;
  install-dev)
    verify_inventory
    echo "==> extensions: installing locked development dependencies"
    (cd "$EXTENSIONS" && npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund)
    for package in "${packages[@]}"; do
      echo "==> $(basename "$package"): installing locked development dependencies"
      (cd "$package" && npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund)
    done
    ;;
  typecheck)
    verify_inventory
    bash "$REPO_ROOT/scripts/pi-typecheck.sh"
    run_script typecheck
    ;;
  load)
    verify_inventory
    verify_loads
    ;;
  test)
    verify_inventory
    echo "==> extensions: npm test"
    (cd "$EXTENSIONS" && npm test)
    run_script test
    ;;
  check)
    "$0" typecheck
    "$0" load
    "$0" test
    ;;
  *) usage ;;
esac
