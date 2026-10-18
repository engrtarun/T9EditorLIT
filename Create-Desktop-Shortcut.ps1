# Create Desktop Shortcut for T9EditorLIT
$desktop = [Environment]::GetFolderPath("Desktop")
$wsDir = $PSScriptRoot
$launcher = Join-Path $wsDir "Launch-T9Editor.bat"
$iconPath = Join-Path $wsDir "src-tauri\icons\icon.ico"

$wsh = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path $desktop "T9EditorLIT.lnk"
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $wsDir
$shortcut.Description = "T9EditorLIT - Zero-RAM Video Editor"
if (Test-Path $iconPath) {
    $shortcut.IconLocation = "$iconPath,0"
}
$shortcut.Save()

Write-Host "Desktop shortcut created successfully at: $shortcutPath" -ForegroundColor Green
