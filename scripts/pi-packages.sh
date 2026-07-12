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

packages=()
package_output="$(python3 - "$SETTINGS" "$REPO_ROOT" <<'PY'
import json, pathlib, sys
settings = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2]).resolve()
prefix = "../../dotfiles/pi/packages/"
data = json.loads(settings.read_text(encoding="utf-8"))
for spec in data.get("packages", []):
    if not isinstance(spec, str) or spec.startswith("npm:"):
        continue
    if not spec.startswith(prefix):
        raise SystemExit(f"Unsupported local Pi package spec: {spec}")
    name = spec.removeprefix(prefix)
    if not name or "/" in name or name in {".", ".."}:
        raise SystemExit(f"Unsafe local Pi package spec: {spec}")
    print(root / "pi" / "packages" / name)
PY
)"
while IFS= read -r package; do
  [[ -n "$package" ]] && packages+=("$package")
done <<< "$package_output"
[[ ${#packages[@]} -gt 0 ]] || { echo "No local Pi packages configured" >&2; exit 1; }

has_script() {
  node -e 'const p=require(process.argv[1]); process.exit(p.scripts?.[process.argv[2]] ? 0 : 1)' "$1/package.json" "$2"
}

has_runtime_dependencies() {
  node -e 'const p=require(process.argv[1]); process.exit(p.dependencies && Object.keys(p.dependencies).length ? 0 : 1)' "$1/package.json"
}

verify_inventory() {
  local package
  for package in "${packages[@]}"; do
    [[ -f "$package/package.json" ]] || { echo "Configured Pi package missing package.json: $package" >&2; return 1; }
    [[ -f "$package/package-lock.json" ]] || { echo "Configured Pi package missing tracked lockfile: $package" >&2; return 1; }
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
  local script="$1" package
  for package in "${packages[@]}"; do
    if has_script "$package" "$script"; then
      echo "==> $(basename "$package"): npm run $script"
      (cd "$package" && npm run "$script")
    else
      echo "==> $(basename "$package"): no $script script (skipped)"
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
