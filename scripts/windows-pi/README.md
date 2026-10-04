# Pi setup for native Windows

This is a source/configuration transfer bundle, **not an offline installer**.
No WSL, Stow, symlinks, or administrator access are required by this installer.
Downloading prerequisites may require your organization's approval.

## Install

1. Install **Node.js 22.19+** (current LTS recommended) and **Git for Windows**
   from their official sites: https://nodejs.org/ and https://git-scm.com/.
   Git must be available to Windows applications. Open a fresh PowerShell window.
2. Extract the ZIP to a short local path, such as `C:\Users\you\Downloads\pi-windows`.
   Do not run inside the ZIP preview. Avoid network shares/OneDrive for installation.
3. In PowerShell, change into the extracted `pi-windows` directory and run:

   ```powershell
   node --version
   git --version
   .\Install.ps1
   ```

   If your organization allows local scripts but Windows marks these downloaded
   files as blocked, inspect them and use `Unblock-File .\Install.ps1`. If scripts
   remain blocked, ask IT; this bundle does not change or bypass execution policy.

4. From your project directory, start this copy explicitly:

   ```powershell
   & "$HOME\.pi\agent\pi.cmd"
   ```

5. Run `/login` to authenticate again. Use `/model` if the copied default model
   is not offered to your Windows account. Ctrl+S in the standard model picker
   is remapped to **Ctrl+Alt+D** for saving a startup model in these keybindings.

The installer downloads the exact Pi and web-extension versions in `bundle.json`.
Local package dependencies use their included lockfiles. Pi's own and the npm
web package's transitive dependencies resolve on installation; this is not a fully
locked offline distribution. Dependency lifecycle scripts are disabled. No Mac
`node_modules` or binaries are copied.

Pi lives at `%USERPROFILE%\.pi\agent`, with its private CLI under `runtime`.
It does not replace a global Pi command or edit PATH, your profile, or system
settings. Always use the launcher above unless you've deliberately configured
PATH; an existing `pi` command may start a different version.

### Options

```powershell
# Local messaging between Pi windows; requires permitted Windows Script Host/VBScript.
.\Install.ps1 -EnableIntercom

# Explicit Git Bash location, including non-admin Git installs:
.\Install.ps1 -GitBashPath 'C:\Tools\Git\bin\bash.exe'

# Omit web tools and their npm dependencies:
.\Install.ps1 -SkipWeb
```

Intercom is opt-in because Windows policy may disable VBScript even when
`wscript.exe` exists. This installer checks presence, not policy. Its Windows
transport uses named pipes; tmux switching is unavailable. Leave it disabled if
not needed. Tailnet intercom is a separate, disabled Unix-oriented integration.

### Existing installation / recovery

The installer refuses to overwrite **any existing** `.pi\agent`, even an empty
one. Close every Pi instance first. If you want to replace your Windows setup,
move the entire directory aside yourself, retaining it as a backup, then install:

```powershell
$backup = "$HOME\.pi\agent.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
Move-Item -LiteralPath "$HOME\.pi\agent" -Destination $backup
```

A failed install retains `.pi\windows-install-<random>` for diagnosis; it does
not activate that staging directory. Correct the error and rerun the installer.
Remove only the specific failed staging directory once it is no longer needed.
To roll back a successful installation, close Pi, move the new `agent` directory
aside and restore your backup to its original `agent` path. Do not merge folders
blindly: that can resurrect incompatible extensions or private credentials.

Optional, for **the current PowerShell window only**:

```powershell
$env:Path = "$HOME\.pi\agent;$env:Path"
pi.cmd
```

## What's included

- Catppuccin Mocha theme, custom keybindings, Vim editor, bordered input, custom
  footer, session naming, copy/clear helpers, recap, resource-token display,
  secret redaction, and send/rewind behavior.
- Subagents and the Explore, Plan, auditor, and general-purpose definitions;
  in-process aside conversations; Q&A cards; browser plan/markup review;
  fresh memory storage; session recall; the atomic-commits skill.
- Optional local Intercom source and skill. Enabled only with the installer flag.
- Web search/content tools (`pi-web-access`), with its skills disabled as on the
  source machine. Log in to Codex for subscription-backed search or configure an
  API provider separately. Mac cookies/API keys are not transferred.
- Both `bash` (Git Bash) and `powershell` tools. `!` / `!!` still run Bash.
- Windows-adjusted global instructions; external editor defaults to Notepad.

**All MCP integrations are omitted**, including Slack, Sunsama, the MCP adapter,
MCP configs and credentials. The web package is not the MCP adapter, though its
upstream zero-key Exa fallback internally uses a remote MCP service. Select the
OpenAI provider when you want Codex-backed search, or install with `-SkipWeb` to
omit that package entirely.

## Deliberate differences and limitations

- `disabled/` contains reference source only, outside Pi discovery: Tailnet
  intercom, Mac notifications, dashboard/calendar widget, tmux status heartbeat,
  agent-browser wrapper, and non-default provider/advisor extensions. Do not copy
  these into `agent/extensions` without addressing platform assumptions.
- Browser **plan review and `/markup` are enabled**. `submit_draft` is disabled
  in the copied plan-review manifest: its COPY flow calls macOS `pbcopy`. Draft
  source remains in that package, but is not a loaded entry point. Approve
  proposed outgoing messages in chat instead. The standard `/cp` uses Pi's
  clipboard implementation and is a separate feature.
- Subagents run in-process and do not require WSL. Worktree isolation has not
  been qualified against Git for Windows; try ordinary subagents first.
- `/qna` automatic extraction uses a fixed Codex model in the source extension;
  availability depends on your account. `launch_qna` with explicit questions
  does not need that extraction model.
- Browser-cookie Gemini search is not transferred or enabled. Optional video
  features require separate Windows ffmpeg/yt-dlp installation. Basic web tools
  still require provider connectivity; not every provider is tested here.
- Memory uses the Windows user's directory and inherited ACLs. Unix permission
  bits are not a Windows privacy guarantee; do not share this directory.
- Startup is intentionally verbose for diagnostics. Mac trust grants, history,
  saved sessions, private/global memory contents, auth tokens, browser profiles,
  caches, daemon state, and custom model credentials are excluded.
- Windows Terminal may intercept Alt+Enter; use **Ctrl+Alt+Enter** for follow-ups.
  Multiline input can use Ctrl+Enter. Inspect `/hotkeys` for your mappings.

## Verify on Windows

This bundle was built/static-checked on macOS, **not executed on Windows**.

1. `& "$HOME\.pi\agent\pi.cmd" --version` should match `bundle.json`.
2. Start from a project directory; inspect verbose startup for extension errors.
3. `/login`, then ask for a small read-only repo summary. Exercise both shells:
   Bash `pwd`, PowerShell `Get-Location`.
4. Check Vim modes, `/hotkeys`, `/cp`, and a Q&A card. Ask for a small plan using
   `submit_plan` and confirm your browser can reach its localhost URL.
5. Try one read-only subagent and an aside, then test a memory write/read.
6. Ask for a web search using provider `openai`, workflow `none`; test browser
   curation separately if desired. If enabled, test Intercom in two Pi windows.

For diagnosis without custom extensions:

```powershell
& "$HOME\.pi\agent\pi.cmd" --no-extensions
```

## Rebuilding (on the source Mac)

From the dotfiles repository:

```sh
python3 scripts/package-pi-windows.py \
  --pi-package /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json \
  --output ~/Downloads/pi-windows-new.zip
```

The builder reads only allowlisted tracked source paths plus selected live Pi
settings and installed version metadata. It refuses an existing output and
requires a passing `gitleaks` scan. Every delivered file is hashed in
`checksums.json`; these checks detect transfer damage, not malicious replacement
of both files and checksums. Preserve the ZIP's separately reported SHA-256.
