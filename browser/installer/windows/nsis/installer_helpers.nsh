# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

!ifndef INSTALLER_HELPERS_NSH
!define INSTALLER_HELPERS_NSH

!include control_utils.nsh
!include install_dir_helpers.nsh

; For new installs, install desktop launcher
; TODO: This case needs more nuance. To be fixed as part of Bug 1981597
Function OnInstallDesktopLauncherHandler
  Push $0
  ${SwapShellVarContext} current $0
  Call InstallDesktopLauncher
  ${SetShellVarContextToValue} $0
  Pop $0
FunctionEnd

!macro GetExistingInstallPath Result
  !ifdef HAVE_64BIT_BUILD
    ${GetExistingInstallPathFromRegView} 64 ${Result}
    ${If} ${Result} == ""
      ${GetExistingInstallPathFromRegView} 32 ${Result}
    ${EndIf}
  !else
    ${GetExistingInstallPathFromRegView} 32 ${Result}
    ${If} ${Result} == ""

      ; Only check the 64-bit registry if the native OS is 64-bit
      ; On a native 32-bit OS there is no 64-bit registry view to fall back to
      ${If} ${IsNativeAMD64}
      ${OrIf} ${IsNativeARM64}
        ${GetExistingInstallPathFromRegView} 64 ${Result}
      ${EndIf}
    ${EndIf}
  !endif
!macroend
!define GetExistingInstallPath "!insertmacro GetExistingInstallPath"

!macro GetExistingInstallPathFromRegView RegView Result
  SetRegView ${RegView}
  ${GetExistingInstallPathFromAnyShellVarContext} ${Result}
  SetRegView lastused
!macroend
!define GetExistingInstallPathFromRegView "!insertmacro GetExistingInstallPathFromRegView"

!macro GetExistingInstallPathFromAnyShellVarContext Result
  ${GetExistingInstallPathFromShellVarContext} all ${Result}
  ${If} ${Result} == ""
    ${GetExistingInstallPathFromShellVarContext} current ${Result}
  ${EndIf}
!macroend
!define GetExistingInstallPathFromAnyShellVarContext "!insertmacro GetExistingInstallPathFromAnyShellVarContext"

!macro GetExistingInstallPathFromShellVarContext ShellVarContext Result
  SetShellVarContext ${ShellVarContext}
  ${GetFirstInstallPath} "Software\BrowserWorks\${BrandFullNameInternal}" ${Result}
  ${If} ${Result} == "false"
    StrCpy ${Result} ""
  ${EndIf}
!macroend
!define GetExistingInstallPathFromShellVarContext "!insertmacro GetExistingInstallPathFromShellVarContext"

!endif
