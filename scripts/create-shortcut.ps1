$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("C:\Users\ASUS\Desktop\Another Me.lnk")
$Shortcut.TargetPath = "C:\Users\ASUS\Documents\Web Projects\another-me\start-another-me.bat"
$Shortcut.WorkingDirectory = "C:\Users\ASUS\Documents\Web Projects\another-me"
$Shortcut.IconLocation = "shell32.dll,13"
$Shortcut.Description = "Start Another Me WhatsApp AI Service & Dashboard"
$Shortcut.Save()
Write-Host "Shortcut created successfully on Desktop!"
