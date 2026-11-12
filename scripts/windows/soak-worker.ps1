#!/usr/bin/env pwsh
<#
.SYNOPSIS
Runs the packaged Gateway for a fixed soak window and counts worker module errors.
#>
[CmdletBinding()]
param(
  [int]$Seconds = 120,
  [int]$Port = 18997,
  [int]$ReadyTimeoutSec = 120,
  [string]$Out = ".artifacts/soak/worker-soak.json",
  [switch]$KeepState
)

$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$soakRoot = Join-Path $root ".artifacts\soak"
$stateDir = Join-Path $soakRoot "state-$stamp"
$logPath = Join-Path $soakRoot "gateway-$stamp.out.log"
$errPath = Join-Path $soakRoot "gateway-$stamp.err.log"
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
New-Item -ItemType Directory -Path $soakRoot -Force | Out-Null

$env:OPENCLAW_STATE_DIR = $stateDir
$env:OPENCLAW_CONFIG_PATH = Join-Path $stateDir "openclaw.json"
$env:OPENCLAW_GATEWAY_PORT = [string]$Port
$env:OPENCLAW_SKIP_CHANNELS = "1"
$env:OPENCLAW_LOG_LEVEL = "debug"
$env:NO_COLOR = "1"
@{ gateway = @{ mode = "local"; port = $Port } } |
  ConvertTo-Json -Depth 6 |
  Set-Content -LiteralPath $env:OPENCLAW_CONFIG_PATH -Encoding UTF8

$node = (Get-Command node -ErrorAction Stop).Source
$arguments = @("dist/index.js", "gateway", "run", "--allow-unconfigured")
$process = Start-Process -FilePath $node -ArgumentList $arguments -PassThru `
  -RedirectStandardOutput $logPath -RedirectStandardError $errPath -NoNewWindow
$watch = [System.Diagnostics.Stopwatch]::StartNew()
$readyAtMs = $null
$readyUrl = "http://127.0.0.1:$Port/readyz"
$sampledRssMb = New-Object System.Collections.Generic.List[int]

try {
  while ($watch.Elapsed.TotalSeconds -lt $ReadyTimeoutSec) {
    if ($process.HasExited) { break }
    try {
      $current = Get-Process -Id $process.Id -ErrorAction Stop
      $sampledRssMb.Add([int]$current.WorkingSet64)
    } catch {}
    try {
      $response = Invoke-WebRequest -Uri $readyUrl -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
        $readyAtMs = [int]$watch.ElapsedMilliseconds
        break
      }
    } catch {}
    Start-Sleep -Milliseconds 200
  }

  if ($null -ne $readyAtMs -and -not $process.HasExited) {
    $soakWatch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($soakWatch.Elapsed.TotalSeconds -lt $Seconds) {
      if ($process.HasExited) { break }
      try {
        $current = Get-Process -Id $process.Id -ErrorAction Stop
        $sampledRssMb.Add([int]$current.WorkingSet64)
      } catch {}
      Start-Sleep -Milliseconds 500
    }
  }
} finally {
  $watch.Stop()
  if (-not $process.HasExited) {
    & taskkill /PID $process.Id /T /F 2>$null | Out-Null
  }
  $process.WaitForExit(10000) | Out-Null
}

$log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { "" }
$err = if (Test-Path -LiteralPath $errPath) { Get-Content -LiteralPath $errPath -Raw } else { "" }
$combined = "$log`n$err"
$errorMatches = [regex]::Matches($combined, 'Cannot find module|ERR_MODULE_NOT_FOUND|standing-intents-kernel')
$standingMentions = [regex]::Matches($combined, 'standing.?intent', 'IgnoreCase').Count
$maxRssMb = if ($sampledRssMb.Count -gt 0) {
  [math]::Round((($sampledRssMb | Measure-Object -Maximum).Maximum / 1MB), 1)
} else { $null }

$record = [ordered]@{
  schema = 1
  capturedAt = (Get-Date).ToString("o")
  mode = "dist"
  argv = $arguments -join " "
  node = (& node --version)
  port = $Port
  seconds = $Seconds
  stateDir = $stateDir
  readyMs = $readyAtMs
  sampledRssMbMax = $maxRssMb
  workerModuleErrorCount = $errorMatches.Count
  workerModuleErrors = @($errorMatches | ForEach-Object { $_.Value } | Select-Object -Unique)
  standingIntentMentions = $standingMentions
  exited = $process.HasExited
  exitCode = if ($process.HasExited) { $process.ExitCode } else { $null }
  logPath = $logPath
  errPath = $errPath
}
New-Item -ItemType Directory -Path (Split-Path -Parent $Out) -Force | Out-Null
$record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Out -Encoding UTF8
$record | ConvertTo-Json -Depth 8
if (-not $KeepState) {
  Remove-Item -LiteralPath $stateDir -Recurse -Force -ErrorAction SilentlyContinue
}
