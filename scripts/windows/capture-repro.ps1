#!/usr/bin/env pwsh
<#
.SYNOPSIS
Captures a reproducible OpenClaw failure capsule on native Windows.

.DESCRIPTION
Collects the facts needed to attribute startup, worker, configuration, UI asset,
and credential failures without guessing the run mode. Read-only: it never starts
a Gateway, changes configuration, or writes outside -OutDir.

.PARAMETER OutDir
Destination directory. Defaults to .artifacts/repro/<timestamp>.

.PARAMETER Mode
Observed run mode: watch, watch-raw, dist, cli, or unspecified.

.PARAMETER Argv
Command line that produced the failure, for example "pnpm gateway:watch:raw".

.PARAMETER StateDir
OpenClaw state directory. Defaults to OPENCLAW_STATE_DIR or %USERPROFILE%\.openclaw.

.PARAMETER IncludeLogs
Copy matching log files after redacting token-like assignments.

.PARAMETER SkipDoctor
Skip the read-only doctor lint (useful when the failure prevents it from running).
#>
[CmdletBinding()]
param(
  [string]$OutDir = "",
  [ValidateSet("watch", "watch-raw", "dist", "cli", "unspecified")]
  [string]$Mode = "unspecified",
  [string]$Argv = "",
  [string]$StateDir = "",
  [switch]$IncludeLogs,
  [switch]$SkipDoctor
)

$ErrorActionPreference = "Continue"
$script:Errors = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$Message) {
  Write-Host "[capture-repro] $Message"
}

function Add-Error([string]$Step, $ErrorRecord) {
  $text = "$Step`: $($ErrorRecord.Exception.Message)"
  $script:Errors.Add($text) | Out-Null
  Write-Warning $text
}

function Write-JsonFile([string]$Path, $Value) {
  try {
    $Value | ConvertTo-Json -Depth 8 | Set-Content -Path $Path -Encoding UTF8
  } catch {
    Add-Error "write $Path" $_
  }
}

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  } catch {
    return $null
  }
}

function Redact-File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try {
    $text = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    $text = $text -replace '(?i)("(?:token|api[_-]?key|secret|password|authorization)"\s*:\s*")[^"]+(")', '$1<redacted>$2'
    $text = $text -replace '(?i)((?:token|api[_-]?key|secret|password|authorization)\s*[:=]\s*)\S+', '$1<redacted>'
    Set-Content -LiteralPath $Path -Value $text -Encoding UTF8
  } catch {
    Add-Error "redact $Path" $_
  }
}

function Read-RedactedEnv {
  $sensitive = "(?i)(TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE)"
  $keys = @(
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
    "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "OPENCLAW_PROFILE",
    "OPENCLAW_GATEWAY_PORT", "OPENCLAW_GATEWAY_WATCH_TMUX", "OPENCLAW_GATEWAY_WATCH_TMUX_CHILD",
    "OPENCLAW_GATEWAY_STARTUP_TRACE", "OPENCLAW_TRACE_SYNC_IO", "OPENCLAW_DIAGNOSTICS",
    "OPENCLAW_DEV_SOURCE_ROOT", "NODE_OPTIONS", "NODE_COMPILE_CACHE", "SHELL", "TERM",
    "TERM_PROGRAM", "WT_SESSION", "TMUX"
  )
  $result = [ordered]@{}
  foreach ($key in $keys) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if ($null -eq $value) { continue }
    if ($key -match $sensitive) {
      $result[$key] = "<redacted>"
    } else {
      $result[$key] = $value
    }
  }
  return $result
}

function Read-ProcessFacts {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Select-Object ProcessId, ParentProcessId, CommandLine)
  } catch {
    Add-Error "process facts" $_
    return @()
  }
}

function Resolve-StateDir([string]$Requested) {
  if ($Requested) { return $Requested }
  if ($env:OPENCLAW_STATE_DIR) { return $env:OPENCLAW_STATE_DIR }
  if ($env:USERPROFILE) { return (Join-Path $env:USERPROFILE ".openclaw") }
  return ""
}

function Copy-RedactedLogs([string]$StateDirPath, [string]$TargetRoot) {
  $candidates = @()
  if ($StateDirPath) {
    $stateLogs = Join-Path $StateDirPath "logs"
    if (Test-Path -LiteralPath $stateLogs) {
      $candidates += Get-ChildItem -LiteralPath $stateLogs -File -ErrorAction SilentlyContinue
    }
  }
  if ($env:LOCALAPPDATA) {
    $localLogs = Join-Path $env:LOCALAPPDATA "openclaw\logs"
    if (Test-Path -LiteralPath $localLogs) {
      $candidates += Get-ChildItem -LiteralPath $localLogs -File -ErrorAction SilentlyContinue
    }
  }
  if ($env:TEMP) {
    $candidates += Get-ChildItem -LiteralPath $env:TEMP -Filter "openclaw*.log" -File -ErrorAction SilentlyContinue
  }
  $seen = @{}
  $copied = @()
  foreach ($file in $candidates) {
    if ($seen.ContainsKey($file.FullName)) { continue }
    $seen[$file.FullName] = $true
    if ($file.Length -gt 20MB) { continue }
    try {
      $target = Join-Path $TargetRoot $file.Name
      $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop
      $redacted = $text -replace '(?i)((?:token|api[_-]?key|secret|password|authorization)\s*[:=]\s*)\S+', '$1<redacted>'
      Set-Content -LiteralPath $target -Value $redacted -Encoding UTF8
      $copied += $file.FullName
    } catch {
      Add-Error "copy log $($file.FullName)" $_
    }
  }
  return $copied
}

if (-not $OutDir) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutDir = Join-Path (Join-Path (Get-Location) ".artifacts\repro") $stamp
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$resolvedStateDir = Resolve-StateDir $StateDir

Write-Step "writing capsule to $OutDir"
Write-Step "state directory: $resolvedStateDir"

$nodeVersion = $null
try { $nodeVersion = (& node --version) 2>$null } catch {}
$pnpmVersion = $null
try { $pnpmVersion = (& pnpm --version) 2>$null } catch {}

$packageJson = Join-Path (Get-Location) "package.json"
$packageVersion = $null
try { $packageVersion = (Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json).version } catch {}
$distBuildInfo = $null
$buildInfoPath = Join-Path (Get-Location) "dist\build-info.json"
if (Test-Path -LiteralPath $buildInfoPath) {
  try { $distBuildInfo = Get-Content -LiteralPath $buildInfoPath -Raw | ConvertFrom-Json } catch {}
}
$gitHead = $null
try {
  $candidateHead = (& git rev-parse --verify HEAD) 2>$null
  if ($LASTEXITCODE -eq 0 -and $candidateHead -and $candidateHead -ne "HEAD") {
    $gitHead = $candidateHead
  }
} catch {}

$manifest = [ordered]@{
  schema = 1
  capturedAt = (Get-Date).ToString("o")
  cwd = (Get-Location).Path
  mode = $Mode
  argv = $Argv
  stateDir = $resolvedStateDir
  powershell = $PSVersionTable.PSVersion.ToString()
  node = $nodeVersion
  pnpm = $pnpmVersion
  env = Read-RedactedEnv
  packageVersion = $packageVersion
  packageJsonSha256 = Get-Sha256 $packageJson
  pnpmLockSha256 = Get-Sha256 (Join-Path (Get-Location) "pnpm-lock.yaml")
  distBuildInfo = $distBuildInfo
  gitHead = $gitHead
  processes = Read-ProcessFacts
  errors = @()
}
Write-JsonFile (Join-Path $OutDir "manifest.json") $manifest

# OS facts the failure depends on.
$osInfo = $null
try { $osInfo = Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture } catch {}
$computerInfo = $null
try { $computerInfo = Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, TotalPhysicalMemory } catch {}
$processors = @()
try { $processors = @(Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed) } catch {}
$executionPolicy = $null
try { $executionPolicy = (Get-ExecutionPolicy -List | Out-String) } catch {}
$symlinkEvaluation = $null
try { $symlinkEvaluation = (& fsutil behavior query SymlinkEvaluation 2>&1 | Out-String) } catch {}
$longPathsEnabled = $null
try {
  $longPathsEnabled = (Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -ErrorAction Stop).LongPathsEnabled
} catch {}
$defender = $null
$defenderError = $null
try {
  $defender = Get-MpPreference -ErrorAction Stop | Select-Object DisableRealtimeMonitoring, ExclusionPath, ExclusionExtension
} catch {
  $defenderError = $_.Exception.Message
}
$symlinkProbe = [ordered]@{ supported = $false; error = $null }
$probeDir = Join-Path $env:TEMP ("openclaw-symlink-probe-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path $probeDir -ErrorAction Stop | Out-Null
  $probeTarget = Join-Path $probeDir "target.txt"
  Set-Content -LiteralPath $probeTarget -Value "probe" -Encoding ASCII
  $probeLink = Join-Path $probeDir "link.txt"
  New-Item -ItemType SymbolicLink -Path $probeLink -Target $probeTarget -ErrorAction Stop | Out-Null
  $symlinkProbe.supported = Test-Path -LiteralPath $probeLink
} catch {
  $symlinkProbe.error = $_.Exception.Message
} finally {
  Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
}
$volume = $null
try {
  $driveLetter = (Get-Location).Path.Substring(0, 1)
  $volume = Get-Volume -DriveLetter $driveLetter | Select-Object DriveLetter, FileSystem, HealthStatus, SizeRemaining, Size
} catch {}

$osFacts = [ordered]@{
  capturedAt = (Get-Date).ToString("o")
  os = $osInfo
  computer = $computerInfo
  processors = $processors
  executionPolicy = $executionPolicy
  symlinkEvaluation = $symlinkEvaluation
  longPathsEnabled = $longPathsEnabled
  symlinkProbe = $symlinkProbe
  defender = $defender
  defenderError = $defenderError
  volume = $volume
}
Write-JsonFile (Join-Path $OutDir "os-facts.json") $osFacts

# ACLs for the state and config paths.
$acl = [ordered]@{}
foreach ($path in @($resolvedStateDir, (Join-Path $resolvedStateDir "openclaw.json"))) {
  if ($path -and (Test-Path -LiteralPath $path)) {
    try {
      $aclText = (& icacls $path 2>&1 | Out-String)
      $access = @(Get-Acl -LiteralPath $path | Select-Object -ExpandProperty Access)
      $acl[$path] = [ordered]@{ icacls = $aclText; access = $access }
    } catch {
      Add-Error "acl $path" $_
    }
  }
}
Write-JsonFile (Join-Path $OutDir "acl.json") $acl

# State layout without file contents.
$stateFacts = [ordered]@{ topLevel = @(); config = $null }
if ($resolvedStateDir -and (Test-Path -LiteralPath $resolvedStateDir)) {
  try {
    $stateFacts.topLevel = @(Get-ChildItem -LiteralPath $resolvedStateDir -Force | Select-Object Name, Mode, Length, LastWriteTime)
    $configPath = Join-Path $resolvedStateDir "openclaw.json"
    if (Test-Path -LiteralPath $configPath) {
      $item = Get-Item -LiteralPath $configPath
      $stateFacts.config = [ordered]@{
        path = $configPath
        length = $item.Length
        lastWriteTime = $item.LastWriteTime
        sha256 = (Get-Sha256 $configPath)
      }
    }
  } catch {
    Add-Error "state layout" $_
  }
}
Write-JsonFile (Join-Path $OutDir "state.json") $stateFacts

# Watch lock (distinguishes a watcher run from a direct Gateway run).
$lockDir = Join-Path (Get-Location) ".local\watch-node"
if (Test-Path -LiteralPath $lockDir) {
  $lockTarget = Join-Path $OutDir "watch-locks"
  New-Item -ItemType Directory -Path $lockTarget -Force | Out-Null
  Get-ChildItem -LiteralPath $lockDir -File -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $lockTarget $_.Name) -Force
  }
}

# Doctor lint (read-only).
if (-not $SkipDoctor) {
  Write-Step "running read-only doctor lint"
  $doctorOut = Join-Path $OutDir "doctor.json"
  $doctorErr = Join-Path $OutDir "doctor.err.txt"
  try {
    & pnpm openclaw doctor --lint --json --severity-min info 1> $doctorOut 2> $doctorErr
    $manifest["doctorExitCode"] = $LASTEXITCODE
  } catch {
    Add-Error "doctor lint" $_
    $manifest["doctorExitCode"] = $null
  }
  Redact-File $doctorOut
  Redact-File $doctorErr
}

# Optional redacted logs.
if ($IncludeLogs) {
  Write-Step "copying redacted logs"
  $logTarget = Join-Path $OutDir "logs"
  New-Item -ItemType Directory -Path $logTarget -Force | Out-Null
  $copied = Copy-RedactedLogs $resolvedStateDir $logTarget
  $manifest["copiedLogs"] = $copied
}

$manifest["errors"] = @($script:Errors)
Write-JsonFile (Join-Path $OutDir "manifest.json") $manifest
Write-Step "done: $OutDir"
exit 0
