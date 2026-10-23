<#
Execution latency Phase 1: build ONE web commit on the VPS and run it as nssm service vyx-exec on localhost:3200 ([::1])
(deploy/vps/exec/README.md). Run ELEVATED on the VPS, only on the owner's go. Prints no secret and no env value.

  .\install-exec.ps1 -Sha <the commit Vercel production runs>

- Each commit is built in its own folder (C:\vyxtrader\exec\<sha>); the service is pointed at it only after the build
  and a local health check pass, so a failed build leaves the running one untouched. Rollback = run again with the
  previous sha (its folder is kept).
- The environment comes from C:\vyxtrader\exec\exec.env (KEY=VALUE lines, the production values; see README.md). This
  script never prints it.
- Caddy is NOT touched here: README.md step 3 adds the /exec route (validate, then reload).
#>
param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{7,40}$')][string]$Sha,
  [string]$EnvFile = "C:\vyxtrader\exec\exec.env",
  [string]$Repo = "C:\vyxtrader\repo",
  [string]$ProbeHost = "futurixglobal.vyxtrader.com"
)
$ErrorActionPreference = "Stop"
$Nssm    = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"   # nssm is not on the VPS PATH: always the full path
$Service = "vyx-exec"
$Port    = 3200
$Root    = "C:\vyxtrader\exec"
$Dir     = Join-Path $Root $Sha
$Cmd     = "C:\vyxtrader\scripts\start-exec.cmd"
$LogDir  = "C:\vyxtrader\logs"

function Invoke-Native([scriptblock]$Command, [int]$Tail = 0) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = & $Command 2>&1 | ForEach-Object { "$_" }; if ($Tail -gt 0) { $out | Select-Object -Last $Tail } else { $out } }
  finally { $ErrorActionPreference = $prev }
}
# curl.exe (Windows 10+): Windows PowerShell's Invoke-WebRequest refuses a custom Host header
function Get-HostCode([string]$Url, [string]$HostName) {
  $c = (Invoke-Native { curl.exe -s -o NUL -m 8 -w "%{http_code}" -H "Host: $HostName" $Url }) -join ""
  if ($c -match '^\d{3}$') { [int]$c } else { 0 }
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "run this elevated (nssm install / restart need it) -- nothing touched" }
if (-not (Test-Path $EnvFile)) { throw "$EnvFile is missing (README.md step 1) -- nothing touched" }
$keys = Get-Content $EnvFile | Where-Object { $_ -match '^\s*[A-Z_][A-Z0-9_]*=' } | ForEach-Object { ($_ -split '=', 2)[0].Trim() }
foreach ($need in "DATABASE_URL", "DIRECT_URL", "REDIS_URL", "INTERNAL_SERVICE_SECRET", "ROOT_DOMAIN") {
  if ($keys -notcontains $need) { throw "$EnvFile has no $need (README.md step 1) -- nothing touched" }
}
"env file: $($keys.Count) keys (values not shown)"

# 1) the commit, in its own folder
New-Item -ItemType Directory -Force $Root, $LogDir | Out-Null
Invoke-Native { git -C $Repo fetch --quiet origin } | Out-Null
if (-not (Test-Path $Dir)) { Invoke-Native { git -C $Repo worktree add --detach $Dir $Sha } -Tail 2 }
$head = (Invoke-Native { git -C $Dir rev-parse HEAD }) -join ""
if (-not $head.StartsWith($Sha)) { throw "$Dir is at $head, not $Sha -- service untouched" }
"source: $Dir at $head"

# 2) build with the production environment (in this process only; nothing is printed)
$saved = @{}
foreach ($line in Get-Content $EnvFile) {
  if ($line -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') { $saved[$Matches[1]] = [Environment]::GetEnvironmentVariable($Matches[1]); [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"')) }
}
try {
  Push-Location $Dir
  Invoke-Native { npm ci --no-audit --no-fund } -Tail 2
  Invoke-Native { npm run build } -Tail 6
  if (-not (Test-Path (Join-Path $Dir ".next\BUILD_ID"))) { throw "next build did not finish (no .next\BUILD_ID) -- service untouched" }
} finally {
  Pop-Location
  foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
}
Invoke-Native { npm cache clean --force } | Out-Null
"build: ok"

# 3) the start script: the env file, then the overrides that make it the local execution server
$lines = @("@echo off", "cd /d `"$Dir`"")
foreach ($line in Get-Content $EnvFile) { if ($line -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') { $lines += "set `"$($Matches[1])=$($Matches[2].Trim('"'))`"" } }
$lines += "set `"NODE_ENV=production`""
$lines += "set `"MIDDLEWARE_INTERNAL_ORIGIN=http://localhost:$Port`""
# localhost (= [::1] on Windows), not 127.0.0.1: next start proxies its own middleware rewrites (e.g. broker-not-found)
# to localhost:<port>; bound to 127.0.0.1 those failed with a 500 (rehearsed 2026-10-24). Caddy proxies to [::1]:3200.
$lines += "node node_modules\next\dist\bin\next start -p $Port -H localhost"
New-Item -ItemType Directory -Force (Split-Path $Cmd) | Out-Null
if (Test-Path $Cmd) { Copy-Item $Cmd "$Cmd.prev" -Force }
Set-Content -Path $Cmd -Value $lines -Encoding ASCII
"start script: $Cmd (values not shown)"

# 4) the service (installed once, restarted on every later run)
$exists = (Invoke-Native { & $Nssm status $Service }) -join "" -notmatch "Can't open service"
if (-not $exists) {
  Invoke-Native { & $Nssm install $Service "C:\Windows\System32\cmd.exe" "/c `"$Cmd`"" } | Out-Null
  Invoke-Native { & $Nssm set $Service AppStdout "$LogDir\exec.out.log" } | Out-Null
  Invoke-Native { & $Nssm set $Service AppStderr "$LogDir\exec.err.log" } | Out-Null
  Invoke-Native { & $Nssm set $Service AppRotateFiles 1 } | Out-Null
  Invoke-Native { & $Nssm set $Service AppRotateBytes 10485760 } | Out-Null
  Invoke-Native { & $Nssm set $Service Start SERVICE_AUTO_START } | Out-Null
  "service: installed"
}
Invoke-Native { & $Nssm set $Service AppDirectory $Dir } | Out-Null
Invoke-Native { & $Nssm restart $Service } | Out-Null

# 5) local health through the broker host, as Caddy will forward it
$code = 0
for ($i = 0; $i -lt 30 -and $code -ne 200; $i++) { Start-Sleep -Seconds 2; $code = Get-HostCode "http://localhost:$Port/api/health" $ProbeHost }
if ($code -ne 200) {
  "FAIL: local /api/health answered $code. Last log lines:"
  Get-Content "$LogDir\exec.err.log" -Tail 20 -ErrorAction SilentlyContinue
  if (Test-Path "$Cmd.prev") { "Rollback: copy $Cmd.prev over $Cmd; nssm restart $Service" }
  throw "vyx-exec is not healthy"
}
$unauth = Get-HostCode "http://localhost:$Port/api/trade/orders" $ProbeHost
"OK: vyx-exec $Sha healthy on localhost:$Port (health 200; GET /api/trade/orders without a session -> $unauth, expected 401)"
"Next: README.md step 3 (Caddy)."
