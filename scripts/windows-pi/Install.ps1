# Requires Windows PowerShell 5.1+ or PowerShell 7+, Node.js, Git for Windows.
[CmdletBinding()]
param(
    [string]$GitBashPath,
    [switch]$EnableIntercom,
    [switch]$SkipWeb
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}
function Write-Utf8 {
    param([string]$Path, [string]$Text)
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

if ($env:OS -ne 'Windows_NT') { throw 'This installer targets native Windows only.' }
if ($env:PI_CODING_AGENT_DIR) {
    throw 'PI_CODING_AGENT_DIR is already set. Use a clean shell without that override before installing.'
}
$AgentDir = Join-Path $HOME '.pi\agent'
if (Test-Path -LiteralPath $AgentDir) {
    throw "Refusing to overwrite $AgentDir. Close Pi and move your existing directory to a backup first; see README.md."
}
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$Git = (Get-Command git.exe -ErrorAction Stop).Source
$NodeVersion = [version]((& $Node --version).TrimStart('v'))
if ($LASTEXITCODE -ne 0 -or $NodeVersion -lt [version]'22.19.0') { throw 'Node.js 22.19+ is required.' }

if (-not $GitBashPath) {
    $Candidates = @(
        (Join-Path (Split-Path (Split-Path $Git -Parent) -Parent) 'bin\bash.exe'),
        "$env:ProgramFiles\Git\bin\bash.exe",
        "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
    )
    $GitBashPath = $Candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $GitBashPath -or -not (Test-Path -LiteralPath $GitBashPath)) {
    throw 'Git Bash not found. Install Git for Windows, or pass -GitBashPath C:\path\to\Git\bin\bash.exe.'
}
$GitBashPath = (Resolve-Path -LiteralPath $GitBashPath).ProviderPath
Invoke-Checked $GitBashPath @('--version')
if ($EnableIntercom -and -not (Get-Command wscript.exe -ErrorAction SilentlyContinue)) {
    throw 'Local Intercom needs Windows Script Host / VBScript. Omit -EnableIntercom; do not bypass organization policy.'
}

# Integrity checks detect accidental damage, not authenticity of an untrusted ZIP.
$Checksums = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'checksums.json') -Raw | ConvertFrom-Json
foreach ($Entry in $Checksums.PSObject.Properties) {
    $Relative = $Entry.Name
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative -match '(^|[\\/])\.\.([\\/]|$)') {
        throw "Invalid manifest path: $Relative"
    }
    $File = Join-Path $PSScriptRoot $Relative
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw "Missing bundle file: $Relative" }
    if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Entry.Value) {
        throw "Bundle checksum mismatch: $Relative"
    }
}
$Bundle = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'bundle.json') -Raw | ConvertFrom-Json
$Parent = Split-Path $AgentDir -Parent
New-Item -ItemType Directory -Force -Path $Parent | Out-Null
$Stage = Join-Path $Parent ('windows-install-' + [guid]::NewGuid().ToString('N'))
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'agent') -Destination $Stage -Recurse

try {
    $SettingsPath = Join-Path $Stage 'settings.json'
    $Settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
    $Settings | Add-Member -NotePropertyName shellPath -NotePropertyValue $GitBashPath -Force
    if ($EnableIntercom) { $Settings.packages = @($Settings.packages) + './packages/pi-intercom' }
    if ($SkipWeb) {
        $Settings.packages = @($Settings.packages | Where-Object { $_ -is [string] })
    }
    Write-Utf8 $SettingsPath ($Settings | ConvertTo-Json -Depth 30)

    # Private CLI installation: does not overwrite a global Pi or modify PATH.
    $Runtime = Join-Path $Stage 'runtime'
    Invoke-Checked $Npm @('--prefix', $Runtime, 'install', '--ignore-scripts', '--no-audit', '--no-fund', $Bundle.pi)
    foreach ($Name in $Bundle.localPackages) {
        if ($Name -eq 'pi-intercom' -and -not $EnableIntercom) { continue }
        $PackageDir = Join-Path $Stage "packages\$Name"
        $Package = Get-Content -LiteralPath (Join-Path $PackageDir 'package.json') -Raw | ConvertFrom-Json
        if ($Package.PSObject.Properties.Name -contains 'dependencies') {
            # Pi supplies its SDK peers at load time. Do not fetch arbitrary peer
            # packages (especially the optional pi-vim peer) from the registry.
            Invoke-Checked $Npm @('--prefix', $PackageDir, 'ci', '--omit=dev', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund')
        }
    }
    if (-not $SkipWeb) {
        foreach ($Spec in $Bundle.npmPackages) {
            Invoke-Checked $Npm @('--prefix', (Join-Path $Stage 'npm'), 'install', '--omit=dev', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', $Spec)
        }
    }
    $CliRelative = 'runtime\node_modules\@earendil-works\pi-coding-agent\' + $Bundle.cliPath.Replace('/', '\')
    $Cli = Join-Path $Stage $CliRelative
    $Version = & $Node $Cli --version
    if ($LASTEXITCODE -ne 0 -or $Version.Trim() -ne $Bundle.piVersion) {
        throw "Installed Pi version check failed: $Version"
    }
    $Launcher = @"
@echo off
setlocal
set "PI_CODING_AGENT_DIR=%~dp0"
node "%~dp0$CliRelative" %*
exit /b %errorlevel%
"@
    Write-Utf8 (Join-Path $Stage 'pi.cmd') ($Launcher.Replace("`r`n", "`n").Replace("`n", "`r`n"))
    # Directory.Move fails if another installer/user created the destination.
    [IO.Directory]::Move($Stage, $AgentDir)
} catch {
    Write-Warning "Install did not complete. Staging files retained at $Stage. Existing Pi config was not overwritten."
    throw
}
Write-Host ''
Write-Host "Installed Pi $($Bundle.piVersion) into $AgentDir"
Write-Host 'Start from your project directory with:'
Write-Host '  & "$HOME\.pi\agent\pi.cmd"'
Write-Host 'Then use /login. See README.md for Windows verification and optional PATH setup.'
