#!/usr/bin/env bash
# pi-doctor.sh — health-check for the pi agent setup
# Outputs PASS:/WARN:/FAIL: prefixed lines; exits 1 if any FAIL is found.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PI_AGENT="$HOME/.pi/agent"

pass=0
warn=0
fail=0

PASS() { printf 'PASS: %s\n' "$*"; (( pass++ )) || true; }
WARN() { printf 'WARN: %s\n' "$*"; (( warn++ )) || true; }
FAIL() { printf 'FAIL: %s\n' "$*"; (( fail++ )) || true; }
INFO() { printf 'INFO: %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. SETTINGS DRIFT
# ---------------------------------------------------------------------------
check_settings_drift() {
  local base="$REPO_ROOT/pi/.pi/agent/settings.base.json"
  local local_overrides="$PI_AGENT/settings.local.json"
  local live="$PI_AGENT/settings.json"

  if ! command -v jq >/dev/null 2>&1; then
    FAIL "SETTINGS DRIFT: jq not on PATH — cannot perform drift check"
    return
  fi

  if [[ ! -f "$live" ]]; then
    FAIL "SETTINGS DRIFT: $live does not exist"
    return
  fi

  if [[ ! -f "$base" ]]; then
    FAIL "SETTINGS DRIFT: settings.base.json not found at $base"
    return
  fi

  local tmp
  tmp="$(mktemp)"

  # Mirror gen-pi-settings.sh's merge and generated package-path rewrite.
  local existing_src="$live"
  local local_src
  if [[ -f "$local_overrides" ]]; then
    local_src="$local_overrides"
  else
    local_src=/dev/null
  fi

  jq -s --arg repo_root "$REPO_ROOT" --arg prefix '../../dotfiles/' '
    ((.[0] // {}) * (.[1] // {}) * (.[2] // {}))
    | if (.packages | type) == "array" then
        .packages |= map(
          if type == "string" and startswith($prefix)
          then $repo_root + "/" + ltrimstr($prefix)
          else .
          end
        )
      else .
      end
  ' \
    <(cat "$existing_src" 2>/dev/null || printf '{}') \
    "$base" \
    <(cat "$local_src" 2>/dev/null || printf '{}') \
    > "$tmp"

  if diff <(jq -S . "$tmp") <(jq -S . "$live") >/dev/null 2>&1; then
    PASS "SETTINGS DRIFT: settings.json matches merged base+local"
  else
    FAIL "SETTINGS DRIFT: settings.json is out of date — run: just pi-settings"
  fi

  rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# 2. PACKAGE PATHS
# ---------------------------------------------------------------------------
check_package_paths() {
  local settings="$PI_AGENT/settings.json"

  if ! command -v jq >/dev/null 2>&1; then
    FAIL "PACKAGE PATHS: jq not on PATH — cannot check packages"
    return
  fi

  if [[ ! -f "$settings" ]]; then
    FAIL "PACKAGE PATHS: $settings not found"
    return
  fi

  local pkg dir
  while IFS= read -r pkg; do
    # Skip npm: specifiers
    [[ "$pkg" == npm:* ]] && continue

    if [[ "$pkg" == /* ]]; then
      dir="$pkg"
    else
      dir="$PI_AGENT/$pkg"
    fi

    if [[ ! -d "$dir" ]]; then
      FAIL "PACKAGE PATHS: directory missing for package '$pkg' (resolved: $dir)"
      continue
    fi

    # If package.json declares dependencies but node_modules is absent, warn
    if [[ -f "$dir/package.json" ]]; then
      if jq -e '.dependencies // empty | length > 0' "$dir/package.json" >/dev/null 2>&1; then
        if [[ ! -d "$dir/node_modules" ]]; then
          WARN "PACKAGE PATHS: '$pkg' has dependencies but node_modules is absent — run: bash install.sh (npm install step)"
        else
          PASS "PACKAGE PATHS: '$pkg' dir and node_modules present"
        fi
      else
        PASS "PACKAGE PATHS: '$pkg' dir present (no runtime deps)"
      fi
    else
      PASS "PACKAGE PATHS: '$pkg' dir present"
    fi
  done < <(jq -r '.packages[]' "$settings" 2>/dev/null)
}

# ---------------------------------------------------------------------------
# 3. HOOKS
# ---------------------------------------------------------------------------
check_hooks() {
  local hooks_path
  hooks_path="$(git -C "$REPO_ROOT" config core.hooksPath 2>/dev/null || echo '')"

  if [[ "$hooks_path" != ".githooks" ]]; then
    FAIL "HOOKS: git core.hooksPath is '${hooks_path:-<unset>}', expected '.githooks' — run: bash install.sh"
    return
  fi

  local hooks_dir="$REPO_ROOT/.githooks"
  if [[ ! -d "$hooks_dir" ]]; then
    FAIL "HOOKS: .githooks directory not found at $hooks_dir"
    return
  fi

  local ok=1
  local hook
  while IFS= read -r hook; do
    if [[ ! -x "$hook" ]]; then
      FAIL "HOOKS: $hook is not executable"
      ok=0
    fi
  done < <(find "$hooks_dir" -maxdepth 1 -type f)

  if [[ "$ok" == 1 ]]; then
    PASS "HOOKS: core.hooksPath=.githooks and all hook files are executable"
  fi
}

# ---------------------------------------------------------------------------
# 4. MEMORY LINK
# ---------------------------------------------------------------------------
check_memory_link() {
  local link="$PI_AGENT/memory/MEMORY.md"
  local expected_target="$REPO_ROOT/pi/.pi/agent/memory/MEMORY.md"

  if [[ ! -L "$link" ]]; then
    FAIL "MEMORY LINK: $link is not a symlink — run: just pi-memory"
    return
  fi

  local resolved
  resolved="$(readlink -f "$link" 2>/dev/null || echo '')"

  if [[ "$resolved" == "$expected_target" ]]; then
    PASS "MEMORY LINK: $link -> $expected_target"
  else
    FAIL "MEMORY LINK: $link resolves to '$resolved', expected '$expected_target' — run: just pi-memory"
  fi
}

# ---------------------------------------------------------------------------
# 5. STOW HEALTH
# ---------------------------------------------------------------------------
check_stow_health() {
  # Stow runs with --no-folding, so parent directories are real and each
  # tracked file is linked individually. Check a stable sentinel rather than
  # requiring the extensions directory itself to be a symlink.
  local sentinel="$PI_AGENT/extensions/recap.ts"
  local expected="$REPO_ROOT/pi/.pi/agent/extensions/recap.ts"

  if [[ ! -e "$sentinel" ]]; then
    FAIL "STOW HEALTH: $sentinel does not exist — run: just stow"
    return
  fi

  local resolved
  resolved="$(readlink -f "$sentinel" 2>/dev/null || echo '')"

  if [[ -L "$sentinel" && "$resolved" == "$expected" ]]; then
    PASS "STOW HEALTH: tracked extension links resolve into repo correctly"
  else
    FAIL "STOW HEALTH: $sentinel resolves to '$resolved', expected symlink to '$expected' — run: just stow"
  fi
}

# ---------------------------------------------------------------------------
# 6. TOOLCHAIN
# ---------------------------------------------------------------------------
check_toolchain() {
  if command -v jq >/dev/null 2>&1; then
    PASS "TOOLCHAIN: jq found at $(command -v jq)"
  else
    FAIL "TOOLCHAIN: jq not on PATH — gen-pi-settings will silently drop local overrides without it"
  fi

  local npm_global_root pi_sdk_path
  npm_global_root="$(npm root -g 2>/dev/null || echo '')"
  if [[ -n "$npm_global_root" ]]; then
    pi_sdk_path="$npm_global_root/@earendil-works/pi-coding-agent"
    if [[ -d "$pi_sdk_path" ]]; then
      PASS "TOOLCHAIN: pi SDK found at $pi_sdk_path"
    else
      WARN "TOOLCHAIN: pi SDK not found at $pi_sdk_path — pi-check (typecheck) may not work"
    fi
  else
    WARN "TOOLCHAIN: could not determine npm global root; pi SDK check skipped"
  fi
}

# ---------------------------------------------------------------------------
# 7. SECRETS REPORT (info only, never values, never FAIL)
# ---------------------------------------------------------------------------
check_secrets() {
  local secrets=(
    OPENROUTER_API_KEY
    AZURE_INFERENCE_ENDPOINT
    AZURE_FOUNDRY_ENDPOINT
    AZURE_INFERENCE_CREDENTIAL
    SLACK_MCP_XOXP_TOKEN
    SLACK_MCP_XOXB_TOKEN
    SLACK_MCP_XOXC_TOKEN
    SLACK_MCP_XOXD_TOKEN
  )

  local var val
  for var in "${secrets[@]}"; do
    val="$(printenv "$var" 2>/dev/null || true)"
    if [[ -n "$val" ]]; then
      INFO "SECRETS: $var = set"
    else
      INFO "SECRETS: $var = unset"
    fi
  done
}

# ---------------------------------------------------------------------------
# Run all checks
# ---------------------------------------------------------------------------
check_settings_drift
check_package_paths
check_hooks
check_memory_link
check_stow_health
check_toolchain
check_secrets

printf '\n%d pass / %d warn / %d fail\n' "$pass" "$warn" "$fail"

[[ "$fail" -eq 0 ]] || exit 1
