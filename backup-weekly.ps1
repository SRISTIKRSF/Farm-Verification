# Sristi Farm Verification - weekly backup runner
#
# WHY THIS EXISTS
# ---------------
# backup.js is a good backup tool that nothing was running. Before this script
# the last full backup was 29 July 2026 - fifteen days of fieldwork that a
# database accident would simply have erased.
#
# This wrapper does three things backup.js deliberately does not:
#   1. writes an audit line to _backups\backup-log.txt on every run, pass or
#      fail, so a backup that has been quietly failing for a month is visible;
#   2. proves a NEW file actually appeared (a script that exits 0 without
#      writing anything is the classic silent backup failure);
#   3. reports how much disk the backup folder now holds.
#
# WHAT IT DOES NOT DO - ON PURPOSE
# --------------------------------
# It never deletes an old backup. Pruning is deletion, deletion is data loss,
# and that is a decision for a person, not a timer. When the folder gets large
# the log says so and someone chooses what goes.
#
# It never commits anything to git. The repo is PUBLIC and these files contain
# every farmer's name and phone number.
#
# USAGE
#   powershell -ExecutionPolicy Bypass -File backup-weekly.ps1
# Registered as a scheduled task by setup-backup-task.ps1.

$ErrorActionPreference = 'Stop'

$AppDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutDir  = Join-Path $AppDir '_backups'
$LogFile = Join-Path $OutDir 'backup-log.txt'
$Node    = 'C:\Program Files\nodejs\node.exe'

function Write-Log([string]$Line) {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $text  = "$stamp  $Line"
    Add-Content -Path $LogFile -Value $text -Encoding utf8
    Write-Output $text
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# What the newest backup was BEFORE this run, so we can prove a new one landed.
$before = Get-ChildItem -Path $OutDir -Filter 'prakrutik_kheti_*.json' -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1

Write-Log 'RUN     starting weekly backup'

if (-not (Test-Path $Node)) {
    Write-Log "FAIL    node.exe not found at $Node"
    exit 1
}

# backup.js shells out to the firebase CLI, which reads its credentials from
# C:\Users\<user>\.config\configstore. The task therefore has to run AS the
# signed-in user - which is how setup-backup-task.ps1 registers it.
$out = ''
try {
    Push-Location $AppDir
    $out = & $Node 'backup.js' 2>&1 | Out-String
    $code = $LASTEXITCODE
} catch {
    $out = $_.Exception.Message
    $code = 1
} finally {
    Pop-Location
}

if ($code -ne 0) {
    Write-Log 'FAIL    backup.js exited non-zero. Nothing trustworthy was written.'
    foreach ($line in ($out -split "`r?`n" | Where-Object { $_ -match '\S' } | Select-Object -First 6)) {
        Write-Log "        $line"
    }
    exit 1
}

# backup.js already verifies UTF-8 and hunts for mojibake. What it cannot tell
# us is whether THIS run produced anything - so check for a genuinely new file.
$after = Get-ChildItem -Path $OutDir -Filter 'prakrutik_kheti_*.json' -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1

if (-not $after -or ($before -and $after.Name -eq $before.Name)) {
    Write-Log 'FAIL    backup.js reported success but no new file appeared.'
    exit 1
}

$sizeMb  = [math]::Round($after.Length / 1MB, 2)
$all     = Get-ChildItem -Path $OutDir -Filter '*.json' -ErrorAction SilentlyContinue
$totalMb = [math]::Round((($all | Measure-Object -Property Length -Sum).Sum) / 1MB, 2)

Write-Log "OK      $($after.Name)  $sizeMb MB  (verified UTF-8, no mojibake)"
Write-Log "        $($all.Count) backups on disk, $totalMb MB total"

# Nothing is deleted automatically. Just say when it is worth a look.
if ($totalMb -gt 2048) {
    Write-Log '        NOTE: backup folder is over 2 GB. Worth deciding which old ones to keep.'
}

exit 0
