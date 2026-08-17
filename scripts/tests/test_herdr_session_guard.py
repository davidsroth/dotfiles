"""Tests for the Herdr Pi session-reference safeguard."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = (
    REPO_ROOT
    / "core"
    / ".config"
    / "herdr"
    / "plugins"
    / "session-guard"
    / "session_guard.py"
)
SPEC = importlib.util.spec_from_file_location("herdr_session_guard", MODULE_PATH)
assert SPEC and SPEC.loader
session_guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(session_guard)


def pi_agent(path: str, pane_id: str = "w1:p1") -> dict:
    return {
        "agent": "pi",
        "agent_session": {
            "source": "herdr:pi",
            "agent": "pi",
            "kind": "path",
            "value": path,
        },
        "pane_id": pane_id,
        "tab_id": "w1:t1",
        "workspace_id": "w1",
        "terminal_id": "term_1",
        "cwd": "/tmp/project",
        "name": "worker",
        "terminal_title_stripped": "Pi worker",
    }


class HerdrSessionGuardTest(unittest.TestCase):
    def test_normalize_pi_agents_keeps_only_official_session_refs(self):
        invalid_source = pi_agent("/tmp/wrong-source.jsonl", "w1:p2")
        invalid_source["agent_session"]["source"] = "custom:pi"
        invalid_agent = pi_agent("/tmp/wrong-agent.jsonl", "w1:p3")
        invalid_agent["agent_session"]["agent"] = "claude"
        payload = {
            "result": {
                "agents": [
                    pi_agent("/tmp/one.jsonl"),
                    invalid_source,
                    invalid_agent,
                    {"agent": "pi", "pane_id": "w1:p4"},
                    {
                        "agent": "claude",
                        "agent_session": {
                            "source": "herdr:claude",
                            "agent": "claude",
                            "kind": "id",
                            "value": "abc",
                        },
                    },
                ]
            }
        }

        agents = session_guard.normalize_pi_agents(payload)

        self.assertEqual(len(agents), 1)
        self.assertEqual(agents[0]["value"], "/tmp/one.jsonl")
        self.assertEqual(agents[0]["terminal_title"], "Pi worker")

    def test_empty_snapshot_does_not_erase_last_known_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            first = session_guard.normalize_pi_agents(
                {"result": {"agents": [pi_agent("/tmp/one.jsonl")]}}
            )
            session_guard.save_snapshot(
                first,
                reason="agent-detected",
                directory=directory,
                captured_at="2026-08-14T18:00:00.000001Z",
            )
            session_guard.save_snapshot(
                [],
                reason="agent-exited",
                directory=directory,
                captured_at="2026-08-14T18:01:00.000001Z",
            )

            latest = session_guard.load_json(directory / "latest.json")
            inventory = session_guard.load_json(directory / "inventory.json")

            self.assertEqual(latest["agents"], [])
            self.assertEqual(len(inventory["entries"]), 1)
            self.assertEqual(
                inventory["last_known_by_pane"]["w1:p1"]["value"],
                "/tmp/one.jsonl",
            )

    def test_snapshot_history_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            for index in range(4):
                session_guard.save_snapshot(
                    [],
                    reason="test",
                    directory=directory,
                    history_limit=2,
                    captured_at=f"2026-08-14T18:00:0{index}.000001Z",
                )

            snapshots = list((directory / "snapshots").glob("*.json"))
            self.assertEqual(len(snapshots), 2)

    def test_verify_snapshot_reports_only_missing_pi_refs(self):
        expected = session_guard.normalize_pi_agents(
            {
                "result": {
                    "agents": [
                        pi_agent("/tmp/one.jsonl", "w1:p1"),
                        pi_agent("/tmp/two.jsonl", "w1:p2"),
                    ]
                }
            }
        )
        session_payload = {
            "workspaces": [
                {
                    "tabs": [
                        {
                            "panes": {
                                "1": {
                                    "agent_session": {
                                        "source": "herdr:pi",
                                        "agent": "pi",
                                        "kind": "path",
                                        "value": "/tmp/one.jsonl",
                                    }
                                }
                            }
                        }
                    ]
                }
            ]
        }

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.json"
            session_guard.write_json_atomic(path, session_payload)
            missing = session_guard.verify_snapshot_persisted(
                {"agents": expected}, path
            )

        self.assertEqual([agent["value"] for agent in missing], ["/tmp/two.jsonl"])

    def test_verify_requires_a_session_snapshot_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "missing.json"
            with self.assertRaisesRegex(
                session_guard.GuardError, "session snapshot is missing"
            ):
                session_guard.verify_snapshot_persisted({"agents": []}, missing)

    def test_safe_stop_refuses_inside_herdr_even_without_herdr_env(self):
        with mock.patch.dict(
            os.environ,
            {
                "HERDR_ENV": "",
                "HERDR_PANE_ID": "w1:p1",
                "HERDR_TAB_ID": "",
                "HERDR_WORKSPACE_ID": "",
            },
            clear=False,
        ):
            with self.assertRaisesRegex(session_guard.GuardError, "outside Herdr"):
                session_guard.safe_stop()

    def test_safe_stop_refuses_empty_current_refs_when_inventory_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            session_guard.write_json_atomic(
                directory / "inventory.json",
                {"entries": {"old": {"value": "/tmp/old.jsonl"}}},
            )
            env = {
                "HERDR_ENV": "",
                "HERDR_PANE_ID": "",
                "HERDR_TAB_ID": "",
                "HERDR_WORKSPACE_ID": "",
            }
            with (
                mock.patch.dict(os.environ, env, clear=False),
                mock.patch.object(session_guard, "state_dir", return_value=directory),
                mock.patch.object(
                    session_guard,
                    "snapshot",
                    return_value={"agents": []},
                ),
                mock.patch.object(session_guard, "run_command") as run_command,
            ):
                with self.assertRaisesRegex(
                    session_guard.GuardError, "refusing an unverifiable safe-stop"
                ):
                    session_guard.safe_stop()
                run_command.assert_not_called()

    def test_safe_stop_refuses_empty_refs_without_prior_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            env = {
                "HERDR_ENV": "",
                "HERDR_PANE_ID": "",
                "HERDR_TAB_ID": "",
                "HERDR_WORKSPACE_ID": "",
            }
            with (
                mock.patch.dict(os.environ, env, clear=False),
                mock.patch.object(session_guard, "state_dir", return_value=directory),
                mock.patch.object(
                    session_guard, "snapshot", return_value={"agents": []}
                ),
                mock.patch.object(session_guard, "run_command") as run_command,
            ):
                with self.assertRaisesRegex(
                    session_guard.GuardError, "no prior inventory is available"
                ):
                    session_guard.safe_stop()
                run_command.assert_not_called()

    def test_safe_stop_stops_waits_and_verifies_current_refs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            config = root / "config" / "herdr"
            config.mkdir(parents=True)
            agents = session_guard.normalize_pi_agents(
                {"result": {"agents": [pi_agent("/tmp/one.jsonl")]}}
            )
            session_guard.write_json_atomic(
                state / "inventory.json",
                {"entries": {session_guard.session_key(agents[0]): agents[0]}},
            )
            env = {
                "HERDR_ENV": "",
                "HERDR_PANE_ID": "",
                "HERDR_TAB_ID": "",
                "HERDR_WORKSPACE_ID": "",
            }
            completed = session_guard.subprocess.CompletedProcess(
                ["herdr", "server", "stop"], 0, "stopped\n", ""
            )
            with (
                mock.patch.dict(os.environ, env, clear=False),
                mock.patch.object(session_guard, "state_dir", return_value=state),
                mock.patch.object(session_guard, "herdr_config_dir", return_value=config),
                mock.patch.object(
                    session_guard,
                    "snapshot",
                    return_value={"agents": agents},
                ),
                mock.patch.object(
                    session_guard,
                    "herdr_socket_path",
                    return_value=root / "herdr.sock",
                ),
                mock.patch.object(
                    session_guard, "socket_owner_pids", return_value=[123]
                ),
                mock.patch.object(
                    session_guard, "run_command", return_value=completed
                ) as run_command,
                mock.patch.object(session_guard, "wait_for_server_stop") as wait,
                mock.patch.object(
                    session_guard, "verify_snapshot_persisted", return_value=[]
                ) as verify,
            ):
                self.assertEqual(session_guard.safe_stop(), 0)
                run_command.assert_called_once_with(
                    [session_guard.herdr_bin(), "server", "stop"], timeout=60
                )
                wait.assert_called_once_with(
                    config / "session.json", root / "herdr.sock", [123]
                )
                verify.assert_called_once_with(
                    {"agents": agents}, config / "session.json"
                )

    def test_safe_stop_writes_recovery_metadata_on_post_stop_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            config = root / "config" / "herdr"
            config.mkdir(parents=True)
            agents = session_guard.normalize_pi_agents(
                {"result": {"agents": [pi_agent("/tmp/one.jsonl")]}}
            )
            session_guard.write_json_atomic(
                state / "inventory.json",
                {"entries": {session_guard.session_key(agents[0]): agents[0]}},
            )
            env = {
                "HERDR_ENV": "",
                "HERDR_PANE_ID": "",
                "HERDR_TAB_ID": "",
                "HERDR_WORKSPACE_ID": "",
            }
            completed = session_guard.subprocess.CompletedProcess(
                ["herdr", "server", "stop"], 0, "", ""
            )
            with (
                mock.patch.dict(os.environ, env, clear=False),
                mock.patch.object(session_guard, "state_dir", return_value=state),
                mock.patch.object(session_guard, "herdr_config_dir", return_value=config),
                mock.patch.object(
                    session_guard, "snapshot", return_value={"agents": agents}
                ),
                mock.patch.object(
                    session_guard,
                    "herdr_socket_path",
                    return_value=root / "herdr.sock",
                ),
                mock.patch.object(
                    session_guard, "socket_owner_pids", return_value=[123]
                ),
                mock.patch.object(
                    session_guard, "run_command", return_value=completed
                ),
                mock.patch.object(
                    session_guard,
                    "wait_for_server_stop",
                    side_effect=session_guard.GuardError("snapshot unstable"),
                ),
            ):
                with self.assertRaisesRegex(
                    session_guard.GuardError, "recovery metadata"
                ):
                    session_guard.safe_stop()

            recovery = session_guard.load_json(state / "recovery-needed.json")
            self.assertEqual(
                recovery["reason"], "safe-stop-command-or-validation-error"
            )
            self.assertEqual(recovery["error"], "snapshot unstable")
            self.assertEqual(recovery["snapshot"]["agents"], agents)

    def test_safe_stop_writes_recovery_metadata_when_stop_command_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            config = root / "config" / "herdr"
            config.mkdir(parents=True)
            agents = session_guard.normalize_pi_agents(
                {"result": {"agents": [pi_agent("/tmp/one.jsonl")]}}
            )
            session_guard.write_json_atomic(
                state / "inventory.json",
                {"entries": {session_guard.session_key(agents[0]): agents[0]}},
            )
            env = {
                "HERDR_ENV": "",
                "HERDR_PANE_ID": "",
                "HERDR_TAB_ID": "",
                "HERDR_WORKSPACE_ID": "",
            }
            with (
                mock.patch.dict(os.environ, env, clear=False),
                mock.patch.object(session_guard, "state_dir", return_value=state),
                mock.patch.object(session_guard, "herdr_config_dir", return_value=config),
                mock.patch.object(
                    session_guard, "snapshot", return_value={"agents": agents}
                ),
                mock.patch.object(
                    session_guard,
                    "herdr_socket_path",
                    return_value=root / "herdr.sock",
                ),
                mock.patch.object(
                    session_guard, "socket_owner_pids", return_value=[123]
                ),
                mock.patch.object(
                    session_guard,
                    "run_command",
                    side_effect=session_guard.GuardError("stop timed out"),
                ),
                mock.patch.object(session_guard, "wait_for_server_stop") as wait,
            ):
                with self.assertRaisesRegex(
                    session_guard.GuardError, "recovery metadata"
                ):
                    session_guard.safe_stop()
                wait.assert_not_called()

            recovery = session_guard.load_json(state / "recovery-needed.json")
            self.assertEqual(
                recovery["reason"], "safe-stop-command-or-validation-error"
            )
            self.assertEqual(recovery["error"], "stop timed out")
            self.assertEqual(recovery["snapshot"]["agents"], agents)


if __name__ == "__main__":
    unittest.main()
