' Launch the Morning Brief daily run with no visible console window.
' Runs run-daily.cmd (same folder) in the interactive session but hidden, so the
' scheduled task doesn't pop a cmd.exe window each morning.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "cmd /c """ & scriptDir & "\run-daily.cmd""", 0, True
