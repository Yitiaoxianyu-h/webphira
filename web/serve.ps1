# Start a local static server for Phira Web
$py = "D:\python\python.exe"
if (-not (Test-Path -LiteralPath $py)) { $py = "python" }
Set-Location -LiteralPath $PSScriptRoot
& $py serve.py
