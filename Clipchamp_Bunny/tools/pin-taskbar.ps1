<#
.SYNOPSIS
    Pin a shortcut to the Windows taskbar.

.DESCRIPTION
    Windows has no supported API for this, so two routes are tried in order:

      1. The shell's own "taskbarpin" verb on the shortcut.
      2. Dropping a copy of the shortcut into the taskbar's pinned folder and
         restarting Explorer, which is the folder Windows itself maintains.

    The second route always works; the first one just does it politely.

.PARAMETER Shortcut
    The .lnk file to pin. Defaults to the one the deploy script writes.

.EXAMPLE
    pwsh -File tools/pin-taskbar.ps1
#>
[CmdletBinding()]
param(
    [string]$Shortcut = (Join-Path $env:LOCALAPPDATA 'Programs\T9EditorLIT\T9 Editor LIT.lnk')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Shortcut)) {
    throw "Shortcut not found: $Shortcut"
}

function Get-PinnedFolder {
    # The taskbar's pinned items live here. There is a second, older location
    # for the classic taskbar; both are checked.
    $candidates = @(
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
    )
    foreach ($c in $candidates | Select-Object -Unique) {
        if (Test-Path $c) { return $c }
    }
    return $candidates[0]
}

Write-Host "==> Pinning $Shortcut" -ForegroundColor Cyan

# --- route 1: the shell verb -------------------------------------------------
$pinned = $false
try {
    $shell = New-Object -ComObject Shell.Application
    $folder = $shell.Namespace((Split-Path $Shortcut -Parent))
    $item = $folder.ParseName((Split-Path $Shortcut -Leaf))
    if ($item) {
        foreach ($verb in $item.Verbs()) {
            if ($verb.Name -replace '&', '' -eq 'taskbarpin') {
                $verb.DoIt()
                $pinned = $true
                break
            }
        }
    }
} catch {
    Write-Host "    [!] shell verb failed: $($_.Exception.Message)" -ForegroundColor Yellow
}

Start-Sleep -Milliseconds 1200

# --- route 2: the pinned folder ---------------------------------------------
$pinnedFolder = Get-PinnedFolder
New-Item -ItemType Directory -Force -Path $pinnedFolder | Out-Null
$dest = Join-Path $pinnedFolder (Split-Path $Shortcut -Leaf)
Copy-Item $Shortcut $dest -Force

# Explorer caches the taskbar; a refresh makes it pick the new item up.
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 1500
Start-Process explorer.exe
Start-Sleep -Milliseconds 1500

if (-not $pinned) {
    Write-Host "    [ok] shortcut placed in the pinned folder" -ForegroundColor Green
} else {
    Write-Host "    [ok] pinned via the shell verb" -ForegroundColor Green
}

# --- report -----------------------------------------------------------------
$items = Get-ChildItem $pinnedFolder -Filter *.lnk -ErrorAction SilentlyContinue
if ($items) {
    Write-Host "    taskbar now holds:" -ForegroundColor DarkGray
    foreach ($i in $items) {
        $ws = New-Object -ComObject WScript.Shell
        $l = $ws.CreateShortcut($i.FullName)
        Write-Host "      - $($i.Name) -> $($l.TargetPath)" -ForegroundColor DarkGray
    }
}
