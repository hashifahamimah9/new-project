' UGC Flow Studio - jalankan server tanpa jendela hitam yang mengganggu
' (jendela server diperkecil ke taskbar, browser terbuka otomatis)
Option Explicit
Dim objShell, fso, scriptDir
Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
objShell.CurrentDirectory = scriptDir
objShell.Run Chr(34) & scriptDir & "\KLIK-DISINI-UNTUK-MULAI.bat" & Chr(34), 7, False
