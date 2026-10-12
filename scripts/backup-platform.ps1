# Weekly platform backup -> one AES-256 encrypted 7z on C:.
#
#   powershell -ExecutionPolicy Bypass -File C:\vyx\web\scripts\backup-platform.ps1            # full run (asks for the password)
#   powershell -ExecutionPolicy Bypass -File C:\vyx\web\scripts\backup-platform.ps1 -StageOnly # everything except the encryption
#
# What goes in (folder C:\vyx-backup-<date>, deleted once the archive is written and tested):
#   git/        git clone --mirror of every repo in $Repos (the Rust engine lives inside vyX, so no extra repo)
#   db/         pg_dump -Fc of the LIVE Neon database (read-only session) + pg_restore --list + live row counts
#   secrets/    copy of C:\vyx-secrets
#   vercel/     vercel env pull of the vy-x production environment
#   website/    the live update feeds (manifests, Setup exe, latest full package, SHA-256 checked against the manifest)
#   extra/      folders on no repo ($ExtraDirs, without build output: $BuildDirs); D:/E: are only read
#   vps/        newest C:\vyx-backup-inbox\vps-config-*.zip (made on the VPS by scripts/vps-config-export.ps1)
#   MANIFEST.txt  what ran, sizes, restore-test results
#
# Restore test (before encrypting): a clone from each mirror + fsck, and the dump restored into a throwaway Postgres 18
# cluster on 127.0.0.1:5498 with row counts for Account, Position and Transaction (the ledger) compared to live.
#
# Re-runnable: a folder already staged today (.staged-ok) is not rebuilt, only encrypted (-Force rebuilds it).
# Keeps the newest $Keep archives (C: is small). Tools (Postgres 18 client, 7-Zip) are fetched once into $ToolsDir.

param(
    [switch] $StageOnly,
    [switch] $Force,
    [int] $Keep = 2,
    [string] $EnvLive = "C:\vyx-secrets\env\D-vyX\.env.live",
    [string] $SecretsDir = "C:\vyx-secrets",
    [string] $WebCheckout = "C:\vyx\web",
    [string] $VpsInbox = "C:\vyx-backup-inbox",
    [string] $ToolsDir = "C:\vyx-backup-tools",
    [string[]] $Repos = @(
        "https://github.com/darkkk001/vyX.git",
        "https://github.com/darkkk001/VyxTrader.git",
        "https://github.com/darkkk001/vyx-mt5-copier.git"
    ),
    # Folders that are on no repo, copied without build output (name = folder under extra/). Missing ones are noted, not fatal.
    [hashtable] $ExtraDirs = @{
        "arch-and-design"          = "D:\VyXTrader-Tauri\vyXTrader Arch & Design"
        "vyx-archive"              = "E:\vyx-archive"
        "vyx-recovery-2026-09-18"  = "C:\Users\Nvme\Documents\vyx-recovery-2026-09-18"
        "vyx-recovery-2026-10-05"  = "C:\vyx-recovery"
        "vyx-terminal-v2"          = "C:\Users\Nvme\Downloads\vyx-terminal-v2"
        "vyx-backoffice-redesign"  = "C:\Users\Nvme\Downloads\vyx-backoffice-redesign"
        "bigfish-terminal"         = "D:\BigFish Terminal"
        "bigfish-terminal-2"       = "D:\BigFish terminal 2"
    },
    # Build output skipped in every extra folder (rebuildable, and it held >260-char paths).
    [string[]] $BuildDirs = @("node_modules", "target", ".next", "bin", "obj", "dist"),
    [string[]] $Feeds = @(
        "https://www.vyxtrader.com/native-terminal-updates/futurixglobal/",
        "https://www.vyxtrader.com/native-backoffice-updates/futurixglobal/"
    )
)

$ErrorActionPreference = "Continue"   # native tools write progress to stderr; failures are checked via $LASTEXITCODE
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$date = Get-Date -Format "yyyy-MM-dd"
$Folder = "C:\vyx-backup-$date"
$Archive = "$Folder.7z"
$PgVersion = "18.6"
$SevenZipExtra = "7z2604-extra.7z"
$Tables = @("Account", "Position", "Transaction")
$TestPort = 5498

function Fail([string] $msg) { Write-Host "FAILED: $msg" -ForegroundColor Red; exit 1 }
function Step([string] $msg) { Write-Host "== $msg" -ForegroundColor Cyan }
function Note([string] $line) { Add-Content -Path (Join-Path $Folder "MANIFEST.txt") -Value $line -Encoding UTF8; Write-Host "   $line" }
function FreeGB { [math]::Round((Get-PSDrive C).Free / 1GB, 1) }
function SizeMB([string] $path) {
    $s = (Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    if (-not $s) { $s = 0 }
    [math]::Round($s / 1MB, 1)
}
# Deletes a folder that may hold >260-char paths (Remove-Item fails on those): robocopy /MIR from an empty folder
# first, then rmdir. Fails if anything is left, because the staging folder holds secrets in plain form.
function Remove-Tree([string] $path) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    $empty = Join-Path $env:TEMP ("vyx-empty-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $empty | Out-Null
    & robocopy $empty $path /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS *> $null
    Remove-Item -LiteralPath $empty -Force
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $path) { Fail "could not delete ${path}: delete it by hand" }
}
# Runs a native exe, sends its output to a log file (never to the console: some arguments hold the DB URL).
function Run([string] $exe, [string[]] $argv, [string] $log) {
    & $exe @argv *>> $log
    return $LASTEXITCODE
}

# ---------- tools ----------
function Ensure-Tools {
    $pgBin = Join-Path $ToolsDir "pgsql18\bin"
    if (-not (Test-Path (Join-Path $pgBin "pg_dump.exe"))) {
        Step "fetching Postgres $PgVersion client tools"
        $dl = Join-Path $ToolsDir ("dl-pg-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force $dl | Out-Null
        $zip = Join-Path $dl "pg.zip"
        Invoke-WebRequest -UseBasicParsing "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-1-windows-x64-binaries.zip" -OutFile $zip
        & tar.exe -xf $zip -C $dl "pgsql/bin" "pgsql/lib" "pgsql/share"
        if ($LASTEXITCODE -ne 0) { Fail "could not unpack the Postgres zip" }
        Move-Item (Join-Path $dl "pgsql") (Join-Path $ToolsDir "pgsql18")
        Remove-Item -Recurse -Force $dl
    }
    $sz = Join-Path $ToolsDir "7z\x64\7za.exe"
    if (-not (Test-Path $sz)) {
        Step "fetching 7-Zip (standalone console version)"
        $d = Join-Path $ToolsDir "7z"
        New-Item -ItemType Directory -Force $d | Out-Null
        Invoke-WebRequest -UseBasicParsing "https://www.7-zip.org/a/7zr.exe" -OutFile (Join-Path $d "7zr.exe")
        Invoke-WebRequest -UseBasicParsing "https://www.7-zip.org/a/$SevenZipExtra" -OutFile (Join-Path $d $SevenZipExtra)
        & (Join-Path $d "7zr.exe") x -y "-o$d" (Join-Path $d $SevenZipExtra) | Out-Null
        if (-not (Test-Path $sz)) { Fail "7za.exe not found after unpacking $SevenZipExtra" }
    }
    return @{ Pg = $pgBin; SevenZip = $sz }
}

function Read-EnvValue([string] $file, [string] $name) {
    foreach ($line in Get-Content -LiteralPath $file) {
        if ($line -match "^\s*$name\s*=\s*`"?([^`"\r\n]+)`"?") { return $Matches[1] }
    }
    return $null
}

function Count-Rows([string] $psql, [string] $url) {
    # Via a file: PowerShell 5.1 drops the inner double quotes of a native argument ("Account" -> account).
    $q = ($Tables | ForEach-Object { "select '$_', count(*) from `"$_`"" }) -join " union all "
    $sql = Join-Path $env:TEMP ("vyx-count-" + [guid]::NewGuid().ToString("N") + ".sql")
    Set-Content -LiteralPath $sql -Value "$q;" -Encoding ASCII
    $env:PGOPTIONS = "-c default_transaction_read_only=on"
    $rows = & $psql -X -At -F "=" -f $sql -d $url 2>$null
    Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $sql -ErrorAction SilentlyContinue
    $h = @{}
    foreach ($r in $rows) { $p = "$r".Split("="); if ($p.Count -eq 2) { $h[$p[0]] = [int64]$p[1] } }
    return $h
}

# ---------- stage ----------
function Stage($tools) {
    if ((Test-Path $Folder) -and $Force) { Remove-Tree $Folder }
    if (Test-Path (Join-Path $Folder ".staged-ok")) { Step "already staged today: $Folder (use -Force to rebuild)"; return }
    if (Test-Path $Folder) { Remove-Tree $Folder }   # half-finished earlier run
    if ((FreeGB) -lt 15) { Fail "only $(FreeGB) GB free on C:, need ~15 GB (staging + archive)" }
    New-Item -ItemType Directory -Force $Folder | Out-Null
    $logs = Join-Path $Folder "logs"
    New-Item -ItemType Directory -Force $logs | Out-Null
    Note "VyX platform backup $date (started $(Get-Date -Format 'HH:mm:ss'), C: free $(FreeGB) GB)"

    # 1. git mirrors
    Step "git mirrors"
    $gitDir = Join-Path $Folder "git"
    New-Item -ItemType Directory -Force $gitDir | Out-Null
    foreach ($r in $Repos) {
        $name = ($r -split "/")[-1]   # vyX.git, VyxTrader.git
        $dst = Join-Path $gitDir $name
        if ((Run "git" @("clone", "--mirror", "--quiet", $r, $dst) (Join-Path $logs "git.log")) -ne 0) { Fail "git clone --mirror $r" }
        $refs = (& git -C $dst for-each-ref --format="%(refname)" refs/heads | Measure-Object).Count
        Note "git: $name mirror, $refs branches, $(SizeMB $dst) MB"
    }

    # 2. live database (read-only)
    Step "pg_dump of the live database (read-only)"
    $url = Read-EnvValue $EnvLive "DIRECT_URL"
    if (-not $url) { $url = Read-EnvValue $EnvLive "DATABASE_URL" }
    if (-not $url) { Fail "no DIRECT_URL / DATABASE_URL in $EnvLive" }
    $dbHost = ([uri]$url.Replace("postgresql://", "http://").Replace("postgres://", "http://")).Host
    $dbDir = Join-Path $Folder "db"
    New-Item -ItemType Directory -Force $dbDir | Out-Null
    $dump = Join-Path $dbDir "neon-live-$date.dump"
    $live = Count-Rows (Join-Path $tools.Pg "psql.exe") $url
    $env:PGOPTIONS = "-c default_transaction_read_only=on"
    $rc = Run (Join-Path $tools.Pg "pg_dump.exe") @("-Fc", "--no-owner", "--no-privileges", "-f", $dump, "-d", $url) (Join-Path $logs "pg_dump.log")
    Remove-Item Env:PGOPTIONS -ErrorAction SilentlyContinue
    if ($rc -ne 0) { Fail "pg_dump exited $rc (see $logs\pg_dump.log)" }
    $toc = & (Join-Path $tools.Pg "pg_restore.exe") --list $dump 2>$null
    if ($LASTEXITCODE -ne 0) { Fail "pg_restore --list could not read the dump" }
    $toc | Set-Content (Join-Path $dbDir "toc.txt") -Encoding UTF8
    $tableData = ($toc | Where-Object { $_ -match " TABLE DATA " }).Count
    Note "db: host $dbHost, dump $(SizeMB $dump) MB, pg_restore --list OK ($($toc.Count) entries, $tableData tables with data)"
    Note ("db: live rows at dump time: " + (($Tables | ForEach-Object { "$_=$($live[$_])" }) -join ", "))
    Set-Content (Join-Path $dbDir "live-counts.txt") (($Tables | ForEach-Object { "$_=$($live[$_])" }) -join "`r`n")

    # 3. secrets
    Step "secrets"
    Copy-Item -Recurse -Force $SecretsDir (Join-Path $Folder "secrets")
    Note "secrets: copy of $SecretsDir, $((Get-ChildItem -Recurse -File (Join-Path $Folder 'secrets')).Count) files"

    # 4. vercel production env
    Step "vercel env pull (production)"
    $vdir = Join-Path $Folder "vercel"
    New-Item -ItemType Directory -Force $vdir | Out-Null
    $vfile = Join-Path $vdir "vy-x.production.env"
    $rc = Run "cmd.exe" @("/c", "vercel", "env", "pull", $vfile, "--environment=production", "--yes", "--cwd", $WebCheckout) (Join-Path $logs "vercel.log")
    if ($rc -ne 0 -or -not (Test-Path $vfile)) { Fail "vercel env pull failed (is $WebCheckout linked? see $logs\vercel.log)" }
    $vars = @(Get-Content $vfile | Where-Object { $_ -match "^[A-Z0-9_]+=" })
    $empty = @($vars | Where-Object { $_ -match '^[A-Z0-9_]+=("")?$' })
    Note "vercel: $($vars.Count) production variables ($($empty.Count) empty: Vercel never returns 'Sensitive' values)"

    # 5. live update feeds
    Step "website feeds"
    $wdir = Join-Path $Folder "website"
    foreach ($f in $Feeds) {
        $sub = Join-Path $wdir (($f.TrimEnd("/") -split "/")[-2] + "-" + ($f.TrimEnd("/") -split "/")[-1])
        New-Item -ItemType Directory -Force $sub | Out-Null
        foreach ($file in @("releases.win.json", "RELEASES", "assets.win.json")) {
            Invoke-WebRequest -UseBasicParsing ($f + $file) -OutFile (Join-Path $sub $file)
        }
        $rel = Get-Content (Join-Path $sub "releases.win.json") -Raw | ConvertFrom-Json
        $full = $rel.Assets | Where-Object { $_.Type -eq "Full" } | Sort-Object { [version]$_.Version } | Select-Object -Last 1
        Invoke-WebRequest -UseBasicParsing ($f + $full.FileName) -OutFile (Join-Path $sub $full.FileName)
        $sha = (Get-FileHash (Join-Path $sub $full.FileName) -Algorithm SHA256).Hash
        if ($sha -ne $full.SHA256) { Fail "$($full.FileName): SHA-256 differs from the manifest" }
        $assets = Get-Content (Join-Path $sub "assets.win.json") -Raw | ConvertFrom-Json
        $setups = @($assets | Where-Object { $_.Type -eq "Installer" } | ForEach-Object { $_.RelativeFileName })
        $brandSetup = ($full.PackageId -replace "Native$", "") -replace "^(.*?)(Trader|Backoffice)$", 'Setup-$1$2.exe'
        foreach ($s in ($setups + $brandSetup | Select-Object -Unique)) {
            try { Invoke-WebRequest -UseBasicParsing ($f + $s) -OutFile (Join-Path $sub $s) } catch { Note "website: $s not served ($($_.Exception.Message))" }
        }
        Note "website: $f -> $($full.PackageId) $($full.Version) (full package SHA-256 matches the manifest), $(SizeMB $sub) MB"
    }

    # 6. folders on no repo (read only: robocopy reads the source, writes only into the backup folder)
    Step "extra folders"
    $xdir = Join-Path $Folder "extra"
    foreach ($k in ($ExtraDirs.Keys | Sort-Object)) {
        $src = $ExtraDirs[$k]
        if (-not (Test-Path -LiteralPath $src)) { Note "extra: $k MISSING ($src)"; continue }
        $dst = Join-Path $xdir $k
        & robocopy $src $dst /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NP /XD @BuildDirs *>> (Join-Path $logs "extra.log")
        if ($LASTEXITCODE -ge 8) { Fail "robocopy $src (exit $LASTEXITCODE, see $logs\extra.log)" }
        Note "extra: $k <- $src (no build output, $(SizeMB $dst) MB)"
    }

    # 7. VPS config (exported on the VPS by scripts/vps-config-export.ps1, copied into the inbox by hand)
    Step "VPS config"
    $vps = Get-ChildItem -Path $VpsInbox -Filter "vps-config-*.zip" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
    if ($vps) {
        New-Item -ItemType Directory -Force (Join-Path $Folder "vps") | Out-Null
        Copy-Item $vps.FullName (Join-Path $Folder "vps")
        $age = [int]((Get-Date) - $vps.LastWriteTime).TotalDays
        Note "vps: $($vps.Name) ($age days old$(if ($age -gt 8) { ': STALE, re-export on the VPS' }))"
    } else {
        Note "vps: MISSING - run scripts/vps-config-export.ps1 on the VPS and copy the zip to $VpsInbox"
    }

    # 8. restore test
    Restore-Test $tools $dump $live $gitDir $logs
    New-Item -ItemType File (Join-Path $Folder ".staged-ok") | Out-Null
    Note "staged: $(SizeMB $Folder) MB, C: free $(FreeGB) GB"
}

function Restore-Test($tools, [string] $dump, $live, [string] $gitDir, [string] $logs) {
    Step "restore test"
    $tmp = Join-Path $env:TEMP ("vyx-restore-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
        foreach ($m in Get-ChildItem $gitDir -Directory) {
            $c = Join-Path $tmp ($m.BaseName + "-clone")
            if ((Run "git" @("clone", "--quiet", "--no-checkout", $m.FullName, $c) (Join-Path $logs "restore.log")) -ne 0) { Fail "clone from mirror $($m.Name)" }
            if ((Run "git" @("-C", $c, "fsck", "--connectivity-only", "--no-progress") (Join-Path $logs "restore.log")) -ne 0) { Fail "git fsck on the clone of $($m.Name)" }
            $head = (& git -C $c log -1 --format="%h %cs %s" 2>$null)
            Note "restore: $($m.Name) clone + fsck OK, default branch at $head"
        }

        $data = Join-Path $tmp "pgdata"
        $pg = $tools.Pg
        if ((Run (Join-Path $pg "initdb.exe") @("-D", $data, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--locale=C") (Join-Path $logs "restore.log")) -ne 0) { Fail "initdb for the restore test" }
        # pg_ctl, not postgres.exe: postgres refuses an admin account, pg_ctl drops to a restricted token. Started via
        # Start-Process (no captured pipes) so the server does not inherit and hold this script's output handles.
        # WaitForExit, not -Wait: -Wait also waits for the server pg_ctl leaves running.
        $ctlArgs = "start -w -D `"$data`" -l `"$(Join-Path $logs 'restore-postgres.log')`" -o `"-p $TestPort -c listen_addresses=127.0.0.1`""
        (Start-Process -FilePath (Join-Path $pg "pg_ctl.exe") -ArgumentList $ctlArgs -WindowStyle Hidden -PassThru).WaitForExit(120000) | Out-Null
        $ready = $false
        for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
            & (Join-Path $pg "pg_isready.exe") -h 127.0.0.1 -p $TestPort -U postgres -q
            if ($LASTEXITCODE -eq 0) { $ready = $true } else { Start-Sleep -Milliseconds 500 }
        }
        if (-not $ready) { Fail "the restore-test Postgres did not start" }
        try {
            & (Join-Path $pg "createdb.exe") -h 127.0.0.1 -p $TestPort -U postgres vyx_restore
            $rc = Run (Join-Path $pg "pg_restore.exe") @("-h", "127.0.0.1", "-p", "$TestPort", "-U", "postgres", "-d", "vyx_restore", "--no-owner", "--no-privileges", "-j", "4", $dump) (Join-Path $logs "pg_restore.log")
            $errs = @(Get-Content (Join-Path $logs "pg_restore.log") -ErrorAction SilentlyContinue | Where-Object { $_ -match "error:" })
            $got = Count-Rows (Join-Path $pg "psql.exe") "postgresql://postgres@127.0.0.1:$TestPort/vyx_restore"
            $line = ($Tables | ForEach-Object { "$_ $($got[$_]) (live $($live[$_]))" }) -join ", "
            $bad = @($Tables | Where-Object { $null -eq $got[$_] -or $got[$_] -ne $live[$_] })
            Note "restore: pg_restore exit $rc, $($errs.Count) error line(s); rows $line"
            if ($errs.Count) { $errs | Select-Object -First 5 | ForEach-Object { Note "restore:   $_" } }
            if ($bad.Count) { Note "restore: WARNING row counts differ for $($bad -join ', ') (rows written between the count and the dump, or a failed restore: check logs\pg_restore.log)" }
            if (@($Tables | Where-Object { $null -eq $got[$_] }).Count) { Fail "restore test: tables missing after pg_restore" }
        } finally {
            (Start-Process -FilePath (Join-Path $pg "pg_ctl.exe") -ArgumentList "stop -m fast -D `"$data`"" -WindowStyle Hidden -PassThru).WaitForExit(60000) | Out-Null
        }
    } finally {
        Start-Sleep -Seconds 1
        Remove-Tree $tmp
    }
}

# ---------- encrypt ----------
function Encrypt($tools) {
    Step "encrypting (7z, AES-256, file names hidden)"
    $needGB = [math]::Ceiling((SizeMB $Folder) / 1024) + 2
    if ((FreeGB) -lt $needGB) { Fail "the archive needs ~$needGB GB free on C:, only $(FreeGB) GB" }
    $p1 = Read-Host "Archive password" -AsSecureString
    $p2 = Read-Host "Repeat password" -AsSecureString
    $b1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1)
    $b2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2)
    try {
        $pw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b1)
        if ($pw -ne [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b2)) { Fail "the passwords differ" }
        if ($pw.Length -lt 12) { Fail "use at least 12 characters" }
        if (Test-Path $Archive) { Remove-Item -Force $Archive }
        & $tools.SevenZip a -t7z -mhe=on -mx=1 "-p$pw" $Archive "$Folder\*" | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "7-Zip could not write $Archive" }
        & $tools.SevenZip t "-p$pw" $Archive | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail "7-Zip test of $Archive failed: the plain folder is kept" }
    } finally {
        $pw = $null
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b1)
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b2)
    }
    Copy-Item (Join-Path $Folder "MANIFEST.txt") "$Archive.manifest.txt"
    Remove-Tree $Folder
    $hash = (Get-FileHash $Archive -Algorithm SHA256).Hash
    "$hash  $(Split-Path -Leaf $Archive)" | Set-Content "$Archive.sha256" -Encoding ASCII
    Get-ChildItem "C:\vyx-backup-*.7z" | Sort-Object Name -Descending | Select-Object -Skip $Keep | ForEach-Object {
        Remove-Item -Force $_.FullName, "$($_.FullName).sha256", "$($_.FullName).manifest.txt" -ErrorAction SilentlyContinue
        Write-Host "   removed old backup $($_.Name)"
    }
    Write-Host ""
    Write-Host "archive: $Archive"
    Write-Host ("size:    {0:N1} GB" -f ((Get-Item $Archive).Length / 1GB))
    Write-Host "sha256:  $hash"
    Write-Host "C: free: $(FreeGB) GB"
}

$tools = Ensure-Tools
Stage $tools
if ($StageOnly) { Write-Host "staged in $Folder (not encrypted yet: rerun without -StageOnly to encrypt)"; exit 0 }
Encrypt $tools
