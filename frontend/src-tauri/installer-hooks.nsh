; Right-click entries for PDFs and pictures, added for the current user only (no administrator rights needed).
; "Edit with officev2" opens the file in the editor; "Convert with officev2" opens the Convert screen for it.

!macro officev2AddVerbs EXT
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\officev2.edit" "" "Edit with officev2"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\officev2.edit" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\officev2.edit\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\officev2.convert" "" "Convert with officev2"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\officev2.convert" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\officev2.convert\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" --convert "%1"'
!macroend

!macro officev2RemoveVerbs EXT
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\officev2.edit"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\officev2.convert"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro officev2AddVerbs ".pdf"
  !insertmacro officev2AddVerbs ".jpg"
  !insertmacro officev2AddVerbs ".jpeg"
  !insertmacro officev2AddVerbs ".png"
  !insertmacro officev2AddVerbs ".webp"
  !insertmacro officev2AddVerbs ".bmp"
  !insertmacro officev2AddVerbs ".tif"
  !insertmacro officev2AddVerbs ".tiff"
  !insertmacro officev2AddVerbs ".gif"
  !insertmacro officev2AddVerbs ".heic"
  !insertmacro officev2AddVerbs ".avif"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; the engine folder also holds files the app made later (caches, add-ons installed from inside the app)
  RMDir /r "$INSTDIR\engine-dist"
  !insertmacro officev2RemoveVerbs ".pdf"
  !insertmacro officev2RemoveVerbs ".jpg"
  !insertmacro officev2RemoveVerbs ".jpeg"
  !insertmacro officev2RemoveVerbs ".png"
  !insertmacro officev2RemoveVerbs ".webp"
  !insertmacro officev2RemoveVerbs ".bmp"
  !insertmacro officev2RemoveVerbs ".tif"
  !insertmacro officev2RemoveVerbs ".tiff"
  !insertmacro officev2RemoveVerbs ".gif"
  !insertmacro officev2RemoveVerbs ".heic"
  !insertmacro officev2RemoveVerbs ".avif"
!macroend
