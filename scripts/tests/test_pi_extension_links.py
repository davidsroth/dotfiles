"""Hermetic tests for the read-only Pi extension runtime-link check."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
CHECKER = REPO_ROOT / "scripts" / "check-pi-extension-links.sh"


class PiExtensionLinksTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name) / "repo"
        (self.root / "scripts").mkdir(parents=True)
        shutil.copy2(CHECKER, self.root / "scripts" / CHECKER.name)
        self.source = self.root / "pi/.pi/agent/extensions/example/index.ts"
        self.source.parent.mkdir(parents=True)
        self.source.write_text("export default () => {};\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True)
        self.runtime = Path(self.tempdir.name) / "home/.pi/agent/extensions"

    def tearDown(self):
        self.tempdir.cleanup()

    def run_checker(self):
        env = os.environ.copy()
        env["PI_EXTENSIONS_RUNTIME_DIR"] = str(self.runtime)
        return subprocess.run(
            ["/bin/bash", str(self.root / "scripts" / CHECKER.name)],
            cwd=self.root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_skips_a_runtime_that_has_not_been_deployed(self):
        result = self.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("not deployed; skipping", result.stdout)

    def test_rejects_a_tracked_module_missing_from_existing_runtime(self):
        self.runtime.mkdir(parents=True)
        result = self.run_checker()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing tracked module", result.stderr)
        self.assertIn("example/index.ts", result.stderr)

    def test_accepts_a_stowed_module_link(self):
        runtime_module = self.runtime / "example/index.ts"
        runtime_module.parent.mkdir(parents=True)
        runtime_module.symlink_to(self.source)
        result = self.run_checker()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("1 tracked extension module(s) are linked", result.stdout)

    def test_rejects_an_unlinked_runtime_copy(self):
        runtime_module = self.runtime / "example/index.ts"
        runtime_module.parent.mkdir(parents=True)
        shutil.copy2(self.source, runtime_module)
        result = self.run_checker()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("present but not linked", result.stderr)


if __name__ == "__main__":
    unittest.main()
