"""Bundle composition tests; no network, installs, or access to live credentials."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("bundle", ROOT / "scripts/package-pi-windows.py")
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class WindowsBundleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name)
        cls.settings = cls.base / "settings.json"
        bundle.json_write(cls.settings, {
            "theme": "catppuccin-mocha", "defaultProvider": "openai-codex",
            "defaultModel": "test-model", "shellPath": "/mac-only/zsh",
            "httpProxy": "must-not-transfer", "sessionDir": "/private/sessions",
            "packages": ["/private/package", "npm:pi-mcp-adapter@2.26.0",
                         {"source": "npm:pi-web-access@0.13.0", "skills": []}],
            "extensions": ["/private/custom.ts"], "skills": ["/private/skills"],
        })
        cls.pi = cls.base / "pi.json"
        bundle.json_write(cls.pi, {"name": "@earendil-works/pi-coding-agent", "version": "0.85.1",
                                   "bin": {"pi": "dist/bundle/cli.js"}})
        cls.out = cls.base / "output"
        cls.metadata = bundle.build(cls.out, cls.settings, cls.pi)
        bundle.write_checksums(cls.out)
        cls.agent = cls.out / "agent"

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_settings_allowlist_and_relative_packages(self):
        settings = json.loads((self.agent / "settings.json").read_text())
        self.assertNotIn("must-not-transfer", json.dumps(settings))
        for key in ("shellPath", "httpProxy", "sessionDir", "extensions", "skills"):
            self.assertNotIn(key, settings)
        self.assertIn("powershell", settings["defaultTools"])
        for package in settings["packages"]:
            if isinstance(package, str):
                self.assertTrue((self.agent / package).is_dir())
        self.assertNotIn("./packages/pi-intercom", settings["packages"])
        self.assertFalse(self.metadata["mcpIncluded"])
        self.assertEqual(self.metadata["npmPackages"], ["pi-web-access@0.13.0"])

    def test_no_private_state_symlinks_or_mcp(self):
        forbidden = {"auth.json", "models.json", "models-store.json", "trust.json", "sessions",
                     "node_modules", "MEMORY.local.md", "slack-mcp", "sunsama-mcp", "mcp.json"}
        for path in self.out.rglob("*"):
            self.assertFalse(path.is_symlink(), path)
            self.assertFalse(forbidden.intersection(path.relative_to(self.out).parts), path)
        self.assertNotIn("Primary shell: zsh", (self.agent / "memory/MEMORY.md").read_text())

    def test_package_entrypoints_and_dependency_locks(self):
        for name in bundle.PACKAGES:
            directory = self.agent / "packages" / name
            manifest = json.loads((directory / "package.json").read_text())
            for entry in manifest["pi"]["extensions"]:
                self.assertTrue((directory / entry).is_file(), (name, entry))
            if manifest.get("dependencies"):
                lock = json.loads((directory / "package-lock.json").read_text())
                self.assertEqual(lock["packages"][""]["dependencies"], manifest["dependencies"])

    def test_unsupported_extensions_are_not_discovered(self):
        self.assertEqual({p.name for p in (self.agent / "extensions").iterdir()},
                         set(bundle.EXTENSIONS) | {"_shared"})
        plan = json.loads((self.agent / "packages/pi-plan-review/package.json").read_text())
        self.assertEqual(plan["pi"]["extensions"], ["./extensions/miniplan/index.ts"])
        self.assertTrue((self.out / "disabled/packages/pi-intercom-tailnet/index.ts").exists())

    def test_windows_instructions_and_secret_guard(self):
        instructions = (self.agent / "AGENTS.md").read_text()
        self.assertIn("native Windows", instructions)
        self.assertNotIn("Apple Silicon", instructions)
        self.assertNotIn("review in tmux", instructions)
        guard = json.loads((self.agent / "secret-guard.json").read_text())
        self.assertIn("powershell", guard["blockTools"])

    def test_checksums_cover_every_payload_file(self):
        checksums = json.loads((self.out / "checksums.json").read_text())
        actual = {p.relative_to(self.out).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in self.out.rglob("*") if p.is_file() and p.name != "checksums.json"}
        self.assertEqual(checksums, actual)

    def test_archive_has_one_safe_root_and_no_symlinks(self):
        output = self.base / "bundle.zip"
        bundle.archive(self.out, output)
        with zipfile.ZipFile(output) as z:
            self.assertIsNone(z.testzip())
            for item in z.infolist():
                self.assertTrue(item.filename.startswith("pi-windows/"))
                self.assertNotIn("..", Path(item.filename).parts)
                self.assertNotEqual((item.external_attr >> 16) & 0o170000, 0o120000)

    def test_source_symlinks_fail_closed(self):
        source = self.base / "unexpected-link"
        source.symlink_to(self.settings)
        with self.assertRaisesRegex(ValueError, "Unexpected source symlink"):
            bundle.copy_file(source, self.base / "should-not-exist", self.base)

    def test_symlinked_parent_fails_closed(self):
        with tempfile.TemporaryDirectory() as outside:
            external = Path(outside)
            (external / "source.ts").write_text("not an approved source")
            source = self.base / "linked-parent"
            source.symlink_to(external, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "Unexpected source symlink"):
                bundle.copy_file(source / "source.ts", self.base / "should-not-exist", self.base)


if __name__ == "__main__":
    unittest.main()
