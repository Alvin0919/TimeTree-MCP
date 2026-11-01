$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$importScript = Join-Path $project 'scripts/Import-TimeTreeSession.ps1'
$testRoot = Join-Path $project ('node_modules/.session-import-test-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($testRoot) | Out-Null
git -C $testRoot init --quiet
[IO.File]::WriteAllText((Join-Path $testRoot '.gitignore'), ".env`n")
$testEnvPath = Join-Path $testRoot '.env'
$originalText = "TIMETREE_EMAIL=mock@example.invalid`r`nTIMETREE_PASSWORD=`r`nTIMETREE_CALENDAR_ID=42`r`nTIMETREE_SESSION_COOKIE=old-mock`r`n# keep this comment`r`n"
function Get-Clipboard { param([switch]$Raw) return $global:TestSessionClipboard }
function Set-Clipboard { param([string]$Value) $global:TestSessionClipboard = $Value }

try {
    [IO.File]::WriteAllText($testEnvPath, $originalText)
    $global:TestSessionClipboard = 'new-mock-session'
    $output = & $importScript -ProjectRoot $testRoot
    if ([IO.File]::ReadAllText($testEnvPath) -cne $originalText.Replace('=old-mock', '=new-mock-session')) { throw 'Other env content changed.' }
    if ($global:TestSessionClipboard -cne '') { throw 'Clipboard was not cleared.' }
    if (($output -join '') -match 'new-mock-session') { throw 'Secret echoed.' }
    foreach ($badValue in @("bad`r`nInjected=x", 'bad; other=x', '_session_id=bad', 'bad value')) {
        [IO.File]::WriteAllText($testEnvPath, $originalText)
        $global:TestSessionClipboard = $badValue
        $rejected = $false
        try { & $importScript -ProjectRoot $testRoot | Out-Null } catch { $rejected = $true }
        if (!$rejected -or [IO.File]::ReadAllText($testEnvPath) -cne $originalText -or $global:TestSessionClipboard -cne '') { throw 'Invalid clipboard handling failed.' }
    }
    [IO.File]::WriteAllText($testEnvPath, $originalText + "  TIMETREE_SESSION_COOKIE =duplicate`r`n")
    $global:TestSessionClipboard = 'new-mock-session'
    $rejected = $false
    try { & $importScript -ProjectRoot $testRoot | Out-Null } catch { $rejected = $true }
    if (!$rejected -or $global:TestSessionClipboard -cne '') { throw 'Duplicate key handling failed.' }
    Write-Output 'Session import tests passed: preserve fields, no echo, clipboard cleared, invalid input and duplicate keys rejected.'
} finally {
    $global:TestSessionClipboard = $null
    # Only mock data remains under ignored node_modules; no real clipboard or secrets were accessed.
}
