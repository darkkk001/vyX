# Rotate the two engine secrets that were exposed (2026-09-26): VYX_RISK_HOOK_SECRET (= Vercel's CRON_SECRET) and the
# vyx_shadow_ro database password inside VYX_SHADOW_DATABASE_URL. Run on the VPS in an ELEVATED Windows PowerShell,
# AFTER the new values are live on Vercel (CRON_SECRET, redeployed) and on Neon (ALTER ROLE vyx_shadow_ro).
#
# NEVER PRINTS A SECRET. The two new values are pasted at the prompts (input hidden); every confirmation below says only
# THAT a line changed. Runbook: deploy/market-data-vps-runbook.md "Rotating the risk-hook secret and the shadow password".
#
#   powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\rotate-engine-secrets-2026-09-26.ps1 [-NoRestart]
#
# -NoRestart: edit start-engine.cmd only (use it when the engine is about to be restarted by another script anyway).
param([switch]$NoRestart)
$ErrorActionPreference = "Stop"
$Cmd = "C:\vyxtrader\scripts\start-engine.cmd"
$Bk  = "C:\vyxtrader\backup\start-engine.cmd.pre-secret-rotation-$(Get-Date -Format yyyyMMdd-HHmmss)"

function Read-Secret($prompt) {
  $s = Read-Host -Prompt $prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$hook = Read-Secret "New VYX_RISK_HOOK_SECRET (paste, hidden)"
$pw   = Read-Secret "New vyx_shadow_ro password (paste, hidden)"
if ($hook -notmatch '^[0-9a-fA-F]{48}$') { throw "the risk-hook secret must be the 48 hex characters generated for this rotation -- nothing written" }
if ($pw -notmatch '^[A-Za-z0-9]{32,}$')  { throw "the shadow password must be the 32+ letters/digits generated for this rotation -- nothing written" }

New-Item -ItemType Directory -Force (Split-Path $Bk) | Out-Null
Copy-Item $Cmd $Bk
$lines = [System.Collections.Generic.List[string]](Get-Content $Cmd)
$hookRx  = '^\s*set\s+"?VYX_RISK_HOOK_SECRET='
$shadowRx = '^(\s*set\s+"?VYX_SHADOW_DATABASE_URL=postgres(?:ql)?://vyx_shadow_ro:)[^@]*(@.*)$'
$hookIdx   = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match $hookRx })
$shadowIdx = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match $shadowRx })
if ($hookIdx.Count -ne 1)   { throw "expected exactly one VYX_RISK_HOOK_SECRET line in $Cmd, found $($hookIdx.Count) -- nothing written (backup $Bk)" }
if ($shadowIdx.Count -ne 1) { throw "expected exactly one VYX_SHADOW_DATABASE_URL=postgres://vyx_shadow_ro:...@... line in $Cmd, found $($shadowIdx.Count) -- nothing written (backup $Bk)" }

$lines[$hookIdx[0]] = 'set "VYX_RISK_HOOK_SECRET=' + $hook + '"'
$m = [regex]::Match($lines[$shadowIdx[0]], $shadowRx)
$tail = $m.Groups[2].Value.TrimEnd('"')
$lines[$shadowIdx[0]] = $m.Groups[1].Value + $pw + $tail + $(if ($lines[$shadowIdx[0]] -match '^\s*set\s+"') { '"' } else { '' })
Set-Content -Path $Cmd -Value $lines -Encoding ascii
"[OK] VYX_RISK_HOOK_SECRET line replaced; VYX_SHADOW_DATABASE_URL password replaced (host/database/options unchanged)"
"     backup: $Bk"

# the web accepts the NEW secret and refuses no secret (a no-op symbol: nothing is evaluated)
$url = ((Get-Content $Cmd | Where-Object { $_ -match '^\s*set\s+"?VYX_RISK_HOOK_URL=' } | Select-Object -First 1) -replace '^\s*set\s+"?VYX_RISK_HOOK_URL=', '' -replace '"\s*$', '').Trim()
if ($url) {
  $probe = "$url" + "?symbols=ZZROTATIONCHECK"
  try { $r = Invoke-WebRequest -UseBasicParsing -Uri $probe -Headers @{ Authorization = "Bearer $hook" }; "[OK] web accepts the new risk-hook secret (HTTP $($r.StatusCode))" }
  catch { "[FAIL] web refused the new risk-hook secret ($($_.Exception.Response.StatusCode.value__)) -- is Vercel's CRON_SECRET redeployed? The engine is NOT restarted."; exit 1 }
  try { Invoke-WebRequest -UseBasicParsing -Uri $probe | Out-Null; "[FAIL] web accepted a call with NO secret" } catch { "[OK] web refuses a call without the secret ($($_.Exception.Response.StatusCode.value__))" }
}
Remove-Variable hook, pw

if ($NoRestart) { "Not restarted (-NoRestart): the new values take effect on the next engine restart."; exit 0 }

$log = (nssm get vyxtrader-engine AppStdout).Trim(); $err = (nssm get vyxtrader-engine AppStderr).Trim()
nssm restart vyxtrader-engine
Start-Sleep 20
nssm status vyxtrader-engine
foreach ($f in @($log, $err) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique) {
  "---- $f (last lines) ----"
  Get-Content $f -Tail 300 | Select-String -Pattern 'read-only role verified|SHADOW REFUSED|password authentication failed|shadow reconciler|risk hook enabled|risk hook backstop|risk hook rejected|idle gate' | ForEach-Object { $_.Line }
}
"Expect: 'read-only role verified', 'shadow reconciler running', 'risk hook enabled'; and NO 'password authentication failed',"
"'SHADOW REFUSED' or 'risk hook rejected' (401 = the web still has the old CRON_SECRET)."
"Rollback of this file alone does not help: the OLD values are dead on Neon and Vercel. Fix forward (re-run with the right values)."
