param(
    [Parameter(Position = 0)]
    [string]$File
)

Write-Host "签名目标：$File"
if (-not $env:PDF_SPLITTER_PFX) {
    Write-Host "未设置 PDF_SPLITTER_PFX，跳过代码签名。"
    exit 0
}

$signtool = if ($env:PDF_SPLITTER_SIGNTOOL) { $env:PDF_SPLITTER_SIGNTOOL } else { "signtool" }
& $signtool sign /fd SHA256 /f $env:PDF_SPLITTER_PFX /p $env:PDF_SPLITTER_PFX_PASSWORD /tr http://timestamp.digicert.com /td SHA256 $File
exit $LASTEXITCODE
