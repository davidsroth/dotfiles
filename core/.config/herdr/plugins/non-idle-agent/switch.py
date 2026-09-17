#!/usr/bin/env python3
"""Prefer done Herdr agents, then cycle non-idle agents or recent sessions."""

from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

NON_IDLE_STATES = frozenset({"working", "blocked", "done", "unknown"})
PRIORITY_STATE = "done"
RECENT_HISTORY_LIMIT = 32


def run(herdr: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [herdr, *args],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )


def agents_from_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        agents = payload["result"]["agents"]
    except (KeyError, TypeError) as error:
        raise ValueError("herdr agent list returned an unexpected response") from error
    if not isinstance(agents, list):
        raise ValueError("herdr agent list did not return an agents array")
    return [
        agent
        for agent in agents
        if isinstance(agent, dict) and isinstance(agent.get("pane_id"), str)
    ]


def active_agents(payload: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        agent
        for agent in agents_from_payload(payload)
        if agent.get("agent_status") in NON_IDLE_STATES
    ]


def select_next(
    agents: list[dict[str, Any]], *, reverse: bool = False
) -> dict[str, Any] | None:
    """Prefer an unfocused done agent, then cycle in Herdr's panel order."""
    ordered = list(reversed(agents)) if reverse else agents
    priority = next(
        (
            agent
            for agent in ordered
            if agent.get("agent_status") == PRIORITY_STATE
            and not agent.get("focused")
        ),
        None,
    )
    if priority is not None:
        return priority
    if not agents:
        return None
    step = -1 if reverse else 1
    for index, agent in enumerate(agents):
        if agent.get("focused"):
            return agents[(index + step) % len(agents)] if len(agents) > 1 else None
    return ordered[0]


def select_target(
    agents: list[dict[str, Any]],
    active: list[dict[str, Any]],
    return_pane_id: str | None,
    *,
    reverse: bool = False,
) -> dict[str, Any] | None:
    """Choose the normal cycle target or the return side of a one-agent toggle."""
    if len(active) != 1 or not active[0].get("focused"):
        return select_next(active, reverse=reverse)
    return next(
        (
            agent
            for agent in agents
            if agent["pane_id"] == return_pane_id
            and agent["pane_id"] != active[0]["pane_id"]
        ),
        None,
    )


def select_recent_session(
    agents: list[dict[str, Any]],
    recent_pane_ids: list[str],
    *,
    reverse: bool = False,
) -> dict[str, Any] | None:
    """Choose the MRU agent session, seeding unseen entries by state recency."""
    by_pane_id = {agent["pane_id"]: agent for agent in agents}
    focused_pane_id = next(
        (agent["pane_id"] for agent in agents if agent.get("focused")), None
    )
    ordered_ids = [
        pane_id
        for pane_id in recent_pane_ids
        if pane_id in by_pane_id and pane_id != focused_pane_id
    ]
    seen = set(ordered_ids)
    unseen = sorted(
        (
            agent
            for agent in agents
            if agent["pane_id"] != focused_pane_id
            and agent["pane_id"] not in seen
        ),
        key=lambda agent: agent.get("state_change_seq")
        if isinstance(agent.get("state_change_seq"), int)
        else -1,
        reverse=True,
    )
    candidates = [by_pane_id[pane_id] for pane_id in ordered_ids] + unseen
    if not candidates:
        return None
    return candidates[-1] if reverse else candidates[0]


def state_dir() -> Path:
    plugin_state = os.environ.get("HERDR_PLUGIN_STATE_DIR")
    if plugin_state:
        return Path(plugin_state).expanduser()
    xdg_state = os.environ.get("XDG_STATE_HOME")
    root = Path(xdg_state).expanduser() if xdg_state else Path.home() / ".local" / "state"
    return root / "herdr" / "plugins" / "local.non-idle-agent"


def load_focus_history(path: Path) -> tuple[str | None, list[str]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, AttributeError, json.JSONDecodeError):
        return None, []
    if not isinstance(payload, dict):
        return None, []
    return_pane_id = payload.get("return_pane_id")
    recent_pane_ids = payload.get("recent_pane_ids")
    return (
        return_pane_id if isinstance(return_pane_id, str) and return_pane_id else None,
        [
            pane_id
            for pane_id in recent_pane_ids
            if isinstance(pane_id, str) and pane_id
        ]
        if isinstance(recent_pane_ids, list)
        else [],
    )


def load_return_pane(path: Path) -> str | None:
    return load_focus_history(path)[0]


def save_focus_history(
    path: Path, return_pane_id: str | None, recent_pane_ids: list[str]
) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(
            {
                "recent_pane_ids": recent_pane_ids[:RECENT_HISTORY_LIMIT],
                "return_pane_id": return_pane_id,
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def save_return_pane(path: Path, pane_id: str) -> None:
    _, recent_pane_ids = load_focus_history(path)
    save_focus_history(path, pane_id, recent_pane_ids)


def record_recent_sessions(path: Path, *pane_ids: str) -> None:
    return_pane_id, prior_pane_ids = load_focus_history(path)
    recent_pane_ids = list(dict.fromkeys((*pane_ids, *prior_pane_ids)))
    save_focus_history(path, return_pane_id, recent_pane_ids)


def notify(herdr: str, title: str) -> None:
    subprocess.run(
        [herdr, "notification", "show", title, "--sound", "none"],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )


def main() -> int:
    reverse = sys.argv[1:] == ["--reverse"]
    if sys.argv[1:] not in ([], ["--reverse"]):
        print("usage: switch.py [--reverse]", file=sys.stderr)
        return 2
    herdr = os.environ.get("HERDR_BIN_PATH", "herdr")
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)

    # Hammerspoon can launch actions in quick succession. Serialize the list,
    # focus, and history update so each invocation observes the prior switch.
    with (directory / "switch.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            result = run(herdr, "agent", "list")
        except (OSError, subprocess.TimeoutExpired) as error:
            print(f"non-idle-agent: could not list agents: {error}", file=sys.stderr)
            return 1
        if result.returncode:
            print(result.stderr, file=sys.stderr, end="")
            return result.returncode

        try:
            agents = agents_from_payload(json.loads(result.stdout))
        except (ValueError, json.JSONDecodeError) as error:
            print(f"non-idle-agent: {error}", file=sys.stderr)
            return 1
        active = [
            agent for agent in agents if agent.get("agent_status") in NON_IDLE_STATES
        ]
        history_path = directory / "focus-history.json"
        if active:
            target = select_target(
                agents,
                active,
                load_return_pane(history_path),
                reverse=reverse,
            )
        else:
            _, recent_pane_ids = load_focus_history(history_path)
            target = select_recent_session(
                agents, recent_pane_ids, reverse=reverse
            )
        if target is None:
            if not active:
                notify(herdr, "No other recent agent sessions")
            elif len(active) == 1 and active[0].get("focused"):
                notify(herdr, "No previous agent to return to")
            else:
                notify(herdr, "No other non-idle agents")
            return 0

        source = next((agent for agent in agents if agent.get("focused")), None)
        try:
            result = run(herdr, "agent", "focus", target["pane_id"])
        except (OSError, subprocess.TimeoutExpired) as error:
            print(f"non-idle-agent: could not focus agent: {error}", file=sys.stderr)
            return 1
        if result.returncode:
            print(result.stderr, file=sys.stderr, end="")
            return result.returncode
        if source and source["pane_id"] != target["pane_id"]:
            save_return_pane(history_path, source["pane_id"])
            record_recent_sessions(
                history_path, target["pane_id"], source["pane_id"]
            )
        else:
            record_recent_sessions(history_path, target["pane_id"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
