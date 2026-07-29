"""Integration test for core's GNU Stow ignore boundary."""

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

REPO_ROOT = Path(__file__).resolve().parents[2]
IGNORE_FILE = REPO_ROOT / ".stow-local-ignore"
STOW_RC = REPO_ROOT / ".stowrc"


@unittest.skipUnless(shutil.which("stow"), "GNU Stow is not installed")
class StowIgnoreTest(unittest.TestCase):
    def test_sensitive_core_directories_are_not_stowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stow_dir = root / "stow"
            package = stow_dir / "core"
            target = root / "home"
            target.mkdir()
            stow_dir.mkdir()
            shutil.copy2(IGNORE_FILE, stow_dir / ".stow-local-ignore")
            (package / ".stow-local-ignore").parent.mkdir(parents=True, exist_ok=True)
            (package / ".stow-local-ignore").symlink_to("../.stow-local-ignore")

            sensitive = [
                ".claude/session.json",
                ".codex/auth.json",
                ".config/gcloud/credentials.db",
                ".config/gws/auth.json",
                ".config/herdr/session.json",
                ".config/herdr/herdr-server.log",
                ".config/herdr/herdr.sock",
                ".config/herdr/sessions/workspace.json",
                ".config/sunsama/session.json",
                ".config/op/token",
                ".config/raycast/state.db",
                ".config/aetna-claims/token",
                ".config/tuxedo/state.json",
                ".config/gh/hosts.yml",
                ".config/gh-dash/config.local.yml",
                ".config/shell/bin/__pycache__/helper.pyc",
            ]
            for relative in sensitive:
                path = package / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("secret state\n", encoding="utf-8")

            tracked_configs = [
                ".config/nvim/init.lua",
                ".config/espanso/config/default.yml",
                ".config/opencode/opencode.json",
                ".config/herdr/config.toml",
                ".config/herdr/bin/workspace-picker.sh",
                ".config/herdr/plugins/agent-indexes/herdr-plugin.toml",
                ".config/herdr/plugins/agent-indexes/refresh.py",
                # Gitignored machine-local input, intentionally linked into the
                # active config so init.lua can actually load the overrides.
                ".hammerspoon/init.local.lua",
            ]
            for relative in tracked_configs:
                path = package / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("tracked config\n", encoding="utf-8")

            # Reproduce the unsafe old behavior first: folding .config bypasses
            # nested ignore rules and exposes auth state through one symlink.
            old_result = subprocess.run(
                ["stow", "--target", str(target), "core"],
                cwd=stow_dir,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(old_result.returncode, 0, old_result.stderr)
            self.assertTrue((target / ".config" / "gh" / "hosts.yml").exists())

            # The tracked rc must also repair an already-folded installation
            # when users run the normal restow/update path.
            shutil.copy2(STOW_RC, stow_dir / ".stowrc")
            env = os.environ.copy()
            env["HOME"] = str(target)
            result = subprocess.run(
                ["stow", "--restow", "core"],
                cwd=stow_dir,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse((target / ".config").is_symlink(), "tree folding must stay disabled")
            for relative in sensitive:
                self.assertFalse((target / relative).exists(), relative)
            for relative in tracked_configs:
                self.assertTrue((target / relative).exists(), relative)

    def test_every_stow_package_uses_shared_ignore_rules(self):
        for package in ("core", "zsh", "git-config"):
            ignore = REPO_ROOT / package / ".stow-local-ignore"
            self.assertTrue(ignore.is_symlink(), package)
            self.assertEqual(ignore.resolve(), IGNORE_FILE.resolve(), package)

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            result = subprocess.run(
                ["stow", "--no", "--verbose", "--target", str(target), "zsh", "git-config", "pi"],
                cwd=REPO_ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            output = result.stdout + result.stderr
            self.assertNotIn(".zshenv.local.example", output)
            self.assertNotIn(".gitconfig.local.example", output)
            self.assertNotIn("settings.local.json.example", output)
            self.assertNotIn("slack-mcp.example.json", output)
            self.assertNotIn("extensions/node_modules", output)


if __name__ == "__main__":
    unittest.main()
