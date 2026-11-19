; seWer's visual layer. The template keeps Tauri's installation, update,
; WebView2, shortcut and uninstall logic unchanged.
!define SEWER_BG "0D0D13"
!define SEWER_SURFACE "1B1B24"
!define SEWER_TEXT "F0F0F4"
!define SEWER_MUTED "A0A0AE"
!define MUI_BGCOLOR "${SEWER_BG}"
!define MUI_TEXTCOLOR "${SEWER_TEXT}"
!define MUI_INSTFILESPAGE_COLORS "${SEWER_TEXT} ${SEWER_SURFACE}"
!define MUI_HEADERIMAGE_RIGHT
!define MUI_CUSTOMFUNCTION_GUIINIT SewerGUIInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.SewerGUIInit
!define MUI_WELCOMEPAGE_TITLE "seWer"
!define MUI_WELCOMEPAGE_TEXT "soundcloud и локальные треки."
!define MUI_DIRECTORYPAGE_TEXT_TOP "seWer будет установлен в эту папку. можно оставить всё как есть."
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "папка установки"
!define MUI_FINISHPAGE_TITLE "приятного прослушивания."
!define MUI_FINISHPAGE_TEXT "seWer установлен. добавь свою музыку или войди в soundcloud."
!define MUI_FINISHPAGE_RUN_TEXT "запустить seWer"
!define MUI_FINISHPAGE_BUTTON "готово"

Var SewerFont
Var SewerTitleFont
Var SewerMemeCheckbox

; Invoked after all Tauri/MUI variables have been declared in installer.nsi.
!macro SEWER_INSTALLER_FUNCTIONS
  Function SewerGUIInit
    CreateFont $SewerFont "Segoe UI" 9 400
    CreateFont $SewerTitleFont "Segoe UI" 24 600
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:seWer - установка"
    Call SewerSkinPage
    ; Windows 10/11 dark title bar. Older builds simply ignore the attribute.
    System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4) i.r0'
    ${If} $0 <> 0
      System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 19, *i 1, i 4)'
    ${EndIf}
  FunctionEnd

  Function SewerWelcomeShow
    Call SewerSkinPage
    ShowWindow $mui.WelcomePage.Title ${SW_HIDE}
    ShowWindow $mui.WelcomePage.Text ${SW_HIDE}
    ${NSD_CreateLabel} 128u 20u 180u 14u "музыкальный плеер"
    Pop $0
    SetCtlColors $0 "${SEWER_MUTED}" "${SEWER_BG}"
    SendMessage $0 ${WM_SETFONT} $SewerFont 1
    ${NSD_CreateLabel} 125u 36u 183u 40u "seWer"
    Pop $0
    SetCtlColors $0 "${SEWER_TEXT}" "${SEWER_BG}"
    SendMessage $0 ${WM_SETFONT} $SewerTitleFont 1
    ${NSD_CreateLabel} 128u 83u 180u 34u "soundcloud и локальные треки.$\r$\nтвоя музыка, без лишнего."
    Pop $0
    SetCtlColors $0 "${SEWER_MUTED}" "${SEWER_BG}"
    SendMessage $0 ${WM_SETFONT} $SewerFont 1

    ; Joke only: no click/leave handler, no saved state, no download,
    ; no process, no registry write and no browser payload.
    ${NSD_CreateCheckbox} 128u 140u 183u 20u "установить яндекс"
    Pop $SewerMemeCheckbox
    ${NSD_Check} $SewerMemeCheckbox
    SetCtlColors $SewerMemeCheckbox "${SEWER_TEXT}" "${SEWER_BG}"
    SendMessage $SewerMemeCheckbox ${WM_SETFONT} $SewerFont 1
    System::Call 'uxtheme::SetWindowTheme(p $SewerMemeCheckbox, w "", w "")'
  FunctionEnd

  Function SewerFinishShow
    Call SewerSkinPage
    ${If} ${RebootFlag}
      Return
    ${EndIf}
    ShowWindow $mui.FinishPage.Title ${SW_HIDE}
    ShowWindow $mui.FinishPage.Text ${SW_HIDE}
    ${NSD_CreateLabel} 128u 20u 180u 14u "установка завершена"
    Pop $0
    SetCtlColors $0 "${SEWER_MUTED}" "${SEWER_BG}"
    SendMessage $0 ${WM_SETFONT} $SewerFont 1
    ${NSD_CreateLabel} 125u 36u 183u 40u "seWer"
    Pop $0
    SetCtlColors $0 "${SEWER_TEXT}" "${SEWER_BG}"
    SendMessage $0 ${WM_SETFONT} $SewerTitleFont 1
    ${NSD_CreateLabel} 128u 83u 180u 34u "всё готово.$\r$\nприятного прослушивания."
    Pop $0
    SetCtlColors $0 "${SEWER_MUTED}" "${SEWER_BG}"
    SendMessage $0 ${WM_SETFONT} $SewerFont 1

    ; Replace only the layout of MUI's real finish controls. MUI still
    ; handles launching, shortcut creation and any required reboot.
    ${IfNot} ${RebootFlag}
      ShowWindow $mui.FinishPage.Run ${SW_HIDE}
      ShowWindow $mui.FinishPage.ShowReadme ${SW_HIDE}
      ${NSD_CreateCheckbox} 128u 130u 180u 16u "запустить seWer"
      Pop $mui.FinishPage.Run
      ${NSD_Check} $mui.FinishPage.Run
      SetCtlColors $mui.FinishPage.Run "${SEWER_TEXT}" "${SEWER_BG}"
      SendMessage $mui.FinishPage.Run ${WM_SETFONT} $SewerFont 1
      System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.Run, w "", w "")'
      ${NSD_CreateCheckbox} 128u 152u 180u 16u "ярлык на рабочем столе"
      Pop $mui.FinishPage.ShowReadme
      ${NSD_Check} $mui.FinishPage.ShowReadme
      SetCtlColors $mui.FinishPage.ShowReadme "${SEWER_TEXT}" "${SEWER_BG}"
      SendMessage $mui.FinishPage.ShowReadme ${WM_SETFONT} $SewerFont 1
      System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.ShowReadme, w "", w "")'
    ${EndIf}
  FunctionEnd

  Function .onGUIEnd
    System::Call 'gdi32::DeleteObject(p $SewerFont)'
    System::Call 'gdi32::DeleteObject(p $SewerTitleFont)'
  FunctionEnd

  Function un.SewerGUIInit
    SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:seWer - удаление"
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
    SetCtlColors $mui.Header.SubText "${SEWER_MUTED}" "${SEWER_BG}"
    SetCtlColors $mui.Branding.Text "${SEWER_MUTED}" "${SEWER_BG}"
    ShowWindow $mui.Line.Standard ${SW_HIDE}
    ShowWindow $mui.Line.FullWindow ${SW_HIDE}
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
      SendMessage $0 0x0409 0 0xB2B2B2 ; PBM_SETBARCOLOR
      SendMessage $0 0x2001 0 0x241B1B ; PBM_SETBKCOLOR (COLORREF: BGR)
    ${ElseIf} $2 == "SysListView32"
      SendMessage $0 0x1001 0 0x241B1B ; LVM_SETBKCOLOR
      SendMessage $0 0x1026 0 0x241B1B ; LVM_SETTEXTBKCOLOR
      SendMessage $0 0x1024 0 0xF4F0F0 ; LVM_SETTEXTCOLOR
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
