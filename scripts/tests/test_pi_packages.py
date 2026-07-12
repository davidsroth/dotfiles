"""Hermetic inventory tests for scripts/pi-packages.sh."""

import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO_ROOT = Path(__file__).resolve().parents[2]
RUNNER = REPO_ROOT / "scripts" / "pi-packages.sh"


class PiPackagesTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name) / "repo"
        (self.root / "scripts").mkdir(parents=True)
        shutil.copy2(RUNNER, self.root / "scripts" / RUNNER.name)
        (self.root / "pi" / ".pi" / "agent" / "extensions").mkdir(parents=True)
        self.write_json("pi/.pi/agent/extensions/package.json", {"name": "extensions"})
        self.write_json("pi/.pi/agent/extensions/package-lock.json", {"lockfileVersion": 3})

    def tearDown(self):
        self.tempdir.cleanup()

    def write_json(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) + "\n", encoding="utf-8")

    def configure(self, *names):
        packages = [f"../../dotfiles/pi/packages/{name}" for name in names]
        self.write_json("pi/.pi/agent/settings.base.json", {"packages": packages})
        for name in names:
            self.write_json(f"pi/packages/{name}/package.json", {"name": name})
            self.write_json(
                f"pi/packages/{name}/package-lock.json", {"lockfileVersion": 3}
            )

    def run_runner(self, action):
        return subprocess.run(
            ["/bin/bash", str(self.root / "scripts" / RUNNER.name), action],
            cwd=self.root,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_verify_accepts_exact_configured_inventory(self):
        self.configure("one", "two")
        result = self.run_runner("verify")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("2 local packages", result.stdout)

    def test_verify_rejects_missing_lockfile(self):
        self.configure("one")
        (self.root / "pi/packages/one/package-lock.json").unlink()
        result = self.run_runner("verify")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing tracked lockfile", result.stderr)

    def test_verify_rejects_unconfigured_package_directory(self):
        self.configure("one")
        self.write_json("pi/packages/orphan/package.json", {"name": "orphan"})
        self.write_json("pi/packages/orphan/package-lock.json", {"lockfileVersion": 3})
        result = self.run_runner("verify")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Unconfigured Pi package directory", result.stderr)


if __name__ == "__main__":
    unittest.main()
