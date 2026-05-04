param(
  [ValidateSet("start", "stop", "restart", "status")]
  [string]$Action = "start"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$BackendPort = 3001
$FrontendPort = 8080
$BackendLog = Join-Path $Root ".local-backend.log"
$FrontendLog = Join-Path $Root ".local-frontend.log"

function Get-PidsByPort([int]$Port) {
  $portPids = @()
  $rows = netstat -ano | Select-String ":$Port"
  foreach ($row in $rows) {
    $line = $row.Line
    if ($line -match "LISTENING\s+(\d+)$") {
      $procId = [int]$Matches[1]
      if ($procId -gt 0) { $portPids += $procId }
    }
  }
  return $portPids | Select-Object -Unique
}

function Stop-PortListeners([int]$Port) {
  $listenerPids = Get-PidsByPort $Port
  foreach ($procId in $listenerPids) {
    try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch {}
  }
}

function Wait-ForHttp([string]$Url, [int]$TimeoutSeconds = 30) {
  $start = Get-Date
  while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSeconds) {
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
        return $true
      }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Start-Services {
  Set-Location $Root

  Stop-PortListeners $BackendPort
  Stop-PortListeners $FrontendPort

  if (Test-Path $BackendLog) { Remove-Item $BackendLog -Force }
  if (Test-Path $FrontendLog) { Remove-Item $FrontendLog -Force }

  Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $BackendLog -RedirectStandardError (Join-Path $Root ".local-backend.err.log")

  Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList @(
    "/c",
    "cd /d `"$Root`" && npm run dev > `"$FrontendLog`" 2>&1"
  )

  $backendOk = Wait-ForHttp "http://localhost:$BackendPort/health" 45
  $frontendOk = Wait-ForHttp "http://localhost:$FrontendPort" 45

  Write-Output ("Backend (:{0})  : {1}" -f $BackendPort, ($(if ($backendOk) { "UP" } else { "DOWN" })))
  Write-Output ("Frontend (:{0}) : {1}" -f $FrontendPort, ($(if ($frontendOk) { "UP" } else { "DOWN" })))
  Write-Output ("Backend log     : {0}" -f $BackendLog)
  Write-Output ("Frontend log    : {0}" -f $FrontendLog)
}

function Show-Status {
  $b = Get-PidsByPort $BackendPort
  $f = Get-PidsByPort $FrontendPort
  Write-Output ("Backend (:{0})  : {1}" -f $BackendPort, ($(if ($b.Count -gt 0) { "LISTENING (PID: $($b -join ', '))" } else { "DOWN" })))
  Write-Output ("Frontend (:{0}) : {1}" -f $FrontendPort, ($(if ($f.Count -gt 0) { "LISTENING (PID: $($f -join ', '))" } else { "DOWN" })))
}

function Stop-Services {
  Stop-PortListeners $FrontendPort
  Stop-PortListeners $BackendPort
  Show-Status
}

switch ($Action) {
  "start" { Start-Services }
  "stop" { Stop-Services }
  "restart" { Stop-Services; Start-Sleep -Milliseconds 500; Start-Services }
  "status" { Show-Status }
}
