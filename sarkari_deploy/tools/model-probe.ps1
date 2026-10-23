# Sarkari model probe - kaun sa model ACTUALLY free hai? (402 ka jhooth pakadna)
# Chalãna: pwsh -NoProfile -File sarkari_deploy\tools\model-probe.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\sarkariBrain.ps1')

$tok = Get-SarkariAiToken
if (-not $tok) { Write-Host 'NO TOKEN'; exit 2 }

$cfg = Get-SarkariBrainConfig
if (-not (Test-Path $cfg.AiLogDir)) { New-Item -ItemType Directory -Force -Path $cfg.AiLogDir | Out-Null }
$logFile = Join-Path $cfg.AiLogDir 'model-probe.jsonl'

$list = $null
try { $list = Invoke-SarkariHttp -Uri 'https://api.puter.com/puterai/chat/models/' -Method 'Get' -Token $tok -TimeoutSec 30 } catch {
    Write-Host ('LIST FAIL: HTTP ' + (Get-SarkariHttpStatus $_))
    exit 3
}
$ids = @($list.models | ForEach-Object { [string]$_ } | Select-Object -Unique)
Write-Host ('Probing ' + $ids.Count + ' models ...')

$i = 0
$free = New-Object System.Collections.Generic.List[string]
foreach ($m in $ids) {
    $i++
    $r = Invoke-SarkariRawChat -Token $tok -UserText 'Reply with exactly: ok' -MaxTokens 8 -TimeoutSec 15 -Model $m
    $line = [ordered]@{ ts = (Get-Date).ToString('HH:mm:ss'); i = $i; total = $ids.Count; model = $m; ok = [bool]$r.OK; status = [string]$r.Status }
    Add-Content -LiteralPath $logFile -Value ($line | ConvertTo-Json -Compress)
    if ($r.OK) {
        $free.Add($m)
        Write-Host ('  FREE: {0} (i={1}/{2})' -f $m, $i, $ids.Count) -ForegroundColor Green
    } elseif (($i % 25) -eq 0) {
        Write-Host ('  ... progress {0}/{1} (ab tak free: {2})' -f $i, $ids.Count, $free.Count) -ForegroundColor DarkGray
    }
}

Write-Host ''
Write-Host ('PROBE DONE. Free models: ' + $free.Count + ' / ' + $ids.Count)
if ($free.Count -gt 0) {
    $pick = [ordered]@{
        pickedAt  = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        picked    = $free[0]
        allFree   = @($free)
        probed    = $ids.Count
    }
    [System.IO.File]::WriteAllText((Join-Path $cfg.AiLogDir 'model-pick.json'), ($pick | ConvertTo-Json -Depth 4))
    Write-Host ('  PICK (pehla free): ' + $free[0]) -ForegroundColor Yellow
    $free | Select-Object -First 30 | ForEach-Object { Write-Host ('   - ' + $_) }
}
exit 0
