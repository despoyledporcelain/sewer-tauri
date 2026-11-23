; Full-width seWer pages. Native NSIS pages still handle directory validation,
; maintenance, install progress and errors.
!define SEWER_BG "16161D"
!define SEWER_SURFACE "23232F"
!define SEWER_TEXT "F5F2FC"
!define SEWER_MUTED "B5B0C3"
!define SEWER_ACCENT "C9B7F5"
!define MUI_BGCOLOR "${SEWER_BG}"
!define MUI_TEXTCOLOR "${SEWER_TEXT}"
!define MUI_INSTFILESPAGE_COLORS "${SEWER_TEXT} ${SEWER_SURFACE}"
!define MUI_CUSTOMFUNCTION_GUIINIT SewerGUIInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.SewerGUIInit

Var SewerTitleFont
Var SewerHeadingFont
Var SewerChoiceFont
!define SEWER_RECORD "${__FILEDIR__}\record.bmp"
Var SewerRecordImage
Var SewerDialog
Var SewerRunCheckbox
Var SewerShortcutCheckbox
Var SewerRestartCheckbox

!macro SEWER_INSTALLER_STRINGS
  LangString SewerInstalled ${LANG_ENGLISH} "Already installed"
  LangString SewerInstalled ${LANG_RUSSIAN} "Уже установлен"
  LangString SewerUpgrade ${LANG_ENGLISH} "Update seWer"
  LangString SewerUpgrade ${LANG_RUSSIAN} "Обновить seWer"
  LangString SewerDowngrade ${LANG_ENGLISH} "Earlier version"
  LangString SewerDowngrade ${LANG_RUSSIAN} "Откат версии"
  LangString SewerReinstall ${LANG_ENGLISH} "Reinstall seWer"
  LangString SewerReinstall ${LANG_RUSSIAN} "Переустановить seWer"
  LangString SewerReplace ${LANG_ENGLISH} "Remove current version first"
  LangString SewerReplace ${LANG_RUSSIAN} "Сначала удалить текущую версию"
  LangString SewerInPlace ${LANG_ENGLISH} "Install over current version"
  LangString SewerInPlace ${LANG_RUSSIAN} "Установить поверх текущей"
  LangString SewerRequiresRemoval ${LANG_ENGLISH} "This version requires removing the current installation."
  LangString SewerRequiresRemoval ${LANG_RUSSIAN} "Для отката нужно удалить текущую версию."
  LangString SewerSetup ${LANG_ENGLISH} "Install seWer"
  LangString SewerSetup ${LANG_RUSSIAN} "Установка seWer"
  LangString SewerUninstall ${LANG_ENGLISH} "Uninstall seWer"
  LangString SewerUninstall ${LANG_RUSSIAN} "Удаление seWer"
  LangString SewerMusic ${LANG_ENGLISH} "Local music and SoundCloud in one player."
  LangString SewerMusic ${LANG_RUSSIAN} "Локальная музыка и SoundCloud в одном плеере."
  LangString SewerReady ${LANG_ENGLISH} "Setup complete"
  LangString SewerReady ${LANG_RUSSIAN} "Готово"
  LangString SewerLaunch ${LANG_ENGLISH} "Launch seWer"
  LangString SewerLaunch ${LANG_RUSSIAN} "Запустить seWer"
  LangString SewerRestartNeeded ${LANG_ENGLISH} "Restart Windows to complete setup"
  LangString SewerRestartNeeded ${LANG_RUSSIAN} "Для завершения установки перезапустите Windows"
  LangString SewerRestartNow ${LANG_ENGLISH} "Restart Windows now"
  LangString SewerRestartNow ${LANG_RUSSIAN} "Перезапустить Windows сейчас"
  LangString SewerDone ${LANG_ENGLISH} "&Finish"
  LangString SewerDone ${LANG_RUSSIAN} "&Готово"
  LangString SewerClose ${LANG_ENGLISH} "&Close"
  LangString SewerClose ${LANG_RUSSIAN} "&Закрыть"
  LangString SewerFolder ${LANG_ENGLISH} "Install location"
  LangString SewerFolder ${LANG_RUSSIAN} "Папка установки"
  LangString SewerInstalling ${LANG_ENGLISH} "Installing seWer"
  LangString SewerInstalling ${LANG_RUSSIAN} "Установка seWer"
!macroend

; Match the NSIS dialog font and DPI instead of positioning in device pixels.
!macro SEWER_PLACE PARENT CONTROL X Y WIDTH HEIGHT ZORDER FLAGS
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  System::Call '*(i ${X}, i ${Y}, i ${WIDTH}, i ${HEIGHT}) p.r4'
  System::Call 'user32::MapDialogRect(p ${PARENT}, p r4)'
  System::Call '*$4(i .r0, i .r1, i .r2, i .r3)'
  System::Free $4
  System::Call 'user32::SetWindowPos(p ${CONTROL}, p ${ZORDER}, i r0, i r1, i r2, i r3, i ${FLAGS})'
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro SEWER_LABEL TOP HEIGHT COPY COLOR
  ${NSD_CreateLabel} 22u ${TOP} 165u ${HEIGHT} "${COPY}"
  Pop $0
  SetCtlColors $0 "${COLOR}" "${SEWER_BG}"
!macroend

!macro SEWER_RADIO TOP HANDLE
  ${NSD_CreateRadioButton} 22u ${TOP} 170u 24u "${HANDLE}"
  Pop ${HANDLE}
  System::Call 'uxtheme::SetWindowTheme(p ${HANDLE}, w " ", w " ")'
  SetCtlColors ${HANDLE} "${SEWER_TEXT}" "${SEWER_BG}"
  SendMessage ${HANDLE} ${WM_SETFONT} $SewerChoiceFont 1
  ${NSD_OnClick} ${HANDLE} PageReinstallUpdateSelection
!macroend

!macro SEWER_CHECKBOX TOP COPY HANDLE
  ${NSD_CreateCheckbox} 22u ${TOP} 165u 15u "${COPY}"
  Pop ${HANDLE}
  SetCtlColors ${HANDLE} "${SEWER_TEXT}" "${SEWER_BG}"
  System::Call 'uxtheme::SetWindowTheme(p ${HANDLE}, w " ", w " ")'
!macroend

!macro SEWER_INSTALLER_FUNCTIONS
  Function SewerGUIInit
    CreateFont $SewerTitleFont "Segoe UI" 38 700
    CreateFont $SewerHeadingFont "Segoe UI" 21 600
    CreateFont $SewerChoiceFont "Segoe UI" 10 400
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:$(SewerSetup)"
    Call SewerSkinPage

    ; Keep the dialog client size and discard the native caption and its edge.
    System::Call '*(i 0, i 0, i 0, i 0) p.r4'
    System::Call 'user32::GetClientRect(p $HWNDPARENT, p r4)'
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i.r1'
    IntOp $1 $1 & 0xFF3FFFFF ; ~WS_CAPTION
    System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i r1)'
    System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20) i.r1'
    IntOp $1 $1 & 0xFFFFFEFE ; ~(WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE)
    System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -20, i r1)'
    System::Call '*$4(i .r0, i .r1, i .r2, i .r3)'
    System::Free $4
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r2, i r3, i 0x36)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4)'

    !insertmacro SEWER_PLACE $HWNDPARENT $mui.Button.Back 26 194 66 22 0 0x14
    !insertmacro SEWER_PLACE $HWNDPARENT $mui.Button.Next 239 194 66 22 0 0x14
    SetAutoClose true
  FunctionEnd

  Function SewerCloseButton
    SendMessage $mui.Button.Cancel ${WM_SETTEXT} 0 "STR:$(SewerClose)"
    !insertmacro SEWER_PLACE $HWNDPARENT $mui.Button.Cancel 261 7 56 18 0 0x10
  FunctionEnd

  Function SewerCreatePage
    ; 1044 is the full-width client area in the NSIS modern dialog.
    nsDialogs::Create 1044
    Pop $SewerDialog
    ${If} $SewerDialog == error
      Abort
    ${EndIf}
    SetCtlColors $SewerDialog "" "${SEWER_BG}"
    InitPluginsDir
    File "/oname=$PLUGINSDIR\record.bmp" "${SEWER_RECORD}"
    ${NSD_CreateBitmap} 198u 38u 116u 102u ""
    Pop $0
    ${NSD_SetStretchedImage} $0 "$PLUGINSDIR\record.bmp" $SewerRecordImage
  FunctionEnd

  Function SewerShowPage
    ShowWindow $mui.Header.Image ${SW_HIDE}
    ShowWindow $mui.Header.Background ${SW_HIDE}
    ShowWindow $mui.Line.Standard ${SW_HIDE}
    ShowWindow $mui.Line.FullWindow ${SW_HIDE}
    ShowWindow $mui.Header.Text ${SW_HIDE}
    ShowWindow $mui.Header.SubText ${SW_HIDE}
    ShowWindow $mui.Branding.Text ${SW_HIDE}
    ShowWindow $mui.Branding.Background ${SW_HIDE}
    Call SewerCloseButton
    nsDialogs::Show
    ${NSD_FreeImage} $SewerRecordImage
    ShowWindow $mui.Header.Text ${SW_SHOW}
    ShowWindow $mui.Header.SubText ${SW_SHOW}
  FunctionEnd

  Function SewerWelcome
    Call SkipIfPassive
    Call SewerCreatePage
    !insertmacro SEWER_LABEL 32u 14u "$(SewerSetup)" "${SEWER_ACCENT}"
    !insertmacro SEWER_LABEL 52u 48u "seWer" "${SEWER_TEXT}"
    SendMessage $0 ${WM_SETFONT} $SewerTitleFont 1
    !insertmacro SEWER_LABEL 105u 40u "$(SewerMusic)" "${SEWER_MUTED}"
    !insertmacro SEWER_LABEL 155u 14u "v${VERSION}" "${SEWER_MUTED}"
    Call SewerShowPage
  FunctionEnd

  Function SewerDirectoryShow
    Call SewerSkinPage
    ShowWindow $mui.Header.Text ${SW_HIDE}
    ShowWindow $mui.Header.SubText ${SW_HIDE}
    ShowWindow $mui.DirectoryPage.DirectoryBox ${SW_HIDE}

    SendMessage $mui.DirectoryPage.Text ${WM_SETTEXT} 0 "STR:$(SewerFolder)"
    SendMessage $mui.DirectoryPage.Text ${WM_SETFONT} $SewerHeadingFont 1
    !insertmacro SEWER_PLACE $mui.DirectoryPage $mui.DirectoryPage.Text 11 9 279 34 0 0x14
    !insertmacro SEWER_PLACE $mui.DirectoryPage $mui.DirectoryPage.Directory 11 58 202 22 0 0x14
    !insertmacro SEWER_PLACE $mui.DirectoryPage $mui.DirectoryPage.BrowseButton 224 58 66 22 0 0x14
    !insertmacro SEWER_PLACE $mui.DirectoryPage $mui.DirectoryPage.SpaceRequired 11 96 276 11 0 0x14
    !insertmacro SEWER_PLACE $mui.DirectoryPage $mui.DirectoryPage.SpaceAvailable 11 110 276 11 0 0x14
    SetCtlColors $mui.DirectoryPage.SpaceRequired "${SEWER_MUTED}" "${SEWER_BG}"
    SetCtlColors $mui.DirectoryPage.SpaceAvailable "${SEWER_MUTED}" "${SEWER_BG}"
  FunctionEnd

  Function SewerProgressShow
    Call SewerSkinPage
    ShowWindow $mui.Header.Text ${SW_SHOW}
    ShowWindow $mui.Header.SubText ${SW_HIDE}
    SendMessage $mui.Header.Text ${WM_SETTEXT} 0 "STR:$(SewerInstalling)"
    SendMessage $mui.Header.Text ${WM_SETFONT} $SewerHeadingFont 1
    !insertmacro SEWER_PLACE $HWNDPARENT $mui.Header.Text 15 9 242 34 0 0x14
  FunctionEnd

  Function SewerFinish
    Call SkipIfPassive
    Call SewerCreatePage
    !insertmacro SEWER_LABEL 26u 14u "seWer   /   v${VERSION}" "${SEWER_ACCENT}"
    !insertmacro SEWER_LABEL 52u 37u "$(SewerReady)" "${SEWER_TEXT}"
    SendMessage $0 ${WM_SETFONT} $SewerHeadingFont 1
    ${If} ${RebootFlag}
      !insertmacro SEWER_LABEL 94u 35u "$(SewerRestartNeeded)" "${SEWER_MUTED}"
      !insertmacro SEWER_CHECKBOX 138u "$(SewerRestartNow)" $SewerRestartCheckbox
    ${Else}
      !insertmacro SEWER_CHECKBOX 100u "$(SewerLaunch)" $SewerRunCheckbox
      !insertmacro SEWER_CHECKBOX 123u "$(createDesktop)" $SewerShortcutCheckbox
      ${NSD_Check} $SewerRunCheckbox
      ${NSD_Check} $SewerShortcutCheckbox
    ${EndIf}
    SendMessage $mui.Button.Next ${WM_SETTEXT} 0 "STR:$(SewerDone)"
    EnableWindow $mui.Button.Back 0
    EnableWindow $mui.Button.Cancel 0
    ShowWindow $mui.Button.Cancel ${SW_HIDE}
    Call SewerShowPage
  FunctionEnd

  Function SewerFinishLeave
    ${If} ${RebootFlag}
      ${NSD_GetState} $SewerRestartCheckbox $0
      ${If} $0 == ${BST_CHECKED}
        Reboot
      ${EndIf}
      Return
    ${EndIf}
    ${NSD_GetState} $SewerShortcutCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      Call CreateOrUpdateDesktopShortcut
    ${EndIf}
    ${NSD_GetState} $SewerRunCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      Call RunMainBinary
    ${EndIf}
  FunctionEnd

  Function .onGUIEnd
    System::Call 'gdi32::DeleteObject(p $SewerChoiceFont)'
    System::Call 'gdi32::DeleteObject(p $SewerTitleFont)'
    System::Call 'gdi32::DeleteObject(p $SewerHeadingFont)'
  FunctionEnd

  Function un.SewerGUIInit
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:$(SewerUninstall)"
    Call un.SewerSkinPage
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  FunctionEnd
!macroend

; Native dialogs retain keyboard navigation, focus rings, disabled states,
; directory validation, progress and the installation error log.
!macro SEWER_SKIN_FUNCTIONS PREFIX
  Function ${PREFIX}SewerSkinPage
    Push $0
    Push $HWNDPARENT
    Call ${PREFIX}SewerSkinChildren
    ShowWindow $mui.Header.Text ${SW_SHOW}
    ShowWindow $mui.Header.SubText ${SW_SHOW}
    SetCtlColors $mui.Header.SubText "${SEWER_MUTED}" "${SEWER_BG}"
    ShowWindow $mui.Branding.Text ${SW_HIDE}
    ShowWindow $mui.Branding.Background ${SW_HIDE}
    ShowWindow $mui.Line.Standard ${SW_HIDE}
    ShowWindow $mui.Line.FullWindow ${SW_HIDE}
    !if "${PREFIX}" == ""
      Call SewerCloseButton
    !endif
    Pop $0
  FunctionEnd

  Function ${PREFIX}SewerSkinChildren
    Exch $0
    Push $1
    Push $2
    SetCtlColors $0 "${SEWER_TEXT}" "${SEWER_BG}"
    System::Call 'user32::GetClassName(p r0, w .r2, i ${NSIS_MAX_STRLEN})'
    ${If} $2 == "Edit"
      SetCtlColors $0 "${SEWER_TEXT}" "${SEWER_SURFACE}"
    ${ElseIf} $2 == "Button"
      System::Call 'uxtheme::SetWindowTheme(p r0, w "DarkMode_Explorer", p 0)'
    ${ElseIf} $2 == "msctls_progress32"
      System::Call 'uxtheme::SetWindowTheme(p r0, w "", w "")'
      SendMessage $0 0x0409 0 0xF5B7C9 ; PBM_SETBARCOLOR
      SendMessage $0 0x2001 0 0x2F2323 ; PBM_SETBKCOLOR (COLORREF: BGR)
    ${ElseIf} $2 == "SysListView32"
      SendMessage $0 0x1001 0 0x2F2323 ; LVM_SETBKCOLOR
      SendMessage $0 0x1026 0 0x2F2323 ; LVM_SETTEXTBKCOLOR
      SendMessage $0 0x1024 0 0xFCF2F5 ; LVM_SETTEXTCOLOR
    ${EndIf}
    System::Call 'user32::GetWindow(p r0, i 5) p.r1' ; GW_CHILD
    sewer_skin_loop:
      ${If} $1 <> 0
        Push $1
        Call ${PREFIX}SewerSkinChildren
        System::Call 'user32::GetWindow(p r1, i 2) p.r1' ; GW_HWNDNEXT
        Goto sewer_skin_loop
      ${EndIf}
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
!macroend
