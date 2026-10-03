$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is missing.' }
$icon = Join-Path $repo 'build/branding/audioforge.ico'
$source = Join-Path $PSScriptRoot 'AudioForgeLauncher.cs'
$output = Join-Path $repo 'AudioForge.exe'
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /reference:System.Windows.Forms.dll "/win32icon:$icon" "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw 'AudioForge launcher compilation failed.' }
Write-Output "Built: $output"
