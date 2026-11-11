<#
.SYNOPSIS
    Give a .lnk an AppUserModelID and pin it to the taskbar.

.DESCRIPTION
    Windows 11 only offers "Pin to taskbar" on a shell item when that item
    carries a **real AppUserModelID**. A plain shortcut made by WScript.Shell
    has none, so the verb never appears and the "copy the .lnk into the pinned
    folder" trick silently does nothing.

    This script does it the way Windows itself does it:

      1. register the AppUserModelID under HKCU\Software\Classes\AppUserModelId
      2. write `System.AppUserModel.ID` into the shortcut's property store
         (that is where the shell looks for it)
      3. ask the shell to pin the shortcut, using its own verb

    After that the app shows up in the Start menu *and* on the taskbar, and the
    pin is a first-class Windows pin - not a file dropped in a folder.

.EXAMPLE
    pwsh -File tools\pin-taskbar.ps1
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\T9EditorLIT'),
    [string]$AppId = '',
    [string]$DisplayName = 'T9 Editor LIT'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The AUMID has to be *exactly* the identifier the app sends to the toast
# platform (tauri.conf.json's `identifier`), or Windows drops every toast as
# "unknown app". Read it instead of trusting a second copy of the string.
if (-not $AppId) {
    $conf = Join-Path (Split-Path $PSScriptRoot -Parent) 'src-tauri\tauri.conf.json'
    if (Test-Path $conf) {
        $AppId = (Get-Content $conf -Raw | ConvertFrom-Json).identifier
    }
    if (-not $AppId) { $AppId = 'com.engrtarun.t9editorlit' }
}

$ExeName = 't9-editor-lit.exe'
$Exe = Join-Path $InstallDir $ExeName
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$Shortcut = Join-Path $StartMenu "$DisplayName.lnk"

if (-not (Test-Path $Exe)) { throw "Executable not found: $Exe" }

# ---------------------------------------------------------------------------
# 1. Register the AppUserModelID
# ---------------------------------------------------------------------------
Write-Host '==> Registering the AppUserModelID' -ForegroundColor Cyan
$classRoot = 'HKCU:\Software\Classes\AppUserModelId'
$appKey = Join-Path $classRoot $AppId
New-Item -Path $appKey -Force | Out-Null
New-ItemProperty -Path $appKey -Name 'DisplayName' -Value $DisplayName -PropertyType String -Force | Out-Null
New-ItemProperty -Path $appKey -Name 'IconUri' -Value $Exe -PropertyType String -Force | Out-Null
Write-Host "    [ok] $AppId" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 2. The COM helper that writes the AUMID into a .lnk
# ---------------------------------------------------------------------------
if (-not ('T9Pinning' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace T9Pinning
{
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        uint GetCount(out uint cProps);
        void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue(ref PROPERTYKEY pkey, out PROPVARIANT pv);
        void SetValue(ref PROPERTYKEY pkey, ref PROPVARIANT pv);
        void Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROPERTYKEY
    {
        public Guid fmtid;
        public uint pid;
        public PROPERTYKEY(Guid f, uint p) { fmtid = f; pid = p; }
    }

    [StructLayout(LayoutKind.Explicit)]
    internal struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointer;
    }

    public static class Shell
    {
        // {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5  ->  System.AppUserModel.ID
        private static readonly PROPERTYKEY AppUserModelIdKey =
            new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), 5);

        private const uint GPS_READWRITE = 0x2;

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHGetPropertyStoreFromParsingName(
            string pszPath, IntPtr pbc, uint flags, ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ppv);

        /// <summary>Write an AppUserModelID into an existing .lnk file.</summary>
        /// <remarks>
        /// The property store is opened on the shortcut itself. Going through
        /// IShellLink + IPersistFile and committing on that same object fails
        /// with STG_E_ACCESSDENIED on Windows 11 (the file is already held by
        /// the object that loaded it), which is exactly how the shortcut ended
        /// up with no AUMID — and then no toast ever reached the shell.
        /// </remarks>
        public static void SetAppUserModelId(string shortcutPath, string appUserModelId)
        {
            Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
            IPropertyStore store;
            SHGetPropertyStoreFromParsingName(shortcutPath, IntPtr.Zero, GPS_READWRITE, ref iid, out store);

            IntPtr text = Marshal.StringToHGlobalUni(appUserModelId);
            try
            {
                var value = new PROPVARIANT { vt = 31 /* VT_LPWSTR */, pointer = text };
                var key = AppUserModelIdKey;
                store.SetValue(ref key, ref value);
                store.Commit();
            }
            finally
            {
                Marshal.FreeHGlobal(text);
                Marshal.ReleaseComObject(store);
            }
        }
    }
}
'@
}

# ---------------------------------------------------------------------------
# 3. Write (or refresh) the shortcut
# ---------------------------------------------------------------------------
Write-Host '==> Writing the shortcut' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $StartMenu | Out-Null

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($Shortcut)
$lnk.TargetPath       = $Exe
$lnk.WorkingDirectory = $InstallDir
$lnk.IconLocation     = "$Exe,0"
$lnk.Description      = 'T9 Editor LIT - transcript-first video cutter'
$lnk.Save()
# Drop the COM handle before the property store opens the same file: a
# shortcut still held open cannot be committed (STG_E_ACCESSDENIED).
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($lnk)
[void][Runtime.InteropServices.Marshal]::ReleaseComObject($ws)
Remove-Variable lnk, ws
Write-Host "    [ok] $Shortcut" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 4. Give it the AppUserModelID
# ---------------------------------------------------------------------------
Write-Host '==> Attaching the AppUserModelID' -ForegroundColor Cyan
try {
    [T9Pinning.Shell]::SetAppUserModelId($Shortcut, $AppId)
    Write-Host "    [ok] $AppId" -ForegroundColor Green
} catch {
    # Without this property Windows has no idea which app a toast belongs to
    # and silently drops every notification for it — the exact reason
    # "notification nahi aa raha" had no visible cause.
    Write-Host "    [!] could not write the property: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '    [!] OS notifications will NOT appear until this succeeds' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 5. Ask the shell to pin it
# ---------------------------------------------------------------------------
Write-Host '==> Pinning to the taskbar' -ForegroundColor Cyan
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace($StartMenu)
$item = $folder.ParseName((Split-Path $Shortcut -Leaf))
if (-not $item) { throw "The shell cannot see $Shortcut" }

$verbs = @($item.Verbs())
Write-Host '    verbs: ' + (($verbs | ForEach-Object { $_.Name -replace '&', '' }) -join ' | ') -ForegroundColor DarkGray

$pinned = $false

# Route 1: the enumerated verb.
$pinVerb = $verbs | Where-Object { ($_.Name -replace '&', '') -match 'Pin to taskbar' } | Select-Object -First 1
if ($pinVerb) {
    $pinVerb.DoIt()
    $pinned = $true
    Write-Host '    [ok] pinned via the enumerated verb' -ForegroundColor Green
}

# Route 2: the canonical verb name, which works even when the shell does not
# advertise the verb on a raw IShellItem (the Start menu search panel does
# show it, the legacy enumeration does not).
if (-not $pinned) {
    try {
        $item.InvokeVerb('taskbarpin')
        $pinned = $true
        Write-Host '    [ok] pinned via InvokeVerb(taskbarpin)' -ForegroundColor Green
    } catch {
        Write-Host "    [!] InvokeVerb failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

Start-Sleep -Seconds 2

if (-not $pinned) {
    Write-Host '    [!] the shell refused the pin - pin it by hand from the Start menu search' -ForegroundColor Yellow
    exit 1
}

# ---------------------------------------------------------------------------
# 6. Report
# ---------------------------------------------------------------------------
$taskbar = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'

# The shell's own word is the truth here: an item that is already pinned
# shows "Unpin from taskbar" instead of "Pin to taskbar".
$pinnedForReal = $false
$verbsNow = @($item.Verbs()) | ForEach-Object { $_.Name -replace '&', '' }
if ($verbsNow -match 'Unpin from taskbar') {
    $pinnedForReal = $true
    Write-Host '    [ok] the shell reports it as pinned ("Unpin from taskbar")' -ForegroundColor Green
}

Get-ChildItem $taskbar -Filter "$DisplayName.lnk" -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "    [ok] shortcut file: $($_.FullName)" -ForegroundColor Green }

if (-not $pinnedForReal) {
    Write-Host ''
    Write-Host '    The shell did not take the pin programmatically.' -ForegroundColor Yellow
    Write-Host '    Pin it by hand - it takes two seconds:' -ForegroundColor Yellow
    Write-Host '      1. Press the Windows key, type "T9 Editor LIT"' -ForegroundColor Yellow
    Write-Host '      2. Right-click the app -> "Pin to taskbar"' -ForegroundColor Yellow
    Write-Host '    The Start menu entry and the AppUserModelID are already in place,' -ForegroundColor Yellow
    Write-Host '    so the app shows up there with the right name and icon.' -ForegroundColor Yellow
    exit 1
}
