# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

!define DESKTOP_LAUNCHER_STATUS_UNKNOWN 0
!define DESKTOP_LAUNCHER_STATUS_NOT_ENABLED 1
!define DESKTOP_LAUNCHER_STATUS_NOT_CHECKED 2
!define DESKTOP_LAUNCHER_STATUS_NOT_INSTALLED 3
!define DESKTOP_LAUNCHER_STATUS_INSTALLED 4
!define DESKTOP_LAUNCHER_STATUS_REINSTALLED 5
!define DESKTOP_LAUNCHER_STATUS_REMOVED 6

!include "control_utils.nsh"

!ifndef GenerateUUID ; mock out when testing
!define GenerateUUID "Call GenerateUUID_dontcall"
!endif

; Generates a UUID. This is used to create custom IDs for each ping, and it's
; factored out to make testing easier. Use the ${GenerateUUID} macro instead.
Function GenerateUUID_dontcall
  Push $0

  ; Create a GUID to use as the unique document ID.
  System::Call "rpcrt4::UuidCreate(g . r0)i"

  ; StringFromGUID2 (which is what System::Call uses internally to stringify
  ; GUIDs) includes braces in its output, and we don't want those.
  StrCpy $0 $0 -1 1

  Exch $0
FunctionEnd

; Sends a ping to the telemetry server with the provided additional data. This
; is used in the full and stub installers.
;
; Takes on the stack, an address (from GetFunctionAddress) that provides
; additional information specific to the type of installer. The callback should
; use lines like
;
;   nsJSON::Set /tree ping "Data" <key> /value <value>
;
; to set the additional data. It should keep registers intact!
;
; Note that this only runs from the full installer if the stub installer was
; not used. It also isn't directly tested, since it sends the HTTP request;
; prefer putting logic into a Prepare...Ping function.
Function SendTelemetryPing
  Call PrepareTelemetryPing

!if "${TELEMETRY_BASE_URL}" != ""
  ; Send the ping request. This call will block until a response is received,
  ; but we shouldn't have any windows still open, so we won't jank anything.
  nsJSON::Set /http ping
!endif
FunctionEnd

; Fills in the telemetry ping with baseline values common to the full and stub
; installers. Add new entries here if they're relevant for stub and full
; installations.
Function PrepareTelemetryPing
  ClearErrors

  ${GenerateUUID}
  Exch $0 ; save $0 on the stack while we're at it

  ; Configure the HTTP request for the ping
  nsJSON::Set /tree ping /value "{}"
  nsJSON::Set /tree ping "Url" /value \
    '"${TELEMETRY_BASE_URL}/${TELEMETRY_NAMESPACE}/${TELEMETRY_INSTALL_PING_DOCTYPE}/${TELEMETRY_INSTALL_PING_VERSION}/$0"'
  nsJSON::Set /tree ping "Verb" /value '"POST"'
  nsJSON::Set /tree ping "DataType" /value '"JSON"'
  ; If the user has a proxy set, use it. (The default is to bypass proxies.)
  nsJSON::Set /tree ping "AccessType" /value '"PreConfig"'

  ; Fill in the ping payload
  nsJSON::Set /tree ping "Data" /value "{}"
  nsJSON::Set /tree ping "Data" "build_channel" /value '"${Channel}"'
  nsJSON::Set /tree ping "Data" "update_channel" /value '"${UpdateChannel}"'
  nsJSON::Set /tree ping "Data" "locale" /value '"${AB_CD}"'

  ; If the installation failed, these values will be the empty string.
  ReadINIStr $0 "$INSTDIR\application.ini" "App" "Version"
  nsJSON::Set /tree ping "Data" "version" /value '"$0"'
  ReadINIStr $0 "$INSTDIR\application.ini" "App" "BuildID"
  nsJSON::Set /tree ping "Data" "build_id" /value '"$0"'

  ; Capture the distribution ID and version if they exist.
  StrCpy $1 "$INSTDIR\distribution\distribution.ini"
  ${If} ${FileExists} "$1"
    ReadINIStr $0 "$1" "Global" "id"
    nsJSON::Set /tree ping "Data" "distribution_id" /value '"$0"'
    ReadINIStr $0 "$1" "Global" "version"
    nsJSON::Set /tree ping "Data" "distribution_version" /value '"$0"'
  ${Else}
    nsJSON::Set /tree ping "Data" "distribution_id" /value '"0"'
    nsJSON::Set /tree ping "Data" "distribution_version" /value '"0"'
  ${EndIf}

  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "UBR"
  ${If} ${Errors}
    StrCpy $0 "-1" ; Assign -1 if an error occured during registry read
  ${EndIf}

  nsJSON::Set /tree ping "Data" "windows_ubr" /value '$0'

  ClearErrors
  ${GetParameters} $0
  ${GetOptions} $0 "/LaunchedFromMSI" $0
  ${IfNot} ${Errors}
    nsJSON::Set /tree ping "Data" "from_msi" /value true
  ${EndIf}

  ${If} ${RunningX64}
    nsJSON::Set /tree ping "Data" "64bit_os" /value true
  ${Else}
    nsJSON::Set /tree ping "Data" "64bit_os" /value false
  ${EndIf}

  ; Though these values are sometimes incorrect due to bug 444664 it happens
  ; so rarely it isn't worth working around it by reading the registry values.
  ${WinVerGetMajor} $0
  ${WinVerGetMinor} $1
  ${WinVerGetBuild} $2
  ${WinVerGetServicePackLevel} $3
  nsJSON::Set /tree ping "Data" "os_version" /value '"$0.$1.$2"'
  nsJSON::Set /tree ping "Data" "service_pack" /value '"$3"'
  ${If} ${IsServerOS}
    nsJSON::Set /tree ping "Data" "server_os" /value true
  ${Else}
    nsJSON::Set /tree ping "Data" "server_os" /value false
  ${EndIf}

  ClearErrors
  WriteRegStr HKLM "Software\BrowserWorks" "${BrandShortName}InstallerTest" \
                   "Write Test"
  ${If} ${Errors}
    nsJSON::Set /tree ping "Data" "admin_user" /value false
  ${Else}
    DeleteRegValue HKLM "Software\BrowserWorks" "${BrandShortName}InstallerTest"
    nsJSON::Set /tree ping "Data" "admin_user" /value true
  ${EndIf}

  nsJSON::Set /tree ping "Data" "new_default" /value false
  nsJSON::Set /tree ping "Data" "old_default" /value false

  AppAssocReg::QueryCurrentDefault "http" "protocol" "effective"
  Pop $0
  ReadRegStr $0 HKCR "$0\shell\open\command" ""
  ${If} $0 != ""
    ${GetPathFromString} "$0" $0
    ${GetParent} "$0" $1
    ${GetLongPath} "$1" $1
    ${If} $1 == $INSTDIR
      nsJSON::Set /tree ping "Data" "new_default" /value true
    ${Else}
      StrCpy $0 "$0" "" -11 # 11 == length of "firefox.exe"
      ${If} "$0" == "${FileMainEXE}"
        nsJSON::Set /tree ping "Data" "old_default" /value true
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; $PostSigningData should only be empty if we didn't try to copy the
  ; postSigningData file at all. If we did try and the file was missing
  ; or empty, this will be "0", and for consistency with the stub we will
  ; still submit it.
  ${If} $PostSigningData != ""
    nsJSON::Quote /always $PostSigningData
    Pop $0
    nsJSON::Set /tree ping "Data" "attribution" /value $0
  ${EndIf}

  ClearErrors
  ${GetParameters} $0
  ${GetOptions} $0 "/TelemetryDebug:" $0
  ${IfNot} ${Errors}
    nsJSON::Set /tree ping "Headers" /value "{}"
    nsJSON::Quote /always "$0"
    Pop $0
    nsJSON::Set /tree ping "Headers" "X-Debug-ID" /value "$0"
  ${EndIf}

  Pop $0

  ; Call the callback function, which is still on the stack.
  Exch $0
  Call $0
  Pop $0
FunctionEnd

!ifdef TELEMETRY_FULL_INSTALLER
; Telemetry values particular to the full installer. That means they either
; don't make sense with the stub installer, or (more often) the values are
; computed differently.
;
; This thematically should be in 'installer.nsi', but it's here to allow easier
; testing.
Function PrepareFullInstallPing
  Push $0
  Push $1

  nsJSON::Set /tree ping "Data" "installer_type" /value '"full"'
  nsJSON::Set /tree ping "Data" "installer_version" /value '"${AppVersion}"'

  !ifdef HAVE_64BIT_BUILD
    nsJSON::Set /tree ping "Data" "64bit_build" /value true
  !else
    nsJSON::Set /tree ping "Data" "64bit_build" /value false
  !endif

  nsJSON::Set /tree ping "Data" "had_old_install" /value "$HadOldInstall"

  ${If} $DefaultInstDir == $INSTDIR
    nsJSON::Set /tree ping "Data" "default_path" /value true
  ${Else}
    nsJSON::Set /tree ping "Data" "default_path" /value false
  ${EndIf}

  nsJSON::Set /tree ping "Data" "set_default" /value "$SetAsDefault"

  ${If} ${Silent}
    ; In silent mode, only the install phase is executed, and the GUI events
    ; that initialize most of the phase times are never called; only
    ; $InstallPhaseStart and $FinishPhaseStart have usable values.
    ${GetSecondsElapsed} $InstallPhaseStart $FinishPhaseStart $0

    nsJSON::Set /tree ping "Data" "intro_time" /value 0
    nsJSON::Set /tree ping "Data" "options_time" /value 0
    nsJSON::Set /tree ping "Data" "install_time" /value "$0"
    nsJSON::Set /tree ping "Data" "finish_time" /value 0
  ${Else}
    ; In GUI mode, all we can be certain of is that the intro phase has started;
    ; the user could have canceled at any time and phases after that won't
    ; have run at all. So we have to be prepared for anything after
    ; $IntroPhaseStart to be uninitialized. For anything that isn't filled in
    ; yet we'll use the current tick count. That means that any phases that
    ; weren't entered at all will get 0 for their times because the start and
    ; end tick counts will be the same.
    System::Call "kernel32::GetTickCount()l .s"
    Pop $0

    ${If} $OptionsPhaseStart == 0
      StrCpy $OptionsPhaseStart $0
    ${EndIf}
    ${GetSecondsElapsed} $IntroPhaseStart $OptionsPhaseStart $1
    nsJSON::Set /tree ping "Data" "intro_time" /value "$1"

    ${If} $InstallPhaseStart == 0
      StrCpy $InstallPhaseStart $0
    ${EndIf}
    ${GetSecondsElapsed} $OptionsPhaseStart $InstallPhaseStart $1
    nsJSON::Set /tree ping "Data" "options_time" /value "$1"

    ${If} $FinishPhaseStart == 0
      StrCpy $FinishPhaseStart $0
    ${EndIf}
    ${GetSecondsElapsed} $InstallPhaseStart $FinishPhaseStart $1
    nsJSON::Set /tree ping "Data" "install_time" /value "$1"

    ${If} $FinishPhaseEnd == 0
      StrCpy $FinishPhaseEnd $0
    ${EndIf}
    ${GetSecondsElapsed} $FinishPhaseStart $FinishPhaseEnd $1
    nsJSON::Set /tree ping "Data" "finish_time" /value "$1"
  ${EndIf}

  nsJSON::Set /tree ping "Data" "succeeded" /value false
  ${If} $InstallResult == "cancel"
    nsJSON::Set /tree ping "Data" "user_cancelled" /value true
  ${ElseIf} $InstallResult == "success"
    nsJSON::Set /tree ping "Data" "succeeded" /value true
  ${EndIf}

  nsJSON::Set /tree ping "Data" "new_launched" /value "$LaunchedNewApp"

  ${If} ${Silent}
    nsJSON::Set /tree ping "Data" "silent" /value true
  ${Else}
    nsJSON::Set /tree ping "Data" "silent" /value false
  ${EndIf}

  Call GetDesktopLauncherStatus
  Pop $0
  nsJSON::Set /tree ping "Data" "desktop_launcher_status" /value "$0"

  Pop $1
  Pop $0
FunctionEnd

Function IsFreshInstall
  ${If} $InstallExisted != "true"
    Push 1
  ${Else}
    Push 0
  ${EndIf}
FunctionEnd

Function IsShortcutInstallationChecked
  ${If} $AddDesktopSC != 0
    Push 1
  ${Else}
    Push 0
  ${EndIf}
FunctionEnd

Function IsInstallationSuccessful
  ${If} $InstallResult == "success"
    Push 1
  ${Else}
    Push 0
  ${EndIf}
FunctionEnd
!endif

!ifdef TELEMETRY_STUB_INSTALLER
Function PrepareStubInstallPing
  Push $0
  Push $1

  nsJSON::Set /tree ping "Data" "installer_type" /value '"stub"'
  ; Stub installers don't really have an installer_version, but it is required.
  nsJSON::Set /tree ping "Data" "installer_version" /value '""'

  nsJSON::Set /tree ping "Data" "stub_build_id" /value '"${MOZ_BUILDID}"'

  !ifdef FunnelcakeVersion
    nsJSON::Quote /always "${FunnelcakeVersion}"
    Pop $0
    nsJSON::Set /tree ping "Data" "funnelcake" /value $0
  !endif

  ${If} $ArchToInstall == ${ARCH_AMD64}
  ${OrIf} $ArchToInstall == ${ARCH_AARCH64}
    nsJSON::Set /tree ping "Data" "64bit_build" /value true
  ${Else}
    nsJSON::Set /tree ping "Data" "64bit_build" /value false
  ${EndIf}

  nsJSON::Set /tree ping "Data" "download_retries" /value "$DownloadRetryCount"
  nsJSON::Set /tree ping "Data" "bytes_downloaded" /value "$DownloadedBytes"
  nsJSON::Set /tree ping "Data" "download_size" /value "$DownloadSizeBytes"

  nsJSON::Set /tree ping "Data" "intro_time" /value "$IntroPhaseSeconds"
  nsJSON::Set /tree ping "Data" "options_time" /value "$OptionsPhaseSeconds"

  nsJSON::Set /tree ping "Data" "succeeded" /value false
  ${Select} "$ExitCode"
    ${Case} ${ERR_SUCCESS}
      nsJSON::Set /tree ping "Data" "succeeded" /value true
    ${Case} ${ERR_DOWNLOAD_CANCEL}
      nsJSON::Set /tree ping "Data" "user_cancelled" /value true
    ${Case} ${ERR_DOWNLOAD_TOO_MANY_RETRIES}
      nsJSON::Set /tree ping "Data" "out_of_retries" /value true
    ${Case} ${ERR_PREINSTALL_INVALID_HANDLE}
      nsJSON::Set /tree ping "Data" "file_error" /value true
    ${Case} ${ERR_PREINSTALL_CERT_UNTRUSTED}
      nsJSON::Set /tree ping "Data" "sig_not_trusted" /value true
    ${Case} ${ERR_PREINSTALL_CERT_ATTRIBUTES}
      nsJSON::Set /tree ping "Data" "sig_unexpected" /value true
    ${Case} ${ERR_PREINSTALL_CERT_UNTRUSTED_AND_ATTRIBUTES}
      nsJSON::Set /tree ping "Data" "sig_not_trusted" /value true
      nsJSON::Set /tree ping "Data" "sig_unexpected" /value true
    ${Case} ${ERR_PREINSTALL_CERT_TIMEOUT}
      nsJSON::Set /tree ping "Data" "sig_check_timeout" /value true
    ${Case} ${ERR_PREINSTALL_SYS_HW_REQ}
      nsJSON::Set /tree ping "Data" "hardware_req_not_met" /value true
    ${Case} ${ERR_PREINSTALL_SYS_OS_REQ}
      nsJSON::Set /tree ping "Data" "os_version_req_not_met" /value true
    ${Case} ${ERR_PREINSTALL_SPACE}
      nsJSON::Set /tree ping "Data" "disk_space_req_not_met" /value true
    ${Case} ${ERR_PREINSTALL_NOT_WRITABLE}
      nsJSON::Set /tree ping "Data" "writeable_req_not_met" /value true
    ${Case} ${ERR_INSTALL_TIMEOUT}
      nsJSON::Set /tree ping "Data" "install_timeout" /value true
    ${Default} ; including ERR_UNKNOWN
      nsJSON::Set /tree ping "Data" "unknown_error" /value true
  ${EndSelect}

  ; Get the seconds elapsed from the start of the download phase to the end of
  ; the download phase.
  ${GetSecondsElapsed} "$StartDownloadPhaseTickCount" "$EndDownloadPhaseTickCount" $0
  nsJSON::Set /tree ping "Data" "download_time" /value "$0"

  ; Get the seconds elapsed from the start of the last download to the end of
  ; the last download.
  ${GetSecondsElapsed} "$StartLastDownloadTickCount" "$EndDownloadPhaseTickCount" $0
  ; FIXME - this was ignored on the server-side! (it's associated with the field after 'download_time')

  nsJSON::Set /tree ping "Data" "download_latency" /value "$DownloadFirstTransferSeconds"

  ; Get the seconds elapsed from the end of the download phase to the
  ; completion of the pre-installation check phase.
  ${GetSecondsElapsed} "$EndDownloadPhaseTickCount" "$EndPreInstallPhaseTickCount" $0
  nsJSON::Set /tree ping "Data" "preinstall_time" /value $0

  ; Get the seconds elapsed from the end of the pre-installation check phase
  ; to the completion of the installation phase.
  ${GetSecondsElapsed} "$EndPreInstallPhaseTickCount" "$EndInstallPhaseTickCount" $0
  nsJSON::Set /tree ping "Data" "install_time" /value $0

  ; Get the seconds elapsed from the end of the installation phase to the
  ; completion of all phases.
  ${GetSecondsElapsed} "$EndInstallPhaseTickCount" "$EndFinishPhaseTickCount" $0
  nsJSON::Set /tree ping "Data" "finish_time" /value $0

  ${If} "$InitialInstallRequirementsCode" == "1"
    nsJSON::Set /tree ping "Data" "disk_space_error" /value true
  ${ElseIf} "$InitialInstallRequirementsCode" == "2"
    nsJSON::Set /tree ping "Data" "no_write_access" /value true
  ${EndIf}

  ${If} "$DownloadServerIP" == ""
    StrCpy $DownloadServerIP "Unknown"
  ${EndIf}
  nsJSON::Quote /always "$DownloadServerIP"
  Pop $0
  nsJSON::Set /tree ping "Data" "download_ip" /value "$0"

  ${GetLongPath} "$INSTDIR" $0
  ${GetLongPath} "$InitialInstallDir" $1
  ${If} "$0" == "$1"
    nsJSON::Set /tree ping "Data" "default_path" /value true
  ${Else}
    nsJSON::Set /tree ping "Data" "default_path" /value false
  ${EndIf}

  ClearErrors
  ${GetParameters} $0
  ${GetOptions} "$0" "/LaunchedBy:" "$0"
  ${If} ${Errors}
    StrCpy $0 "unknown"
  ${EndIf}
  nsJSON::Set /tree ping "Data" "launched_by" /value '"$0"'

  nsJSON::Set /tree ping "Data" "download_requests_blocked_by_server" /value "$DownloadRequestsBlockedByServer"

  ${If} "$OpenedDownloadPage" == "1"
    nsJSON::Set /tree ping "Data" "manual_download" /value true
  ${Else}
    nsJSON::Set /tree ping "Data" "manual_download" /value false
  ${EndIf}

  Call GetHadOldInstall
  Pop $0
  ${If} "$0" == "1"
    nsJSON::Set /tree ping "Data" "had_old_install" /value true
  ${Else}
    nsJSON::Set /tree ping "Data" "had_old_install" /value false
  ${EndIf}

  nsJSON::Set /tree ping "Data" "old_running" /value false
  ${If} "$FirefoxLaunchCode" == 2
    nsJSON::Set /tree ping "Data" "new_launched" /value true
  ${Else}
    nsJSON::Set /tree ping "Data" "new_launched" /value false
  ${EndIf}

  nsJSON::Quote /always "$ExistingVersion"
  Pop $0
  nsJSON::Set /tree ping "Data" "old_version" /value "$0"

  nsJSON::Quote /always "$ExistingBuildID"
  Pop $0
  nsJSON::Set /tree ping "Data" "old_build_id" /value "$0"

  nsJSON::Set /tree ping "Data" "profile_cleanup_prompt" /value '"$ProfileCleanupPromptType"'

  ${If} "$CheckboxCleanupProfile" == "1"
    nsJSON::Set /tree ping "Data" "profile_cleanup_requested" /value true
  ${Else}
    nsJSON::Set /tree ping "Data" "profile_cleanup_requested" /value false
  ${EndIf}

  Call GetDesktopLauncherStatus
  Pop $0
  nsJSON::Set /tree ping "Data" "desktop_launcher_status" /value "$0"

  Call GetHadExistingProfile
  Pop $0
  ${If} "$0" == "1"
    nsJSON::Set /tree ping "Data" "had_existing_profile" /value true
  ${Else}
    nsJSON::Set /tree ping "Data" "had_existing_profile" /value false
  ${EndIf}

  Pop $1
  Pop $0
FunctionEnd

Function IsFreshInstall
  ${If} $ExistingVersion == 0
    Push 1
  ${Else}
    Push 0
  ${EndIf}
FunctionEnd

Function IsShortcutInstallationChecked
  ${If} $CheckboxShortcuts != 0
    Push 1
  ${Else}
    Push 0
  ${EndIf}
FunctionEnd


Function IsInstallationSuccessful
  ${If} $ExitCode == ${ERR_SUCCESS}
    Push 1
  ${Else}
    Push 0
  ${EndIf}
FunctionEnd
!endif

Function WasDesktopLauncherPreviouslyInstalled
  ReadRegDWORD $0 HKCU "Software\BrowserWorks\${BrandFullNameInternal}" \
    "DesktopLauncherAppInstalled"
  ${If} $0 == 1
    Push 1
  ${Else}
    Push 0
  ${EndIf}
FunctionEnd

Function IsDesktopLauncherInstalled
  ; TODO Use $USERDESKTOP once we've updated to NSIS 3.08:
  ;   https://nsis.sourceforge.io/Docs/AppendixF.html#v3.08-c
  ; This would allow avoiding SetShellVarContextToValue/SwapShellVarContext.
  Push $0
  ${SwapShellVarContext} current $0

  ${If} ${FileExists} "$DESKTOP\${BrandShortName}.exe"
    Push 1
  ${Else}
    Push 0
  ${EndIf}

  ${SetShellVarContextToValue} $0
  Exch
  Pop $0
FunctionEnd

Function IsDesktopLauncherEnabled
  !ifdef DESKTOP_LAUNCHER_ENABLED
    Push 1
  !else
    Push 0
  !endif
FunctionEnd

Function GetDesktopLauncherStatus
  Push $0

  Call IsInstallationSuccessful
  Pop $0
  ${If} $0 == 0
    Pop $0
    Push ${DESKTOP_LAUNCHER_STATUS_UNKNOWN}
    Return
  ${EndIf}

  Call IsDesktopLauncherEnabled
  Pop $0
  ${If} $0 == 0
    Pop $0
    Push ${DESKTOP_LAUNCHER_STATUS_NOT_ENABLED}
    Return
  ${EndIf}

  Call IsShortcutInstallationChecked
  Pop $0
  ${If} $0 == 0
    Pop $0
    Push ${DESKTOP_LAUNCHER_STATUS_NOT_CHECKED}
    Return
  ${EndIf}

  Call IsDesktopLauncherInstalled
  Pop $0
  ${If} $0 == 0
    Call WasDesktopLauncherPreviouslyInstalled
    Pop $0
    ${If} $0 == 0
      Pop $0
      Push ${DESKTOP_LAUNCHER_STATUS_NOT_INSTALLED}
    ${Else}
      Pop $0
      Push ${DESKTOP_LAUNCHER_STATUS_REMOVED}
    ${EndIf}
  ${Else}
    Call IsFreshInstall
    Pop $0
    ${If} $0 == 0
      Pop $0
      Push ${DESKTOP_LAUNCHER_STATUS_REINSTALLED}
    ${Else}
      Pop $0
      Push ${DESKTOP_LAUNCHER_STATUS_INSTALLED}
    ${EndIf}
  ${EndIf}
FunctionEnd
