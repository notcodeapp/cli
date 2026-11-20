# NotCode CLI — one-line installer for Windows PowerShell.
#   irm https://raw.githubusercontent.com/notcodeapp/cli/main/install.ps1 | iex
# Installs Node.js LTS (if missing) and the notcode-cli package via npm.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "    $Text" -ForegroundColor Gray }
function Write-Warn2([string]$Text) { Write-Host "!!  $Text" -ForegroundColor Yellow }

function Show-Banner {
  $b = @'
  _   _        _          _  _____
 | \ | | ___  | |    ___ | |/ ____|
 |  \| |/ _ \ | |   / _ \| | (___
 | |\  | (_) || |__| (_) | |\___ \
 |_| \_|\___/ |_____\___/|_|____) |
'@
  Write-Host $b -ForegroundColor Green
  Write-Host '  NotCode CLI — ИИ-агент в терминале' -ForegroundColor White
  Write-Host ''
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-NodeVersion {
  try { return (& node --version) 2>$null } catch { return $null }
}

function Install-NodeLts {
  Write-Step 'Node.js не найден — устанавливаю LTS'
  # Prefer winget: it is present on Windows 10/11 and handles PATH refresh.
  if (Test-Command 'winget') {
    Write-Info 'winget install OpenJS.NodeJS.LTS'
    & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0 -and (Test-Command 'node')) { return }
  }
  # Fallback: direct MSI download for 64-bit Windows.
  Write-Info 'Скачиваю установщик Node.js LTS с nodejs.org'
  $msi = Join-Path $env:TEMP 'notcode-node-lts.msi'
  $url = 'https://nodejs.org/dist/latest-v22.x/node-v22.x-x64.msi'
  # Resolve the exact filename from the dist index (names carry the real version).
  $index = Invoke-WebRequest -Uri 'https://nodejs.org/dist/latest-v22.x/' -UseBasicParsing
  if ($index.Links -and $index.Links.Count -gt 0) {
    $msiLink = ($index.Links | Where-Object { $_.href -match '^node-v\d+\.\d+\.\d+-x64\.msi$' } | Select-Object -First 1)
    if ($msiLink) { $url = "https://nodejs.org/dist/latest-v22.x/$($msiLink.href)" }
  }
  Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
  Write-Info 'Запускаю установщик (silent)'
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
  Remove-Item $msi -Force -ErrorAction SilentlyContinue
  # Refresh PATH for the current session so node/npm are visible immediately.
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machinePath;$userPath"
  if (-not (Test-Command 'node')) {
    throw 'Node.js установлен, но не найден в PATH. Откройте новый PowerShell и запустите команду установки ещё раз.'
  }
}

Show-Banner

Write-Step 'Проверяю окружение'
if (-not (Test-Command 'node') -or -not (Get-NodeVersion)) {
  Install-NodeLts
}
$nodeVer = Get-NodeVersion
Write-Info "Node.js $nodeVer"
$npmVer = (& npm --version) 2>$null
Write-Info "npm $npmVer"

Write-Step 'Устанавливаю NotCode CLI'
$installed = $false
# Published package first, GitHub fallback for fresh releases.
& npm install -g notcode-cli 2>$null
if ($LASTEXITCODE -eq 0) { $installed = $true } else {
  Write-Warn2 'notcode-cli из npm недоступен — пробую репозиторий GitHub'
  & npm install -g github:notcodeapp/cli
  if ($LASTEXITCODE -eq 0) { $installed = $true }
}
if (-not $installed) { throw 'Не удалось установить notcode-cli через npm. Проверьте интернет и права доступа.' }

Write-Step 'Готово!'
Write-Host ''
Write-Host '  Запустите в терминале:' -ForegroundColor White
Write-Host '    notcode' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Выбор моделей: провайдеры Ollama, OpenAI-compatible, OpenCode Zen (бесплатные модели), Codex, Claude.' -ForegroundColor Gray
Write-Host '  Документация: https://github.com/notcodeapp/cli' -ForegroundColor Gray
Write-Host ''
& notcode --version
