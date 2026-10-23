<#
.SYNOPSIS
    Sarkari Puter Desk - the AI login counter of the sarkari family.

.DESCRIPTION
    Ek hi cheez ka incharge: Puter ka auth token. Na repo me, na .env me,
    na User env var me - DPAPI-encrypted file me, sirf tumhare Windows
    account se khulta hai.

      1. LOGIN KARANA - "easy setup, no magajmari": browser khud khulta
         hai (puter.com/dashboard#account), user Create token karke
         PASTE karta hai, hum live check karke DPAPI me sambhal lete hain.
         Ek dafa ho gaya, phir kabhi nahi poocha jayega.
      2. STATUS batana - token sahi baitha hai? consent hai? kitne model
         available hain? ai-log me kya chal raha hai?
      3. LOGOUT/ROTATE - credentials ka pol-khol.

    Login ke baad ka AI engine `sarkariBrain.ps1` hai (dot-source module),
    aur users/agents ka AI dara `sarkariHelp.ps1` hai.
    Token priority Brain me: env PUTER_AUTH_TOKEN > ye DPAPI file.

    PRIVACY (poochh kar hi likhte hain - consent flag):
      - AI call me repo ka TEXT Puter cloud me jata hai (user ke apne
        Puter account ke free tier se) - ye dafa consent me likha hota hai.
      - Token kabhi repo/log/console me nahi jata (masked sirf 6 char).
      - ai-log.jsonl me sirf METADATA (kab, kaunsa persona, kitna samay).

    CI/agents: env `PUTER_AUTH_TOKEN` me token de do, -WithToken ki
    zaroorat nahin (Console server par DPAPI ka tak hai hi nahi).

.PARAMETER RepoRoot
    Repository root. Default: sarkari_deploy/ ke parent se resolve hota.

.PARAMETER Agent
    Kis ne chalaya (log me jata hai), e.g. 'opencode/beam-free'.

.PARAMETER Login
    Full login flow (browser kholan, token maangel, validate, consent, save).

.PARAMETER Rotate
    Login jaisa hi, par purana token OVERWRITE hota hai - warn karta hu.

.PARAMETER Logout
    Token file uthao (consent flag banta rehta hai).

.PARAMETER Status
    Poora hisab: token, consent, live models check, ai-log summary.

.PARAMETER ListModels
    Available models ki list (token chahiye).

.PARAMETER Consent
    Sirf consent flag set karo (privacy note phir se padha deta hai).

.PARAMETER WithToken
    Non-interactive: token yahin de do ('-' = STDIN read karo);
    consent ke saath -Consent bhi do (warna AI band rahegi).

.PARAMETER Json
    Machine-readable jawab (agents isi se digest karte hain).

.NOTES
    Exit codes:
      0 = kaam ho gaya / status theek
      1 = token invalid (Puter ne mana kiya)
      2 = login nahi hai / token file padhi nahi gayi
      3 = network se confirm nahi ho paya
#>
[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [string]$Agent = 'unknown',
    [switch]$Login,
    [switch]$Rotate,
    [switch]$Logout,
    [switch]$Status,
    [switch]$ListModels,
    [switch]$Consent,
    [string]$WithToken = '',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

if (-not $RepoRoot) {
    $parent = Split-Path -Parent $PSScriptRoot
    if (Test-Path (Join-Path $parent 'sarkari_deploy')) { $RepoRoot = $parent }
    else { $RepoRoot = Split-Path -Parent $parent }
}

# Console encoding: AI ke jawab (aur console) me unicode bina kaante.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# Engine module (functions only - khud kuch nahi chalata).
. (Join-Path $PSScriptRoot 'sarkariBrain.ps1')
$cfg = Get-SarkariBrainConfig
$dashboardUrl = 'https://puter.com/dashboard#account'

function Write-JsonOut {
    param([hashtable]$Body)
    $Body | ConvertTo-Json -Depth 6 -Compress | Write-Host
}

function Get-PuterTokenInput {
    # -WithToken me token aaya ho (ya '-' = STDIN).
    if ($WithToken -eq '-') {
        $raw = [Console]::In.ReadToEnd()
        return ($raw -replace '(`r`n|`n)', ' ').Trim()
    }
    return $WithToken.Trim()
}

function Read-PuterInteractiveToken {
    # Masked paste: console me kuch na dikhe (right-click paste + Enter).
    $sec = Read-Host 'Token yahan paste karo (nazar me nahi aayega) aur Enter dabao' -AsSecureString
    $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Show-PuterConsent {
    # Privacy ka pakka sach - login ke saamne, ek dafa ka haan-nahi
    # (KAANOON 4 ka asli darwaza; bina iske AI calls band reh jati hain).
    Write-Host ''
    Write-Host '  EK SHART (privacy, ek hi dafa):' -ForegroundColor Yellow
    Write-Host '  AI ke SAWAL ka mtlab yeh hai ki repo ka thoda text (AGENTS.md' -ForegroundColor Gray
    Write-Host '  digest, script synopses, tumhara sawal, error tail) Puter ka' -ForegroundColor Gray
    Write-Host '  CLOUD padhega - TUMHARE Puter account se (free tier). Mahaul' -ForegroundColor Gray
    Write-Host '  me token/DPAPI/server jaisi secrets YAHIN rehte hain - cloud' -ForegroundColor Gray
    Write-Host '  ko bheje ja hi nahi (redaction bhi hota hai).' -ForegroundColor Gray
    Write-Host ''
    $ans = Read-Host '  Y/N (y/N)'
    return ($ans -match '(?i)^y(es)?$')
}

# ------------------------------------------------------------------ modes ---

function Invoke-PuterLoginMode {
    param([bool]$IsRotate)

    $alreadyIn = [bool](Get-SarkariAiToken)

    if ($Json) {
        # JSON = machine lane: NON-interactive - WithToken hi chahiye.
        if (-not $WithToken) {
            Write-JsonOut @{ mode = 'login'; ok = $false; error = 'missing_with_token'
                             note = 'Json+Login me -WithToken ("-"=stdin) do'; exit = 2 }
            return 2
        }
        $token = Get-PuterTokenInput
        return (Finish-PuterLogin $token $IsRotate)
    }

    Write-Host ''
    Write-Host '========================================================' -ForegroundColor Cyan
    Write-Host '  SARKARI AI - PUTER LOGIN (easy setup, no magajmari)' -ForegroundColor Cyan
    Write-Host '========================================================' -ForegroundColor Cyan
    if ($IsRotate) {
        $old = Get-SarkariAiToken
        if ($old) { Write-Host ('  ROTATE: purana token {0} overwrite ho chuka.' -f (Hide-SarkariAi $old)) -ForegroundColor Yellow }
        else     { Write-Host '  ROTATE: purana token hai hi nahi - naya lagayenge.' -ForegroundColor Yellow }
    } elseif ($alreadyIn) {
        Write-Host '  Ek token pehle se baitha hai; naya login usko badal dega.' -ForegroundColor Gray
    }

    Write-Host ''
    Write-Host '  SIRF 2 KAAM tumse:' -ForegroundColor Green
    Write-Host ('    1) Browser khula: {0}' -f $dashboardUrl) -ForegroundColor Gray
    Write-Host '       - Login/signup (puter email free hai)' -ForegroundColor Gray
    Write-Host '       - Dashboard > Account > API tokens > CREATE TOKEN' -ForegroundColor Gray
    Write-Host '    2) Token copy karke idhar paste karo. BAS.' -ForegroundColor Gray
    Write-Host ''

    try { Start-Process $dashboardUrl | Out-Null } catch {
        Write-Host ('  Browser khula nahi - khud khol lo: {0}' -f $dashboardUrl) -ForegroundColor Yellow
    }

    $token = ''
    if ($WithToken) { $token = Get-PuterTokenInput }
    else            { $token = Read-PuterInteractiveToken }

    return (Finish-PuterLogin $token $IsRotate)
}

function Finish-PuterLogin {
    param([string]$Token, [bool]$IsRotate)

    if (-not $Token -or $Token.Length -lt 12) {
        if ($Json) {
            Write-JsonOut @{ mode = 'login'; ok = $false; error = 'token_missing_or_small'; exit = 1 }
        } else {
            Write-Host ''
            Write-Host '  Token nahi mila / chhota hai - phir se bolo:' -ForegroundColor Red
            Write-Host '    pwsh -File sarkari_deploy\sarkariPuterjs.ps1 -Login' -ForegroundColor White
        }
        return 1
    }

    if (-not $Json) {
        Write-Host ''
        Write-Host ('  Token pehchana: {0}' -f (Hide-SarkariAi $Token)) -ForegroundColor DarkGray
        Write-Host '  Live check kar raha hu (Puter se puchh ke) ...' -ForegroundColor Gray
    }

    $t = Test-SarkariAiToken -Token $Token
    if ($t.Valid) {
        if (-not $Json) {
            Write-Host ('  [GREEN] Token CHALTA hai ({0} ke zariye)!' -f $t.Method) -ForegroundColor Green
            if (@($t.Models).Count -gt 0) {
                Write-Host ('          Models list me: {0} (dekhne ke liye -ListModels)' -f @($t.Models).Count) -ForegroundColor DarkGray
            }
        }
    } elseif ($t.Reason -eq 'invalid') {
        Write-SarkariAiLog -Action 'login' -Ok $false -ErrorNote 'invalid' | Out-Null
        if ($Json) {
            Write-JsonOut @{ mode = 'login'; ok = $false; error = 'invalid'; detail = $t.Detail; exit = 1 }
        } else {
            Write-Host ('  [RED] Token GALAT: {0}' -f $t.Detail) -ForegroundColor Red
            Write-Host '        Poori copy hai? (koi chhota kat gaya, ya trailing space?) ya naya banao.' -ForegroundColor White
        }
        return 1
    } else {
        # network se confirm nahi - sach batate hain, aur user ki marji.
        Write-SarkariAiLog -Action 'login' -Ok $false -ErrorNote 'network' | Out-Null
        if ($Json) {
            Write-JsonOut @{ mode = 'login'; ok = $false; error = 'network'; detail = $t.Detail; exit = 3 }
            return 3
        }
        Write-Host ('  [YELLOW] Network se confirm nahi ho paya: {0}' -f $t.Detail) -ForegroundColor Yellow
        $ans = Read-Host '  Phir bhi is token ko save kar du? (y/N)'
        if ($ans -notmatch '(?i)^y(es)?$') {
            Write-Host '  Theek hai - network dekho, phir se -Login. Kuch save nahi hua.' -ForegroundColor Gray
            return 3
        }
    }

    # Consent - bina iske AI band rahegi (KAANOON 4). Ek dafa ka haan.
    $hadConsent = (Test-SarkariAiConsent)
    if (-not $hadConsent) {
        if ($Json) {
            # JSON/map me dialogue nahi - switch hi mark hai.
            if ($Consent) { Set-SarkariAiConsent }
        } else {
            if (Show-PuterConsent) { Set-SarkariAiConsent }
            else {
                Write-Host '  Nahi? Theek hai - token save hua, par AI calls CONSENT na hone tak band' -ForegroundColor Yellow
                Write-Host '  (baad me -Consent switch se de dena).' -ForegroundColor Yellow
            }
        }
    }

    Set-SarkariAiToken -Token $Token
    $action = if ($IsRotate) { 'rotate' } else { 'login' }
    Write-SarkariAiLog -Action $action -Ok ([bool]$t.Valid) -ErrorNote ([string]$t.Reason) | Out-Null

    if ($Json) {
        Write-JsonOut @{
            mode = $action; ok = $true; valid = [bool]$t.Valid; reason = [string]$t.Reason
            token = (Hide-SarkariAi $Token); consent = (Test-SarkariAiConsent)
            models = @($t.Models); exit = 0
        }
        return 0
    }

    Write-Host ''
    Write-Host '  [GREEN] HO GAYA - token DPAPI me sambhal gaya (repo me KUCH nahi gaya):' -ForegroundColor Green
    Write-Host ('    File    : {0}' -f $cfg.TokenFile) -ForegroundColor DarkGray
    Write-Host ('    Token   : {0}' -f (Hide-SarkariAi $Token)) -ForegroundColor Gray
    $cons = if (Test-SarkariAiConsent) { 'haan (AI chal sakta hai)' } else { 'nahi (AI band - -Consent do)' }
    Write-Host ('    Consent : {0}' -f $cons) -ForegroundColor Gray
    Write-Host ''
    Write-Host '  AB TEST KARO:' -ForegroundColor White
    Write-Host '    pwsh -File sarkari_deploy\sarkariHelp.ps1 "naye agent ka pehla sawal"' -ForegroundColor White
    Write-Host '    pwsh -File sarkari_deploy\sarkariPuterjs.ps1 -Status' -ForegroundColor White
    Write-Host ''
    return 0
}

function Invoke-PuterLogoutMode {
    $existed = Clear-SarkariAiToken
    Write-SarkariAiLog -Action 'logout' -Ok $true | Out-Null
    if ($Json) {
        Write-JsonOut @{ mode = 'logout'; removedToken = [bool]$existed; consentKept = (Test-SarkariAiConsent); exit = 0 }
        return 0
    }
    if ($existed) { Write-Host 'sarkari Puter: token file MITA DI gayi. (Consent wali ittila banchuki hai.)' -ForegroundColor Green }
    else          { Write-Host 'sarkari Puter: koi token file thi hi nahi - jaisa thaa.' -ForegroundColor Gray }
    return 0
}

function Invoke-PuterStatusMode {
    # Poora hisab - bina AI call ke sirf ek sasta models check.
    $tok = Get-SarkariAiToken
    $envActive = [bool]$env:PUTER_AUTH_TOKEN
    $live = $null
    if ($tok)       { $live = Invoke-SarkariModels -Token $tok -TimeoutSec 20 }

    $exit = 0
    if (-not $tok) { $exit = 2 }
    elseif ($live -and (-not $live.OK) -and (([string]$live.Status) -in @('401', '403'))) { $exit = 2 }

    $report = [ordered]@{
        mode          = 'status'
        envOverride   = $envActive
        token         = $(if ($tok) { Hide-SarkariAi $tok } else { $null })
        consent       = (Test-SarkariAiConsent)
        modelCount    = $(if ($live -and $live.OK) { @($live.Models).Count } else { 0 })
        liveOk        = $(if ($live) { [bool]$live.OK } else { $false })
        liveStatus    = $(if ($live) { [string]$live.Status } else { '' })
        defaultModel  = $cfg.DefaultModel
        modelOverride = $(if ($env:SARKARI_AI_MODEL) { $env:SARKARI_AI_MODEL.Trim() } else { '' })
        tokenFile     = $cfg.TokenFile
        aiLogBytes    = $(if (Test-Path $cfg.AiLogFile) { (Get-Item -LiteralPath $cfg.AiLogFile).Length } else { 0 })
        exit          = $exit
    }
    Write-JsonOut $report
    return $exit
}

function Invoke-PuterListModelsMode {
    $tok = Get-SarkariAiToken
    if (-not $tok) {
        if ($Json) {
            Write-JsonOut @{ mode = 'models'; error = 'no_token'; note = 'pehle -Login chalao'; exit = 2 }
        } else {
            Write-Host 'sarkari Puter: token nahi mila - pehle login karo:' -ForegroundColor Yellow
            Write-Host '  pwsh -File sarkari_deploy\sarkariPuterjs.ps1 -Login' -ForegroundColor White
        }
        return 2
    }

    $r = Invoke-SarkariModels -Token $tok -TimeoutSec 30
    if (-not $r.OK) {
        Write-SarkariAiLog -Action 'models' -Ok $false -ErrorNote ([string]$r.Status) | Out-Null
        $bad = (([string]$r.Status) -in @('401', '403'))
        $code = if ($bad) { 2 } else { 3 }
        if ($Json) {
            Write-JsonOut @{ mode = 'models'; ok = $false; status = [string]$r.Status; error = [string]$r.Error; exit = $code }
        } else {
            $why = if ($bad) { 'token reject hua - -Rotate karke naya lagao' } else { 'Puter se baat nahi: ' + $r.Error }
            Write-Host ('sarkari Puter: {0}' -f $why) -ForegroundColor Yellow
        }
        return $code
    }
    Write-SarkariAiLog -Action 'models' -Ok $true | Out-Null

    if ($Json) {
        Write-JsonOut @{ mode = 'models'; ok = $true; count = @($r.Models).Count; models = @($r.Models); exit = 0 }
        return 0
    }

    $freeish = @($r.Models | Where-Object { $_ -match '(?i)free|nano|mini|flash|small|haiku' })
    Write-Host ''
    Write-Host ('  PUTER MODELS: {0} available' -f @($r.Models).Count) -ForegroundColor Cyan
    $def = ("  default free-tier model: {0}   (SARKARI_AI_MODEL env se override)" -f $cfg.DefaultModel)
    Write-Host $def -ForegroundColor DarkGray
    Write-Host '  (kaun kitna free: Puter dashboard ka AI usage page khud dikha dega -' -ForegroundColor DarkGray
    Write-Host '   free tier tumhar APNE account se chalta hai, is wajah se sab "apna" hai)' -ForegroundColor DarkGray
    if ($freeish.Count -gt 0) {
        Write-Host '  Naam se "free-ish":' -ForegroundColor Yellow
        $freeish | Select-Object -First 20 | ForEach-Object { Write-Host ('   - ' + $_) -ForegroundColor Yellow }
        Write-Host ''
    }
    Write-Host '  Poori list:' -ForegroundColor Cyan
    $r.Models | Select-Object -First 80 | ForEach-Object { Write-Host ('   - ' + $_) -ForegroundColor Gray }
    if (@($r.Models).Count -gt 80) {
        Write-Host ('   ... +{0} aur' -f (@($r.Models).Count - 80)) -ForegroundColor DarkGray
    }
    Write-Host ''
    Write-Host '  Model pass karne ke liye: sarkariHelp.ps1 -Model <model-id> "sawal"' -ForegroundColor DarkGray
    return 0
}

function Invoke-PuterConsentMode {
    Set-SarkariAiConsent
    Write-SarkariAiLog -Action 'consent' -Ok $true | Out-Null
    if ($Json) {
        Write-JsonOut @{ mode = 'consent'; granted = $true; file = $cfg.ConsentFile; exit = 0 }
        return 0
    }
    Write-Host ''
    Write-Host ('  Consent likh diya: {0}' -f $cfg.ConsentFile) -ForegroundColor Green
    Write-Host '  (Token pehle se hai ho to AI ab chal jayegi; warna -Login pehle karo.)' -ForegroundColor Gray
    return 0
}

# --------------------------------------------------------------------- main ---

$mode = 'status'
if ($Logout)          { $mode = 'logout' }
elseif ($Login)       { $mode = 'login'  }
elseif ($Rotate)      { $mode = 'rotate' }
elseif ($ListModels)  { $mode = 'models' }
elseif ($Consent)     { $mode = 'consent' }

$code = switch ($mode) {
    'login'   { Invoke-PuterLoginMode -IsRotate $false; break }
    'rotate'  { Invoke-PuterLoginMode -IsRotate $true;  break }
    'logout'  { Invoke-PuterLogoutMode;   break }
    'status'  { Invoke-PuterStatusMode;   break }
    'models'  { Invoke-PuterListModelsMode; break }
    'consent' { Invoke-PuterConsentMode;  break }
    default   { Invoke-PuterStatusMode;   break }
}
exit $code
