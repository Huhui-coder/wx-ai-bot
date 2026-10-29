$ErrorActionPreference = 'Stop'
if (-not [Environment]::Is64BitOperatingSystem) { throw '需要 64 位 Windows。' }
$repo = 'Huhui-coder/wx-ai-bot'
$asset = 'weixin-lite-windows-x64.exe'
$base = "https://github.com/$repo/releases/latest/download"
$tempDir = Join-Path ([IO.Path]::GetTempPath()) ('weixin-lite-' + [Guid]::NewGuid().ToString('N'))
$dest = Join-Path $env:LOCALAPPDATA 'WeixinLite'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
try {
  Write-Host '正在下载微信小助理…'
  $download = Join-Path $tempDir $asset
  Invoke-WebRequest "$base/$asset" -OutFile $download -UseBasicParsing
  $sums = (Invoke-WebRequest "$base/SHA256SUMS" -UseBasicParsing).Content
  $pattern = '(?m)^([a-fA-F0-9]{64})\s+' + [Regex]::Escape($asset) + '\s*$'
  $match = [Regex]::Match($sums, $pattern)
  if (-not $match.Success) { throw '发布包缺少校验信息。' }
  if ((Get-FileHash $download -Algorithm SHA256).Hash -ne $match.Groups[1].Value) { throw '下载校验失败，请重试。' }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  $exe = Join-Path $dest 'weixin-lite.exe'
  if (Test-Path $exe) { & $exe stop; if ($LASTEXITCODE -ne 0) { throw '旧服务未能停止，未替换程序。' } }
  Copy-Item $download $exe -Force
  Write-Host "已安装。以后运行：& `"$exe`""
  & $exe
  if ($LASTEXITCODE -ne 0) { throw '启动失败，请查看上方提示。' }
} finally {
  Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
