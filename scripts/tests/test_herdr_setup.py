"""Hermetic tests for the Herdr setup version preflight."""

import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
PREFLIGHT = REPO_ROOT / "scripts" / "require-herdr-version.sh"


class HerdrSetupPreflightTest(unittest.TestCase):
    def run_preflight(self, version_output: str):
        with tempfile.TemporaryDirectory() as tmp:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            herdr = bin_dir / "herdr"
            herdr.write_text(
                "#!/usr/bin/env bash\n"
                "if [[ \"${1:-}\" == \"--version\" ]]; then\n"
                f"  printf '%s\\n' {version_output!r}\n"
                "fi\n",
                encoding="utf-8",
            )
            herdr.chmod(herdr.stat().st_mode | stat.S_IXUSR)
            env = os.environ.copy()
            # Inside a Herdr pane this points at the real binary, bypassing the stub.
            env.pop("HERDR_BIN_PATH", None)
            env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
            return subprocess.run(
                ["bash", str(PREFLIGHT)],
                cwd=REPO_ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

    def test_accepts_minimum_version_and_preview_builds(self):
        for version in ("herdr 0.9.2", "herdr 0.9.5", "herdr 0.10.0", "herdr 1.0.0", "herdr 0.9.2-preview.2026-09-29"):
            with self.subTest(version=version):
                result = self.run_preflight(version)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_unsupported_version(self):
        for version in ("herdr 0.9.1", "herdr 0.8.2-preview.2026-08-19", "herdr 0.7.9"):
            with self.subTest(version=version):
                result = self.run_preflight(version)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("0.9.2 or newer is required", result.stderr)

    @unittest.skipUnless(shutil.which("just"), "just is not installed")
    def test_setup_rejects_unsupported_version_before_linking_plugins(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            call_log = root / "calls.log"
            herdr = bin_dir / "herdr"
            herdr.write_text(
                "#!/usr/bin/env bash\n"
                "if [[ \"${1:-}\" == \"--version\" ]]; then\n"
                "  echo 'herdr 0.7.9'\n"
                "else\n"
                "  printf '%s\\n' \"$*\" >> \"$CALL_LOG\"\n"
                "fi\n",
                encoding="utf-8",
            )
            herdr.chmod(herdr.stat().st_mode | stat.S_IXUSR)
            env = os.environ.copy()
            env.pop("HERDR_BIN_PATH", None)
            env.update(
                {
                    "PATH": f"{bin_dir}{os.pathsep}{env['PATH']}",
                    "CALL_LOG": str(call_log),
                }
            )
            result = subprocess.run(
                ["just", "herdr-setup"],
                cwd=REPO_ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("0.9.2 or newer is required", result.stderr)
            self.assertFalse(call_log.exists(), call_log.read_text() if call_log.exists() else "")

    def test_rejects_unparseable_version_safely(self):
        result = self.run_preflight("herdr development build")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not parse version", result.stderr)


if __name__ == "__main__":
    unittest.main()
