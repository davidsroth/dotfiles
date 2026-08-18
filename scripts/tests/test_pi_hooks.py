"""Hermetic tests for canonical Pi settings git-hook behavior."""

import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
POST_CHECKOUT = REPO_ROOT / ".githooks" / "post-checkout"
REFRESH = REPO_ROOT / ".githooks" / "refresh-pi-settings"


class PiSettingsHookTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.repo = root / "canonical"
        self.hooks = self.repo / ".githooks"
        self.scripts = self.repo / "scripts"
        self.hooks.mkdir(parents=True)
        self.scripts.mkdir()
        shutil.copy2(POST_CHECKOUT, self.hooks / POST_CHECKOUT.name)
        shutil.copy2(REFRESH, self.hooks / REFRESH.name)
        for hook in self.hooks.iterdir():
            hook.chmod(hook.stat().st_mode | stat.S_IXUSR)

        self.marker = root / "settings-runs"
        generator = self.scripts / "gen-pi-settings.sh"
        generator.write_text(
            '#!/bin/sh\nprintf "run\\n" >> "$PI_SETTINGS_TEST_MARKER"\n',
            encoding="utf-8",
        )
        generator.chmod(0o755)

        self.env = os.environ.copy()
        self.env["PATH"] = "/usr/bin:/bin"
        self.env["PI_SETTINGS_TEST_MARKER"] = str(self.marker)
        subprocess.run(["git", "init"], cwd=self.repo, env=self.env, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=self.repo,
            env=self.env,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=self.repo,
            env=self.env,
            check=True,
        )
        (self.repo / "README.md").write_text("test\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.repo, env=self.env, check=True)
        subprocess.run(
            ["git", "commit", "-m", "initial"],
            cwd=self.repo,
            env=self.env,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "core.hooksPath", str(self.hooks)],
            cwd=self.repo,
            env=self.env,
            check=True,
        )

    def tearDown(self):
        self.tempdir.cleanup()

    def test_linked_worktree_does_not_refresh_global_pi_settings(self):
        subprocess.run(
            ["git", "checkout", "-b", "canonical-check"],
            cwd=self.repo,
            env=self.env,
            check=True,
            capture_output=True,
        )
        self.assertEqual(self.marker.read_text(encoding="utf-8").splitlines(), ["run"])

        worktree = Path(self.tempdir.name) / "ephemeral"
        subprocess.run(
            ["git", "worktree", "add", "--detach", str(worktree), "HEAD"],
            cwd=self.repo,
            env=self.env,
            check=True,
            capture_output=True,
        )

        self.assertEqual(self.marker.read_text(encoding="utf-8").splitlines(), ["run"])


if __name__ == "__main__":
    unittest.main()
