"""Tests for core/.config/tmux/bin/session-picker.py (row building, dedup,
pi heartbeat handling, worktree parsing). Hermetic: no tmux, sesh, or git
subprocesses — only the pure row/parse layer plus tempdir file IO.

Run via `just picker-test` or `python3 -m unittest discover -s scripts/tests`.
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PICKER_PATH = os.path.join(REPO_ROOT, "core", ".config", "tmux", "bin", "session-picker.py")

spec = importlib.util.spec_from_file_location("session_picker", PICKER_PATH)
sp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sp)


def strip_ansi(text):
    import re

    return re.sub(r"\033\[[0-9;]*m", "", text)


class TestSeshRows(unittest.TestCase):
    def test_zoxide_rows_lead_with_basename(self):
        rows = sp.build_sesh_rows(
            [{"Src": "zoxide", "Name": "~/dotfiles", "Path": "/Users/u/dotfiles"}], {}, ""
        )
        self.assertEqual(len(rows), 1)
        self.assertIn("dotfiles  ~/dotfiles", rows[0].display)
        self.assertEqual(rows[0].target, "/Users/u/dotfiles")
        self.assertEqual(rows[0].src, "zoxide")

    def test_tmux_rows_target_session_name(self):
        rows = sp.build_sesh_rows(
            [{"Src": "tmux", "Name": "work", "Path": "/Users/u/work"}], {}, ""
        )
        self.assertEqual(rows[0].target, "work")
        self.assertTrue(strip_ansi(rows[0].display).endswith(" work"))

    def test_current_tmux_session_is_skipped(self):
        rows = sp.build_sesh_rows(
            [
                {"Src": "tmux", "Name": "here", "Path": "/a"},
                {"Src": "tmux", "Name": "other", "Path": "/b"},
            ],
            {},
            "here",
        )
        self.assertEqual([r.target for r in rows], ["other"])

    def test_marker_slot_is_always_two_chars(self):
        roots = {os.path.realpath("/r/working"): "working"}
        working, idle = sp.build_sesh_rows(
            [
                {"Src": "zoxide", "Name": "/r/working", "Path": "/r/working"},
                {"Src": "zoxide", "Name": "/r/idle", "Path": "/r/idle"},
            ],
            roots,
            "",
        )
        # Both displays must put the name at the same column once ANSI codes
        # are stripped — the fzf begin tiebreak depends on it.
        self.assertEqual(
            strip_ansi(working.display).index("working"),
            strip_ansi(idle.display).index("idle"),
        )
        self.assertIn("π", strip_ansi(working.display))
        self.assertNotIn("π", strip_ansi(idle.display))


class TestWorktreeRows(unittest.TestCase):
    def test_rows_render_label_branch_and_path(self):
        lines = ["/wt/repo-fix\trepo\tfix/bug\t\n"]
        rows = sp.build_worktree_rows(lines, {}, isdir=lambda p: True)
        self.assertEqual(len(rows), 1)
        self.assertIn("repo:fix/bug  /wt/repo-fix", rows[0].display)
        self.assertEqual(rows[0].target, "/wt/repo-fix")
        self.assertEqual(rows[0].src, "worktree")

    def test_missing_directories_are_dropped(self):
        lines = ["/gone\trepo\tmain\t\n"]
        self.assertEqual(sp.build_worktree_rows(lines, {}, isdir=lambda p: False), [])


class TestDedupe(unittest.TestCase):
    def row(self, src, key, priority, display=None):
        return sp.Row(display or f"{src}:{key}", key or "t", src, key, priority)

    def test_higher_priority_row_wins_at_first_position(self):
        zox = self.row("zoxide", "/r/wt", 2)
        wt = self.row("worktree", "/r/wt", 1)
        other = self.row("zoxide", "/r/other", 2)
        out = sp.dedupe([zox, other, wt])
        # Worktree row wins, but at the zoxide row's (frecency) position.
        self.assertEqual(out, [wt, other])

    def test_tmux_beats_worktree(self):
        tmux = self.row("tmux", "/r/wt", 0)
        wt = self.row("worktree", "/r/wt", 1)
        self.assertEqual(sp.dedupe([tmux, wt]), [tmux])

    def test_keyless_rows_always_emit(self):
        a = self.row("config", None, 0)
        b = self.row("config", None, 0)
        self.assertEqual(sp.dedupe([a, b]), [a, b])


class TestWorktreeParsing(unittest.TestCase):
    PORCELAIN = (
        "worktree /repo/main\n"
        "HEAD aaaa111122223333\n"
        "branch refs/heads/main\n"
        "\n"
        "worktree /repo/wt-fix\n"
        "HEAD bbbb111122223333\n"
        "branch refs/heads/fix/bug\n"
        "locked\n"
        "\n"
        "worktree /repo/wt-detached\n"
        "HEAD cccc111122223333\n"
        "detached\n"
    )

    def test_parse_porcelain(self):
        records = sp.parse_worktree_porcelain(self.PORCELAIN)
        self.assertEqual(len(records), 3)
        self.assertEqual(records[0]["worktree"], "/repo/main")
        self.assertEqual(records[1]["locked"], True)

    def test_ref_label(self):
        records = sp.parse_worktree_porcelain(self.PORCELAIN)
        self.assertEqual(sp.ref_label(records[0]), "main")
        self.assertEqual(sp.ref_label(records[1]), "fix/bug")
        self.assertEqual(sp.ref_label(records[2]), "detached@cccc111")

    def test_repo_label_unwraps_main_checkout_dirs(self):
        self.assertEqual(sp.repo_label("/git/repo"), "repo")
        self.assertEqual(sp.repo_label("/git/repo/main"), "repo")
        self.assertEqual(sp.repo_label("/git/repo/trunk/"), "repo")


class TestPiHeartbeats(unittest.TestCase):
    def write_record(self, dirpath, pid, **extra):
        record = {"pid": pid, "cwd": "/r", "status": "idle", "interactive": True}
        record.update(extra)
        with open(os.path.join(dirpath, f"{pid}.json"), "w") as fh:
            json.dump(record, fh)

    def test_dead_pid_files_are_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.write_record(tmp, 1111)
            self.write_record(tmp, 2222)
            records = sp.read_pi_records(status_dir=tmp, alive=lambda pid: pid == 2222)
            self.assertEqual([r["pid"] for r in records], [2222])
            self.assertEqual(os.listdir(tmp), ["2222.json"])

    def test_malformed_files_are_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "bad.json"), "w") as fh:
                fh.write("{not json")
            self.assertEqual(sp.read_pi_records(status_dir=tmp, alive=lambda pid: True), [])

    def test_working_wins_per_root(self):
        records = [
            {"pid": 1, "cwd": "/r/sub", "status": "idle", "interactive": True},
            {"pid": 2, "cwd": "/r", "status": "working", "interactive": True},
        ]
        roots = sp.pi_roots(records, root_of=lambda cwd: "/r")
        self.assertEqual(roots, {os.path.realpath("/r"): "working"})

    def test_status_summary_counts_interactive_roots_only(self):
        records = [
            {"pid": 1, "cwd": "/a", "status": "working", "interactive": True},
            {"pid": 2, "cwd": "/b", "status": "idle", "interactive": True},
            {"pid": 3, "cwd": "/c", "status": "working", "interactive": False},
        ]
        summary = sp.status_summary(records)
        self.assertIn("π1", summary)  # one working interactive root
        self.assertEqual(summary.count("π"), 2)  # …and one idle; subagent excluded

    def test_status_summary_empty_when_nothing_runs(self):
        self.assertEqual(sp.status_summary([]), "")


class TestGitRoot(unittest.TestCase):
    def test_walks_up_to_dot_git(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "repo")
            sub = os.path.join(root, "a", "b")
            os.makedirs(os.path.join(root, ".git"))
            os.makedirs(sub)
            self.assertEqual(sp.git_root(sub), os.path.realpath(root))


if __name__ == "__main__":
    unittest.main()
