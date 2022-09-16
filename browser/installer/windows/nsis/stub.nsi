Unicode true

OutFile "setup-stub.exe"

; On real installer executables, test breakpoint checks are no-ops.
; See test_stub.nsi for the test version of this macro.
!macro IsTestBreakpointSet breakpointNumber
!macroend

Icon "firefox64.ico"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "TextFunc.nsh"
!include "WinVer.nsh"
!include "WordFunc.nsh"

!include "stub_shared_defs.nsh"

Function CheckCpuSupportsSSE
  ; Don't install on systems that don't support SSE2. The parameter value of
  ; 10 is for PF_XMMI64_INSTRUCTIONS_AVAILABLE which will check whether the
  ; SSE2 instruction set is available.
  System::Call "kernel32::IsProcessorFeaturePresent(i 10)i .R7"
  StrCpy $CpuSupportsSSE "$R7"
FunctionEnd

!include "stub.nsh"

Page custom createProfileCleanup
Page custom createInstall ; Download / Installation page

Function CanWrite
  StrCpy $CanWriteToInstallDir "false"

  StrCpy $0 "$INSTDIR"
  ; Use the existing directory when it exists
  ${Unless} ${FileExists} "$INSTDIR"
    ; Get the topmost directory that exists for new installs
    ${DoUntil} ${FileExists} "$0"
      ${GetParent} "$0" $0
      ${If} "$0" == ""
        Return
      ${EndIf}
    ${Loop}
  ${EndUnless}

  GetTempFileName $2 "$0"
  Delete $2
  CreateDirectory "$2"

  ${If} ${FileExists} "$2"
    ${If} ${FileExists} "$INSTDIR"
      GetTempFileName $3 "$INSTDIR"
    ${Else}
      GetTempFileName $3 "$2"
    ${EndIf}
    ${If} ${FileExists} "$3"
      Delete "$3"
      StrCpy $CanWriteToInstallDir "true"
    ${EndIf}
    RmDir "$2"
  ${EndIf}
FunctionEnd

Function .onInit
  Call CommonOnInit
FunctionEnd

Function .onUserAbort
  WebBrowser::CancelTimer $TimerHandle

  ${If} "$IsDownloadFinished" != ""
    ; Go ahead and cancel the download so it doesn't keep running while this
    ; prompt is up. We'll resume it if the user decides to continue.
    InetBgDL::Get /RESET /END

    ${ShowTaskDialog} $(STUB_CANCEL_PROMPT_HEADING) \
                      $(STUB_CANCEL_PROMPT_MESSAGE) \
                      $(STUB_CANCEL_PROMPT_BUTTON_CONTINUE) \
                      $(STUB_CANCEL_PROMPT_BUTTON_EXIT)
    Pop $0
    ${If} $0 == 1002
      ; The cancel button was clicked
      StrCpy $ExitCode "${ERR_DOWNLOAD_CANCEL}"
      Call LaunchHelpPage
      Call SendPing
    ${Else}
      ; Either the continue button was clicked or the dialog was dismissed
      Call StartDownload
    ${EndIf}
  ${Else}
    Call SendPing
  ${EndIf}

  ; Aborting the abort will allow SendPing to hide the installer window and
  ; close the installer after it sends the metrics ping, or allow us to just go
  ; back to installing if that's what the user selected.
  Abort
FunctionEnd


Section
SectionEnd
