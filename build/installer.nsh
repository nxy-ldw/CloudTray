; installer.nsh —— 自定义安装脚本
;
; 在安装目录写入 installed.marker，让程序能明确区分「安装版」与「便携版」：
;   · 安装版  数据放在 %APPDATA%\收纳桌面，卸载时保留
;   · 便携版  数据放在程序旁的 data 目录，随压缩包一起搬走

!macro customInstall
  FileOpen $0 "$INSTDIR\installed.marker" w
  FileWrite $0 "installed"
  FileClose $0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\installed.marker"
!macroend
