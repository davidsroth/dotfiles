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
  local generator="$REPO_ROOT/scripts/gen-pi-settings.sh"
  if [[ ! -x "$generator" ]]; then
    FAIL "SETTINGS DRIFT: generator missing or not executable at $generator"
    return
  fi
  local status=0
  "$generator" --quiet --check || status=$?
  if [[ "$status" == 0 ]]; then
    PASS "SETTINGS DRIFT: settings.json matches merged base+local"
  elif [[ "$status" == 3 ]]; then
    FAIL "SETTINGS DRIFT: settings.json is out of date — run: just pi-settings"
  else
    FAIL "SETTINGS DRIFT: generator check failed (exit $status)"
  fi
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
# 6. AI TOOL RUNTIME STATE
# ---------------------------------------------------------------------------
check_runtime_state_locations() {
  local path
  for path in "$HOME/.claude" "$HOME/.codex"; do
    if [[ -L "$path" ]]; then
      FAIL "RUNTIME STATE: $path is a legacy repository symlink — migrate it to a private real directory"
    elif [[ -d "$path" ]]; then
      PASS "RUNTIME STATE: $path is a real home-directory store"
    else
      WARN "RUNTIME STATE: $path is absent (tool may not be initialized)"
    fi
  done

  local raycast_dir="$HOME/Library/Application Support/com.raycast.macos/extensions"
  local raycast_link bad_raycast_links=0
  if [[ -d "$raycast_dir" ]]; then
    while IFS= read -r -d '' raycast_link; do
      case "$(readlink "$raycast_link")" in
        "$REPO_ROOT"/*)
          FAIL "RUNTIME STATE: Raycast extension $raycast_link points into the dotfiles repository"
          bad_raycast_links=$((bad_raycast_links + 1))
          ;;
      esac
    done < <(find "$raycast_dir" -maxdepth 1 -type l -print0 2>/dev/null)
    if [[ "$bad_raycast_links" == 0 ]]; then
      PASS "RUNTIME STATE: Raycast extensions are stored outside the repository"
    fi
  fi
}

# ---------------------------------------------------------------------------
# 7. TOOLCHAIN
# ---------------------------------------------------------------------------
check_toolchain() {
  if command -v jq >/dev/null 2>&1; then
    PASS "TOOLCHAIN: jq found at $(command -v jq)"
  elif command -v python3 >/dev/null 2>&1; then
    PASS "TOOLCHAIN: jq absent; supported python3 settings fallback is available"
  else
    FAIL "TOOLCHAIN: neither jq nor python3 is available for settings generation"
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
# 8. PRIVATE FILE PERMISSIONS
# ---------------------------------------------------------------------------
path_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null || true
}

check_private_permissions() {
  local path expected mode issues=0
  local -a private_dirs=(
    "$PI_AGENT/memory"
    "$PI_AGENT/memory/daily"
    "$PI_AGENT/intercom"
    "$HOME/.claude"
    "$HOME/.codex"
  )
  local -a private_files=(
    "$HOME/.zshenv.local"
    "$HOME/.env"
    "$HOME/.claude.json"
    "$PI_AGENT/settings.json"
    "$PI_AGENT/settings.local.json"
    "$PI_AGENT/memory/MEMORY.local.md"
    "$PI_AGENT/memory/SCRATCHPAD.md"
    "$PI_AGENT/intercom/broker.log"
    "$PI_AGENT/intercom/broker.pid"
    "$PI_AGENT/intercom/tailnet-relay.pid"
  )

  for path in "${private_dirs[@]}"; do
    [[ -e "$path" ]] || continue
    mode="$(path_mode "$path")"
    if [[ "$mode" == "700" ]]; then
      PASS "PERMISSIONS: $path is 0700"
    else
      WARN "PERMISSIONS: $path is ${mode:-unknown}, expected 0700 — run: chmod 700 '$path'"
      issues=$((issues + 1))
    fi
  done

  shopt -s nullglob
  private_files+=("$PI_AGENT"/memory/daily/*.md)
  shopt -u nullglob
  for path in "${private_files[@]}"; do
    [[ -e "$path" && ! -L "$path" ]] || continue
    expected=600
    mode="$(path_mode "$path")"
    if [[ "$mode" == "$expected" ]]; then
      PASS "PERMISSIONS: $path is 0$expected"
    else
      WARN "PERMISSIONS: $path is ${mode:-unknown}, expected 0$expected — run: chmod $expected '$path'"
      issues=$((issues + 1))
    fi
  done

  if [[ "$issues" -eq 0 ]]; then
    PASS "PERMISSIONS: existing private runtime paths are restricted"
  fi
}

# ---------------------------------------------------------------------------
# 9. SECRETS REPORT (info only, never values, never FAIL)
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
check_runtime_state_locations
check_toolchain
check_private_permissions
check_secrets

printf '\n%d pass / %d warn / %d fail\n' "$pass" "$warn" "$fail"

[[ "$fail" -eq 0 ]] || exit 1
