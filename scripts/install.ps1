# ─────────────────────────────────────────────────────────────
#  Тренер - установка на Windows 10/11 (64-бит). Запускается из install.bat.
#    -Model <имя>   другая модель ИИ (например qwen3:14b - меньше памяти)
#    -NoAi          без локальной ИИ (всё основное работает и так)
#    -NoShortcut    не создавать ярлык на рабочем столе
# ─────────────────────────────────────────────────────────────
param([string]$Model = "", [switch]$NoAi, [switch]$NoShortcut)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = "utf-8"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step($t) { Write-Host ""; Write-Host $t -ForegroundColor Cyan }
function Warn($t) { Write-Host "! $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host ""; Write-Host "Ошибка: $t" -ForegroundColor Red; exit 1 }

Step "Тренер - установка"
Write-Host "Папка приложения: $Root"
if (-not [Environment]::Is64BitOperatingSystem) { Fail "Нужна 64-битная Windows 10 или 11." }
if (-not (Get-Command git -ErrorAction SilentlyContinue) -or -not (Test-Path "$Root\.git")) {
    Warn "Приложение не из git clone - обновлять из приложения не получится (см. README, «Обновление»)."
}

# память → какая модель потянет
$ramGB = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$vramGB = 0
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
    $v = (nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | Sort-Object {[int]$_} -Descending | Select-Object -First 1)
    if ($v) { $vramGB = [math]::Floor([int]$v / 1024) }
}
Write-Host "Оперативная память: $ramGB ГБ; видеопамять NVIDIA: $vramGB ГБ"

# ── 1. uv ──
Step "1/5  Менеджер окружения uv"
$uvDirs = @("$env:USERPROFILE\.local\bin", "$env:USERPROFILE\.cargo\bin")
foreach ($d in $uvDirs) { if (Test-Path $d) { $env:Path = "$d;$env:Path" } }
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "Устанавливаю uv (https://docs.astral.sh/uv/)..."
    try { powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex" } catch { Fail "Не удалось установить uv. Проверьте интернет." }
    foreach ($d in $uvDirs) { if (Test-Path $d) { $env:Path = "$d;$env:Path" } }
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { Fail "uv установлен, но не найден. Перезапустите install.bat." }
}
Write-Host ("uv: " + (uv --version))

# ── 2. Python и библиотеки ──
Step "2/5  Python и библиотеки"
uv sync --frozen --no-dev
if ($LASTEXITCODE -ne 0) { Fail "Не удалось установить библиотеки." }
$Py = Join-Path $Root ".venv\Scripts\python.exe"

# ── 3. Локальная ИИ (Ollama) ──
Step "3/5  Локальная ИИ (Ollama)"
$ai = -not $NoAi
if ($ai -and -not $Model) {
    if ($ramGB -ge 32 -or $vramGB -ge 20) { $Model = "qwen3:30b" }
    elseif ($ramGB -ge 16) {
        Warn "Для основной модели qwen3:30b нужно от 32 ГБ памяти (или видеокарта на 24 ГБ), здесь $ramGB ГБ."
        $a = Read-Host "Поставить облегчённую qwen3:14b (~9 ГБ)? [Y/n]"
        if ($a -match '^[Nn]') { $ai = $false } else { $Model = "qwen3:14b" }
    } else { Warn "Памяти $ramGB ГБ - локальной ИИ не хватит. Приложение будет работать без неё."; $ai = $false }
}
if ($ai) {
    if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            Write-Host "Устанавливаю Ollama через winget..."
            winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
            $env:Path = "$env:LOCALAPPDATA\Programs\Ollama;$env:Path"
        }
        if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { Fail "Установите Ollama: https://ollama.com/download/windows, затем запустите install.bat ещё раз." }
    }
    $up = $false
    for ($i = 0; $i -lt 15; $i++) {
        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:11434/api/tags | Out-Null; $up = $true; break }
        catch { if ($i -eq 0) { Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden }; Start-Sleep 2 }
    }
    if (-not $up) { Fail "Ollama не запускается. Запустите приложение Ollama и повторите установку." }
    Write-Host "Скачиваю модель $Model (qwen3:30b ~19 ГБ, qwen3:14b ~9 ГБ; прерванная загрузка продолжится)..."
    ollama pull $Model
    if ($LASTEXITCODE -ne 0) { Fail "Не удалось скачать модель. Запустите установку ещё раз - загрузка продолжится." }
    $settings = Join-Path $Root "settings.env"
    if ($Model -ne "qwen3:30b") { Set-Content -Encoding UTF8 $settings "TRAINER_MODEL=$Model"; Write-Host "Модель записана в settings.env" }
    elseif (Test-Path $settings) { Remove-Item $settings }
} else {
    Write-Host "Без локальной ИИ: чат, разбор недели, программы и рецепты будут недоступны; всё остальное работает."
}

# ── 4. Проверка ──
Step "4/5  Проверка"
& $Py -c "import app.server" | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "Приложение не запускается - см. сообщения выше." }
Write-Host "Ок"

# ── 5. Ярлык и сеть ──
Step "5/5  Ярлык и доступ из домашней сети"
if (-not $NoShortcut) {
    $lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Тренер.lnk"
    $sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    $sh.TargetPath = Join-Path $Root "start.bat"
    $sh.WorkingDirectory = $Root
    $sh.Save()
    Write-Host "Ярлык на рабочем столе: Тренер"
}
# телефоны ходят на порт 8790 - нужен входящий доступ в брандмауэре (только частные сети)
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    if (-not (Get-NetFirewallRule -DisplayName "Тренер 8790" -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName "Тренер 8790" -Direction Inbound -Protocol TCP -LocalPort 8790 -Action Allow -Profile Private | Out-Null
    }
    Write-Host "Брандмауэр: порт 8790 открыт для домашней (частной) сети"
} else {
    Warn "Для телефонов откройте порт 8790: при первом запуске Windows спросит доступ - разрешите для частных сетей."
}

Step "Готово!"
Write-Host "Запуск: ярлык «Тренер» на рабочем столе или start.bat"
Write-Host "На этом компьютере:  http://localhost:8791"
Write-Host ("Телефоны и планшеты: https://" + $env:COMPUTERNAME.ToLower() + ".local:8790 или https://<IP компьютера>:8790 - сначала сертификат (README)")
