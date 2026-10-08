"""Resolution of the installed pi SDK and its dependencies (scripts/lib/pi-sdk.sh)."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

LIB = Path(__file__).resolve().parents[2] / "scripts" / "lib" / "pi-sdk.sh"


def resolve(env, *deps):
    script = 'source "$1"; shift; s=$(pi_sdk_dir) || exit 3; echo "$s"; for d in "$@"; do pi_sdk_dep "$s" "$d" || echo MISSING; done'
    return subprocess.run(["/bin/bash", "-c", script, "-", str(LIB), *deps],
                          env=env, capture_output=True, text=True)


class PiSdkTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = {"PATH": "/usr/bin:/bin", "HOME": str(self.root / "home")}

    def tearDown(self):
        self.tmp.cleanup()

    def touch_pkg(self, path):
        path.mkdir(parents=True)
        (path / "package.json").write_text("{}")

    def test_managed_install_with_hoisted_dependencies(self):
        agent = self.root / "agent"
        modules = agent / "install/releases/9.9.9/node_modules"
        self.touch_pkg(modules / "@earendil-works/pi-coding-agent")
        self.touch_pkg(modules / "jiti")
        (agent / "install").mkdir(exist_ok=True)
        (agent / "install/current-version").write_text("9.9.9\n")
        result = resolve({**self.env, "PI_CODING_AGENT_DIR": str(agent)}, "jiti", "typebox")
        lines = result.stdout.split()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(lines[0], str(modules / "@earendil-works/pi-coding-agent"))
        self.assertEqual(Path(lines[1]).resolve(), (modules / "jiti").resolve())
        self.assertEqual(lines[2], "MISSING")

    def test_override_with_nested_dependencies(self):
        sdk = self.root / "global/@earendil-works/pi-coding-agent"
        self.touch_pkg(sdk)
        self.touch_pkg(sdk / "node_modules/jiti")
        result = resolve({**self.env, "PI_SDK_DIR": str(sdk)}, "jiti")
        self.assertEqual(result.stdout.split(), [str(sdk), str(sdk / "node_modules/jiti")])

    def test_rejects_path_like_managed_version(self):
        agent = self.root / "agent"
        (agent / "install").mkdir(parents=True)
        (agent / "install/current-version").write_text("../evil\n")
        result = resolve({**self.env, "PI_CODING_AGENT_DIR": str(agent)})
        self.assertEqual(result.returncode, 3)


if __name__ == "__main__":
    unittest.main()
