#!/usr/bin/env python3
"""Back up Herdr's native Pi session references and stop Herdr safely."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

PLUGIN_ID = "local.session-guard"
SCHEMA_VERSION = 1
DEFAULT_HISTORY_LIMIT = 96
DEFAULT_INVENTORY_LIMIT = 512


class GuardError(RuntimeError):
    """A user-actionable session guard failure."""


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def state_dir() -> Path:
    override = os.environ.get("HERDR_SESSION_GUARD_STATE_DIR")
    if override:
        return Path(override).expanduser()
    plugin_state = os.environ.get("HERDR_PLUGIN_STATE_DIR")
    if plugin_state:
        return Path(plugin_state).expanduser()
    xdg_state = os.environ.get("XDG_STATE_HOME")
    root = Path(xdg_state).expanduser() if xdg_state else Path.home() / ".local" / "state"
    return root / "herdr" / "plugins" / PLUGIN_ID


def herdr_bin() -> str:
    return os.environ.get("HERDR_BIN_PATH", "herdr")


def herdr_config_dir() -> Path:
    xdg_config = os.environ.get("XDG_CONFIG_HOME")
    root = Path(xdg_config).expanduser() if xdg_config else Path.home() / ".config"
    return root / "herdr"


def run_command(
    argv: list[str], *, timeout: float = 30, check: bool = True
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            argv,
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError as error:
        raise GuardError(f"command not found: {argv[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise GuardError(f"command timed out after {timeout:g}s: {' '.join(argv)}") from error
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise GuardError(f"{' '.join(argv)} failed: {detail}")
    return result


def load_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except (OSError, json.JSONDecodeError) as error:
        raise GuardError(f"could not read {path}: {error}") from error


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{path.name}.",
        delete=False,
    )
    tmp = Path(handle.name)
    try:
        with handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        tmp.chmod(0o600)
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except FileNotFoundError:
            pass


def session_key(session: dict[str, Any]) -> str:
    return "\0".join(
        str(session.get(key, "")) for key in ("source", "agent", "kind", "value")
    )


def normalize_pi_agents(payload: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        agents = payload["result"]["agents"]
    except (KeyError, TypeError) as error:
        raise GuardError("herdr agent list returned an unexpected response") from error
    if not isinstance(agents, list):
        raise GuardError("herdr agent list did not return an agents array")

    normalized: list[dict[str, Any]] = []
    for item in agents:
        if not isinstance(item, dict) or item.get("agent") != "pi":
            continue
        session = item.get("agent_session")
        if not isinstance(session, dict):
            continue
        source = session.get("source")
        session_agent = session.get("agent")
        kind = session.get("kind")
        value = session.get("value")
        if (
            source != "herdr:pi"
            or session_agent != "pi"
            or kind not in {"path", "id"}
            or not isinstance(value, str)
            or not value
        ):
            continue
        normalized.append(
            {
                "source": source,
                "agent": "pi",
                "kind": kind,
                "value": value,
                "pane_id": item.get("pane_id"),
                "tab_id": item.get("tab_id"),
                "workspace_id": item.get("workspace_id"),
                "terminal_id": item.get("terminal_id"),
                "cwd": item.get("cwd"),
                "name": item.get("name"),
                "terminal_title": item.get("terminal_title_stripped")
                or item.get("terminal_title"),
            }
        )
    normalized.sort(key=lambda item: (str(item.get("workspace_id")), str(item.get("tab_id")), str(item.get("pane_id"))))
    return normalized


def list_pi_agents(herdr: str | None = None) -> list[dict[str, Any]]:
    result = run_command([herdr or herdr_bin(), "agent", "list"])
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise GuardError("herdr agent list returned invalid JSON") from error
    return normalize_pi_agents(payload)


def merge_inventory(
    existing: dict[str, Any] | None,
    agents: list[dict[str, Any]],
    captured_at: str,
    *,
    limit: int = DEFAULT_INVENTORY_LIMIT,
) -> dict[str, Any]:
    entries = dict((existing or {}).get("entries") or {})
    panes = dict((existing or {}).get("last_known_by_pane") or {})
    for agent in agents:
        key = session_key(agent)
        prior = entries.get(key) if isinstance(entries.get(key), dict) else {}
        entries[key] = {
            **agent,
            "first_seen_at": prior.get("first_seen_at", captured_at),
            "last_seen_at": captured_at,
        }
        pane_id = agent.get("pane_id")
        if isinstance(pane_id, str) and pane_id:
            panes[pane_id] = {**agent, "last_seen_at": captured_at}

    if len(entries) > limit:
        newest = sorted(
            entries.items(),
            key=lambda pair: str(pair[1].get("last_seen_at", "")),
            reverse=True,
        )[:limit]
        entries = dict(newest)
        retained = set(entries)
        panes = {
            pane: entry
            for pane, entry in panes.items()
            if session_key(entry) in retained
        }

    return {
        "schema_version": SCHEMA_VERSION,
        "updated_at": captured_at,
        "entries": entries,
        "last_known_by_pane": panes,
    }


def prune_snapshots(directory: Path, limit: int) -> None:
    snapshots = sorted(directory.glob("*.json"))
    for path in snapshots[:-limit] if limit > 0 else snapshots:
        path.unlink(missing_ok=True)


def save_snapshot(
    agents: list[dict[str, Any]],
    *,
    reason: str,
    directory: Path | None = None,
    history_limit: int = DEFAULT_HISTORY_LIMIT,
    captured_at: str | None = None,
) -> dict[str, Any]:
    directory = directory or state_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    captured_at = captured_at or utc_now()
    payload = {
        "schema_version": SCHEMA_VERSION,
        "captured_at": captured_at,
        "reason": reason,
        "socket_path": os.environ.get("HERDR_SOCKET_PATH"),
        "agents": agents,
    }

    lock_path = directory / "snapshot.lock"
    with lock_path.open("a+", encoding="utf-8") as lock:
        lock_path.chmod(0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        inventory_path = directory / "inventory.json"
        inventory = merge_inventory(load_json(inventory_path, {}), agents, captured_at)
        write_json_atomic(inventory_path, inventory)
        write_json_atomic(directory / "latest.json", payload)

        history_dir = directory / "snapshots"
        history_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        history_dir.chmod(0o700)
        stamp = captured_at.replace("-", "").replace(":", "").replace(".", "")
        write_json_atomic(history_dir / f"{stamp}-{os.getpid()}.json", payload)
        prune_snapshots(history_dir, history_limit)

    return payload


def snapshot(reason: str, *, directory: Path | None = None) -> dict[str, Any]:
    return save_snapshot(list_pi_agents(), reason=reason, directory=directory)


def collect_persisted_pi_refs(payload: Any) -> set[str]:
    found: set[str] = set()

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            if (
                value.get("source") == "herdr:pi"
                and value.get("agent") == "pi"
                and value.get("kind") in {"path", "id"}
                and isinstance(value.get("value"), str)
                and value.get("value")
            ):
                found.add(session_key(value))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(payload)
    return found


def verify_snapshot_persisted(snapshot_payload: dict[str, Any], session_file: Path) -> list[dict[str, Any]]:
    session_payload = load_json(session_file, None)
    if session_payload is None:
        raise GuardError(f"Herdr session snapshot is missing: {session_file}")
    persisted = collect_persisted_pi_refs(session_payload)
    return [
        agent
        for agent in snapshot_payload.get("agents", [])
        if session_key(agent) not in persisted
    ]


def herdr_socket_path() -> Path:
    return Path(
        os.environ.get("HERDR_SOCKET_PATH", str(herdr_config_dir() / "herdr.sock"))
    )


def socket_owner_pids(socket: Path) -> list[int]:
    lsof = shutil.which("lsof")
    if not lsof:
        raise GuardError("lsof is required to verify that the Herdr server exits")
    result = subprocess.run(
        [lsof, "-t", "--", str(socket)],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )
    pids = sorted(
        {int(line) for line in result.stdout.splitlines() if line.strip().isdigit()}
    )
    if not pids:
        raise GuardError(f"could not identify the Herdr process owning {socket}")
    return pids


def pid_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_for_server_stop(
    session_file: Path, socket: Path, server_pids: list[int], *, timeout: float = 15
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        live_pids = [pid for pid in server_pids if pid_is_alive(pid)]
        if not socket.exists() and not live_pids:
            break
        time.sleep(0.1)
    else:
        raise GuardError(
            f"Herdr did not fully stop; socket_exists={socket.exists()}, "
            f"live_pids={[pid for pid in server_pids if pid_is_alive(pid)]}"
        )

    previous: tuple[int, int] | None = None
    stable_reads = 0
    stabilize_deadline = time.monotonic() + min(timeout, 5)
    while time.monotonic() < stabilize_deadline:
        try:
            stat = session_file.stat()
        except FileNotFoundError:
            time.sleep(0.1)
            continue
        current = (stat.st_mtime_ns, stat.st_size)
        stable_reads = stable_reads + 1 if current == previous else 1
        if stable_reads >= 10:
            return
        previous = current
        time.sleep(0.1)
    raise GuardError(f"Herdr session snapshot did not stabilize: {session_file}")


def safe_stop(*, allow_empty: bool = False) -> int:
    if os.environ.get("HERDR_ENV") == "1" or any(
        os.environ.get(name)
        for name in ("HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID")
    ):
        raise GuardError(
            "herdr-safe-stop must run in a regular terminal outside Herdr; "
            "stopping the server would terminate this helper before verification"
        )

    directory = state_dir()
    before = snapshot("safe-stop", directory=directory)
    count = len(before["agents"])
    inventory = load_json(directory / "inventory.json", {})
    inventory_count = len((inventory or {}).get("entries") or {})
    if count == 0 and not allow_empty:
        raise GuardError(
            "Herdr currently reports no active Pi session references"
            + (
                f", while the guard inventory contains {inventory_count}"
                if inventory_count
                else " and no prior inventory is available"
            )
            + "; refusing an unverifiable safe-stop. Restore/check the sessions first, "
            "or pass --allow-empty if this is intentional."
        )
    print(f"backed up {count} active Pi session reference{'s' if count != 1 else ''}")

    socket = herdr_socket_path()
    server_pids = socket_owner_pids(socket)
    session_file = herdr_config_dir() / "session.json"
    recovery_path = directory / "recovery-needed.json"
    try:
        result = run_command([herdr_bin(), "server", "stop"], timeout=60)
        if result.stdout.strip():
            print(result.stdout.strip())
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
        wait_for_server_stop(session_file, socket, server_pids)
        missing = verify_snapshot_persisted(before, session_file)
    except GuardError as error:
        recovery = {
            "schema_version": SCHEMA_VERSION,
            "created_at": utc_now(),
            "reason": "safe-stop-command-or-validation-error",
            "session_file": str(session_file),
            "error": str(error),
            "snapshot": before,
        }
        write_json_atomic(recovery_path, recovery)
        raise GuardError(f"{error}; recovery metadata: {recovery_path}") from error
    if missing:
        recovery = {
            "schema_version": SCHEMA_VERSION,
            "created_at": utc_now(),
            "reason": "safe-stop-verification-failed",
            "session_file": str(session_file),
            "missing_agents": missing,
            "snapshot": before,
        }
        write_json_atomic(recovery_path, recovery)
        print(
            f"ERROR: Herdr stopped, but {len(missing)} Pi session reference(s) "
            f"are missing from {session_file}",
            file=sys.stderr,
        )
        for agent in missing:
            print(
                f"  {agent.get('pane_id') or '?'}: {agent.get('value')}",
                file=sys.stderr,
            )
        print(
            f"Recovery metadata: {recovery_path}",
            file=sys.stderr,
        )
        return 2

    recovery_path.unlink(missing_ok=True)
    print(
        f"verified {count} Pi session reference{'s' if count != 1 else ''} "
        f"in {session_file}"
    )
    print("Herdr stopped safely; it is now safe to reboot.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    snapshot_parser = subparsers.add_parser("snapshot", help="back up active Pi session references")
    snapshot_parser.add_argument("--reason", default="manual")
    safe_stop_parser = subparsers.add_parser(
        "safe-stop", help="back up, stop Herdr, and verify persisted references"
    )
    safe_stop_parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="allow stopping when no active Pi refs exist despite retained inventory",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "snapshot":
            payload = snapshot(args.reason)
            print(
                f"backed up {len(payload['agents'])} active Pi session reference(s) "
                f"to {state_dir()}"
            )
            return 0
        if args.command == "safe-stop":
            return safe_stop(allow_empty=args.allow_empty)
        raise GuardError(f"unknown command: {args.command}")
    except GuardError as error:
        print(f"session-guard: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
