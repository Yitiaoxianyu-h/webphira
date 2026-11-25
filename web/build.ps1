# Phira Web build script
# Usage: powershell -ExecutionPolicy Bypass -File .\build.ps1
# All paths are computed at runtime so the script stays ASCII-only.

$ErrorActionPreference = "Continue"

$webDir = $PSScriptRoot
$root = Split-Path -Parent $webDir
$pkgDir = Join-Path $webDir "pkg"
$toolsDir = Join-Path $root "tools"

# --- 本机 Rust 环境（该目录存在时才生效，否则沿用系统已有的 PATH/环境变量）---
$localRust = "D:\Rust"
if (Test-Path -LiteralPath $localRust) {
    $env:CARGO_HOME = Join-Path $localRust "cargo"
    $env:RUSTUP_HOME = Join-Path $localRust "rustup"
    $env:RUSTUP_TOOLCHAIN = "stable-x86_64-pc-windows-gnu"
    $env:TMP = Join-Path $localRust "tmp"
    $env:TEMP = $env:TMP
    New-Item -ItemType Directory -Force -Path $env:TMP | Out-Null
    $env:PATH = (Join-Path $localRust "cargo\bin") + ";" + (Join-Path $localRust "mingw\mingw64\bin") + ";" + $env:PATH
}

# wasm-bindgen：优先使用仓库内 tools/ 或同级 tools/ 下的预编译目录，否则用 PATH 上已安装的。
# 注意：必须逐个候选目录确认 wasm-bindgen.exe 真的在里面。之前用
# `Get-ChildItem -Path @(...) -Filter "wasm-bindgen-*"` 的写法在本机上没匹配到，
# 而命令不存在时 `$LASTEXITCODE` 仍保留上一步 cargo 的 0，导致构建「静默跳过」
# 了 wasm-bindgen 这一整步 —— 之后 pkg 里还是旧 wasm，排查了很久。
$bindgenDirs = @()
foreach ($base in @($toolsDir, (Join-Path (Split-Path -Parent $root) "tools"))) {
    if (Test-Path -LiteralPath $base) {
        $bindgenDirs += (Get-ChildItem -LiteralPath $base -Directory -Filter "wasm-bindgen-*" -ErrorAction SilentlyContinue |
            ForEach-Object { $_.FullName })
    }
}
$wasmBindgenDir = $bindgenDirs | Where-Object { Test-Path -LiteralPath (Join-Path $_ "wasm-bindgen.exe") } | Select-Object -First 1
if ($wasmBindgenDir) { $env:PATH = $wasmBindgenDir + ";" + $env:PATH }

if (-not (Get-Command wasm-bindgen -ErrorAction SilentlyContinue)) {
    throw "wasm-bindgen not found. Put the prebuilt wasm-bindgen-<version> directory under tools/, or install it with 'cargo install wasm-bindgen-cli'."
}

# Python：优先使用本机 D:\python，否则用 PATH 上的 python
$python = "D:\python\python.exe"
if (-not (Test-Path -LiteralPath $python)) { $python = "python" }

Set-Location -LiteralPath $root

Write-Host "[1/4] cargo build -p phira --target wasm32-unknown-unknown --release"
# `chat` 打开多人联机的聊天框（panel.rs 里 CHAT_ENABLED 由该 feature 决定）。
cargo build -p phira --target wasm32-unknown-unknown --release --no-default-features --features chat
if ($LASTEXITCODE -ne 0) {
    throw "cargo build failed, exit code: $LASTEXITCODE"
}

Write-Host "[2/4] wasm-bindgen --target web"
wasm-bindgen --target web --no-typescript --out-dir web\pkg target\wasm32-unknown-unknown\release\phira.wasm
if ($LASTEXITCODE -ne 0) {
    throw "wasm-bindgen failed, exit code: $LASTEXITCODE"
}

Write-Host "[3/4] patching web\pkg\phira.js"
$gluePath = Join-Path $pkgDir "phira.js"
if (-not (Test-Path -LiteralPath $gluePath)) {
    throw "missing $gluePath"
}
& $python (Join-Path $toolsDir "patch_glue.py") $gluePath
if ($LASTEXITCODE -ne 0) {
    throw "patch_glue.py failed"
}

$envModule = Join-Path $pkgDir "env.js"
[System.IO.File]::WriteAllText($envModule, "// empty module for the bare env specifier used by wasm-bindgen`nexport {};`n", (New-Object System.Text.UTF8Encoding($false)))

Write-Host "[4/4] copying assets to web\assets"
$assetsDir = Join-Path $root "assets"
$webAssets = Join-Path $webDir "assets"
if (Test-Path -LiteralPath $assetsDir) {
    New-Item -ItemType Directory -Force -Path $webAssets | Out-Null
    Copy-Item -Path (Join-Path $assetsDir "*") -Destination $webAssets -Recurse -Force
} else {
    Write-Warning "assets directory not found: $assetsDir"
}

Write-Host ""
Write-Host "Build complete. Start server with:"
Write-Host "  start.bat    (or: $python serve.py)"
Write-Host "Then open http://localhost:8000/"
