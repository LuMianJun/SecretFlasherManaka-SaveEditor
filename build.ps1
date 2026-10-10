param([Parameter(Mandatory=$true)][string]$OutputDir)
$ErrorActionPreference='Stop'
$destination=[IO.Path]::GetFullPath($OutputDir)
if(Test-Path -LiteralPath $destination){throw 'Use a new release directory.'}
$projectRoot=$PSScriptRoot
Push-Location (Join-Path $projectRoot 'tauri')
try {
    if(-not(Test-Path -LiteralPath 'node_modules')) {& npm.cmd ci; if($LASTEXITCODE -ne 0){throw 'Tauri dependencies failed'}}
    if(-not(Test-Path -LiteralPath 'ui/node_modules')) {& npm.cmd --prefix ui ci; if($LASTEXITCODE -ne 0){throw 'UI dependencies failed'}}
    . ./setup-tools.ps1
    & npm.cmd run build
    if($LASTEXITCODE -ne 0){throw 'Tauri build failed'}
    New-Item -ItemType Directory -Path $destination | Out-Null
    Copy-Item -LiteralPath 'src-tauri/target/release/SecretFlasherManakaSaveEditor.exe' -Destination $destination
    Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination $destination
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs') -Destination $destination -Recurse
    Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $destination 'SecretFlasherManakaSaveEditor.exe'),(Join-Path $destination 'README.md'),(Join-Path $destination 'docs/存档类型与字段作用.md') | ForEach-Object {'{0}  {1}' -f $_.Hash.ToLowerInvariant(),$_.Path.Substring($destination.Length+1).Replace('\','/')} | Set-Content -LiteralPath (Join-Path $destination 'files.sha256') -Encoding utf8
    Write-Output "Built: $destination"
} finally {Pop-Location}
