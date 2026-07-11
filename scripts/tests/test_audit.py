"""Tests for the tracked-file repository audit."""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO_ROOT = Path(__file__).resolve().parents[2]
AUDIT_SCRIPT = REPO_ROOT / "scripts" / "audit.sh"


class AuditTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name) / "repo"
        (self.root / "scripts").mkdir(parents=True)
        shutil.copy2(AUDIT_SCRIPT, self.root / "scripts" / "audit.sh")
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)

    def tearDown(self):
        self.tempdir.cleanup()

    def write(self, relative_path, content):
        path = self.root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def track(self, *paths):
        subprocess.run(["git", "-C", str(self.root), "add", "--", *paths], check=True)

    def run_audit(self):
        return subprocess.run(
            ["/bin/bash", str(self.root / "scripts" / "audit.sh")],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_ignores_untracked_and_node_modules_state(self):
        self.write("valid.json", '{"ok": true}\n')
        self.write("untracked.json", "{invalid\n")
        self.write(".gitignore", "ignored.json\n")
        self.write("ignored.json", "{invalid\n")
        self.write("cache/node_modules/tracked-but-generated.json", "{invalid\n")
        self.track("valid.json", ".gitignore")
        subprocess.run(
            [
                "git",
                "-C",
                str(self.root),
                "add",
                "-f",
                "--",
                "cache/node_modules/tracked-but-generated.json",
            ],
            check=True,
        )

        result = self.run_audit()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Audit passed", result.stdout)

    def test_fails_cleanly_for_missing_tracked_file(self):
        self.write("deleted.json", '{"ok": true}\n')
        self.track("deleted.json")
        (self.root / "deleted.json").unlink()

        result = self.run_audit()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            "tracked path missing from working tree: deleted.json", result.stderr
        )
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("FileNotFoundError", result.stderr)

    def test_fails_for_invalid_tracked_json(self):
        self.write("broken.json", "{invalid\n")
        self.track("broken.json")

        result = self.run_audit()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("JSON syntax: broken.json", result.stderr)

    def test_fails_for_invalid_tracked_shell(self):
        self.write("broken.sh", "#!/usr/bin/env bash\nif then\n")
        self.track("broken.sh")

        result = self.run_audit()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bash syntax: broken.sh", result.stderr)


if __name__ == "__main__":
    unittest.main()
