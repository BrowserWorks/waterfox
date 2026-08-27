# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

!ifndef DESKTOP_LAUNCHER_HELPERS_NSH
!define DESKTOP_LAUNCHER_HELPERS_NSH

; Looks at installation_telemetry.json to determine whether the installation
; was installed by the stub installer or not.
;
; Expects the JSON file on the stack as a parameter; will return the
; installation type from the JSON file, generally either "stub" or "full".
; On failure, pushes "unknown".
Function GetInstallationType
  Exch $1 ; directory
  Push $0 ; temporary variable

  nsJSON::Set /file /unicode "$1"
  nsJSON::Get /type `installer_type` /end

  Pop $0
  ${If} $0 == ""
    ; It's only ever written as UTF-16, but decode it as ANSI for redundancy.
    nsJSON::Set /file "$1"
    nsJSON::Get /type `installer_type` /end
    Pop $0 ; type
  ${EndIf}

  ClearErrors
  StrCpy $1 "unknown"
  ${If} $0 == "string"
    nsJSON::Get `installer_type` /end
    ${IfNot} ${Errors}
      ; get the actual installer type from the file
      Pop $1
    ${EndIf}
  ${EndIf}

  Exch
  Pop $0
  Exch $1
  ClearErrors
FunctionEnd

!endif

Function GetInstallationTelemetryFromMsi
  Pop $0
  ClearErrors

  nsJSON::Set /file /unicode "$0"
  ${If} ${Errors}
    SetErrors
    Push 0
    Return
  ${EndIf}

  nsJSON::Get /type `from_msi` /end
  ${If} ${Errors}
    SetErrors
    Push 0
    Return
  ${EndIf}

  Pop $1
  ${If} $1 != "value"
    SetErrors
    Push 0
    Return
  ${EndIf}

  nsJSON::Get `from_msi` /end
  ${If} ${Errors}
    SetErrors
    Push 0
    Return
  ${EndIf}

  Pop $1
  ${If} $1 == "true"
    Push 1
  ${ElseIf} $1 == "false"
    Push 0
  ${Else}
    SetErrors
    Push 0
  ${EndIf}
FunctionEnd

Function IsUpdateChannelEsr
  Exch $0
  ${If} $0 == "esr"
    StrCpy $0 1
  ${Else}
    StrCpy $0 0
  ${EndIf}
  Exch $0
FunctionEnd

Function ShouldInstallDesktopLauncher
  Push $0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} "$0" "/DesktopLauncher" "$0"
  ${IfNot} ${Errors}
    StrCpy $0 1
  ${Else}
    StrCpy $0 0
  ${EndIf}
  Exch $0
FunctionEnd

; Replaces an installer-owned desktop launcher with a conventional shortcut.
; The desktop directory is passed on the stack and the result is returned as 1
; when the launcher was removed or 0 when no safe migration was possible.
Function MigrateDesktopLauncher
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4

  StrCpy $1 "$0\${BrandShortName}.exe"
  StrCpy $2 "$0\${BrandShortName}.lnk"
  StrCpy $4 0

  ${IfNot} ${FileExists} "$1"
    Goto migrate_desktop_launcher_done
  ${EndIf}

  ${IfNot} ${FileExists} "$2"
    ClearErrors
    CreateShortCut "$2" "$INSTDIR\${FileMainEXE}"
    ${If} ${Errors}
      Goto migrate_desktop_launcher_done
    ${EndIf}

    ShellLink::SetShortCutDescription "$2" "$(BRIEF_APP_DESC)"
    ShellLink::SetShortCutWorkingDirectory "$2" "$INSTDIR"
    ${If} "$AppUserModelID" != ""
      ApplicationID::Set "$2" "$AppUserModelID" "true"
    ${EndIf}
  ${EndIf}

  ClearErrors
  ShellLink::GetShortCutArgs "$2"
  Pop $3
  ${If} ${Errors}
  ${OrIf} "$3" != ""
    Goto migrate_desktop_launcher_done
  ${EndIf}

  ClearErrors
  ShellLink::GetShortCutTarget "$2"
  Pop $3
  ${If} ${Errors}
    Goto migrate_desktop_launcher_done
  ${EndIf}
  ${GetLongPath} "$3" $3
  ${If} "$3" != "$INSTDIR\${FileMainEXE}"
    Goto migrate_desktop_launcher_done
  ${EndIf}

  ClearErrors
  Delete "$1"
  ${IfNot} ${Errors}
  ${AndIfNot} ${FileExists} "$1"
    StrCpy $4 1
  ${EndIf}

migrate_desktop_launcher_done:
  StrCpy $0 $4
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
FunctionEnd
