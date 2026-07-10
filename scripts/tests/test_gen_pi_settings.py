"""Hermetic tests for scripts/gen-pi-settings.sh."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "gen-pi-settings.sh"


class GenPiSettingsTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name) / "checkout in a custom location"
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "pi" / ".pi" / "agent").mkdir(parents=True)
        shutil.copy2(SCRIPT, self.root / "scripts" / SCRIPT.name)
        self.home = Path(self.tempdir.name) / "home"
        (self.home / ".pi" / "agent").mkdir(parents=True)

    def tearDown(self):
        self.tempdir.cleanup()

    @property
    def base_path(self):
        return self.root / "pi" / ".pi" / "agent" / "settings.base.json"

    @property
    def destination(self):
        return self.home / ".pi" / "agent" / "settings.json"

    def write_json(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")

    def run_generator(self, path=None):
        env = os.environ.copy()
        env["HOME"] = str(self.home)
        if path is not None:
            env["PATH"] = str(path)
        return subprocess.run(
            ["/bin/bash", str(self.root / "scripts" / SCRIPT.name), "--quiet"],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def base_settings(self):
        return {
            "theme": "tracked",
            "nested": {"base": True},
            "packages": [
                "../../dotfiles/pi/packages/pi-vim",
                "npm:pi-web-access",
                "/already/absolute",
            ],
        }

    def assert_merged_output(self):
        generated = json.loads(self.destination.read_text(encoding="utf-8"))
        self.assertEqual(generated["theme"], "tracked")
        self.assertEqual(generated["runtimeOnly"], 7)
        self.assertEqual(generated["defaultModel"], "local-model")
        self.assertEqual(generated["nested"], {"runtime": True, "base": True, "local": True})
        self.assertEqual(
            generated["packages"],
            [
                str(self.root / "pi" / "packages" / "pi-vim"),
                "npm:pi-web-access",
                "/already/absolute",
            ],
        )

    def prepare_merge_inputs(self, symlink_destination=False):
        base = self.base_settings()
        self.write_json(self.base_path, base)
        live = {"theme": "stale", "runtimeOnly": 7, "nested": {"runtime": True}}
        if symlink_destination:
            live_path = Path(self.tempdir.name) / "live-settings.json"
            self.write_json(live_path, live)
            self.destination.symlink_to(live_path)
        else:
            self.write_json(self.destination, live)
        self.write_json(
            self.home / ".pi" / "agent" / "settings.local.json",
            {"defaultModel": "local-model", "nested": {"local": True}},
        )
        return base

    def test_jq_merge_rewrites_packages_without_modifying_base(self):
        base = self.prepare_merge_inputs(symlink_destination=True)

        result = self.run_generator()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.destination.is_symlink())
        self.assert_merged_output()
        self.assertEqual(json.loads(self.base_path.read_text(encoding="utf-8")), base)

    def test_python_fallback_preserves_live_and_local_settings(self):
        self.prepare_merge_inputs()
        tool_bin = Path(self.tempdir.name) / "tools-without-jq"
        tool_bin.mkdir()
        tools = {
            "cat": shutil.which("cat"),
            "dirname": shutil.which("dirname"),
            "mkdir": shutil.which("mkdir"),
            "mktemp": shutil.which("mktemp"),
            "mv": shutil.which("mv"),
            "python3": sys.executable,
            "rm": shutil.which("rm"),
        }
        for name, target in tools.items():
            self.assertIsNotNone(target, name)
            (tool_bin / name).symlink_to(target)

        result = self.run_generator(tool_bin)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_merged_output()


if __name__ == "__main__":
    unittest.main()
