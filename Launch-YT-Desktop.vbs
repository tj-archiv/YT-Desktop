Set FSO = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
strFolder = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = strFolder
WshShell.Run """node_modules\electron\dist\electron.exe"" .", 0, False
