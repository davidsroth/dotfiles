"""Tests for the Herdr non-idle-agent plugin."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "plugins" / "non-idle-agent" / "switch.py"
)
SPEC = importlib.util.spec_from_file_location("non_idle_agent", MODULE_PATH)
assert SPEC and SPEC.loader
switch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(switch)


def agent(status: str, pane_id: str, *, focused: bool = False) -> dict[str, object]:
    return {"agent_status": status, "pane_id": pane_id, "focused": focused}


class NonIdleAgentTest(unittest.TestCase):
    def test_active_agents_excludes_idle_and_malformed_rows(self):
        payload = {
            "result": {
                "agents": [
                    agent("idle", "w0:p1"),
                    agent("working", "w0:p2"),
                    agent("done", "w0:p3"),
                    agent("unknown", "w0:p4"),
                    {"agent_status": "blocked"},
                    "not-an-agent",
                ]
            }
        }

        self.assertEqual(
            [row["pane_id"] for row in switch.active_agents(payload)],
            ["w0:p2", "w0:p3", "w0:p4"],
        )

    def test_select_next_starts_at_first_active_agent_when_focus_is_idle(self):
        agents = [agent("working", "w0:p2"), agent("blocked", "w0:p3")]

        self.assertEqual(switch.select_next(agents)["pane_id"], "w0:p2")

    def test_select_next_prefers_green_done_agent_before_panel_order(self):
        agents = [
            agent("done", "w0:p2"),
            agent("working", "w0:p3", focused=True),
            agent("blocked", "w0:p4"),
        ]

        self.assertEqual(switch.select_next(agents)["pane_id"], "w0:p2")

    def test_select_next_prefers_another_done_agent_when_done_is_focused(self):
        agents = [
            agent("done", "w0:p2", focused=True),
            agent("working", "w0:p3"),
            agent("done", "w0:p4"),
        ]

        self.assertEqual(switch.select_next(agents)["pane_id"], "w0:p4")

    def test_select_next_uses_panel_order_when_no_unfocused_done_agent_exists(self):
        agents = [
            agent("working", "w0:p2"),
            agent("blocked", "w0:p3", focused=True),
            agent("unknown", "w0:p4"),
        ]

        self.assertEqual(switch.select_next(agents)["pane_id"], "w0:p4")

    def test_select_next_wraps_to_first_active_agent(self):
        agents = [
            agent("working", "w0:p2"),
            agent("blocked", "w0:p3", focused=True),
        ]

        self.assertEqual(switch.select_next(agents)["pane_id"], "w0:p2")

    def test_select_next_returns_none_without_a_distinct_target(self):
        self.assertIsNone(switch.select_next([]))
        self.assertIsNone(switch.select_next([agent("working", "w0:p2", focused=True)]))

    def test_sole_active_agent_returns_to_previous_idle_agent(self):
        previous = agent("idle", "w0:p1")
        active = agent("working", "w0:p2", focused=True)

        self.assertEqual(
            switch.select_target([previous, active], [active], "w0:p1")["pane_id"],
            "w0:p1",
        )

    def test_sole_active_agent_is_focused_from_previous_idle_agent(self):
        previous = agent("idle", "w0:p1", focused=True)
        active = agent("working", "w0:p2")

        self.assertEqual(
            switch.select_target([previous, active], [active], "w0:p1")["pane_id"],
            "w0:p2",
        )

    def test_sole_active_agent_ignores_stale_return_target(self):
        active = agent("working", "w0:p2", focused=True)

        self.assertIsNone(switch.select_target([active], [active], "w0:closed"))

    def test_focus_history_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "focus-history.json"

            self.assertIsNone(switch.load_return_pane(path))
            switch.save_return_pane(path, "w0:p1")
            self.assertEqual(switch.load_return_pane(path), "w0:p1")


if __name__ == "__main__":
    unittest.main()
