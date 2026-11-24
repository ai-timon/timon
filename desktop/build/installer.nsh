; Windows installer hook (step 5.7.2).
;
; This file no longer REGISTERS the daemon service, and that is the point.
;
; It did until 12/09/2026, by calling `timon service install` from
; `customInstall`. At that instant no `timon.config.json` exists yet, so the
; CLI answered with the daemon's built-in defaults — which describe a developer
; machine. The registered task therefore ran the daemon on port 3000 with
; `app.enabled = false` and `profile = linux-desktop`: a service that serves no
; UI, on a port the desktop shell does not look at, while the first-run screen
; reported "the service is installed" and refused to install the real one.
;
; The installer cannot know those values. The shell decides them on the first
; launch (3010 / 3110, portable until the user says otherwise) and the first-run
; screen registers the service once they exist — with the right ports, the right
; profile and the durable runtime path. That screen already installs, already
; explains, and already blocks until the service answers. One place, informed,
; instead of two, one of them guessing.
;
; Uninstall still removes the task: whoever registered it, it must not outlive
; the application. `timon service uninstall` leaves TIMON_HOME — missions,
; agents, database — exactly where the user left it. The invariant is enforced
; in the CLI; it is repeated here because this file is far from the code that
; holds it. The CLI runs on the Node the package ships (resources\node), so no
; Node installation is required on the machine. The app's executable itself no
; longer runs as Node (RunAsNode fuse off): without that Node, only the direct
; cleanup below remains.
;
; The payload unpacks to ~500 MB over tens of thousands of files, and an install
; that crawls between two percents for minutes reads as a freeze — it was
; reported stuck at 60% on 12/09/2026. Showing the file list is NOT the answer,
; tempting as it looks: `installSection.nsh` opens on `SetDetailsPrint none`,
; and the payload travels through `Nsis7z::Extract` then `CopyFiles /SILENT`,
; neither of which names a file. `ShowInstDetails show` would only open an empty
; white box for the whole extraction — a worse signal than the bar on its own.
; `hide` puts it behind a "show details" button instead.
!macro customHeader
  ShowInstDetails hide
!macroend

!include "StdUtils.nsh"

; The Timon service runs under a Task Scheduler S4U logon, in session 0. A
; per-user installer cannot end those Timon.exe, and the stock check looped on
; "Timon cannot be closed" (0.1.2-rc.2 update, 27/09/2026). rc.3 tried to detect
; them with `tasklist /FI "SESSION eq 0"` from the unelevated installer and saw
; nothing. So no detection any more: whenever Timon is already installed or a
; service launcher exists, the installer asks for elevation as it opens, and
; timon-service-pause.ps1 pauses the service until the installer exits.
;
; Nothing here may be written in the NSIS form that reads an environment
; variable between percent signs: NSIS replaces it when the installer is
; COMPILED, with the value of the build machine. The script was told the build
; account that way and ended nothing on anyone else's PC (0.1.7 to 0.1.8
; update). It now reads the account from the installer's own process; a value
; of the user's machine is read while the installer runs, with ReadEnvStr.
;
; The script answers with its exit code, and only its 0 lets the installer go
; on: nothing of Timon runs any more. TIMON_SERVICE_STILL_RUNNING means that
; something still does (a refused elevation leaves a session-0 daemon out of
; reach). Windows renames a running executable without complaint, so the files
; would be replaced under a daemon that keeps serving the old version from
; memory and holds the port, and the new one could not start.
;
; A script that did not run, or that ended with any other code, has checked
; nothing: TIMON_SERVICE_PAUSE_FAILED. It is the same stop. It used to let the
; installer through, on the grounds that a PC that forbids PowerShell must
; still be able to install Timon: that PC is exactly where nothing has looked
; at the port or the processes, so the daemon may well be alive.
;
; Either way, with a window the person tries again or cancels; without one
; (/S), the installer exits with that code, which the app reports as a failed
; update (update-installer.ts).
!ifndef TIMON_SERVICE_STILL_RUNNING
  !define TIMON_SERVICE_STILL_RUNNING 5
!endif
!ifndef TIMON_SERVICE_PAUSE_FAILED
  !define TIMON_SERVICE_PAUSE_FAILED 6
!endif

!macro timonPauseService
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  ; An update's uninstaller runs after the installer already paused it; under
  ; /S nothing may prompt. One exception: the update Timon starts from its own
  ; window (/S --updated --force-run --timon-app-update, update-installer.ts).
  ; The person asked for it, and the service must not hold the files the
  ; installer replaces, so the same pause runs, with its elevation prompt.
  StrCpy $2 "pause"
  ${If} ${Silent}
  ${OrIf} ${isUpdated}
    StrCpy $2 "skip"
    ${StdUtils.TestParameter} $1 "timon-app-update"
    ${If} $1 == "true"
      StrCpy $2 "pause"
    ${EndIf}
  ${EndIf}
  !ifndef BUILD_UNINSTALLER
  !ifndef INSTALL_MODE_PER_ALL_USERS
  !ifndef ONE_CLICK
    ; A silent update of a per-machine install elevates itself in its install
    ; section and runs again elevated (UAC_RunElevated): that instance pauses
    ; the service, without a second prompt from this one.
    ${If} ${Silent}
    ${AndIf} $hasPerMachineInstallation == "1"
    ${AndIfNot} ${UAC_IsAdmin}
      StrCpy $2 "skip"
    ${EndIf}
  !endif
  !endif
  !endif
  ${If} $2 == "pause"
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${OrIf} ${FileExists} "$PROFILE\.timon\run\timon-service.json"
    ${OrIf} ${FileExists} "$PROFILE\.timon\run\timon-service.cmd"
    ${OrIf} ${FileExists} "$PROFILE\.timon\run\timon-service.vbs"
      InitPluginsDir
      File /oname=$PLUGINSDIR\timon-service-pause.ps1 "${PROJECT_DIR}\build\timon-service-pause.ps1"
      ; The data directory, read on this machine while the installer runs.
      ReadEnvStr $3 TIMON_HOME
      ${If} $3 == ""
        StrCpy $3 "$PROFILE\.timon"
      ${EndIf}
      ${Do}
        System::Call 'kernel32::GetCurrentProcessId() i .r0'
        ${StdUtils.ExecShellWaitEx} $1 $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "runas" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\timon-service-pause.ps1" -InstallerPid $0 -Exe "${APP_EXECUTABLE_FILENAME}" -InstallDir "$INSTDIR" -TimonHome "$3"'
        ${If} $1 == "ok"
          ${StdUtils.WaitForProcEx} $0 $2
        ${Else}
          ; Refused elevation (a standard account on a managed PC, 21/10/2026):
          ; the same script, unelevated, still pauses the user's own Interactive
          ; task and ends the daemon in the user's session. A session-0 S4U
          ; service is out of its reach, and the script says so.
          ${StdUtils.ExecShellWaitEx} $1 $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "open" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\timon-service-pause.ps1" -InstallerPid $0 -Exe "${APP_EXECUTABLE_FILENAME}" -InstallDir "$INSTDIR" -TimonHome "$3"'
          ${If} $1 == "ok"
            ${StdUtils.WaitForProcEx} $0 $2
          ${EndIf}
        ${EndIf}
        ; Only the script's own "nothing of Timon runs any more" goes on.
        ${If} $1 == "ok"
        ${AndIf} $0 == 0
          ${ExitDo}
        ${EndIf}
        StrCpy $4 ${TIMON_SERVICE_PAUSE_FAILED}
        ${If} $1 != "ok"
          ; Still the installer's own process id: the script never ran.
          StrCpy $0 "not run"
        ${ElseIf} $0 == ${TIMON_SERVICE_STILL_RUNNING}
          StrCpy $4 ${TIMON_SERVICE_STILL_RUNNING}
        ${EndIf}
        ${If} $4 == ${TIMON_SERVICE_PAUSE_FAILED}
          ; The script wrote nothing, or not to its end: its journal says so
          ; from here, for the diagnostic report.
          CreateDirectory "$3\tmp"
          ClearErrors
          FileOpen $5 "$3\tmp\timon-service-pause.log" a
          ${IfNot} ${Errors}
            FileSeek $5 0 END
            FileWrite $5 "installer: the service pause did not complete (PowerShell: $1, result: $0), nothing is installed$\r$\n"
            FileClose $5
          ${EndIf}
          ClearErrors
        ${EndIf}
        ${If} ${Silent}
          SetErrorLevel $4
          Quit
        ${EndIf}
        ${If} $4 == ${TIMON_SERVICE_STILL_RUNNING}
          ${If} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Timon is still running in the background and could not be stopped.$\r$\n$\r$\nChoose Retry and accept the Windows permission prompt, or restart the computer and run this again. No file has been changed.$\r$\n$\r$\nDetails: $3\tmp\timon-service-pause.log" IDCANCEL`
            SetErrorLevel $4
            Quit
          ${EndIf}
        ${Else}
          ${If} ${Cmd} `MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "The check that Timon is stopped in the background did not run: Windows PowerShell failed (PowerShell: $1, result: $0).$\r$\n$\r$\nChoose Retry, or restart the computer and run this again. If it keeps failing, Windows PowerShell may be blocked on this computer. No file has been changed.$\r$\n$\r$\nDetails: $3\tmp\timon-service-pause.log" IDCANCEL`
            SetErrorLevel $4
            Quit
          ${EndIf}
        ${EndIf}
      ${Loop}
    ${EndIf}
  ${EndIf}
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customInit
  !insertmacro timonPauseService
!macroend

!macro customUnInit
  !insertmacro timonPauseService
!macroend

!macro timonCliPath action
  InitPluginsDir
  ; Compile the helper into both installers: INSTDIR may already be deleted.
  File /oname=$PLUGINSDIR\timon-cli-path.ps1 "${PROJECT_DIR}\..\orchestrator\src\host\windows-cli-path.ps1"
  nsExec::ExecToLog /TIMEOUT=30000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\timon-cli-path.ps1" -Action ${action} -InstallDirectory "$INSTDIR" -Scope "$installMode"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Timon CLI PATH update failed (result: $0)."
  ${EndIf}
  SendMessage 0xffff 0x001A 0 "STR:Environment" /TIMEOUT=5000
!macroend

; Node.js and Git, the prerequisites the onboarding otherwise asks for. Once
; the service runs the daemon in session 0, the onboarding's Install buttons
; cannot reach the user for permission, and the Node.js MSI is machine-wide;
; the installer runs in the user's session and asks once (27/09/2026). Nothing
; under /S, and a failure only leaves the onboarding to offer them again.
!macro timonPrerequisites
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  ${IfNot} ${Silent}
    StrCpy $3 ""
    nsExec::Exec '"$SYSDIR\cmd.exe" /d /c where node'
    Pop $0
    ${If} $0 != 0
    ${AndIfNot} ${FileExists} "$PROGRAMFILES64\nodejs\node.exe"
      StrCpy $3 "$3 -Node"
    ${EndIf}
    nsExec::Exec '"$SYSDIR\cmd.exe" /d /c where git'
    Pop $0
    ${If} $0 != 0
    ${AndIfNot} ${FileExists} "$PROGRAMFILES64\Git\cmd\git.exe"
      StrCpy $3 "$3 -Git"
    ${EndIf}
    ${If} $3 != ""
      SetDetailsPrint both
      DetailPrint "Installing the prerequisites (Node.js, Git). Windows asks for permission; this can take a few minutes..."
      InitPluginsDir
      File /oname=$PLUGINSDIR\timon-prerequisites.ps1 "${PROJECT_DIR}\build\timon-prerequisites.ps1"
      StrCpy $4 "$TEMP\timon-prerequisites.log"
      Delete $4
      ${StdUtils.ExecShellWaitEx} $1 $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "runas" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\timon-prerequisites.ps1"$3 -Log "$4"'
      ${If} $1 == "ok"
        ${StdUtils.WaitForProcEx} $0 $2
        ${If} $0 == 0
          DetailPrint "Prerequisites installed."
        ${Else}
          DetailPrint "Some prerequisites were not installed (result $0, log $4). Timon's setup screen offers them again."
        ${EndIf}
      ${Else}
        DetailPrint "Prerequisites skipped ($1). Timon's setup screen offers them again."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customInstall
  Push $0
  !insertmacro timonCliPath install
  Pop $0
  !insertmacro timonPrerequisites
!macroend

!macro customUnInstall
  Push $0
  Push $1
  Push $2
  ; Updates run this uninstaller with /S --updated and do not register the
  ; Windows task again, so preserve it for the next logon.
  ${If} ${isUpdated}
    Goto timon_task_done
  ${EndIf}
  !insertmacro timonCliPath remove
  ${IfNot} ${Silent}
    SetDetailsPrint both
  ${EndIf}
  ; electron-builder calls this AFTER removing (or moving, on update) INSTDIR.
  ; Keep the CLI for partial removals, but never depend on its availability.
  SetOutPath $TEMP
  StrCpy $0 "missing or skipped"
  ${If} ${Silent}
    Goto timon_task_fallback
  ${EndIf}
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 timon_task_fallback
  IfFileExists "$INSTDIR\resources\orchestrator\bin\timon" 0 timon_task_fallback
  ; The CLI runs on the Node the package ships, and on nothing else: the app's
  ; executable no longer runs as Node, so a missing node.exe goes straight to
  ; the direct cleanup instead of opening a window from the uninstaller.
  IfFileExists "$INSTDIR\resources\node\node.exe" 0 timon_task_fallback
  nsExec::ExecToLog /TIMEOUT=30000 '"$INSTDIR\resources\node\node.exe" "$INSTDIR\resources\orchestrator\bin\timon" service uninstall'
  Pop $0
  ; The CLI can return zero even when its elevated deletion failed, so the
  ; direct, idempotent cleanup also verifies that apparent success.

  timon_task_fallback:
  ${If} $0 != 0
    DetailPrint "Removing the Timon logon task directly (CLI result: $0)..."
  ${Else}
    DetailPrint "Verifying removal of the Timon logon task..."
  ${EndIf}
  ; Independent commands: /End may fail for an already stopped task.
  nsExec::ExecToLog /TIMEOUT=10000 '"$SYSDIR\schtasks.exe" /End /TN TimonOrchestrator'
  Pop $0
  nsExec::ExecToLog /TIMEOUT=10000 '"$SYSDIR\schtasks.exe" /Delete /TN TimonOrchestrator /F'
  Pop $0
  ${If} $0 != 0
    nsExec::ExecToLog /TIMEOUT=10000 '"$SYSDIR\schtasks.exe" /Query /TN TimonOrchestrator'
    Pop $1
    ${If} $1 == 0
      ; Per-user uninstallers need elevation to remove an elevated logon task.
      ; Unattended uninstall must be launched elevated; never prompt under /S.
      ${IfNot} ${Silent}
        DetailPrint "Windows permission is required to remove the Timon logon task."
        ${StdUtils.ExecShellWaitEx} $1 $2 "$SYSDIR\cmd.exe" "runas" '/d /s /c ""$SYSDIR\schtasks.exe" /End /TN TimonOrchestrator & "$SYSDIR\schtasks.exe" /Delete /TN TimonOrchestrator /F"'
        ${If} $1 == "ok"
          ${StdUtils.WaitForProcEx} $0 $2
        ${Else}
          StrCpy $0 $1
        ${EndIf}
      ${EndIf}
      ${If} $0 != 0
        DetailPrint "Warning: TimonOrchestrator could not be removed. Remove it from Task Scheduler with administrator rights."
      ${EndIf}
    ${Else}
      ; An absent task is harmless. Do not equate every query error with absence.
      DetailPrint "TimonOrchestrator is absent or cannot be queried (result: $1)."
    ${EndIf}
  ${EndIf}
  ; The task is gone: its launcher files go with it, as `timon service uninstall`
  ; does. A revision file left behind made the next install's desktop wait on a
  ; task that no longer existed (0.1.2-rc.5 reinstall, 27/09/2026).
  ${If} $0 == 0
    Delete "$PROFILE\.timon\run\service-revision"
    Delete "$PROFILE\.timon\run\timon-service.json"
    Delete "$PROFILE\.timon\run\timon-service.cmd"
    Delete "$PROFILE\.timon\run\timon-service.vbs"
    Delete "$PROFILE\.timon\run\session-witness.dpapi"
    Delete "$PROFILE\.timon\run\service-repair-declined"
  ${EndIf}
  DetailPrint "Timon data has been kept."
  ; Cleanup is best effort, including cancellation of UAC and an absent task.
  ClearErrors
  timon_task_done:
  Pop $2
  Pop $1
  Pop $0
!macroend
