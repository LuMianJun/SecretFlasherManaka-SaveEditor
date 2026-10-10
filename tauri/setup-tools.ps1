$ErrorActionPreference = 'Stop'
$rustBin = Join-Path $env:USERPROFILE '.cargo/bin'
$msvcRoot = 'C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC'
$sdkRoot = 'C:/Program Files (x86)/Windows Kits/10'
$compiler = Get-ChildItem -LiteralPath $msvcRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
$sdk = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'Lib') -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $compiler -or -not $sdk) { throw 'MSVC Build Tools and Windows SDK are required.' }
$env:PATH = "$rustBin;$(Join-Path $compiler.FullName 'bin/Hostx64/x64');$(Join-Path $sdkRoot "bin/$($sdk.Name)/x64");$env:PATH"
$env:LIB = "$(Join-Path $compiler.FullName 'lib/x64');$(Join-Path $sdk.FullName 'ucrt/x64');$(Join-Path $sdk.FullName 'um/x64')"
$env:INCLUDE = "$(Join-Path $compiler.FullName 'include');$(Join-Path $sdkRoot "Include/$($sdk.Name)/ucrt");$(Join-Path $sdkRoot "Include/$($sdk.Name)/shared");$(Join-Path $sdkRoot "Include/$($sdk.Name)/um");$(Join-Path $sdkRoot "Include/$($sdk.Name)/winrt")"
