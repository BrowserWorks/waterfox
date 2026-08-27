# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
Unicode true

; Tests use the silent install feature to bypass message box prompts.
SilentInstall silent

; This is the executable that will be run by an xpcshell test
OutFile "test_stub_installer.exe"


; The executable will write output to this file, and the xpcshell test
; will read the contents of the file to determine whether the tests passed
!define TEST_OUTPUT_FILENAME .\test_installer_output.txt


!include "stub_shared_defs.nsh"

; Some variables used only by tests and mocks
Var Stdout
Var FailureMessage
Var TestBreakpointNumber
Var ExpectedLegacyUninstallKey

; For building the test exectuable, this version of the IsTestBreakpointSet macro
; checks the value of the TestBreakpointNumber. For real installer executables,
; this macro is empty, and does nothing. (See stub.nsi for the that version.)
!macro IsTestBreakpointSet breakpointNumber
    ${If} ${breakpointNumber} == $TestBreakpointNumber
        Return
    ${EndIf}
!macroend

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "TextFunc.nsh"
!include "WinVer.nsh"
!include "WordFunc.nsh"
!include "control_utils.nsh"

Function AttachConsole
    ; NSIS doesn't attach a console to the installer, so we'll do that now
    System::Call 'kernel32::AttachConsole(i -1)i.r0'
    ${If} $0 != 0
        ; Windows STD_OUTPUT_HANDLE is defined as -11
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        Push $0
    ${Else}
        ; If there's no console, exit with a nonzero exit code
        System::Call 'kernel32::ExitProcess(i 65536)'
    ${EndIf}
FunctionEnd

; ${AtLeastWin10} is a macro provided by WinVer.nsh that can act as the predicate of a LogicLib
; control statement. This macro redefinition makes this test mockable
Var MockAtLeastWin10
!define /redef AtLeastWin10 `$MockAtLeastWin10 IsMockedAsTrue ""`

; See stub.nsi for the real version of CheckCpuSupportsSSE
Var MockCpuHasSSE
Function CheckCpuSupportsSSE
  StrCpy $CpuSupportsSSE "$MockCpuHasSSE"
FunctionEnd

; See stub.nsi for the real version of CanWrite
Var MockCanWrite
Function CanWrite
  StrCpy $CanWriteToInstallDir $MockCanWrite
FunctionEnd

!macro _IsMockedAsTrue _v _b _t _f
  ; If the mock value is the same as 'true', jump to the label specified in $_t
  ; Otherwise, jump to the label specified in $_f
  ; (This is compatible with LogicLib ${If} and similar tests)
  StrCmp `${_v}` 'true' `${_t}` `${_f}`
!macroend

; Fail a unit test. Prints the message and location of the failure.
!macro Fail _message
    StrCpy $FailureMessage "At Line ${__LINE__}: ${_message}"
    SetErrors
    Return
!macroend
!define Fail "!insertmacro Fail"

; A helpful macro for testing that a variable is equal to a value.
; Provide the variable name (bare, without $ prefix) and the expected value.
; For example, to test that $MyVariable is equal to "hello there", you would write:
; !insertmacro AssertEqual MyVariable "hello there"
!macro AssertEqual _variableName _expectedValue
    ${If} "$${_variableName}" != "${_expectedValue}" ; quoted to prevent numeric coercion (01 != 1)
        ${Fail} "Expected ${_variableName} to have value `${_expectedValue}` , actual value was `$${_variableName}`"
        SetErrors
        Return
    ${EndIf}
!macroend
!define AssertEqual "!insertmacro AssertEqual"

Var TestFailureCount

!macro UnitTest _testFunctionName
    Call ${_testFunctionName}
    IfErrors 0 +3
    IntOp $TestFailureCount $TestFailureCount + 1
    FileWrite $Stdout "FAILURE: $FailureMessage; "
    ClearErrors
!macroend
!define UnitTest "!insertmacro UnitTest"

; Redefine ElevateUAC as a no-op in this test exectuable
!define /redef ElevateUAC ``

Var MockParameters
!macro MockGetParameters parameters
  StrCpy ${parameters} $MockParameters
!macroend
!define /redef GetParameters "!insertmacro MockGetParameters"

Var MockLocalAppDataFolder
!macro MockGetLocalAppDataFolder dir
  StrCpy ${dir} $MockLocalAppDataFolder
!macroend
!define GetLocalAppDataFolder "!insertmacro MockGetLocalAppDataFolder"

!define GenerateUUID "Push 'THIS_IS_A_UNIQUE_ID_FOR_TESTING'"

!include stub.nsh
!include desktop_launcher_helpers.nsh
!include install_dir_helpers.nsh

Var MockCommandLine
!macro MockGetRawCommandLine Result
  StrCpy $${Result} $MockCommandLine
!macroend
!define /redef GetRawCommandLine "!insertmacro MockGetRawCommandLine"

!include test_telemetry.nsh

; .onInit is responsible for running the tests
Function .onInit
    Call AttachConsole
    Pop $Stdout
    IntOp $TestFailureCount 0 + 0
    ${UnitTest} TestDontInstallOnOldWindows

    ${UnitTest} TestDontInstallOnNewWindowsWithoutSSE

    ${UnitTest} TestDontInstallOnOldWindowsWithoutSSE

    ${UnitTest} TestGetArchToInstall

    ${UnitTest} TestMaintServiceCfg

    ${UnitTest} TestCanWriteToDirSuccess

    ${UnitTest} TestCanWriteToDirFail

    ${UnitTest} TestUninstallRegKey

    ${UnitTest} TestSwapShellVarContext

    ${UnitTest} TestGetInstallationTypeAbsent
    ${UnitTest} TestGetInstallationTypeEmpty
    ${UnitTest} TestGetInstallationTypeInvalid_ACP
    ${UnitTest} TestGetInstallationTypeStub_ACP
    ${UnitTest} TestGetInstallationTypeFull_ACP
    ${UnitTest} TestGetInstallationTypeOther_ACP
    ${UnitTest} TestGetInstallationTypeInvalid_UTF16
    ${UnitTest} TestGetInstallationTypeStub_UTF16
    ${UnitTest} TestGetInstallationTypeFull_UTF16
    ${UnitTest} TestGetInstallationTypeOther_UTF16

    ${UnitTest} TestGetHadOldInstallFailure
    ${UnitTest} TestGetHadOldInstallSuccess

    ${UnitTest} TestGetHadExistingProfileFailure
    ${UnitTest} TestGetHadExistingProfileSuccess

    ${UnitTest} TestIsInstallerLaunchedByDesktopLauncherNoParameter
    ${UnitTest} TestIsInstallerLaunchedByDesktopLauncherUnknownParameter
    ${UnitTest} TestIsInstallerLaunchedByDesktopLauncherSuccess
    ${UnitTest} TestSetDlsourceFieldInPostSigningData
    ${UnitTest} TestUpdateInstalledPostSigningDataFileFailure
    ${UnitTest} TestUpdateInstalledPostSigningDataFileSuccess

    ${UnitTest} TestUseExistingInstallPathIfNoInstallDirArg
    ${UnitTest} TestUseExistingInstallPathIfNoInstallDirArgWithExistingInRegister
    ${UnitTest} TestUseExistingInstallPathIfNoInstallDirArgWithPathArg
    ${UnitTest} TestUseExistingInstallPathIfNoInstallDirArgWithNameArg
    ${UnitTest} TestUseExistingInstallPathIfNoInstallDirArgWithDArg

    ${UnitTest} TestGetInstallationTelemetryFromMsiFileDoesNotExist
    ${UnitTest} TestGetInstallationTelemetryFromMsiFileIsEmpty
    ${UnitTest} TestGetInstallationTelemetryFromMsiTypeIsIncorrect
    ${UnitTest} TestGetInstallationTelemetryFromMsiValueIsUnknown
    ${UnitTest} TestGetInstallationTelemetryFromMsiValueIsTrue
    ${UnitTest} TestGetInstallationTelemetryFromMsiValueIsFalse

    ${UnitTest} TestIsUpdateChannelEsrFailure
    ${UnitTest} TestIsUpdateChannelEsrSuccess

    ${UnitTest} TestShouldInstallDesktopLauncherFailure
    ${UnitTest} TestShouldInstallDesktopLauncherSuccess
    ${UnitTest} TestMigrateDesktopLauncher
    ${UnitTest} TestMigrateDesktopLauncherPreservesConflict

    Call TelemetryTests

    ${If} $TestFailureCount = 0
        ; On success, write the success metric and jump to the end
        FileWrite $Stdout "All stub installer tests passed"
    ${Else}
        FileWrite $Stdout "$TestFailureCount stub installer tests failed"
    ${EndIf}
    FileClose $Stdout
    Return
FunctionEnd

; Expect installation to abort if windows version < 10
Function TestDontInstallOnOldWindows
    StrCpy $MockAtLeastWin10 'false'
    StrCpy $MockCpuHasSSE '1'
    StrCpy $AbortInstallation ''
    StrCpy $ExitCode "Unknown"
    Call CommonOnInit
    !insertmacro AssertEqual ExitCode "${ERR_PREINSTALL_SYS_OS_REQ}"
    !insertmacro AssertEqual AbortInstallation "true"
    !insertmacro AssertEqual R7 "$(WARN_MIN_SUPPORTED_OSVER_MSG2)"
FunctionEnd


; Expect installation to abort on processor without SSE, WIndows 10+ version
Function TestDontInstallOnNewWindowsWithoutSSE
    StrCpy $MockAtLeastWin10 'true'
    StrCpy $MockCpuHasSSE '0'
    StrCpy $AbortInstallation ''
    StrCpy $ExitCode "Unknown"
    Call CommonOnInit
    !insertmacro AssertEqual ExitCode "${ERR_PREINSTALL_SYS_HW_REQ}"
    !insertmacro AssertEqual AbortInstallation "true"
FunctionEnd

; Expect installation to abort on processor without SSE, Windows <10 version
Function TestDontInstallOnOldWindowsWithoutSSE
    StrCpy $MockAtLeastWin10 'false'
    StrCpy $MockCpuHasSSE '0'
    StrCpy $AbortInstallation ''
    StrCpy $ExitCode "Unknown"
    Call CommonOnInit
    !insertmacro AssertEqual ExitCode "${ERR_PREINSTALL_SYS_OS_REQ}"
    !insertmacro AssertEqual AbortInstallation "true"
    !insertmacro AssertEqual R7 "$(WARN_MIN_SUPPORTED_OSVER_CPU_MSG2)"
FunctionEnd

; Expect to find a known supported architecture for Windows
Function TestGetArchToInstall
    StrCpy $TestBreakpointNumber "${TestBreakpointArchToInstall}"
    StrCpy $MockAtLeastWin10 'true'
    StrCpy $MockCpuHasSSE '1'
    StrCpy $INSTDIR "Unknown"
    StrCpy $ArchToInstall "Unknown"

    Call CommonOnInit
    ${Switch} $ArchToInstall
        ${Case} "${ARCH_X86}"
            ; OK, fall through
        ${Case} "${ARCH_AMD64}"
            ; OK, fall through
        ${Case} "${ARCH_AARCH64}"
            ; OK
            ${Break}
        ${Default}
            StrCpy $FailureMessage "Unexpected value for ArchToInstall: $ArchToInstall"
            SetErrors
            Return
    ${EndSwitch}

    ${Switch} $INSTDIR
        ${Case} "${DefaultInstDir64bit}"
            ; OK, fall through
        ${Case} "${DefaultInstDir32bit}"
            ; OK
            ${Break}
        ${Default}
            StrCpy $FailureMessage "Unexpected value for INSTDIR: $INSTDIR"
            SetErrors
            Return
    ${EndSwitch}
FunctionEnd

; Since we're not actually elevating permissions, expect not to enable installing maintenance service
Function TestMaintServiceCfg
    StrCpy $TestBreakpointNumber "${TestBreakpointMaintService}"
    StrCpy $CheckboxInstallMaintSvc 'Unknown'
    StrCpy $MockAtLeastWin10 'true'
    StrCpy $MockCpuHasSSE '1'

    Call CommonOnInit

    !insertmacro AssertEqual CheckboxInstallMaintSvc "0"
FunctionEnd

; Expect success if we can write to installation directory
Function TestCanWriteToDirSuccess
    StrCpy $TestBreakpointNumber "${TestBreakpointCanWriteToDir}"
    StrCpy $MockCanWrite 'true'
    StrCpy $MockAtLeastWin10 'true'
    StrCpy $MockCpuHasSSE '1'
    StrCpy $CanWriteToInstallDir "Unknown"
    StrCpy $AbortInstallation "false"

    Call CommonOnInit

    ; Since we're not running as admin, expect directory to be under user's own home directory, so it should be writable
    !insertmacro AssertEqual CanWriteToInstallDir "true"
    !insertmacro AssertEqual AbortInstallation "false"
FunctionEnd

; Expect failure if we can't write to installation directory
Function TestCanWriteToDirFail
    StrCpy $TestBreakpointNumber "${TestBreakpointCanWriteToDir}"
    StrCpy $MockCanWrite 'false'
    StrCpy $MockAtLeastWin10 'true'
    StrCpy $MockCpuHasSSE '1'
    StrCpy $CanWriteToInstallDir "Unknown"
    StrCpy $AbortInstallation "false"

    Call CommonOnInit

    ; Since we're not running as admin, expect directory to be under user's own home directory, so it should be writable
    !insertmacro AssertEqual CanWriteToInstallDir "false"
    !insertmacro AssertEqual ExitCode "${ERR_PREINSTALL_NOT_WRITABLE}"
    !insertmacro AssertEqual AbortInstallation "true"
FunctionEnd

!include postupdate_helper.nsh

Function GetExpectedLegacyUninstallKey
  Push $0
  Push $1
  StrCpy $0 "Software\Microsoft\Windows\CurrentVersion\Uninstall\${BrandFullNameInternal} ${AppVersion}"
  ${WordFind} "${UpdateChannel}" "esr" "E#" $1
  ${IfNot} ${Errors}
    StrCpy $0 "$0 ESR"
  ${EndIf}
  StrCpy $0 "$0 (${ARCH} ${AB_CD})"
  ClearErrors
  Pop $1
  Exch $0
FunctionEnd

Function TestUninstallRegKey
    Call CommonOnInit

    Call GetExpectedLegacyUninstallKey
    Pop $ExpectedLegacyUninstallKey

    Push $R0 ; We will locally use $R0, ensuring that we can restore it later.

    Call findUninstallKey
    Pop $R0
    !insertmacro AssertEqual R0 ""

    Call getModernUninstallKey
    Pop $R0
    !insertmacro AssertEqual R0 \
        "Software\Microsoft\Windows\CurrentVersion\Uninstall\${BrandFullNameInternal}"

    Call getLegacyUninstallKey
    Pop $R0
    !insertmacro AssertEqual R0 "$ExpectedLegacyUninstallKey"

    ; Ensure that the getDefaultInstallDir function does not modify the
    ; contents of $1.
    Push $INSTDIR ; back up the original contents for later
    Push $1
    Call getDefaultInstallDir
    Pop $INSTDIR ; discard the return value of getDefaultInstallDir
    Pop $INSTDIR ; restore to original (see above)
    !insertmacro AssertEqual INSTDIR "$1"

    ; Later, we also want to check that none of the common registers have been
    ; altered by calling functions. We save their contents on the stack for
    ; that check.
    Push "(0 $0, 1 $1, 2 $2, 3 $3, 4 $4, 5 $5, 6 $6, 7 $7, 8 $8, 9 $9)"

    ; ----
    ; Modify the INSTDIR in a way as if a user had chosen to add a version
    ; number to the path
    UserInfo::GetAccountType
    Pop $INSTDIR

    ${If} $INSTDIR == "User"
        ${GetLocalAppDataFolder} $INSTDIR
        StrCpy $INSTDIR "$INSTDIR\${BrandFullName} 123.0\" ; %LOCALAPPDATA%/${BrandFullName}
    ${Else}
        !ifdef HAVE_64BIT_BUILD
          StrCpy $INSTDIR "$PROGRAMFILES64\${BrandFullNameInternal} 123.0\"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES32\${BrandFullNameInternal} 123.0\"
        !endif
    ${EndIf}
    Push ${buildNumWin10}
    Call getUninstallKey
    Pop $INSTDIR ; reuse INSTDIR for the return value
    !insertmacro AssertEqual INSTDIR "$ExpectedLegacyUninstallKey"
    ClearErrors

    ; ----
    ; Modify the INSTDIR as if we wanted to install to
    ; (like unelevated installations do it)
    Push ${buildNumWin10}
    Call getUninstallKey
    Pop $INSTDIR ; reuse INSTDIR for the return value
    !insertmacro AssertEqual INSTDIR "$ExpectedLegacyUninstallKey"
    ClearErrors

    ; ----
    ; An empty installation path should lead to the legacy uninstall key.
    StrCpy $INSTDIR ""
    Push ${buildNumWin10}
    Call getUninstallKey
    Pop $INSTDIR ; reuse INSTDIR for the return value
    !insertmacro AssertEqual INSTDIR "$ExpectedLegacyUninstallKey"
    ClearErrors

    ; ----
    ; Modify the INSTDIR as if it was not touched by a user (use the default
    ; settings), which under Windows 10 is a special case and the Uninstall
    ; key should be rewritten, leaving the Version number out of it.
    Call getDefaultInstallDir ; pushes the default directory on the stack
    Pop $INSTDIR
    Push ${buildNumWin10}
    Call getUninstallKey
    Pop $INSTDIR ; reuse INSTDIR for the return value
    !insertmacro AssertEqual INSTDIR \
        "Software\Microsoft\Windows\CurrentVersion\Uninstall\${BrandFullNameInternal}"
    ClearErrors

    ; ----
    ; Special case: The maximal supported path length here is 1024 chars, in
    ; which case the return value for the path comparison is an error value.
    ; Since this error value will never match the default path name, we expect
    ; the same return value as we would get with an unsupported OS version.
    StrCpy $INSTDIR ""
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR--------------------------------------------------"
    StrCpy $INSTDIR "$INSTDIR-----------------------" ; 1023 - chars

    ; 1st test: Just a sanity check to see if the block above really has 1023
    ; minus signs.
    push $0 ; save $0
    StrLen $0 $INSTDIR
    !insertmacro AssertEqual 0 1023
    Pop $0 ; restore $0

    ; 2nd test: getNormalizedPath is supposed to return the error message
    ; instead of a path.
    push $0 ; save $0
    ; test the one error case specifically that getNormalizedPath can return.
    Push $INSTDIR ; Simulate Windows 10
    Call getNormalizedPath
    Pop $0

    !insertmacro AssertEqual 0 \
        "[!] GetFullPathNameW: Insufficient buffer memory."
    ${IfNot} ${Errors}
      StrCpy $FailureMessage "At Line ${__LINE__}. An error was expected. Is a SetError missing?"
      SetErrors
      Return
    ${EndIf}
    ClearErrors
    Pop $0 ; restore $0

    ; 3rd test: getUninstallKey should return the legacy uninstall key with
    ; this buffer overflow.
    push $0 ; save $0
    Push 10240 ; Simulate Windows 10
    Call getUninstallKey
    Pop $0
    !insertmacro AssertEqual 0 "$ExpectedLegacyUninstallKey"
    ClearErrors
    Pop $0 ; restore $0

    ; ----
    ; Make sure that after all the testing the common working registers still
    ; have their original values. We are using $R0, because INSTDIR can have
    ; `Function .onVerifyInstDir` attached to it and that can modify registers.
    Pop $R0
    ${If} "$R0" != "(0 $0, 1 $1, 2 $2, 3 $3, 4 $4, 5 $5, 6 $6, 7 $7, 8 $8, 9 $9)"
      StrCpy $FailureMessage "At Line ${__LINE__}  Registers were changed, we expected $\n"
      StrCpy $FailureMessage "$FailureMessage    '$R0' but received $\n"
      StrCpy $FailureMessage "$FailureMessage    '(0 $0, 1 $1, 2 $2, 3 $3, 4 $4, 5 $5, 6 $6, 7 $7, 8 $8, 9 $9)'"
      SetErrors
      Return
    ${EndIf}
    Pop $INSTDIR
    Pop $R0
FunctionEnd

Function TestSwapShellVarContext
    Push $0
    StrCpy $0 ""
    SetShellVarContext current

    ; Swap from current to all
    ${SwapShellVarContext} all $0
    ${AssertEqual} 0 "current"
    ${IfNot} ${ShellVarContextAll}
        ${Fail} "Expected shell var context to have value 'all', but it was 'current'"
    ${EndIf}

    ; Swap from all to all
    ${SwapShellVarContext} all $0
    ${AssertEqual} 0 "all"
    ${IfNot} ${ShellVarContextAll}
        ${Fail} "Expected shell var context to have value 'all', but it was 'current'"
    ${EndIf}

    ; Swap from all to current
    ${SwapShellVarContext} current $0
    ${AssertEqual} 0 "all"
    ${If} ${ShellVarContextAll}
        ${Fail} "Expected shell var context to have value 'current', but it was 'all'"
    ${EndIf}

    ; Swap from current to current
    ${SwapShellVarContext} current $0
    ${AssertEqual} 0 "current"
    ${If} ${ShellVarContextAll}
        ${Fail} "Expected shell var context to have value 'current', but it was 'all'"
    ${EndIf}

    ; Leave context and register in expected start state
    SetShellVarContext current
    Pop $0
FunctionEnd

Function TestGetInstallationTypeAbsent
    GetTempFileName $1
    Delete "$1"
    Push $1
    Call GetInstallationType
    Pop $0
    ${AssertEqual} 0 "unknown"
FunctionEnd

Function TestGetInstallationTypeEmpty
    GetTempFileName $1
    FileOpen $0 "$1" w
    FileClose $0

    Push $1
    Call GetInstallationType
    Pop $0
    ${AssertEqual} 0 "unknown"
    Delete $1
FunctionEnd

!macro GetInstallationTypeTests _WRITEFUNC _ENCODING
Function TestGetInstallationTypeInvalid_${_ENCODING}
    GetTempFileName $1
    FileOpen $0 "$1" w
    ${_WRITEFUNC} $0 "{$\"installer_type$\":[1, 2, 3]}"
    FileClose $0

    Push $1
    Call GetInstallationType
    Pop $0
    Delete $1
    ${AssertEqual} 0 "unknown"
FunctionEnd

Function TestGetInstallationTypeStub_${_ENCODING}
    GetTempFileName $1
    FileOpen $0 "$1" w
    ${_WRITEFUNC} $0 "{$\"installer_type$\":$\"stub$\"}"
    FileClose $0

    Push $1
    Call GetInstallationType
    Pop $0
    Delete $1
    ${AssertEqual} 0 "stub"
FunctionEnd

Function TestGetInstallationTypeFull_${_ENCODING}
    GetTempFileName $1
    FileOpen $0 "$1" w
    ${_WRITEFUNC} $0 "{$\"installer_type$\":$\"full$\"}"
    FileClose $0

    Push $1
    Call GetInstallationType
    Pop $0
    Delete $1
    ${AssertEqual} 0 "full"
FunctionEnd

Function TestGetInstallationTypeOther_${_ENCODING}
    GetTempFileName $1
    FileOpen $0 "$1" w
    ${_WRITEFUNC} $0 "{$\"installer_type$\":$\"abc$\"}"
    FileClose $0

    Push $1
    Call GetInstallationType
    Pop $0
    Delete $1
    ${AssertEqual} 0 "abc"
FunctionEnd
!macroend
!insertmacro GetInstallationTypeTests FileWrite ACP
!insertmacro GetInstallationTypeTests FileWriteUTF16LE UTF16

Function TestGetHadOldInstallFailure
  StrCpy $PreviousInstallDir ""
  Call GetHadOldInstall
  Pop $0
  ${AssertEqual} 0 "0"
FunctionEnd

Function TestGetHadOldInstallSuccess
  StrCpy $PreviousInstallDir "foo"
  Call GetHadOldInstall
  Pop $0
  ${AssertEqual} 0 "1"
FunctionEnd

Function TestGetHadExistingProfileFailure
  GetTempFileName $0
  Delete $0
  CreateDirectory $0
  StrCpy $MockLocalAppDataFolder $0

  Call GetHadExistingProfile
  Pop $0
  ${AssertEqual} 0 "0"

  RMDir $MockLocalAppDataFolder
FunctionEnd

Function TestGetHadExistingProfileSuccess
  GetTempFileName $0
  Delete $0
  CreateDirectory "$0\BrowserWorks\Waterfox"
  StrCpy $MockLocalAppDataFolder $0

  Call GetHadExistingProfile
  Pop $0
  ${AssertEqual} 0 "1"

  RMDir /r $MockLocalAppDataFolder
FunctionEnd

Function TestIsInstallerLaunchedByDesktopLauncherNoParameter
  StrCpy $MockParameters ""
  Call IsInstallerLaunchedByDesktopLauncher
  Pop $0
  ${AssertEqual} 0 "0"
FunctionEnd

Function TestIsInstallerLaunchedByDesktopLauncherUnknownParameter
  StrCpy $MockParameters "/LaunchedBy:unknown"
  Call IsInstallerLaunchedByDesktopLauncher
  Pop $0
  ${AssertEqual} 0 "0"
FunctionEnd

Function TestIsInstallerLaunchedByDesktopLauncherSuccess
  StrCpy $MockParameters "/LaunchedBy:desktoplauncher"
  Call IsInstallerLaunchedByDesktopLauncher
  Pop $0
  ${AssertEqual} 0 "1"
FunctionEnd

Function TestSetDlsourceFieldInPostSigningData
  StrCpy $PostSigningData "source%3Dfoo%26dlsource%3Dmozillaci%26campaign%3Dbar"
  Push "desktoplauncher"
  Call SetDlsourceFieldInPostSigningData
  ${AssertEqual} PostSigningData "dlsource%3Ddesktoplauncher"
FunctionEnd

Function TestUpdateInstalledPostSigningDataFileFailure
  ; Save the original $INSTDIR to restore it later, so the real dir is untouched
  Push $INSTDIR
  GetTempFileName $INSTDIR

  ; $INSTDIR is a file, so opening "$INSTDIR\postSigningData" will fail
  StrCpy $PostSigningData "dlsource%3Ddesktoplauncher"
  Call UpdateInstalledPostSigningDataFile

  ${AssertEqual} PostSigningData "error:filewrite"

  ; Clean up the temporary file and restore $INSTDIR
  Delete $INSTDIR
  Pop $INSTDIR
FunctionEnd

Function TestUpdateInstalledPostSigningDataFileSuccess
  ; Save the original $INSTDIR to restore it later
  Push $INSTDIR
  GetTempFileName $INSTDIR
  Delete $INSTDIR
  CreateDirectory $INSTDIR

  StrCpy $0 "dlsource%3Ddesktoplauncher"
  StrCpy $PostSigningData $0
  Call UpdateInstalledPostSigningDataFile

  ${AssertEqual} PostSigningData "$0"

  ClearErrors
  FileOpen $1 "$INSTDIR\postSigningData" r
  FileRead $1 $2
  FileClose $1
  ${AssertEqual} 2 "$0"

  ; Clean up the temporary directory and restore $INSTDIR
  Delete "$INSTDIR\postSigningData"
  RMDir $INSTDIR
  Pop $INSTDIR
FunctionEnd

Function TestUseExistingInstallPathIfNoInstallDirArg
  StrCpy $MockParameters ""
  StrCpy $INSTDIR "C:\Default"
  ${UseExistingInstallPathIfNoInstallDirArg} "C:\Existing"
  ${AssertEqual} INSTDIR "C:\Existing"
FunctionEnd

Function TestUseExistingInstallPathIfNoInstallDirArgWithExistingInRegister
  StrCpy $MockParameters ""
  StrCpy $INSTDIR "C:\Default"
  Push $0
  StrCpy $0 "C:\Existing"
  ${UseExistingInstallPathIfNoInstallDirArg} $0
  ${AssertEqual} INSTDIR "C:\Existing"
  Pop $0
FunctionEnd

Function TestUseExistingInstallPathIfNoInstallDirArgWithPathArg
  StrCpy $MockParameters "/InstallDirectoryPath=C:\Test"
  StrCpy $INSTDIR "C:\Default"
  ${UseExistingInstallPathIfNoInstallDirArg} "C:\Existing"
  ${AssertEqual} INSTDIR "C:\Default"
FunctionEnd

Function TestUseExistingInstallPathIfNoInstallDirArgWithNameArg
  StrCpy $MockParameters "/InstallDirectoryName=Test"
  StrCpy $INSTDIR "C:\Default"
  ${UseExistingInstallPathIfNoInstallDirArg} "C:\Existing"
  ${AssertEqual} INSTDIR "C:\Default"
FunctionEnd

Function TestUseExistingInstallPathIfNoInstallDirArgWithDArg
  Push $MockCommandLine
  StrCpy $MockCommandLine "setup.exe /D=C:\Test"
  StrCpy $INSTDIR "C:\Default"
  ${UseExistingInstallPathIfNoInstallDirArg} "C:\Existing"
  ${AssertEqual} INSTDIR "C:\Default"
  Pop $MockCommandLine
FunctionEnd

Function TestGetInstallationTelemetryFromMsiFileDoesNotExist
  GetTempFileName $0
  Delete $0

  Push $0
  Call GetInstallationTelemetryFromMsi
  Pop $1
  ${IfNot} ${Errors}
    ${Fail} "Expected GetInstallationTelemetryFromMsi to set errors if file does not exist"
  ${EndIf}
FunctionEnd

Function TestGetInstallationTelemetryFromMsiFileIsEmpty
  GetTempFileName $0
  FileOpen $1 "$0" w
  FileClose $1

  Push $0
  Call GetInstallationTelemetryFromMsi
  Pop $1
  Delete $0
  ${IfNot} ${Errors}
    ${Fail} "Expected GetInstallationTelemetryFromMsi to set errors if file is empty"
  ${EndIf}
FunctionEnd

Function TestGetInstallationTelemetryFromMsiTypeIsIncorrect
  GetTempFileName $0
  FileOpen $1 "$0" w
  FileWriteUTF16LE $1 "{$\"from_msi$\":$\"text$\"}"
  FileClose $1

  Push $0
  Call GetInstallationTelemetryFromMsi
  Pop $1
  Delete $0
  ${IfNot} ${Errors}
    ${Fail} "Expected GetInstallationTelemetryFromMsi to set errors if type is incorrect"
  ${EndIf}
FunctionEnd

Function TestGetInstallationTelemetryFromMsiValueIsUnknown
  GetTempFileName $0
  FileOpen $1 "$0" w
  FileWriteUTF16LE $1 "{$\"from_msi$\":unknown}"
  FileClose $1

  Push $0
  Call GetInstallationTelemetryFromMsi
  Pop $1
  Delete $0
  ${IfNot} ${Errors}
    ${Fail} "Expected GetInstallationTelemetryFromMsi to set errors if value is unknown"
  ${EndIf}
FunctionEnd

Function TestGetInstallationTelemetryFromMsiValueIsTrue
  GetTempFileName $0
  FileOpen $1 "$0" w
  FileWriteUTF16LE $1 "{$\"from_msi$\":true}"
  FileClose $1

  Push $0
  Call GetInstallationTelemetryFromMsi
  Pop $1
  Delete $0
  ${AssertEqual} 1 "1"
FunctionEnd

Function TestGetInstallationTelemetryFromMsiValueIsFalse
  GetTempFileName $0
  FileOpen $1 "$0" w
  FileWriteUTF16LE $1 "{$\"from_msi$\":false}"
  FileClose $1

  Push $0
  Call GetInstallationTelemetryFromMsi
  Pop $1
  Delete $0
  ${AssertEqual} 1 "0"
FunctionEnd

Function TestIsUpdateChannelEsrFailure
  Push "release"
  Call IsUpdateChannelEsr
  Pop $0
  ${AssertEqual} 0 "0"
FunctionEnd

Function TestIsUpdateChannelEsrSuccess
  Push "esr"
  Call IsUpdateChannelEsr
  Pop $0
  ${AssertEqual} 0 "1"
FunctionEnd

Function TestShouldInstallDesktopLauncherFailure
  StrCpy $MockParameters ""
  Call ShouldInstallDesktopLauncher
  Pop $0
  ${AssertEqual} 0 "0"
FunctionEnd

Function TestShouldInstallDesktopLauncherSuccess
  StrCpy $MockParameters "/DesktopLauncher"
  Call ShouldInstallDesktopLauncher
  Pop $0
  ${AssertEqual} 0 "1"
FunctionEnd

Function TestMigrateDesktopLauncher
  Push $INSTDIR
  GetTempFileName $0
  Delete "$0"
  CreateDirectory "$0"
  CreateDirectory "$0\install"
  StrCpy $INSTDIR "$0\install"
  StrCpy $7 "$INSTDIR\${FileMainEXE}"

  FileOpen $1 "$7" w
  FileClose $1
  FileOpen $1 "$0\${BrandShortName}.exe" w
  FileClose $1

  Push "$0"
  Call MigrateDesktopLauncher
  Pop $2
  Push "$0"
  Call MigrateDesktopLauncher
  Pop $3

  StrCpy $4 0
  ${If} ${FileExists} "$0\${BrandShortName}.exe"
    StrCpy $4 1
  ${EndIf}
  StrCpy $5 0
  ${If} ${FileExists} "$0\${BrandShortName}.lnk"
    StrCpy $5 1
  ${EndIf}
  ShellLink::GetShortCutTarget "$0\${BrandShortName}.lnk"
  Pop $6
  ${GetLongPath} "$6" $6

  RmDir /r "$0"
  Pop $INSTDIR

  ${AssertEqual} 2 "1"
  ${AssertEqual} 3 "0"
  ${AssertEqual} 4 "0"
  ${AssertEqual} 5 "1"
  ${AssertEqual} 6 "$7"
FunctionEnd

Function TestMigrateDesktopLauncherPreservesConflict
  Push $INSTDIR
  GetTempFileName $0
  Delete "$0"
  CreateDirectory "$0"
  CreateDirectory "$0\install"
  StrCpy $INSTDIR "$0\install"
  StrCpy $5 "$0\other.exe"

  FileOpen $1 "$INSTDIR\${FileMainEXE}" w
  FileClose $1
  FileOpen $1 "$0\${BrandShortName}.exe" w
  FileClose $1
  FileOpen $1 "$5" w
  FileClose $1
  CreateShortCut "$0\${BrandShortName}.lnk" "$5"

  Push "$0"
  Call MigrateDesktopLauncher
  Pop $2

  StrCpy $3 0
  ${If} ${FileExists} "$0\${BrandShortName}.exe"
    StrCpy $3 1
  ${EndIf}
  ShellLink::GetShortCutTarget "$0\${BrandShortName}.lnk"
  Pop $4
  ${GetLongPath} "$4" $4
  ${GetLongPath} "$5" $5

  RmDir /r "$0"
  Pop $INSTDIR

  ${AssertEqual} 2 "0"
  ${AssertEqual} 3 "1"
  ${AssertEqual} 4 "$5"
FunctionEnd

Section
SectionEnd
