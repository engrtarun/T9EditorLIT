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
    [string]$AppId = 'com.engrtarun.t9editorlit',
    [string]$DisplayName = 'T9 Editor LIT'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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
using System.Text;

namespace T9Pinning
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    internal class ShellLinkCoClass { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPersistFile
    {
        void GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string ppszFileName);
    }

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
        // {9F4C2855-9F79-4B39-A8D0-E1D42DE1D936}, 5  ->  System.AppUserModel.ID
        private static readonly PROPERTYKEY AppUserModelIdKey =
            new PROPERTYKEY(new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D936"), 5);

        /// <summary>Write an AppUserModelID into an existing .lnk file.</summary>
        public static void SetAppUserModelId(string shortcutPath, string appUserModelId)
        {
            var link = (IShellLinkW)new ShellLinkCoClass();
            ((IPersistFile)link).Load(shortcutPath, 0);

            var store = (IPropertyStore)link;

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
            }

            ((IPersistFile)link).Save(shortcutPath, true);
            Marshal.ReleaseComObject(link);
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
Write-Host "    [ok] $Shortcut" -ForegroundColor Green

# ---------------------------------------------------------------------------
# 4. Give it the AppUserModelID
# ---------------------------------------------------------------------------
Write-Host '==> Attaching the AppUserModelID' -ForegroundColor Cyan
try {
    [T9Pinning.Shell]::SetAppUserModelId($Shortcut, $AppId)
    Write-Host "    [ok] $AppId" -ForegroundColor Green
} catch {
    # Some Windows builds refuse the property write on a shortcut that is
    # already registered. Not fatal: the pin can still be done by hand, and
    # the AppUserModelId registration below is what the shell really needs.
    Write-Host "    [!] could not write the property: $($_.Exception.Message)" -ForegroundColor Yellow
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
