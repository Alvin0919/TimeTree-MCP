param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = 'Stop'
$envPath = Join-Path $ProjectRoot '.env'
$examplePath = Join-Path $ProjectRoot '.env.example'
git -C $ProjectRoot check-ignore --quiet -- .env
if ($LASTEXITCODE -ne 0) { throw 'Import refused: .env must be ignored by this Git repository.' }

$clipboardRead = $false
try {
    $cookie = Get-Clipboard -Raw
    $clipboardRead = $true
    if ([string]::IsNullOrEmpty($cookie) -or $cookie -match '[\s;,\x00-\x1f\x7f]' -or $cookie.StartsWith('_session_id=')) {
        throw 'Import refused: copy only the _session_id cookie value, without whitespace or cookie headers.'
    }
    $text = if (Test-Path -LiteralPath $envPath) { [IO.File]::ReadAllText($envPath) } else { [IO.File]::ReadAllText($examplePath) }
    $pattern = '(?m)^[ \t]*TIMETREE_SESSION_COOKIE[ \t]*=([^\r\n]*)'
    $found = [regex]::Matches($text, $pattern)
    if ($found.Count -gt 1) { throw 'Import refused: duplicate TIMETREE_SESSION_COOKIE keys.' }
    if ($found.Count -eq 1) {
        $value = $found[0].Groups[1]
        $updated = $text.Remove($value.Index, $value.Length).Insert($value.Index, $cookie)
    } else {
        $newline = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
        $updated = $text + $(if ($text.EndsWith("`n")) { '' } else { $newline }) + 'TIMETREE_SESSION_COOKIE=' + $cookie + $newline
    }
    [IO.File]::WriteAllText($envPath, $updated, [Text.UTF8Encoding]::new($false))
    $verified = [regex]::Matches([IO.File]::ReadAllText($envPath), $pattern)
    if ($verified.Count -ne 1 -or $verified[0].Groups[1].Value -cne $cookie) { throw 'Session import verification failed.' }
    Write-Output 'TimeTree session imported into the local gitignored .env. No secret was printed.'
} finally {
    if ($clipboardRead) { Set-Clipboard -Value '' }
    $cookie = $null
    $text = $null
    $updated = $null
}
