#!/usr/bin/env python3
"""Cycle non-idle Herdr agents, with a return target for a sole active agent."""

from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

NON_IDLE_STATES = frozenset({"working", "blocked", "done", "unknown"})


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


def select_next(agents: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return the next non-idle agent in Herdr's panel order."""
    if not agents:
        return None
    for index, agent in enumerate(agents):
        if agent.get("focused"):
            return agents[(index + 1) % len(agents)] if len(agents) > 1 else None
    return agents[0]


def select_target(
    agents: list[dict[str, Any]],
    active: list[dict[str, Any]],
    return_pane_id: str | None,
) -> dict[str, Any] | None:
    """Choose the normal cycle target or the return side of a one-agent toggle."""
    if len(active) != 1 or not active[0].get("focused"):
        return select_next(active)
    return next(
        (
            agent
            for agent in agents
            if agent["pane_id"] == return_pane_id
            and agent["pane_id"] != active[0]["pane_id"]
        ),
        None,
    )


def state_dir() -> Path:
    plugin_state = os.environ.get("HERDR_PLUGIN_STATE_DIR")
    if plugin_state:
        return Path(plugin_state).expanduser()
    xdg_state = os.environ.get("XDG_STATE_HOME")
    root = Path(xdg_state).expanduser() if xdg_state else Path.home() / ".local" / "state"
    return root / "herdr" / "plugins" / "local.non-idle-agent"


def load_return_pane(path: Path) -> str | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8")).get("return_pane_id")
    except (OSError, AttributeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, str) and value else None


def save_return_pane(path: Path, pane_id: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps({"return_pane_id": pane_id}, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def notify(herdr: str, title: str) -> None:
    subprocess.run(
        [herdr, "notification", "show", title, "--sound", "none"],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )


def main() -> int:
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
        target = select_target(agents, active, load_return_pane(history_path))
        if target is None:
            if not active:
                notify(herdr, "No non-idle agents")
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
