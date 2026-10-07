#!/usr/bin/env python3
"""Build a credential-free native Windows Pi bundle from explicit source roots."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "scripts/windows-pi"
PACKAGES = (
    "pi-vim", "pi-subagents", "pi-aside", "pi-intercom", "pi-qna",
    "pi-plan-review", "pi-memory", "pi-session-recall",
)
EXTENSIONS = (
    "bordered-editor.ts", "clear.ts", "cp.ts", "custom-footer.ts", "recap.ts",
    "resource-tokens.ts", "secret-guard.ts", "session-name.ts", "zz-send-rewind.ts",
)
# Packages whose canonical source is its own git repo rather than this tree. Their
# checkout is located from the live settings' git: source (pi installs git packages
# under <agent>/git/<host>/<path>), so private repo URLs stay out of this repo.
EXTERNAL_PACKAGES = (
    "pi-vim", "pi-aside", "pi-intercom", "pi-qna",
    "pi-plan-review", "pi-memory", "pi-session-recall",
)
DISABLED = ("advisor.ts", "agent-browser.ts", "azure-foundry.ts", "openrouter.ts",
            "pi-notification.ts", "pi-status.ts", "name-header")
SETTING_KEYS = (
    "defaultThinkingLevel", "theme", "hideThinkingBlock", "doubleEscapeAction",
    "treeFilterMode", "warnings", "defaultProvider", "defaultModel", "enabledModels",
    "steeringMode", "followUpMode", "compaction", "retry", "transport",
)


def json_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def copy_file(source, target, source_root=ROOT):
    # Check every component beneath the explicit source root, not just the file.
    relative = source.relative_to(source_root)
    cursor = source_root
    for part in relative.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ValueError(f"Unexpected source symlink: {cursor}")
    if not source.resolve().is_relative_to(source_root.resolve()):
        raise ValueError(f"Source escapes approved root: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def tracked_files(root):
    output = subprocess.check_output(["git", "-C", str(root), "ls-files", "-z"])
    return [Path(p.decode()) for p in output.split(b"\0") if p]


def package_target(agent, destination, name, rest):
    # No tests, build output, project-local agent resources, or dev patches.
    if any(p in {"node_modules", "dist", "test", "tests", ".pi", ".github", "patches"} for p in rest):
        return None
    if any(p.endswith((".test.ts", ".map")) for p in rest):
        return None
    base = agent / "packages" if name in PACKAGES else destination / "disabled/packages"
    return base / name / Path(*rest)


def external_package_roots(settings_path, agent_dir=None):
    """Map EXTERNAL_PACKAGES to the git checkouts pi installed for their settings sources."""
    agent_dir = agent_dir or settings_path.parent
    roots = {}
    for item in json.loads(settings_path.read_text()).get("packages", []):
        spec = item if isinstance(item, str) else item.get("source", "")
        if not spec.startswith("git:"):
            continue
        location = spec.removeprefix("git:").split("@", 2)
        # git:git@host:owner/repo@ref  or  git:host/owner/repo@ref
        if location[0] == "git" and len(location) > 1:
            host, _, path = location[1].partition(":")
        else:
            host, _, path = location[0].partition("/")
        path = path.removesuffix(".git")
        name = path.rsplit("/", 1)[-1]
        if name in EXTERNAL_PACKAGES:
            roots[name] = agent_dir / "git" / host / path
    return roots


def build(destination, settings_path, pi_package_path, root=ROOT, templates=TEMPLATES, package_roots=None):
    agent = destination / "agent"
    agent.mkdir(parents=True)
    package_roots = external_package_roots(settings_path) if package_roots is None else package_roots
    missing = [n for n in EXTERNAL_PACKAGES if n in PACKAGES and not (package_roots.get(n) and (package_roots[n] / ".git").exists())]
    if missing:
        raise ValueError(f"No installed git checkout for external package(s): {', '.join(missing)}")
    external_commits = {}
    for name, package_root in sorted(package_roots.items()):
        for rel in tracked_files(package_root):
            target = package_target(agent, destination, name, rel.parts)
            if target is not None:
                copy_file(package_root / rel, target, package_root)
        external_commits[name] = subprocess.check_output(
            ["git", "-C", str(package_root), "rev-parse", "HEAD"], text=True).strip()
    files = tracked_files(root)
    for rel in files:
        parts = rel.parts
        target = None
        if len(parts) >= 4 and parts[:2] == ("pi", "packages"):
            name = parts[2]
            if name in package_roots or name not in (*PACKAGES, "pi-intercom-tailnet"):
                continue
            target = package_target(agent, destination, name, parts[3:])
        elif len(parts) >= 5 and parts[:4] == ("pi", ".pi", "agent", "extensions"):
            name = parts[4]
            if name in (*EXTENSIONS, "_shared"):
                target = agent / "extensions" / Path(*parts[4:])
            elif name in DISABLED:
                target = destination / "disabled/extensions" / Path(*parts[4:])
        elif len(parts) >= 5 and parts[:3] == ("pi", ".pi", "agent") and parts[3] in {"agents", "themes"}:
            target = agent / Path(*parts[3:])
        elif parts[:3] == (".agent", "skills", "atomic-commits"):
            target = agent / "skills" / Path(*parts[2:])
        if target is not None:
            copy_file(root / rel, target, root)

    for name in ("keybindings.json", "secret-guard.json"):
        copy_file(root / "pi/.pi/agent" / name, agent / name, root)
    guard_path = agent / "secret-guard.json"
    guard = json.loads(guard_path.read_text())
    guard["blockTools"] = ["bash", "powershell"]
    json_write(guard_path, guard)

    # Separate manifest entry: keep browser plan review, but do not advertise a
    # draft COPY outcome while its clipboard implementation is macOS-only.
    manifest_path = agent / "packages/pi-plan-review/package.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["pi"]["extensions"] = ["./extensions/miniplan/index.ts"]
    json_write(manifest_path, manifest)

    current = json.loads(settings_path.read_text())
    settings = {k: current[k] for k in SETTING_KEYS if k in current}
    settings.update({
        "quietStartup": False,
        "defaultProjectTrust": "ask",
        "externalEditor": "notepad.exe",
        "defaultTools": ["read", "bash", "powershell", "edit", "write"],
        "packages": [f"./packages/{p}" for p in PACKAGES if p != "pi-intercom"],
    })
    web_specs = []
    for item in current.get("packages", []):
        spec = item if isinstance(item, str) else item.get("source", "")
        if spec.startswith("npm:pi-web-access@"):
            web_specs.append(spec.removeprefix("npm:"))
            settings["packages"].append({"source": spec, "skills": []})
    json_write(agent / "settings.json", settings)
    instructions = (root / "pi/.pi/agent/AGENTS.md").read_text()
    start = instructions.index("## Environment\n")
    end = instructions.index("\n## ", start + 3)
    instructions = instructions[:start] + """## Environment

- **Platform**: native Windows (no WSL)
- **Shells**: PowerShell and Git for Windows Bash
- **Editor**: Notepad by default; use installed editors when requested
- **Terminal**: Windows Terminal recommended
- Use native Windows paths for file tools; use Git Bash paths only inside Bash.
- Do not assume Homebrew, macOS tools, tmux, Unix sockets, or POSIX permissions.
""" + instructions[end:]
    instructions = instructions.replace(
        "- After editing files, prefer continuing review in tmux with Neovim when practical.",
        "- After editing files, offer a diff or review in an installed editor.",
    )
    instructions += """
## Transfer-bundle safeguards

- Never post a message on the user's behalf without explicit approval of its text.
  The Mac-only submit_draft extension is disabled here; ask in chat instead.
- Memory starts fresh. Do not infer this machine's context from the old Mac setup.
- Windows-specific integrations still need local verification; consult README.md
  shipped with this bundle before enabling disabled source.
"""
    (agent / "AGENTS.md").write_text(instructions)
    json_write(agent / "subagents.json", {})
    memory = agent / "memory/MEMORY.md"
    memory.parent.mkdir()
    memory.write_text("# Long-term memory\n\n## User preferences\n\n"
                      "- Prefer concise, practical, evidence-based answers.\n"
                      "- Prefer small, targeted code changes.\n\n"
                      "## Environment\n\n- Native Windows; PowerShell and Git Bash.\n\n## Other\n")
    installed = json.loads(pi_package_path.read_text())
    cli = installed["bin"]
    cli = cli["pi"] if isinstance(cli, dict) else cli
    if Path(cli).is_absolute() or ".." in Path(cli).parts:
        raise ValueError("Unexpected Pi CLI path")
    metadata = {
        "pi": f"{installed['name']}@{installed['version']}",
        "piVersion": installed["version"], "cliPath": cli,
        "npmPackages": web_specs, "localPackages": list(PACKAGES),
        "sourceCommit": subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip(),
        "sourceIsWorkingTree": True,
        "externalPackageCommits": external_commits,
        "mcpIncluded": False,
    }
    json_write(destination / "bundle.json", metadata)
    for name in ("Install.ps1", "README.md"):
        copy_file(templates / name, destination / name, templates)
    copy_file(root / "LICENSE", destination / "LICENSE", root)
    return metadata


def write_checksums(destination):
    # Hashes named after secret-guard files look like API keys to generic scans;
    # generate this derived integrity metadata only after scanning all payloads.
    checksums = {
        p.relative_to(destination).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(destination.rglob("*")) if p.is_file()
    }
    json_write(destination / "checksums.json", checksums)


def archive(source, output):
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(source.rglob("*")):
            if p.is_file():
                z.write(p, "pi-windows/" + p.relative_to(source).as_posix())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--settings", type=Path, default=Path.home() / ".pi/agent/settings.json")
    parser.add_argument("--pi-package", type=Path, required=True, help="Installed Pi package.json")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("Output already exists; choose another path")
    if not shutil.which("gitleaks"):
        parser.error("gitleaks is required; no unscanned archive will be produced")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pi-windows-") as temp:
        root = Path(temp) / "pi-windows"
        metadata = build(root, args.settings, args.pi_package)
        subprocess.run(["gitleaks", "dir", "--no-banner", "--redact", str(root)], check=True)
        write_checksums(root)
        archive(root, args.output)
    print(f"Created {args.output} ({args.output.stat().st_size:,} bytes; {metadata['pi']})")
    print("SHA256: " + hashlib.sha256(args.output.read_bytes()).hexdigest())


if __name__ == "__main__":
    main()
