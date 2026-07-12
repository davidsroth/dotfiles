"""Reproducibility test for the generated macOS keyboard layout."""

from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = REPO_ROOT / "macos" / "keyboard-layouts"


class KeyboardLayoutTest(unittest.TestCase):
    def test_committed_layout_matches_generator(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            generator = root / "gen-us-nooption.py"
            layout = root / "US-NoOption.keylayout"
            shutil.copy2(SOURCE_DIR / generator.name, generator)
            shutil.copy2(SOURCE_DIR / layout.name, layout)
            expected = layout.read_bytes()

            result = subprocess.run(
                ["python3", str(generator)],
                cwd=root,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(layout.read_bytes(), expected)


if __name__ == "__main__":
    unittest.main()
