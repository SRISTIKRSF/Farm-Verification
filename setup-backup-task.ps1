# Registers the weekly Farm Verification backup with Windows Task Scheduler.
# Run once. Safe to re-run - it replaces the existing task rather than adding
# a second copy.
#
#   powershell -ExecutionPolicy Bypass -File setup-backup-task.ps1
#
# To see it afterwards:      Get-ScheduledTask 'Sristi Farm Verification*'
# To run it now:             Start-ScheduledTask -TaskName 'Sristi Farm Verification - Weekly Backup'
# To stop it permanently:    Unregister-ScheduledTask -TaskName 'Sristi Farm Verification - Weekly Backup'

$ErrorActionPreference = 'Stop'

$AppDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script   = Join-Path $AppDir 'backup-weekly.ps1'
$TaskName = 'Sristi Farm Verification - Weekly Backup'

if (-not (Test-Path $Script)) { throw "backup-weekly.ps1 not found next to this script ($Script)" }

# -WindowStyle Hidden so a Monday morning does not start with a console window.
# -ExecutionPolicy Bypass because the file is local and unsigned.
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $Script + '"') `
    -WorkingDirectory $AppDir

# Monday 10:00. A weekday morning is when this laptop is reliably on, and it
# captures the weekend's fieldwork.
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '10:00'

# StartWhenAvailable is the setting that matters: if the laptop was off on
# Monday, the backup runs at the next opportunity instead of being skipped
# silently until the following week.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

# Runs AS the signed-in user, only while signed in. That is deliberate: the
# firebase CLI keeps its credentials in this user's profile
# (C:\Users\<user>\.config\configstore), so any other account would fail to
# authenticate. It also means no Windows password has to be stored anywhere.
$principal = New-ScheduledTaskPrincipal -UserId ("$env:USERDOMAIN\$env:USERNAME") -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Replaced the existing task."
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'Weekly verified backup of the Sristi Farm Verification database to _backups\. Writes an audit line to _backups\backup-log.txt on every run. Never deletes an old backup.' | Out-Null

$t = Get-ScheduledTask -TaskName $TaskName
$i = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Output ''
Write-Output ('Registered : ' + $t.TaskName)
Write-Output ('State      : ' + $t.State)
Write-Output ('Next run   : ' + $i.NextRunTime)
