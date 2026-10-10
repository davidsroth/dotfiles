"""Real-Git integration tests for zsh helpers; tmux is stubbed, HOME isolated."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SHELL = ROOT / "core/.config/shell"
SCRIPT = SHELL / "bin/tmux_worktree_session_for_branch"


@unittest.skipUnless(shutil.which("zsh") and shutil.which("git"), "requires zsh and git")
class WorktreeHelpers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.home = self.base / "home"
        installed = self.home / ".config/shell"
        installed.mkdir(parents=True)
        for name in ("functions.sh", "worktree-paths.sh"):
            (installed / name).symlink_to(SHELL / name)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.log = self.base / "tmux.jsonl"
        stub = self.bin / "tmux"
        stub.write_text("#!/usr/bin/env python3\nimport json,os,sys\nwith open(os.environ['TMUX_TEST_LOG'],'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n")
        stub.chmod(0o755)
        self.env = {**os.environ, "HOME": str(self.home),
                    "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
                    "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                    "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0",
                    "TMUX_TEST_LOG": str(self.log)}
        for key in ("TMUX", "GIT_WORKTREE_ROOT", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
            self.env.pop(key, None)
        self.workspace = self.base / "workspace with spaces"
        self.repo = self.workspace / "widget"
        self.repo.mkdir(parents=True)
        self.init_repo(self.repo)

    def init_repo(self, repo):
        self.git("init", "-q", "-b", "main", cwd=repo)
        for key, value in (("user.name", "Test"), ("user.email", "test@example.invalid"),
                           ("core.fsmonitor", "false"), ("core.hooksPath", os.devnull),
                           ("commit.gpgsign", "false")):
            self.git("config", key, value, cwd=repo)
        (repo / "apps/api").mkdir(parents=True)
        (repo / "apps/api/source.txt").write_text("fixture\n")
        self.git("add", ".", cwd=repo)
        self.git("commit", "-qm", "fixture", cwd=repo)

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.repo, env=self.env,
                              check=True, text=True, capture_output=True).stdout.strip()

    def function(self, name, *args, cwd=None):
        return subprocess.run(["zsh", "-f", "-c", 'source "$1"; shift; "$@"', "test",
                               str(SHELL / "functions.sh"), name, *args],
                              cwd=cwd or self.repo, env=self.env, text=True, capture_output=True)

    def branch_helper(self, branch, cwd=None):
        return subprocess.run(["zsh", "-f", str(SCRIPT), branch], cwd=cwd or self.repo,
                              env=self.env, text=True, capture_output=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def target(self):
        call = next(c for c in reversed(self.calls()) if c[0] == "new-session")
        return Path(call[call.index("-c") + 1])

    def session(self):
        call = next(c for c in reversed(self.calls()) if c[0] == "new-session")
        return call[call.index("-s") + 1]

    def assertOK(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def legacy(self, branch="legacy"):
        path = self.workspace / "widget-old-fix"
        self.git("worktree", "add", "-b", branch, str(path))
        return path

    def test_creation_from_main_preserves_subdirectory_and_session_label(self):
        self.assertOK(self.function("tmux_worktree_session", cwd=self.repo / "apps/api"))
        target = self.target()
        self.assertEqual(target.parent.parent.parent, self.workspace / "worktrees/widget")
        self.assertTrue(target.parent.parent.name.startswith("work-"))
        self.assertTrue(self.session().startswith("widget-work-"))
        self.assertEqual(self.git("rev-parse", "--show-prefix", cwd=target), "apps/api/")

    def test_creation_from_linked_checkout_uses_canonical_repo(self):
        old = self.legacy()
        self.assertOK(self.function("tmux_worktree_session", cwd=old))
        self.assertEqual(self.target().parent, self.workspace / "worktrees/widget")
        self.assertTrue(self.session().startswith("widget-work-"))
        self.assertFalse((self.workspace / "worktrees/widget-old-fix").exists())

    def test_existing_branch_creates_organized_worktree(self):
        self.git("branch", "fix/bug")
        self.assertOK(self.branch_helper("fix/bug", cwd=self.repo / "apps/api"))
        self.assertEqual(self.target(), self.workspace / "worktrees/widget/fix-bug/apps/api")
        self.assertEqual(self.session(), "widget-fix-bug")

    def test_existing_branch_reuses_legacy_path_even_from_linked_checkout(self):
        old = self.legacy("fix/legacy")
        self.assertOK(self.branch_helper("fix/legacy", cwd=old / "apps/api"))
        self.assertEqual(self.target(), old / "apps/api")
        self.assertFalse((self.workspace / "worktrees").exists())

    def test_existing_main_branch_opens_main_checkout(self):
        self.assertOK(self.branch_helper("main"))
        self.assertEqual(self.target(), self.repo)

    def test_flattened_branch_collision_does_not_open_wrong_worktree(self):
        self.git("branch", "fix/a")
        self.git("branch", "fix-a")
        self.assertOK(self.branch_helper("fix/a"))
        before = self.calls()
        result = self.branch_helper("fix-a")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), before)
        self.assertEqual(self.git("branch", "--show-current", cwd=self.target()), "fix/a")

    def test_directory_collision_is_refused(self):
        self.git("branch", "fix")
        target = self.workspace / "worktrees/widget/fix"
        target.mkdir(parents=True)
        (target / "keep.txt").write_text("keep")
        self.assertNotEqual(self.branch_helper("fix").returncode, 0)
        self.assertEqual((target / "keep.txt").read_text(), "keep")
        self.assertEqual(self.calls(), [])

    def test_broken_symlink_collision_is_refused(self):
        self.git("branch", "fix")
        target = self.workspace / "worktrees/widget/fix"
        target.parent.mkdir(parents=True)
        target.symlink_to(self.base / "missing")
        self.assertNotEqual(self.branch_helper("fix").returncode, 0)
        self.assertTrue(target.is_symlink())

    def test_stale_branch_registration_is_refused(self):
        old = self.legacy()
        shutil.rmtree(old)
        self.assertNotEqual(self.branch_helper("legacy").returncode, 0)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.workspace / "worktrees").exists())

    def test_registered_path_replaced_by_unrelated_repo_is_refused(self):
        old = self.legacy()
        shutil.rmtree(old)
        old.mkdir()
        self.init_repo(old)
        self.assertNotEqual(self.branch_helper("legacy").returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_stale_destination_registration_is_refused(self):
        old = self.workspace / "worktrees/widget/fix"
        self.git("worktree", "add", "-b", "old", str(old))
        shutil.rmtree(old)
        self.git("branch", "fix")
        self.assertNotEqual(self.branch_helper("fix").returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_unsafe_rename_names_are_refused(self):
        old = self.legacy()
        for name in ("../escape", "/absolute", "..", "-option", "bad name", "a/b"):
            with self.subTest(name=name):
                self.assertNotEqual(self.function("tmux_rename_worktree", name, cwd=old).returncode, 0)
                self.assertTrue(old.is_dir())

    def test_absolute_override_and_relative_override_refusal(self):
        self.git("branch", "fix")
        self.env["GIT_WORKTREE_ROOT"] = "relative"
        self.assertNotEqual(self.branch_helper("fix").returncode, 0)
        self.env["GIT_WORKTREE_ROOT"] = str(self.base / "custom with spaces")
        self.assertOK(self.branch_helper("fix"))
        self.assertEqual(self.target(), self.base / "custom with spaces/widget/fix")

    def test_main_named_checkout_uses_parent_repo_label(self):
        main = self.workspace / "other/main"
        main.mkdir(parents=True)
        self.init_repo(main)
        self.git("branch", "fix", cwd=main)
        self.assertOK(self.branch_helper("fix", cwd=main))
        self.assertEqual(self.target(), self.workspace / "other/worktrees/other/fix")
        self.assertEqual(self.session(), "other-fix")

    def test_rename_preserves_dirty_file_head_and_matching_subdirectory(self):
        old = self.legacy()
        head = self.git("rev-parse", "HEAD", cwd=old)
        (old / "apps/api/untracked.txt").write_text("preserve me")
        result = subprocess.run(["zsh", "-f", "-c",
                                 'source "$1"; tmux_rename_worktree renamed || exit; pwd',
                                 "test", str(SHELL / "functions.sh")],
                                cwd=old / "apps/api", env=self.env, text=True, capture_output=True)
        self.assertOK(result)
        target = self.workspace / "worktrees/widget/renamed"
        self.assertEqual(result.stdout.strip(), str(target / "apps/api"))
        self.assertEqual((target / "apps/api/untracked.txt").read_text(), "preserve me")
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=target), head)
        self.assertFalse(old.exists())

    def test_rename_main_checkout_is_refused(self):
        self.assertNotEqual(self.function("tmux_rename_worktree", "renamed").returncode, 0)
        self.assertTrue(self.repo.is_dir())

    def test_picker_discovers_real_nested_worktree_from_main(self):
        self.git("branch", "fix")
        self.assertOK(self.branch_helper("fix"))
        picker = ROOT / "core/.config/tmux/bin/session-picker.py"
        spec = importlib.util.spec_from_file_location("worktree_picker_integration", picker)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        rows = module.discover_worktree_lines([str(self.repo)])
        self.assertIn(str(self.target()) + "\twidget\tfix\t", rows)


if __name__ == "__main__":
    unittest.main()
