# Pauses the Timon background service while the installer replaces its files.
# Run by installer.nsh (timonPauseService), never by hand: elevated when
# Windows grants it, and once more without elevation when it does not.
#
# Why elevated: the service runs under a Task Scheduler S4U logon, in session 0.
# The per-user installer sees those Timon.exe processes (same user) but cannot
# end them, and looped on "Timon cannot be closed" (0.1.2-rc.2 update,
# 27/09/2026). The task is disabled first: its 5-minute repeating trigger would
# otherwise start the daemon again from half-replaced files.
#
# Why it also runs unelevated: an account Windows refuses S4U for (a standard
# account on an Entra-joined PC) gets an Interactive task, which runs the daemon
# in the user's own session; that user may disable the task and end the daemon
# without elevation. Left running, the daemon kept its files open while the
# installer replaced them, and the next launch failed on a missing `ffmpeg.dll`
# (0.1.5 update, 21/10/2026).
#
# The first run (stop phase) ends the service and starts a detached copy of
# itself (resume phase), which waits for the installer to exit and then enables
# and starts the task again if it still exists: an uninstall deletes it.
#
# The stop phase answers the installer with its exit code: 0 when nothing of
# Timon runs any more, 5 when something still does. The installer then asks
# to try again or stops, and never replaces the files of a running daemon.
param(
  # The installer's process: the resume waits for it, and its owner is the
  # account whose Timon this is.
  [Parameter(Mandatory = $true)][int]$InstallerPid,
  [Parameter(Mandatory = $true)][string]$Exe,
  # The application directory: what remains of this installation is found by
  # the paths under it on a command line. Empty: only the daemon is ended.
  [string]$InstallDir = '',
  # The data directory of the account that runs the installer, which names it:
  # under another account's elevation, this script's own profile is not it.
  [string]$TimonHome = '',
  # The journal of both phases. The stop phase computes it and hands it to the
  # resume phase, whose environment comes from WMI, not from the installer.
  [string]$Log = '',
  [switch]$Resume
)
$task = 'TimonOrchestrator'
# Exit code of the stop phase when something of Timon still runs. The installer
# (installer.nsh, TIMON_SERVICE_STILL_RUNNING) and the host adapter
# (PROCESSES_REMAIN) read the same number.
$stillRunning = 5
if (-not $TimonHome -and $env:USERPROFILE) { $TimonHome = Join-Path $env:USERPROFILE '.timon' }
if (-not $Log -and $TimonHome) { $Log = Join-Path $TimonHome 'tmp\timon-service-pause.log' }
$note = {
  param([string]$text)
  if (-not $Log) { return }
  try {
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) -ErrorAction Stop
    # UTF-8: Windows PowerShell appends in the ANSI code page otherwise, and the
    # diagnostic report reads this file as UTF-8.
    Add-Content -LiteralPath $Log -Value ('{0} {1}' -f (Get-Date -Format o), $text) -Encoding UTF8 -ErrorAction Stop
  } catch { }
}
$taskState = {
  try {
    [string](Get-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop).State
  } catch {
    if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { 'not registered' } else { "unreadable ($($_.Exception.Message))" }
  }
}

# Not under SilentlyContinue: it hid why a killed installer left the task
# Disabled and the daemon stopped (VM, 06/11/2026). Each call reports its own
# error, is tried again, and the last failure is written to $Log.
if ($Resume) {
  Wait-Process -Id $InstallerPid -ErrorAction Ignore
  # Wait-Process gives up at once on a process it may not open (an elevated
  # installer seen from an unelevated resume): poll until no installer runs.
  while (Get-Process -Id $InstallerPid -ErrorAction Ignore) { Start-Sleep -Seconds 2 }
  $failure = ''
  foreach ($attempt in 1..3) {
    try {
      $state = (Get-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop).State
      # The state is read, not assumed: a task an earlier pause left Disabled
      # is enabled too, and a running one is not started twice.
      if ($state -eq 'Disabled') { Enable-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop | Out-Null }
      if ($state -ne 'Running') { Start-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop }
      if ((Get-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop).State -eq 'Disabled') { throw 'the task is still disabled' }
      $failure = ''
      break
    } catch {
      # An uninstall deleted the task: nothing to resume.
      if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { $failure = ''; break }
      $failure = "attempt $attempt`: $($_.Exception.Message)"
      if ($attempt -lt 3) { Start-Sleep -Seconds 5 }
    }
  }
  if ($failure) { & $note "resume: could not enable and start $task ($failure)" } else { & $note ("resume: the installer exited, task {0} is {1}" -f $task, (& $taskState)) }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction Ignore
  exit 0
}

# The stop phase writes what it found and what it did to $Log, call by call.
# It used to run with every error silenced and every output discarded: when it
# ended nothing at all on a tester's PC (0.1.7 to 0.1.8 update), no file said
# so, and the cause had to be read out of the installer. A call that fails is
# written down and the phase goes on: the net at its end decides.
# Kept small: one run of the installer writes a few dozen lines.
if ($Log) {
  try {
    if ((Get-Item -LiteralPath $Log -ErrorAction Stop).Length -gt 1MB) { Remove-Item -LiteralPath $Log -Force -ErrorAction Stop }
  } catch { }
}
$elevated = $false
try {
  $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

# Whose Timon this is: the owner of the installer's process, by SID. Never a
# name. The installer passed `-User` built from the NSIS form that is replaced
# when the installer is COMPILED, so every installer carried the account of the
# build machine: on a tester's PC the comparison was always false, nothing was
# ended, and the previous daemon outlived the update holding its port
# (0.1.7 to 0.1.8). A SID also holds for a Microsoft Entra account, and for an
# elevation granted by another account, where this script runs as the
# administrator while the installer still belongs to the user.
$sidOf = {
  param($process)
  try { (Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop).Sid } catch { $null }
}
$account = $null
$accountSource = 'the installer process'
$installer = $null
try { $installer = Get-CimInstance Win32_Process -Filter "ProcessId=$InstallerPid" -ErrorAction Stop } catch { }
if ($installer) { $account = & $sidOf $installer }
# The installer could not be read (it is elevated, this run is not): this
# process then runs as the very account that started it.
if (-not $account) {
  $account = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $accountSource = 'this process, the installer could not be read'
}
$mine = { param($process) $account -and ((& $sidOf $process) -eq $account) }
& $note ("pause: start, elevated: {0}, installer pid {1}, account SID {2} (from {3}), installation '{4}', data '{5}'" -f $elevated, $InstallerPid, $account, $accountSource, $InstallDir, $TimonHome)

# Disabled first: its 5-minute repeating trigger would otherwise start the
# daemon again from half-replaced files.
& $note ("pause: task {0} is {1}" -f $task, (& $taskState))
try {
  $null = Disable-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop
  & $note 'pause: task disabled'
} catch { & $note "pause: task not disabled: $($_.Exception.Message)" }
try {
  Stop-ScheduledTask -TaskName $task -TaskPath '\' -ErrorAction Stop
  & $note 'pause: task stopped'
} catch { & $note "pause: task not stopped: $($_.Exception.Message)" }
& $note ("pause: task {0} is now {1}" -f $task, (& $taskState))

# The daemon runs on the Node the package ships (resources\node\node.exe);
# a package before it ran it on $Exe as Node. An update from one to the other
# finds either, so both are ours.
$runtimes = @($Exe, 'node.exe')
# The path, never the command line: a command line can carry a secret.
$describe = {
  param($process)
  $path = 'path unreadable'
  if ($process.ExecutablePath) { $path = $process.ExecutablePath }
  "pid $($process.ProcessId), $($process.Name), session $($process.SessionId), $path"
}
$processes = {
  try {
    @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    & $note "pause: the process list could not be read: $($_.Exception.Message)"
    @()
  }
}
$end = {
  param($process, [string]$what)
  & $note ("pause: found {0}: {1}" -f $what, (& $describe $process))
  $said = (& taskkill.exe /F /T /PID $process.ProcessId 2>&1 | ForEach-Object { "$_".Trim() }) -join ' '
  & $note ("pause: taskkill of pid {0} ended with {1}: {2}" -f $process.ProcessId, $LASTEXITCODE, $said)
}

# Stop-ScheduledTask ends the launcher and leaves its daemon orphaned: end the
# launcher's tree, then every daemon of this account it left behind, in
# whatever session it runs (session 0 for S4U, the user's own for an
# Interactive task) and wherever it is installed. The daemon names its entry
# point on its command line; the window (no boot.js) is left to the installer's
# own "close the application".
# A launcher is the batch of task revisions 2 to 5 (cmd.exe), or, since
# revision 6, the program whose command line names the launcher configuration:
# the Node of the launcher script, or Timon.exe --timon-service in the session
# (LAUNCHER_PROGRAMS, host/service-install.ts). Never this script itself.
$launcherPrograms = @('cmd.exe', 'node.exe', 'timon.exe', 'powershell.exe', 'electron.exe')
$launchers = @(& $processes | Where-Object {
  $launcherPrograms -contains $_.Name -and $_.ProcessId -ne $PID -and $_.CommandLine -and
  ($_.CommandLine.ToLowerInvariant().Contains('\run\timon-service.cmd') -or
   $_.CommandLine.ToLowerInvariant().Contains('\run\timon-service.json')) -and (& $mine $_)
})
& $note ("pause: {0} service launcher(s) of this account" -f $launchers.Count)
$launchers | ForEach-Object { & $end $_ 'a service launcher' }
$daemons = @(& $processes | Where-Object {
  $runtimes -contains $_.Name -and $_.CommandLine -and
  $_.CommandLine.ToLowerInvariant().Contains('\dist\boot.js')
})
& $note ("pause: {0} daemon(s) by entry point" -f $daemons.Count)
foreach ($daemon in $daemons) {
  if (& $mine $daemon) {
    & $end $daemon 'a daemon of this account'
  } else {
    # Written down: an owner that does not match is how the pause once ended nothing.
    & $note ("pause: not this account's (owner SID {0}), left to the installation sweep: {1}" -f (& $sidOf $daemon), (& $describe $daemon))
  }
}

# What runs from THIS installation is ended whoever owns it: the installer is
# about to replace those very files, and the path alone says they are Timon's.
# That is the Node the package ships, wherever its script lives, and $Exe or
# node.exe running a file of the installation as Node: the daemon, its web
# server (resources\app\...\server.cjs), the browser helper of a mission
# (bin\browser-mcp.mjs), the terminal host (detached on purpose). No tree
# reaches the last three once the daemon is gone, and they kept the installer
# looping on "Timon cannot be closed" after the user had quit the app (0.1.5
# update, 22/10/2026). The window and Electron's own helpers (--type=) carry
# none of these paths. Two passes: a child whose parent went first in a pass
# has no tree left to be ended with.
$root = $InstallDir.TrimEnd('\').ToLowerInvariant()
$shipped = "$root\resources\node\"
$needles = @("$root\resources\orchestrator\", "$root\resources\app\")
$fromInstallation = {
  param($process)
  if (-not $root -or $process.ProcessId -eq $PID) { return $false }
  if ($process.ExecutablePath -and $process.ExecutablePath.ToLowerInvariant().StartsWith($shipped)) { return $true }
  if ($runtimes -notcontains $process.Name -or -not $process.CommandLine -or $process.CommandLine.Contains('--type=')) { return $false }
  $line = $process.CommandLine.ToLowerInvariant()
  foreach ($needle in $needles) { if ($line.Contains($needle)) { return $true } }
  $false
}
$ofInstallation = { & $processes | Where-Object { & $fromInstallation $_ } }
foreach ($pass in 1..2) {
  $found = @(& $ofInstallation)
  & $note ("pause: installation sweep {0}: {1} process(es)" -f $pass, $found.Count)
  if ($found.Count -eq 0) { break }
  $found | ForEach-Object { & $end $_ 'a process of this installation' }
  Start-Sleep -Seconds 1
}

# The installer deletes its plugins directory on exit: the resume phase runs
# from its own copy.
$copy = Join-Path ([IO.Path]::GetTempPath()) ("timon-service-resume-{0}.ps1" -f $InstallerPid)
# "Retry" in the installer runs this phase again: one resume already waits for
# that installer, and a second would only do the same thing twice.
$waiting = @(& $processes | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.Contains($copy) })
if ($waiting.Count -gt 0) {
  & $note ("pause: the resume already waits for the installer (pid {0})" -f $waiting[0].ProcessId)
} else {
  try {
    Copy-Item -LiteralPath $PSCommandPath -Destination $copy -Force -ErrorAction Stop
  } catch { & $note "pause: the resume script could not be copied: $($_.Exception.Message)" }
  $powershell = Join-Path $PSHOME 'powershell.exe'
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$copy`" -Resume " +
    "-InstallerPid $InstallerPid -Exe `"$Exe`""
  # An empty quoted value is dropped from a -File command line, and -Log would
  # then swallow nothing and fail the whole resume.
  if ($Log) { $arguments += " -Log `"$Log`"" }
  # A child of this process stays in its job object and dies with it: an SSH
  # session's job took the waiting resume down with it (VM, 06/11/2026). WMI
  # creates the process from its own service, outside any job, with this
  # process's token (the elevation it holds) and its window hidden from the start.
  $created = $null
  try {
    $startup = New-CimInstance -CimClass (Get-CimClass -ClassName Win32_ProcessStartup) -Property @{ ShowWindow = [uint16]0 } -ClientOnly
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -ErrorAction Stop -Arguments @{
      CommandLine = "`"$powershell`" $arguments"; ProcessStartupInformation = $startup
    }
  } catch { & $note "pause: WMI could not start the resume: $($_.Exception.Message)" }
  if ($created -and $created.ReturnValue -eq 0) {
    & $note ("pause: resume started (pid {0})" -f $created.ProcessId)
  } else {
    $result = 'no answer'
    if ($created) { $result = $created.ReturnValue }
    & $note ("pause: WMI could not start the resume (result {0}), started as a child" -f $result)
    try {
      Start-Process -WindowStyle Hidden -FilePath $powershell -ArgumentList $arguments -ErrorAction Stop
    } catch { & $note "pause: the resume could not be started at all, the task stays disabled: $($_.Exception.Message)" }
  }
}

# The net. Everything above can miss: an elevation that was refused leaves a
# session-0 daemon out of reach, and a filter can be wrong again. Before the
# installer replaces a single file, what is left is listed once more: the
# processes of this installation, and whoever listens on the daemon's port.
# Windows renames a running executable without complaint, so a daemon left
# alive keeps serving the old version from memory, holds the port and the data
# directory, and the new one never starts (0.1.7 to 0.1.8 update).
$port = 3010
$portSource = 'the packaged default'
if ($TimonHome) {
  try {
    $config = Get-Content -LiteralPath (Join-Path $TimonHome 'timon.config.json') -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $configured = [int]$config.daemon.listen.port
    if ($configured -gt 0) { $port = $configured; $portSource = 'timon.config.json' }
  } catch { $portSource = "the packaged default, timon.config.json could not be read ($($_.Exception.Message))" }
}
$remaining = {
  $left = @(& $ofInstallation)
  $owners = @()
  # Read without elevation too, unlike a command line: it is what still sees a
  # session-0 daemon from an installer that was refused its elevation. No
  # listener at all is an error to this command, and the expected answer here.
  try { $owners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique) } catch { }
  foreach ($id in $owners) {
    $listener = $null
    try { $listener = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop } catch { }
    if (-not $listener -or $runtimes -notcontains $listener.Name) { continue }
    if (@($left | Where-Object { $_.ProcessId -eq $listener.ProcessId }).Count -gt 0) { continue }
    # A command line that cannot be read is a process of session 0 seen without
    # elevation: on this port and under this name, the daemon. One that can be
    # read counts when it is a daemon, unless it is proven to be another
    # account's; a foreign program on the port is not Timon's to wait for.
    if (-not $listener.CommandLine) { $left += $listener; continue }
    if (-not $listener.CommandLine.ToLowerInvariant().Contains('\dist\boot.js')) { continue }
    $owner = & $sidOf $listener
    if (-not $owner -or $owner -eq $account) { $left += $listener }
  }
  $left
}
& $note ("pause: checking what is left, daemon port {0} (from {1})" -f $port, $portSource)
$left = @()
foreach ($check in 1..5) {
  $left = @(& $remaining)
  if ($left.Count -eq 0) { break }
  # A process that was just ended takes a moment to leave the list.
  if ($check -lt 5) { Start-Sleep -Seconds 1 }
}
if ($left.Count -gt 0) {
  foreach ($process in $left) { & $note ("pause: still running: {0}" -f (& $describe $process)) }
  & $note ("pause: exit {0}, {1} process(es) of Timon still run: the installer must not go on" -f $stillRunning, $left.Count)
  exit $stillRunning
}
& $note 'pause: exit 0, nothing of Timon runs any more'
exit 0
