$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("C:\Users\ASUS\Desktop\Restart Another Me.lnk")
$Shortcut.TargetPath = "C:\Users\ASUS\Documents\Web Projects\another-me\restart-another-me.bat"
$Shortcut.WorkingDirectory = "C:\Users\ASUS\Documents\Web Projects\another-me"
$Shortcut.IconLocation = "shell32.dll,238"
$Shortcut.Description = "Restart Another Me WhatsApp AI Service"
$Shortcut.Save()
Write-Host "Restart Shortcut created successfully!"
