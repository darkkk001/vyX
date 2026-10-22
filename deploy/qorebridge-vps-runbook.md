# QoreBridge M5: VPS install runbook (bridge + simulated LP)

This installs two Windows services on the VPS, the engine pattern: nssm, auto-start, logs next to the binary.

| Service | Binary | Listens | What it does |
|---|---|---|---|
| `QoreBridgeSimLP` | `C:\qorebridge\sim\qb-sim.exe` | `127.0.0.1:9878` (FIX 4.4, loopback) | the simulated LP: fills every order at its configured price |
| `QoreBridge` | `C:\qorebridge\bridge\qorebridge.exe` | `127.0.0.1:8095` (`/health`, `/metrics`, loopback) | claims the platform's hedge intents (`HedgeIntent`), sends them to the LP, writes `HedgeResult`, publishes `bridge.result.<broker id>` |

**Scope of this install: the QA tenant `zzzqa` only.** The bridge's `[intake] broker_id` is zzzqa's `Broker.id`, so
it never claims another broker's intents. The only LP it knows is the simulator. No real LP and no real money are
involved. Futurix (and its A_BOOK group "Seawolf") is not touched.

**Before this runbook:**
1. M5 is merged, deployed on Vercel, and the gateway runbook (`deploy/m5-gateway-runbook.md`) is done.
2. The coordinator has created, on zzzqa: the A_BOOK test group, the test account, the LP entry "QoreBridge Sim LP"
   (`LiquidityProvider.id` = `<LP_ID>`), and a routing rule (test group, every symbol, that LP, priority 1, weight 1).
3. The coordinator gives you: `<ZZZQA_BROKER_ID>`, `<LP_ID>`, the two binaries with their SHA-256, and the
   `vyx_qorebridge` password (section 2).

## Rules

- Run in an **elevated** Windows PowerShell on the VPS. Paste one block at a time, and check its expected output before
  the next block.
- Nothing below prints a secret. The database URL is written into `qorebridge.toml`, whose ACL section 4 limits to
  Administrators and SYSTEM; it is never echoed.
- `nssm` is not on the VPS PATH. Always use `$Nssm` (the full path).
- Any `throw` means stop: nothing after it ran. Report the line.
- Each section ends with its own rollback line. The full removal is at the end.

## 0. Setup (paste first; prints nothing secret)

```powershell
$ErrorActionPreference = "Stop"
$Nssm      = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$Root      = "C:\qorebridge"
$Bridge    = "$Root\bridge"
$Sim       = "$Root\sim"
$GwCmd     = "C:\vyxtrader\scripts\start-gateway.cmd"
$BrokerId  = "<ZZZQA_BROKER_ID>"
$LpId      = "<LP_ID>"
function Get-CmdVar([string]$Path, [string]$Name) {
  $line = Get-Content $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim()
}
function Get-Code([string]$Url) {
  try { (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5).StatusCode }
  catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
}
foreach ($s in "QoreBridge", "QoreBridgeSimLP") { if (Get-Service $s -ErrorAction SilentlyContinue) { throw "service $s already exists -- stop and report" } }
foreach ($p in 8095, 9878) { if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { throw "port $p already in use -- stop and report" } }
if (-not (Test-Path $Nssm)) { throw "nssm not found at $Nssm" }
"NATS url in start-gateway.cmd: $([bool](Get-CmdVar $GwCmd 'NATS_URL'))"
"free GB on C: $([int]((Get-PSDrive C).Free / 1GB))"
```

Expected: `NATS url in start-gateway.cmd: True` and at least 5 GB free. No `throw`.
If the NATS variable has another name in `start-gateway.cmd`, report it before going on.

## 1. Binaries in place, checksums match

Copy `qorebridge.exe` to `C:\qorebridge\bridge\` and `qb-sim.exe` to `C:\qorebridge\sim\`, then:

```powershell
$Expect = @{ "$Bridge\qorebridge.exe" = "<SHA256_QOREBRIDGE>"; "$Sim\qb-sim.exe" = "<SHA256_QBSIM>" }
foreach ($f in $Expect.Keys) {
  if (-not (Test-Path $f)) { throw "missing $f" }
  $h = (Get-FileHash -Algorithm SHA256 $f).Hash
  if ($h -ne $Expect[$f].ToUpper()) { throw "checksum mismatch on $f -- do not run it" }
  "OK $f"
}
& "$Bridge\qorebridge.exe" --version
```

Expected: two `OK` lines, then the version line (`qorebridge <version> (<commit>)`).
Rollback: `Remove-Item -Recurse -Force C:\qorebridge`.

## 2. The database role (run on the ADMIN PC, not the VPS)

The coordinator runs `deploy/qorebridge-role.sql` once on ep-morning-glade as neondb_owner:

```
psql -v ON_ERROR_STOP=1 -v qb_pw='<strong password>' -f deploy/qorebridge-role.sql -d "<DIRECT_URL of ep-morning-glade>"
```

The self-check at the end prints exactly these rights, and nothing else:

| table_name | rights |
|---|---|
| HedgeIntent | SELECT, UPDATE |
| HedgeIntent (table) | SELECT |
| HedgeResult | INSERT, SELECT, UPDATE |
| HedgeResult (table) | INSERT, SELECT |
| HedgeRoutingRule | SELECT |
| HedgeRoutingRule (table) | SELECT |
| Notification | INSERT |

(Rows without "(table)" are the column grants; UPDATE is on the claim / outcome columns only, INSERT on Notification
only on the columns the escalation trigger writes. Verified on a scratch clone 2026-10-22: every bridge statement runs
as this role, and Account, Position, Deal, Notification reads, LpRoutingRule, any DELETE and any other column update
are refused.)

The role can read no Account, Position, Deal, Transaction or Broker row, and it can DELETE nothing.
Rollback: the `Revert:` line at the top of `deploy/qorebridge-role.sql`.

## 3. The simulated LP service

```powershell
@"
# QoreBridge Sim LP on the VPS (QA tenant zzzqa only). Fills every order at the price below.
listen = "127.0.0.1:9878"
comp_id = "QBSIM"
seed = 24301

[default]
scenario = { kind = "normal_fill" }

[symbols.XAUUSD]
price = <XAUUSD_PRICE>
point = 0.01

[symbols.EURUSD]
price = <EURUSD_PRICE>
point = 0.00001
"@ | Set-Content -Encoding ascii "$Sim\qb-sim.toml"
New-Item -ItemType Directory -Force "$Sim\logs" | Out-Null
& $Nssm install QoreBridgeSimLP "$Sim\qb-sim.exe" | Out-Null
& $Nssm set QoreBridgeSimLP AppParameters "--config `"$Sim\qb-sim.toml`"" | Out-Null
& $Nssm set QoreBridgeSimLP AppDirectory $Sim | Out-Null
& $Nssm set QoreBridgeSimLP DisplayName "QoreBridge Sim LP" | Out-Null
& $Nssm set QoreBridgeSimLP Description "Simulated FIX LP for the QoreBridge M5 test (zzzqa only)" | Out-Null
& $Nssm set QoreBridgeSimLP Start SERVICE_AUTO_START | Out-Null
& $Nssm set QoreBridgeSimLP AppStdout "$Sim\logs\stdout.log" | Out-Null
& $Nssm set QoreBridgeSimLP AppStderr "$Sim\logs\stderr.log" | Out-Null
& $Nssm set QoreBridgeSimLP AppRotateFiles 1 | Out-Null
& $Nssm set QoreBridgeSimLP AppRotateOnline 1 | Out-Null
& $Nssm set QoreBridgeSimLP AppRotateBytes 10485760 | Out-Null
Start-Service QoreBridgeSimLP
$ok = $false; foreach ($i in 1..20) { if (Get-NetTCPConnection -LocalPort 9878 -State Listen -ErrorAction SilentlyContinue) { $ok = $true; break }; Start-Sleep 1 }
"sim LP listening: $ok"
netstat -ano | Select-String ":9878\s" | Select-String "LISTENING"
```

The coordinator fills in `<XAUUSD_PRICE>` and `<EURUSD_PRICE>` with the current market price when they hand you this
page, so the test's slippage is small. The simulator does not follow the market.

Expected: `sim LP listening: True`, and `127.0.0.1:9878 ... LISTENING` (never `0.0.0.0`).
Rollback: `Stop-Service QoreBridgeSimLP; & $Nssm remove QoreBridgeSimLP confirm`.

## 4. The bridge config (the database URL never printed)

`<the vyx_qorebridge password>` is typed only into the `Read-Host` prompt below.

```powershell
$pw   = Read-Host "vyx_qorebridge password" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
$db   = "postgresql://vyx_qorebridge:$([Uri]::EscapeDataString($plain))@ep-morning-glade-b23tui1g-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require"
$nats = Get-CmdVar $GwCmd "NATS_URL"
Copy-Item -Force "<path to intake-schema.vyxtrader.toml from the qorebridge repo>" "$Bridge\intake-schema.toml"
@"
# QoreBridge on the VPS, M5 test install: QA tenant zzzqa, simulated LP only.
[instance]
name = "vyx-vps-zzzqa-m5"
data_dir = "data"

[api]
bind = "127.0.0.1:8095"

[log]
dir = "logs"
level = "info"
retention_days = 30

[database]
url = "$db"

[nats]
url = "$nats"

[license]
key = ""

[intake]
broker_id = "$BrokerId"
poll_ms = 1000
schema_file = "intake-schema.toml"

[[lp]]
id = "$LpId"
host = "127.0.0.1"
port = 9878
sender_comp_id = "VYXQB"
target_comp_id = "QBSIM"
tls = "off"
"@ | Set-Content -Encoding ascii "$Bridge\qorebridge.toml"
$plain = $null; $db = $null; $pw = $null
# only Administrators and SYSTEM can read the file that holds the database URL
icacls "$Bridge\qorebridge.toml" /inheritance:r /grant:r "Administrators:F" "SYSTEM:F" | Out-Null
(Get-Acl "$Bridge\qorebridge.toml").Access | ForEach-Object { "$($_.IdentityReference) $($_.FileSystemRights)" }
& "$Bridge\qorebridge.exe" --check-config --config "$Bridge\qorebridge.toml"
"check-config exit: $LASTEXITCODE"
```

Expected: exactly two ACL lines (`BUILTIN\Administrators FullControl`, `NT AUTHORITY\SYSTEM FullControl`), then
`check-config exit: 0`. A non-zero exit prints the reason (never the URL): fix the file and re-run this block.
Rollback: `Remove-Item -Force "$Bridge\qorebridge.toml"`.

## 5. Install and start the bridge

```powershell
Set-Location $Bridge
& "<path to deploy\install-service.ps1 from the qorebridge repo>" -InstallDir $Bridge -NssmPath $Nssm
$ok = $false; foreach ($i in 1..30) { if ((Get-Code "http://127.0.0.1:8095/health") -eq 200) { $ok = $true; break }; Start-Sleep 1 }
if (-not $ok) { "<<< /health not 200 after 30 s -- go to REMOVE and report" } else { "OK: /health 200" }
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8095/health -TimeoutSec 5).Content
netstat -ano | Select-String ":8095\s" | Select-String "LISTENING"
(Get-Service QoreBridge).StartType
```

Expected: `OK: /health 200`; the health body shows the intake and `lp:<LP_ID>` ready; `127.0.0.1:8095 ... LISTENING`;
`Automatic`.
Rollback: `Stop-Service QoreBridge; & $Nssm remove QoreBridge confirm`.

## 6. Session up, nothing claimed, log clean

```powershell
$m = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8095/metrics -TimeoutSec 5).Content -split "`n"
$m | Select-String "^qb_lp_sessions_ready|^qb_intake_claimed|^qb_intake_db_errors|^qb_hedge_open|^qb_hedge_violation"
$log = Get-ChildItem "$Bridge\logs\qorebridge.*.log" | Sort-Object LastWriteTime | Select-Object -Last 1
Get-Content $log.FullName -Tail 60 | Select-String -Pattern "logged on|ERROR|WARN|permission denied" | Select-Object -Last 10
```

Expected:
- `qb_lp_sessions_ready 1`, `qb_intake_claimed 0`, `qb_intake_db_errors 0`, `qb_hedge_open 0`, and both violations 0;
- a `logged on` line, and no `ERROR` or `permission denied`.

`permission denied` means the role in section 2 is missing a grant: REMOVE, report the line, nothing was hedged.

Then tell the coordinator: "QoreBridge + Sim LP running, health 200, session ready, claimed 0, log clean". The
coordinator then runs the end-to-end test: an order on the zzzqa A_BOOK test account, filled at once, then hedged at
the simulated LP (`HedgeResult` FILLED), shown in `/api/manage/hedges` and on the backoffice LP screen.

## 7. After the end-to-end test

```powershell
$m = (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8095/metrics -TimeoutSec 5).Content -split "`n"
$m | Select-String "^qb_intake_claimed|^qb_intake_legs_sent|^qb_hedge_delivered|^qb_hedge_open|^qb_hedge_violation|^qb_intake_db_errors"
```

Expected: `claimed`, `legs_sent` and `delivered` equal to the test's deal count, `open 0`, violations 0, `db_errors 0`.

## REMOVE (everything this runbook installed)

```powershell
foreach ($s in "QoreBridge", "QoreBridgeSimLP") {
  if (Get-Service $s -ErrorAction SilentlyContinue) {
    "$s AppDirectory: $(& $Nssm get $s AppDirectory)"   # must be under C:\qorebridge -- else stop, it is not ours
    Stop-Service $s; & $Nssm remove $s confirm
  }
}
Remove-Item -Recurse -Force C:\qorebridge
```

Then the coordinator runs the role's `Revert:` line (section 2). Intents written while the bridge was down stay
`PENDING` in `HedgeIntent`; the backoffice shows them as unhedged. Nothing else on the platform depends on the bridge:
clients are always filled first.
