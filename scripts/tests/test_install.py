"""Hermetic tests for install.sh bootstrap behavior.

The installer is sourced in short-lived Bash processes so these tests exercise
its real functions without changing the developer machine.
"""

import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
INSTALL_SH = REPO_ROOT / "install.sh"


class InstallScriptTests(unittest.TestCase):
    def run_bash(self, body, *, env=None, check=False):
        merged_env = os.environ.copy()
        if env:
            merged_env.update({key: str(value) for key, value in env.items()})
        result = subprocess.run(
            ["bash", "-c", f"source {shlex.quote(str(INSTALL_SH))}\n{body}"],
            cwd=REPO_ROOT,
            env=merged_env,
            text=True,
            capture_output=True,
            check=False,
        )
        if check and result.returncode:
            self.fail(
                f"bash failed ({result.returncode})\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            )
        return result

    @staticmethod
    def write_executable(path, content):
        path.write_text("#!/usr/bin/env bash\n" + content)
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def test_sourcing_does_not_run_main(self):
        result = self.run_bash('declare -F main >/dev/null && printf "sourced\\n"', check=True)
        self.assertEqual(result.stdout, "sourced\n")
        self.assertEqual(result.stderr, "")

    def test_default_repository_matches_documented_clone_url(self):
        result = self.run_bash('printf "%s\\n" "$GITHUB_REPO"', check=True)
        repo_url = result.stdout.strip()
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")

        self.assertEqual(repo_url, "https://github.com/davidsroth/dotfiles.git")
        self.assertIn(f"git clone {repo_url} ~/dotfiles", readme)

    def test_downloaded_installers_use_mktemp_paths(self):
        source = INSTALL_SH.read_text(encoding="utf-8")
        self.assertNotIn('homebrew-install-$$', source)
        self.assertNotIn('nvm-install-$$', source)
        self.assertNotIn('tlink-install-$$', source)
        self.assertNotIn('FiraCodeNerdFont-$$', source)
        for prefix in (
            "homebrew-install.XXXXXX",
            "nvm-install.XXXXXX",
            "tlink-install.XXXXXX",
            "FiraCodeNerdFont.XXXXXX",
        ):
            self.assertIn(prefix, source)

        self.assertNotIn("Homebrew/install/HEAD/install.sh", source)
        self.assertNotIn("ahnopologetic/tlink/main/install.sh", source)
        for constant in (
            "HOMEBREW_INSTALL_COMMIT",
            "NVM_INSTALL_COMMIT",
            "TLINK_INSTALL_COMMIT",
        ):
            match = re.search(rf'{constant}="([0-9a-f]{{40}})"', source)
            self.assertIsNotNone(match, f"{constant} must be a full Git commit")

    def test_current_neovim_release_assets_are_arch_specific(self):
        result = self.run_bash(
            """
            nvim_release_asset tarball x86_64
            nvim_release_asset tarball arm64
            nvim_release_asset appimage amd64
            nvim_release_asset appimage aarch64
            """,
            check=True,
        )
        self.assertEqual(
            result.stdout.splitlines(),
            [
                "nvim-linux-x86_64.tar.gz",
                "nvim-linux-arm64.tar.gz",
                "nvim-linux-x86_64.appimage",
                "nvim-linux-arm64.appimage",
            ],
        )

    def test_pinned_neovim_assets_have_reviewed_checksums(self):
        result = self.run_bash(
            """
            nvim_release_sha256 tarball arm64 v0.12.4
            nvim_release_sha256 tarball x86_64 v0.12.4
            nvim_release_sha256 appimage arm64 v0.12.4
            nvim_release_sha256 appimage x86_64 v0.12.4
            """,
            check=True,
        )
        self.assertEqual(len(result.stdout.splitlines()), 4)
        self.assertTrue(all(len(value) == 64 for value in result.stdout.splitlines()))
        unreviewed = self.run_bash("nvim_release_sha256 tarball arm64 v9.9.9")
        self.assertNotEqual(unreviewed.returncode, 0)

    def test_neovim_asset_rejects_unsupported_arch_and_method(self):
        result = self.run_bash(
            "nvim_release_asset tarball riscv64 || nvim_release_asset zip x86_64"
        )
        self.assertNotEqual(result.returncode, 0)

    def test_neovim_config_and_binary_versions_are_validated(self):
        with tempfile.TemporaryDirectory() as tempdir:
            fake_nvim = Path(tempdir) / "nvim"
            self.write_executable(fake_nvim, 'echo "NVIM v0.10.3"\n')
            good = self.run_bash(
                f"validate_nvim_config && validate_nvim_binary {shlex.quote(str(fake_nvim))}",
                env={"NVIM_MIN_VERSION": "0.10.0", "NVIM_VERSION_TAG": "v0.10.3"},
            )
            self.assertEqual(good.returncode, 0, good.stderr)
            self.assertEqual(good.stdout.strip(), "0.10.3")

            too_old = self.run_bash(
                f"validate_nvim_binary {shlex.quote(str(fake_nvim))}",
                env={"NVIM_MIN_VERSION": "0.11.0"},
            )
            self.assertNotEqual(too_old.returncode, 0)
            self.assertIn("older than required", too_old.stderr)

            wrong_tag = self.run_bash(
                f"validate_nvim_binary {shlex.quote(str(fake_nvim))}",
                env={"NVIM_VERSION_TAG": "v0.10.4"},
            )
            self.assertNotEqual(wrong_tag.returncode, 0)
            self.assertIn("does not match requested", wrong_tag.stderr)

            bad_method = self.run_bash(
                "validate_nvim_config", env={"NVIM_METHOD": "zip"}
            )
            self.assertNotEqual(bad_method.returncode, 0)
            self.assertIn("Unsupported NVIM_METHOD", bad_method.stderr)

    def test_dry_run_is_non_mutating_on_linux_and_macos(self):
        for ostype in ("linux-gnu", "darwin23"):
            with self.subTest(ostype=ostype), tempfile.TemporaryDirectory() as tempdir:
                root = Path(tempdir)
                home = root / "home"
                tmp = root / "tmp"
                bin_dir = root / "bin"
                home.mkdir()
                tmp.mkdir()
                bin_dir.mkdir()
                mutation_log = root / "mutations"
                forbidden = """printf '%s %s\\n' "$0" "$*" >> "$MUTATION_LOG"
exit 97
"""
                for command in ("sudo", "curl", "brew", "apt-get", "git", "stow", "npm", "defaults"):
                    self.write_executable(bin_dir / command, forbidden)
                # Platform probing may read xcode-select -p; only installation is forbidden.
                self.write_executable(
                    bin_dir / "xcode-select",
                    """if [[ "${1:-}" == "-p" ]]; then exit 0; fi
printf '%s %s\\n' "$0" "$*" >> "$MUTATION_LOG"
exit 97
""",
                )
                env = os.environ.copy()
                env.update(
                    {
                        "OSTYPE": ostype,
                        "DOTFILES_DIR": str(root / "not-cloned-yet"),
                        "HOME": str(home),
                        "TMPDIR": str(tmp),
                        "MUTATION_LOG": str(mutation_log),
                        "PATH": f"{bin_dir}{os.pathsep}{env['PATH']}",
                        "SHELL": "/bin/bash",
                        "TERM": "dumb",
                    }
                )
                result = subprocess.run(
                    ["bash", str(INSTALL_SH), "--dry-run"],
                    cwd=REPO_ROOT,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertFalse(mutation_log.exists(), mutation_log.read_text() if mutation_log.exists() else "")
                self.assertEqual(list(home.iterdir()), [])
                self.assertEqual(list(tmp.iterdir()), [])
                self.assertIn("no log file or system changes", result.stdout)

    def test_node_and_pi_are_installed_and_validated_through_nvm(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            nvm_dir = root / ".nvm"
            nvm_dir.mkdir()
            call_log = root / "calls.log"
            pi_state = root / "pi-version"
            (nvm_dir / "nvm.sh").write_text(
                """nvm() { { printf 'nvm'; printf ' <%s>' \"$@\"; printf '\\n'; } >> \"$CALL_LOG\"; }
node() { echo v22.99.0; }
npm() {
  { printf 'npm'; printf ' <%s>' \"$@\"; printf '\\n'; } >> \"$CALL_LOG\"
  if [[ \"${1:-}\" == \"--version\" ]]; then echo 10.9.0; return; fi
  printf '%s' \"$PI_VERSION\" > \"$PI_STATE\"
}
pi() { [[ -f \"$PI_STATE\" ]] || return 127; cat \"$PI_STATE\"; }
""",
                encoding="utf-8",
            )
            result = self.run_bash(
                "install_node_and_pi",
                env={
                    "HOME": root,
                    "NVM_DIR": nvm_dir,
                    "NODE_VERSION": "22",
                    "PI_VERSION": "0.80.6",
                    "CALL_LOG": call_log,
                    "PI_STATE": pi_state,
                },
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            calls = call_log.read_text(encoding="utf-8")
            self.assertIn("nvm <install> <22>", calls)
            self.assertIn("nvm <alias> <default> <22>", calls)
            self.assertIn("nvm <use> <22>", calls)
            self.assertIn(
                "npm <install> <-g> <--no-audit> <--no-fund> "
                "<@earendil-works/pi-coding-agent@0.80.6>",
                calls,
            )
            self.assertIn("Validated Pi 0.80.6", result.stdout)

    def test_node_and_pi_setup_fails_without_nvm_runtime(self):
        with tempfile.TemporaryDirectory() as tempdir:
            result = self.run_bash(
                "install_node_and_pi", env={"HOME": tempdir, "NVM_DIR": tempdir}
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("nvm.sh is missing", result.stderr)

    def test_minimal_linux_dry_run_bootstraps_missing_curl(self):
        result = self.run_bash(
            """
            OSTYPE=linux-gnu
            DRY_RUN=true
            command() {
              if [[ "$1" == "-v" && "$2" == "curl" ]]; then return 1; fi
              if [[ "$1" == "-v" && "$2" == "apt-get" ]]; then return 0; fi
              builtin command "$@"
            }
            check_platform
            printf 'family=%s manager=%s packages=' "$OS_FAMILY" "$LINUX_PKG_MGR"
            printf '%s,' "${STOW_PACKAGES[@]}"
            printf '\\n'
            """,
            check=True,
        )
        self.assertIn("Would install bootstrap prerequisites", result.stdout)
        self.assertIn("family=linux manager=apt packages=core,zsh,git-config,pi,linux,", result.stdout)

    def test_linux_package_set_includes_fontconfig(self):
        with tempfile.TemporaryDirectory() as tempdir:
            apt_log = Path(tempdir) / "apt.log"
            result = self.run_bash(
                """
                OS_FAMILY=linux
                LINUX_PKG_MGR=apt
                step() { :; }
                sudo() { "$@"; }
                apt-get() { printf '%s\\n' "$*" >> "$APT_LOG"; }
                apt-cache() { return 1; }
                ensure_user_local_bin_path() { :; }
                install_modern_neovim_linux() { :; }
                install_linux_packages
                """,
                env={"APT_LOG": apt_log, "HOME": tempdir},
                check=True,
            )
            self.assertIn("fontconfig", apt_log.read_text())
            self.assertIn("Apt package installation completed", result.stdout)

    def test_selected_neovim_failure_propagates_from_linux_package_install(self):
        with tempfile.TemporaryDirectory() as tempdir:
            result = self.run_bash(
                """
                OS_FAMILY=linux
                LINUX_PKG_MGR=apt
                step() { :; }
                sudo() { "$@"; }
                apt-get() { :; }
                apt-cache() { return 1; }
                ensure_user_local_bin_path() { :; }
                install_modern_neovim_linux() { return 29; }
                install_linux_packages
                """,
                env={"HOME": tempdir},
            )
            self.assertNotEqual(result.returncode, 0)

    def test_font_install_refreshes_and_validates_font_cache(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            bin_dir = root / "bin"
            home = root / "home"
            bin_dir.mkdir()
            home.mkdir()
            state = root / "fc-list-count"
            cache_log = root / "cache-log"
            self.write_executable(
                bin_dir / "fc-list",
                """count=0
[[ -f "$FC_STATE" ]] && count=$(cat "$FC_STATE")
count=$((count + 1)); printf '%s' "$count" > "$FC_STATE"
[[ $count -gt 1 ]] && echo 'FiraCode Nerd Font'
""",
            )
            self.write_executable(bin_dir / "fc-cache", 'echo "$*" >> "$CACHE_LOG"\n')
            self.write_executable(
                bin_dir / "curl",
                """while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then shift; : > "$1"; fi
  shift
done
""",
            )
            self.write_executable(bin_dir / "unzip", 'mkdir -p "${@: -1}"\n')
            result = self.run_bash(
                "OS_FAMILY=linux; step() { :; }; verify_sha256() { :; }; install_fira_code_nerd_font",
                env={
                    "HOME": home,
                    "TMPDIR": root,
                    "FC_STATE": state,
                    "CACHE_LOG": cache_log,
                    "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                },
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(cache_log.exists())
            self.assertIn("installed and font cache validated", result.stdout)

    def test_pi_runtime_dependencies_delegate_to_package_runner(self):
        with tempfile.TemporaryDirectory() as tempdir:
            repo = Path(tempdir) / "repo"
            runner = repo / "scripts" / "pi-packages.sh"
            runner.parent.mkdir(parents=True)
            call_log = Path(tempdir) / "runner.log"
            self.write_executable(runner, 'printf "%s\\n" "$*" >> "$RUNNER_LOG"\n')

            result = self.run_bash(
                "install_pi_package_deps; install_pi_package_deps",
                env={"DOTFILES_DIR": repo, "RUNNER_LOG": call_log},
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(call_log.read_text().splitlines(), ["install-runtime", "install-runtime"])

    def test_pi_memory_setup_restricts_private_runtime_paths(self):
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            repo = root / "repo"
            source_dir = repo / "pi" / ".pi" / "agent" / "memory"
            source_dir.mkdir(parents=True)
            (source_dir / "MEMORY.md").write_text("# Shared memory\n", encoding="utf-8")
            home = root / "home"
            private_dir = home / ".pi" / "agent" / "memory"
            daily_dir = private_dir / "daily"
            daily_dir.mkdir(parents=True)
            local_memory = private_dir / "MEMORY.local.md"
            daily = daily_dir / "2026-07-11.md"
            local_memory.write_text("private\n", encoding="utf-8")
            daily.write_text("private daily\n", encoding="utf-8")
            private_dir.chmod(0o755)
            daily_dir.chmod(0o755)
            local_memory.chmod(0o644)
            daily.chmod(0o644)

            result = self.run_bash(
                "setup_pi_memory", env={"DOTFILES_DIR": repo, "HOME": home}
            )

            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(stat.S_IMODE(private_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(daily_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(local_memory.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(daily.stat().st_mode), 0o600)
            self.assertTrue((private_dir / "MEMORY.md").is_symlink())

    def test_required_pi_failures_are_not_suppressed(self):
        with tempfile.TemporaryDirectory() as tempdir:
            repo = Path(tempdir) / "repo"
            runner = repo / "scripts" / "pi-packages.sh"
            runner.parent.mkdir(parents=True)
            self.write_executable(runner, "exit 23\n")
            npm_failure = self.run_bash(
                "install_pi_package_deps", env={"DOTFILES_DIR": repo}
            )
            self.assertNotEqual(npm_failure.returncode, 0)
            self.assertIn("Locked Pi runtime dependency installation failed", npm_failure.stderr)

            for function, expected in (
                ("setup_pi_settings", "settings generator is missing"),
                ("setup_pi_memory", "memory file is missing"),
                ("setup_git_hooks", "hooks directory is missing"),
            ):
                with self.subTest(function=function):
                    result = self.run_bash(f"{function}", env={"DOTFILES_DIR": repo})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(expected, result.stderr)


if __name__ == "__main__":
    unittest.main()
