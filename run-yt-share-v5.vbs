Set WshShell = CreateObject("WScript.Shell")
' Set working directory to project root (adjust if needed)
WshShell.CurrentDirectory = "C:\apps\yt-share-v5"
' Launch node server.js hidden (0 = hidden window, False = async)
WshShell.Run "cmd /c node server.js", 0, False
