"""Tests for core/.config/shell/bin/claude-status-hook (heartbeat files for
the tmux session picker). Hermetic: the claude-pid walk uses an injected ps
lookup, and files are written to tempdirs.

Run via `just picker-test` or `python3 -m unittest discover -s scripts/tests`.
"""

import importlib.util
import json
import os
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK_PATH = os.path.join(REPO_ROOT, "core", ".config", "shell", "bin", "claude-status-hook")

loader = importlib.machinery.SourceFileLoader("claude_status_hook", HOOK_PATH)
spec = importlib.util.spec_from_loader("claude_status_hook", loader)
hook = importlib.util.module_from_spec(spec)
loader.exec_module(hook)


def read_record(directory, pid):
    with open(os.path.join(directory, f"{pid}.json")) as fh:
        return json.load(fh)


class TestStatusDir(unittest.TestCase):
    def test_prefers_xdg_cache_home(self):
        self.assertEqual(hook.status_dir({"XDG_CACHE_HOME": "/x"}), "/x/claude-status")

    def test_falls_back_to_home_cache(self):
        self.assertTrue(hook.status_dir({}).endswith(".cache/claude-status"))


class TestFindClaude(unittest.TestCase):
    def lookup_from(self, table):
        return lambda pid: table.get(pid)

    def test_walks_up_to_claude_process(self):
        # hook script (300) <- sh (200) <- claude (100) <- login shell (1)
        table = {
            300: (200, "ttys001", "/bin/sh -c ~/.config/shell/bin/claude-status-hook"),
            200: (100, "ttys001", "claude --resume"),
            100: (1, "ttys001", "-zsh"),
        }
        pid, interactive = hook.find_claude(300, lookup=self.lookup_from(table))
        self.assertEqual(pid, 200)
        self.assertTrue(interactive)

    def test_own_command_line_is_not_matched(self):
        # The sh -c line mentions the hook itself; it must not count as claude.
        table = {300: (1, "ttys001", "/bin/sh -c claude-status-hook")}
        self.assertEqual(hook.find_claude(300, lookup=self.lookup_from(table)), (None, False))

    def test_headless_claude_is_not_interactive(self):
        table = {300: (100, "??", "claude -p do-something")}
        pid, interactive = hook.find_claude(300, lookup=self.lookup_from(table))
        self.assertEqual(pid, 300)
        self.assertFalse(interactive)

    def test_gives_up_at_init(self):
        table = {300: (1, "ttys001", "python3 something-else")}
        self.assertEqual(hook.find_claude(300, lookup=self.lookup_from(table)), (None, False))


class TestHandle(unittest.TestCase):
    def test_event_status_mapping(self):
        expectations = {
            "SessionStart": "idle",
            "UserPromptSubmit": "working",
            "PostToolUse": "working",
            "Stop": "idle",
            "Notification": "idle",
        }
        for name, status in expectations.items():
            with tempfile.TemporaryDirectory() as tmp:
                handled = hook.handle(
                    {"hook_event_name": name, "cwd": "/repo"}, tmp, 42, True
                )
                self.assertTrue(handled, name)
                self.assertEqual(
                    read_record(tmp, 42),
                    {"pid": 42, "cwd": "/repo", "interactive": True, "status": status},
                    name,
                )

    def test_session_end_removes_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            hook.handle({"hook_event_name": "SessionStart", "cwd": "/repo"}, tmp, 42, True)
            hook.handle({"hook_event_name": "SessionEnd", "cwd": "/repo"}, tmp, 42, True)
            self.assertEqual(os.listdir(tmp), [])

    def test_unknown_events_are_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            handled = hook.handle({"hook_event_name": "PreCompact", "cwd": "/r"}, tmp, 42, True)
            self.assertFalse(handled)
            self.assertEqual(os.listdir(tmp), [])


if __name__ == "__main__":
    unittest.main()
