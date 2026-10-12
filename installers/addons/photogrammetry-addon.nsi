; Open DroneLog — Photogrammetry add-on installer (NSIS).
; Built by scripts/build-addons.ps1, which passes VERSION, MANIFEST and OUTDIR
; and runs makensis from this folder (paths below are relative to it).
;
; Installs the add-on manifest into the app's add-ons folder; the app's
; Add-ons screen picks it up on Refresh.

Unicode True
SetCompressor /SOLID lzma

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef MANIFEST
  !define MANIFEST "photogrammetry\addon.json"
!endif
!ifndef OUTDIR
  !define OUTDIR "..\..\src-tauri\target\release\bundle\addons"
!endif

!define ADDON_ID "photogrammetry"
!define ADDON_NAME "Open DroneLog Photogrammetry Add-on"
!define REG_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\OpenDroneLog-Addon-${ADDON_ID}"

Name "${ADDON_NAME} ${VERSION}"
OutFile "${OUTDIR}\OpenDroneLog-Photogrammetry-Addon_${VERSION}_x64-setup.exe"
InstallDir "$APPDATA\com.drone-logbook\addons\${ADDON_ID}"
RequestExecutionLevel user
ShowInstDetails show

Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File "/oname=addon.json" "${MANIFEST}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${REG_KEY}" "DisplayName" "${ADDON_NAME}"
  WriteRegStr HKCU "${REG_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REG_KEY}" "Publisher" "Airwulf, LLC"
  WriteRegStr HKCU "${REG_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REG_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${REG_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REG_KEY}" "NoRepair" 1

  MessageBox MB_OK|MB_ICONINFORMATION \
    "${ADDON_NAME} ${VERSION} is installed.$\r$\n$\r$\nIn Open DroneLog open Add-ons (next to Settings) and press Refresh — the Photogrammetry tab appears in the sidebar." \
    /SD IDOK
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\addon.json"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${REG_KEY}"
SectionEnd
