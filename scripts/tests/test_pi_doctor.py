"""Hermetic package-spec tests for scripts/pi-doctor.sh."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
DOCTOR = REPO_ROOT / "scripts" / "pi-doctor.sh"
GENERATOR = REPO_ROOT / "scripts" / "gen-pi-settings.sh"


class PiDoctorPackagePathsTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name) / "repo"
        scripts = self.root / "scripts"
        scripts.mkdir(parents=True)
        shutil.copy2(DOCTOR, scripts / DOCTOR.name)
        shutil.copy2(GENERATOR, scripts / GENERATOR.name)
        self.home = Path(self.tempdir.name) / "home"
        self.agent = self.home / ".pi" / "agent"
        self.agent.mkdir(parents=True)

    def tearDown(self):
        self.tempdir.cleanup()

    def write_settings(self, packages):
        (self.agent / "settings.json").write_text(
            json.dumps({"packages": packages}) + "\n", encoding="utf-8"
        )

    def run_doctor(self):
        env = os.environ.copy()
        env["HOME"] = str(self.home)
        return subprocess.run(
            ["/bin/bash", str(self.root / "scripts" / DOCTOR.name)],
            cwd=self.root,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_package_paths_accept_object_sources_and_skip_npm(self):
        package = self.agent / "packages" / "object-source"
        package.mkdir(parents=True)
        (package / "package.json").write_text('{"dependencies": {}}\n', encoding="utf-8")
        self.write_settings(
            [
                {"source": "packages/object-source", "skills": []},
                "npm:example@1.0.0",
                {"source": "npm:another-example@2.0.0", "skills": []},
            ]
        )

        result = self.run_doctor()

        self.assertIn(
            "PASS: PACKAGE PATHS: 'packages/object-source' dir present (no runtime deps)",
            result.stdout,
        )
        self.assertNotIn("directory missing for package 'npm:", result.stdout)

    def test_package_paths_reject_malformed_object_source(self):
        self.write_settings([{"skills": []}])

        result = self.run_doctor()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "FAIL: PACKAGE PATHS: invalid settings package spec — malformed package spec at packages[0]: object source must be a non-empty string",
            result.stdout,
        )


if __name__ == "__main__":
    unittest.main()
