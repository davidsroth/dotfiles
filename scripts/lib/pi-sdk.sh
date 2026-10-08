# shellcheck shell=bash
# Locate the installed pi SDK (@earendil-works/pi-coding-agent) and its dependencies.
# Sourced by pi-packages.sh, pi-typecheck.sh, and pi-doctor.sh.
#
# Resolution order:
#   1. $PI_SDK_DIR (explicit override)
#   2. pi's managed install: ${PI_CODING_AGENT_DIR:-~/.pi/agent}/install/current-version
#      -> install/releases/<version>/node_modules/@earendil-works/pi-coding-agent
#   3. a `pi` on PATH that resolves into the SDK's dist/ (npm/Homebrew global install)
#   4. `npm root -g`

pi_sdk_dir() {
  local agent_dir version dir cli groot
  if [[ -n "${PI_SDK_DIR:-}" ]]; then
    [[ -f "$PI_SDK_DIR/package.json" ]] || return 1
    echo "$PI_SDK_DIR"
    return 0
  fi
  agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  if [[ -r "$agent_dir/install/current-version" ]]; then
    version=""
    IFS= read -r version < "$agent_dir/install/current-version" || true
    dir="$agent_dir/install/releases/$version/node_modules/@earendil-works/pi-coding-agent"
    if [[ -n "$version" && "$version" != *[/]* && -f "$dir/package.json" ]]; then
      echo "$dir"
      return 0
    fi
  fi
  if command -v pi >/dev/null 2>&1; then
    cli="$(command -v pi)"
    cli="$(realpath "$cli" 2>/dev/null || readlink -f "$cli" 2>/dev/null || echo "$cli")"
    dir="${cli%/dist/*}"
    if [[ "$dir" != "$cli" && -f "$dir/package.json" ]]; then
      echo "$dir"
      return 0
    fi
  fi
  groot="$(npm root -g 2>/dev/null || true)"
  if [[ -n "$groot" && -f "$groot/@earendil-works/pi-coding-agent/package.json" ]]; then
    echo "$groot/@earendil-works/pi-coding-agent"
    return 0
  fi
  return 1
}

# pi_sdk_dep <sdk_dir> <package-name>
# Print a dependency's directory: nested under the SDK (global npm layout) or hoisted
# beside it (managed install layout).
pi_sdk_dep() {
  local sdk="$1" name="$2" hoisted
  if [[ -e "$sdk/node_modules/$name" ]]; then
    echo "$sdk/node_modules/$name"
    return 0
  fi
  # $sdk is <node_modules>/@earendil-works/pi-coding-agent.
  hoisted="$(cd "$sdk/../.." 2>/dev/null && pwd)/$name"
  if [[ -e "$hoisted" ]]; then
    echo "$hoisted"
    return 0
  fi
  return 1
}
