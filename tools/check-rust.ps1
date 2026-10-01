# Rust compile check.
#
# A script instead of a bare `cargo check` for two reasons:
#   1. the linker and Windows SDK live in Visual Studio Build Tools; rustc
#      usually finds them via the registry, but not always (e.g. non-standard
#      install path), so we import vcvars64.bat when it is there;
#   2. cargo can live in two places (rustup shim or an msi install) - we look
#      in both.
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads
# .ps1 as ANSI unless there is a BOM, and non-ASCII comments break the parser.
#
#   powershell -ExecutionPolicy Bypass -File tools\check-rust.ps1
#   powershell -ExecutionPolicy Bypass -File tools\check-rust.ps1 --release

param([switch]$Release)

$ErrorActionPreference = 'Continue'

$cargoCandidates = @(
    (Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'),
    'C:\Program Files\Rust stable MSVC 1.98\bin\cargo.exe'
)
$cargo = $cargoCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $cargo) {
    $cargo = Get-ChildItem 'C:\Program Files' -Filter cargo.exe -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'Rust' } |
        Select-Object -First 1 -ExpandProperty FullName
}

if (-not $cargo) {
    Write-Error "cargo not found. Install rustup (https://rustup.rs) or the msi from https://static.rust-lang.org/dist/"
    exit 1
}
Write-Host "cargo: $cargo"

$vsRoot = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools'
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) {
    foreach ($guess in @(
        'C:\Program Files\Microsoft Visual Studio\2022\Community',
        'C:\Program Files\Microsoft Visual Studio\2022\BuildTools',
        'C:\Program Files\Microsoft Visual Studio\18\Community',
        'C:\Program Files\Microsoft Visual Studio\18\BuildTools')) {
        $candidate = Join-Path $guess 'VC\Auxiliary\Build\vcvars64.bat'
        if (Test-Path $candidate) { $vcvars = $candidate; break }
    }
}

if (Test-Path $vcvars) {
    Write-Host "MSVC env: $vcvars"
    cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
        if ($_ -match '^([^=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }
} else {
    Write-Warning "vcvars64.bat not found - cargo will try to locate MSVC on its own"
}

$cargoArgs = @('check', '--manifest-path', 'src-tauri\Cargo.toml', '--message-format', 'short')
if ($Release) { $cargoArgs += '--release' }

& $cargo @cargoArgs
exit $LASTEXITCODE
