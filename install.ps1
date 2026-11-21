# NotCode CLI - one-line installer for Windows PowerShell.
#   irm https://raw.githubusercontent.com/notcodeapp/cli/main/install.ps1 | iex
# Installs Node.js LTS (if missing) and the notcode CLI via npm.
#
# Notes for maintainers:
# - NO BOM: iex chokes on a leading BOM ("irm ... | iex" is the documented path;
#   irm decodes the body correctly because raw.githubusercontent sends charset=utf-8).
# - Every native command runs through cmd.exe with 2>&1 merged into stdout:
#   under iex, stderr would otherwise become an ErrorRecord and, with
#   ErrorActionPreference=Stop, kill the script mid-way.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Green }
function Write-Info([string]$Text) { Write-Host "    $Text" -ForegroundColor Gray }
function Write-Warn2([string]$Text) { Write-Host "!!  $Text" -ForegroundColor Yellow }

function Show-Banner {
  # Тот же блочный NOTCODE, что рисует сам CLI (lib/ui-menu.js).
  $b = @'
███╗   ██╗  ██████╗  ████████╗   ██████╗  ██████╗  ██████╗  ███████╗
████╗  ██║ ██╔═══██╗ ██╔══════╝  ██╔═══██╗ ██╔═══██╗ ██╔══██╗ ██╔════╝
██╔██╗ ██║ ██║   ██║ ██║   ██║   ██║   ██║ ██║   ██║ ██║  ██║ █████╗
██║╚██╗██║ ██║   ██║ ██║    ██╗  ██║   ██║ ██║   ██║ ██║  ██║ ██╔══╝
██║ ╚████║ ╚██████╔╝ ╚██████╔╝   ╚██████╔╝ ╚██████╔╝ ██████╔╝ ███████╗
╚═╝  ╚═══╝  ╚═════╝   ╚═════╝     ╚═════╝   ╚═════╝  ╚═════╝  ╚══════╝
'@
  Write-Host $b -ForegroundColor Green
  Write-Host '  notcode · ваш ключ · ваши модели' -ForegroundColor White
  Write-Host ''
}

# Run a shell command with stderr merged into stdout (see header notes).
# Returns exit code and combined output; never throws on stderr traffic.
function Run-Cmd([string]$Command) {
  $ErrorActionPreference = 'Continue'
  $output = & cmd.exe /c "$Command 2>&1"
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  return @{ Exit = $code; Output = (($output | ForEach-Object { "$_" }) -join "`n") }
}

function Install-NodeLts {
  Write-Step 'Node.js not found - installing LTS'
  if ((Run-Cmd 'winget --version').Exit -eq 0) {
    Write-Info 'winget install OpenJS.NodeJS.LTS'
    $r = Run-Cmd 'winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements'
    $check = Run-Cmd 'node --version'
    if ($check.Exit -eq 0) { return }
    Write-Warn2 'winget path failed, falling back to MSI download'
  }
  Write-Info 'Downloading Node.js LTS MSI from nodejs.org'
  $msi = Join-Path $env:TEMP 'notcode-node-lts.msi'
  # Resolve the exact MSI filename from the dist index (it carries the real version).
  $index = Invoke-WebRequest -Uri 'https://nodejs.org/dist/latest-v22.x/' -UseBasicParsing
  $msiHref = ($index.Links | Where-Object { $_.href -match '^node-v\d+\.\d+\.\d+-x64\.msi$' } | Select-Object -First 1).href
  if (-not $msiHref) { throw 'Не удалось определить имя установщика Node.js на nodejs.org' }
  Invoke-WebRequest -Uri "https://nodejs.org/dist/latest-v22.x/$msiHref" -OutFile $msi -UseBasicParsing
  Write-Info 'Running installer (silent)'
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
  Remove-Item $msi -Force -ErrorAction SilentlyContinue
  # Refresh PATH for the current session so node/npm are visible immediately.
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if ((Run-Cmd 'node --version').Exit -ne 0) {
    throw 'Node.js установлен, но не найден в PATH. Откройте новый PowerShell и запустите команду установки ещё раз.'
  }
}

Show-Banner

Write-Step 'Checking environment'
$node = Run-Cmd 'node --version'
if ($node.Exit -ne 0) {
  Install-NodeLts
  $node = Run-Cmd 'node --version'
}
Write-Info ("Node.js " + $node.Output.Trim())
$npm = Run-Cmd 'npm --version'
Write-Info ("npm " + $npm.Output.Trim())
if ($npm.Exit -ne 0) { throw 'npm не найден. Переустановите Node.js LTS и попробуйте снова.' }

Write-Step 'Installing NotCode CLI'
# Published registry package first (probe is cheap); GitHub repo is the
# guaranteed fallback that always has the latest commit.
$published = Run-Cmd 'npm view notcode-cli version --fetch-timeout=15000'
$installed = $false
if ($published.Exit -eq 0) {
  $r = Run-Cmd 'npm install -g notcode-cli'
  if ($r.Exit -eq 0) { $installed = $true }
  else { Write-Warn2 'npm registry install failed, trying GitHub' }
}
if (-not $installed) {
  $r = Run-Cmd 'npm install -g github:notcodeapp/cli'
  if ($r.Exit -ne 0) {
    Write-Warn2 $r.Output
    throw 'Не удалось установить notcode-cli через npm. Проверьте интернет и права доступа.'
  }
}

Write-Step 'Done!'
Write-Host ''
Write-Host '  Run in your terminal:' -ForegroundColor White
Write-Host '    notcode' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Models: Ollama, OpenAI-compatible, OpenCode Zen (free models), Codex, Claude.' -ForegroundColor Gray
Write-Host '  Docs: https://github.com/notcodeapp/cli' -ForegroundColor Gray
Write-Host ''
$ver = Run-Cmd 'notcode --version'
if ($ver.Exit -eq 0) { Write-Info ($ver.Output.Trim()) }
