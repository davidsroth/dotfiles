"""Hermetic tests for the version-gated Herdr Pi integration patcher."""

from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
from io import StringIO
from pathlib import Path
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[4]
PATCHER_PATH = REPO_ROOT / "core/.config/herdr/bin/apply-herdr-pi-state-patch.py"
FIXTURE_PATH = REPO_ROOT / "core/.config/herdr/patches/herdr-agent-state-v9.ts"
FIXTURES_DIR = REPO_ROOT / "core/.config/herdr/tests/fixtures"
# Exact reviewed outputs of earlier patch revisions.
LEGACY_FIXTURE_PATHS = (
    FIXTURES_DIR / "herdr-agent-state-v8.legacy-patched.ts",
    FIXTURES_DIR / "herdr-agent-state-v8.patched.ts",
    FIXTURES_DIR / "herdr-agent-state-v9.r1-patched.ts",
)
# The v8 output exercises the version-header exemption for legacy files.
LEGACY_FIXTURE_PATH = LEGACY_FIXTURE_PATHS[1]
PATCH_PATH = REPO_ROOT / "core/.config/herdr/patches/herdr-pi-state-v9.patch"
SPEC = importlib.util.spec_from_file_location("herdr_pi_state_patcher", PATCHER_PATH)
assert SPEC and SPEC.loader
patcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patcher)


class HerdrPiStatePatcherTest(unittest.TestCase):
    def copy_fixture(self, directory: Path) -> Path:
        target = directory / "herdr-agent-state.ts"
        target.write_bytes(FIXTURE_PATH.read_bytes())
        return target

    def copy_legacy_fixture(self, directory: Path, source: Path = LEGACY_FIXTURE_PATH) -> Path:
        target = directory / "herdr-agent-state.ts"
        target.write_bytes(source.read_bytes())
        return target

    def test_v9_fixture_is_the_expected_unpatched_source(self):
        self.assertEqual(patcher.sha256(FIXTURE_PATH), patcher.BASE_SHA256)
        fixture = FIXTURE_PATH.read_text()
        self.assertIn("// HERDR_INTEGRATION_ID=pi", fixture)
        self.assertIn("// HERDR_INTEGRATION_VERSION=9", fixture)

    def test_legacy_fixtures_are_exact_migratable_sources(self):
        for source in LEGACY_FIXTURE_PATHS:
            with self.subTest(source=source.name):
                self.assertIn(patcher.sha256(source), patcher.LEGACY_PATCHED_SHA256S)
                self.assertIn("PATCHED_BY_DOTFILES_HERDR_PI_STATE", source.read_text())

    def test_applies_once_then_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = self.copy_fixture(Path(tmp))

            result = patcher.apply_patch(target, PATCH_PATH)

            self.assertTrue(result.startswith("applied (backup:"))
            self.assertEqual(patcher.sha256(target), patcher.PATCHED_SHA256)
            self.assertIn("PATCHED_BY_DOTFILES_HERDR_PI_STATE_V9", target.read_text())
            backups = list(Path(tmp).glob("*.pre-dotfiles-patch-*.bak"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(patcher.sha256(backups[0]), patcher.BASE_SHA256)

            self.assertEqual(patcher.apply_patch(target, PATCH_PATH), "already applied")
            self.assertEqual(len(list(Path(tmp).glob("*.pre-dotfiles-patch-*.bak"))), 1)

    def test_check_succeeds_only_for_exact_patched_source_without_mutating_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = self.copy_fixture(Path(tmp))
            stock = target.read_bytes()

            with self.assertRaisesRegex(ValueError, "stock Herdr Pi v9 integration"):
                patcher.check_patch(target)
            with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                self.assertEqual(patcher.main(["--check", "--target", str(target)]), 1)
            self.assertEqual(target.read_bytes(), stock)

            patcher.apply_patch(target, PATCH_PATH)
            patched = target.read_bytes()
            self.assertEqual(patcher.check_patch(target), "installed")
            output = StringIO()
            with redirect_stdout(output), redirect_stderr(StringIO()):
                self.assertEqual(patcher.main(["--check", "--target", str(target)]), 0)
            self.assertEqual(output.getvalue().strip(), "herdr-pi-state: installed")
            self.assertEqual(target.read_bytes(), patched)

    def test_check_reports_absent_and_mismatched_targets_without_mutating_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "herdr-agent-state.ts"
            with self.assertRaisesRegex(ValueError, "is absent.*just herdr-setup"):
                patcher.check_patch(target)

            target.write_text("export default () => {};\n")
            original = target.read_bytes()
            with self.assertRaisesRegex(ValueError, "not Herdr's managed Pi integration v9.*just herdr-setup"):
                patcher.check_patch(target)
            self.assertEqual(target.read_bytes(), original)

    def test_migrates_only_the_exact_legacy_patches(self):
        for source in LEGACY_FIXTURE_PATHS:
            with self.subTest(source=source.name), tempfile.TemporaryDirectory() as tmp:
                target = self.copy_legacy_fixture(Path(tmp), source)
                legacy = target.read_bytes()

                self.assertEqual(patcher.patch_status(target), "legacy")
                with self.assertRaisesRegex(ValueError, "legacy Herdr Pi patch; migration to v9 required.*just herdr-setup"):
                    patcher.check_patch(target)
                self.assertEqual(target.read_bytes(), legacy)

                result = patcher.apply_patch(target, PATCH_PATH)
                self.assertTrue(result.startswith("migrated legacy patch (backup:"))
                self.assertEqual(patcher.sha256(target), patcher.PATCHED_SHA256)
                self.assertIn("// HERDR_INTEGRATION_VERSION=9", target.read_text())
                self.assertEqual(patcher.check_patch(target), "installed")
                backups = list(Path(tmp).glob("*.pre-dotfiles-patch-*.bak"))
                self.assertEqual(len(backups), 1)
                self.assertEqual(backups[0].read_bytes(), legacy)

    def test_check_reports_legacy_migration_required_with_just_remediation(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = self.copy_legacy_fixture(Path(tmp))
            error = StringIO()

            with redirect_stdout(StringIO()), redirect_stderr(error):
                self.assertEqual(patcher.main(["--check", "--target", str(target)]), 1)

            self.assertIn("migration to v9 required", error.getvalue())
            self.assertIn("just herdr-setup", error.getvalue())
            self.assertNotIn("herdr integration install pi", error.getvalue())

    def test_refuses_altered_legacy_without_overwriting_or_backing_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = self.copy_legacy_fixture(Path(tmp))
            target.write_text(target.read_text() + "\n// locally altered\n")
            original = target.read_bytes()

            # An altered v8 file is unknown, so it must carry the v9 header.
            with self.assertRaisesRegex(ValueError, "not Herdr's managed Pi integration v9"):
                patcher.check_patch(target)
            with self.assertRaisesRegex(ValueError, "not Herdr's managed Pi integration v9"):
                patcher.apply_patch(target, PATCH_PATH)

            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(list(Path(tmp).glob("*.pre-dotfiles-patch-*.bak")), [])

    def test_refuses_altered_source_without_overwriting_or_backing_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = self.copy_fixture(Path(tmp))
            target.write_text(target.read_text() + "\n// locally altered\n")
            original = target.read_bytes()

            with self.assertRaisesRegex(ValueError, "does not match the reviewed Herdr Pi v9 patch.*just herdr-setup"):
                patcher.check_patch(target)
            self.assertEqual(target.read_bytes(), original)

            with self.assertRaisesRegex(ValueError, "does not match the reviewed Herdr Pi v9 patch"):
                patcher.apply_patch(target, PATCH_PATH)

            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(list(Path(tmp).glob("*.pre-dotfiles-patch-*.bak")), [])

    def test_refuses_wrong_managed_version_without_overwriting(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = self.copy_fixture(Path(tmp))
            target.write_text(target.read_text().replace("HERDR_INTEGRATION_VERSION=9", "HERDR_INTEGRATION_VERSION=10"))
            original = target.read_bytes()

            with self.assertRaisesRegex(ValueError, "not Herdr's managed Pi integration v9"):
                patcher.apply_patch(target, PATCH_PATH)

            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(list(Path(tmp).glob("*.pre-dotfiles-patch-*.bak")), [])

    def test_never_overwrites_an_unrecognized_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "herdr-agent-state.ts"
            target.write_text("export default () => {};\n")
            original = target.read_bytes()

            with self.assertRaisesRegex(ValueError, "not Herdr's managed Pi integration v9"):
                patcher.apply_patch(target, PATCH_PATH)

            self.assertEqual(target.read_bytes(), original)
            self.assertEqual(list(Path(tmp).glob("*.pre-dotfiles-patch-*.bak")), [])


if __name__ == "__main__":
    unittest.main()
