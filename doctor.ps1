# 黄果客户端 · 体检与自愈
# ========================
# 随时跑一下, 检查线上站点是否正常; 有问题自动修
#
# 用法:
#   .\doctor.ps1          # 体检, 有问题会自动修
#   .\doctor.ps1 -Check   # 只体检, 不修

[CmdletBinding()]
param([switch]$Check)

$ErrorActionPreference = 'Continue'
$script:HereDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$here = $script:HereDir
Set-Location $here

function Head([string]$m) { Write-Host ""; Write-Host ("=" * 58) -ForegroundColor DarkCyan; Write-Host ("  " + $m) -ForegroundColor Cyan; Write-Host ("=" * 58) -ForegroundColor DarkCyan }
function Step([string]$m) { Write-Host ""; Write-Host ("-> " + $m) -ForegroundColor Cyan }
function Good([string]$m) { Write-Host ("   [OK] " + $m) -ForegroundColor Green }
function Warn([string]$m) { Write-Host ("   [!]  " + $m) -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host ("   [X]  " + $m) -ForegroundColor Red }

# ---- 配置 ----
$cfgFile = Join-Path $here 'deploy.config.psd1'
if (-not (Test-Path $cfgFile)) { Bad "找不到 deploy.config.psd1"; exit 1 }
$cfg = Import-PowerShellDataFile -Path $cfgFile
$TOKEN = $cfg.CF_API_TOKEN
$AID   = $cfg.CF_ACCOUNT_ID
$WNAME = if ($cfg.WORKER_NAME) { $cfg.WORKER_NAME } else { 'huangguo-web' }

Head "黄果客户端 · 体检"

# ---- 动态查询真实 workers.dev 子域名 (不能拿 Account ID 猜!) ----
$subdomain = $null
try {
  $sd = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$AID/workers/subdomain" `
    -Headers @{ Authorization = "Bearer $TOKEN" } -TimeoutSec 30
  $subdomain = $sd.result.subdomain
  Write-Host ("  子域名: " + $subdomain) -ForegroundColor Gray
} catch {
  Write-Host "  子域名查询失败" -ForegroundColor Yellow
  $subdomain = $cfg.WORKERS_SUBDOMAIN
}
if (-not $subdomain) {
  Write-Host "  无法确定子域名, 请在 deploy.config.psd1 里补 WORKERS_SUBDOMAIN" -ForegroundColor Red
  exit 1
}

$url = "https://$WNAME.$subdomain.workers.dev"
Write-Host ("  目标: " + $url) -ForegroundColor Gray

# ---- 代理探测 ----
$proxyCands = if ($cfg.PROXY_CANDIDATES) { $cfg.PROXY_CANDIDATES -split ',' } else { @() }
$proxyUrl = $null
foreach ($cand in $proxyCands) {
  $cand = $cand.Trim()
  if (-not $cand) { continue }
  try {
    $parts = $cand.Split(':')
    $c = New-Object System.Net.Sockets.TcpClient
    $ar = $c.BeginConnect($parts[0], [int]$parts[1], $null, $null)
    $ok = $ar.AsyncWaitHandle.WaitOne(800)
    if ($ok) { $c.EndConnect($ar); $c.Close(); $proxyUrl = "http://$cand"; break }
    $c.Close()
  } catch { }
}
if ($proxyUrl) {
  $env:HTTPS_PROXY = $proxyUrl; $env:HTTP_PROXY = $proxyUrl; $env:ALL_PROXY = $proxyUrl
  Good ("代理: " + $proxyUrl)
} else {
  Warn "无可用代理, 走直连 (workers.dev 国内直连可能不通)"
}

$problems = @()

# ---- 1. Worker 绑定检查 ----
Step "1. 检查 ASSETS 绑定"
$bindings = @()
try {
  $s = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$AID/workers/scripts/$WNAME/settings" `
    -Headers @{ Authorization = "Bearer $TOKEN" } -TimeoutSec 30
  $bindings = @($s.result.bindings | ForEach-Object { $_.name })
  if ($bindings -contains 'ASSETS') { Good "ASSETS 绑定存在" }
  else { Bad "ASSETS 绑定丢失 (这会导致 /api/* 全 404)"; $problems += 'binding' }
} catch {
  Bad ("查询失败: " + $_.Exception.Message)
  $problems += 'api'
}

# ---- 2. 线上端点检查 ----
Step "2. 检查线上端点"
$checks = @(
  @{ p = '/';                     must = '200'; what = '首页' },
  @{ p = '/api/health';           must = '200'; what = '健康检查' },
  @{ p = '/api/list?cat=&page=1'; must = '200'; what = '列表接口' },
  @{ p = '/manifest.json';        must = '200'; what = 'PWA清单' },
  @{ p = '/sw.js';                must = '200'; what = 'ServiceWorker' },
  @{ p = '/worker.js';            must = '404'; what = '源码保护' }
)
foreach ($t in $checks) {
  $code = '000'
  try {
    $r = Invoke-WebRequest -Uri ($url + $t.p) -TimeoutSec 40 -UseBasicParsing -ErrorAction Stop
    $code = [string]$r.StatusCode
  } catch {
    if ($_.Exception.Response) { $code = [string][int]$_.Exception.Response.StatusCode }
  }
  if ($code -eq $t.must) { Good ($t.what + " -> " + $code) }
  else {
    Bad ($t.what + " -> " + $code + " (期望 " + $t.must + ")")
    if ($t.p -eq '/api/health') { $problems += 'api' }
    if ($t.p -eq '/worker.js' -and $code -eq '200') { $problems += 'leak' }
    if ($t.p -eq '/' -and $code -ne '200') { $problems += 'front' }
    if ($t.p -eq '/manifest.json') { $problems += 'pwa' }
  }
}

# ---- 3. 上游检查 ----
Step "3. 检查上游站点"
try {
  $h = Invoke-RestMethod -Uri ($url + '/api/health') -TimeoutSec 40
  if ($h.ok) { Good ("上游存活: " + $h.mirror) }
  else { Warn "上游全挂 (官方可能换域名了, 需改 worker.js 的 MIRRORS)"; $problems += 'upstream' }
} catch { Warn "健康检查取不到" }

# ---- 4. DEFAULT_API 检查 ----
Step "4. 检查前端自动配置"
try {
  $r = Invoke-WebRequest -Uri ($url + '/') -TimeoutSec 40 -UseBasicParsing
  if ($r.Content -match "const DEFAULT_API = '([^']*)'") {
    $d = $Matches[1]
    if ($d -eq $url) { Good ("DEFAULT_API 正确: " + $d) }
    elseif ($d -eq '') { Bad "DEFAULT_API 为空"; $problems += 'front' }
    else { Warn ("DEFAULT_API 指向别处: " + $d); $problems += 'front' }
  } else { Bad "页面里没找到 DEFAULT_API"; $problems += 'front' }
} catch { Bad "首页取不到" }

# ---- 汇总 ----
$problems = @($problems | Select-Object -Unique)

Head "体检结论"
if ($problems.Count -eq 0) {
  Write-Host ""
  Write-Host "  一切正常, 无需处理。" -ForegroundColor Green
  Write-Host ""
  exit 0
}

Write-Host ""
Write-Host ("  发现问题: " + ($problems -join ', ')) -ForegroundColor Yellow
Write-Host ""

if ($Check) {
  Write-Host "  (只检查模式, 未修复。去掉 -Check 参数可自动修复)" -ForegroundColor Gray
  exit 1
}

# ---- 自愈 ----
Step "自动修复"
if (Test-Path (Join-Path $here 'deploy.ps1')) {
  Write-Host "   调用 deploy.ps1 重新部署..." -ForegroundColor Gray
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'deploy.ps1')
  $ec = $LASTEXITCODE
  Write-Host ""
  if ($ec -eq 0) { Good "修复完成, 建议再跑一次 doctor.ps1 确认" }
  else { Warn ("deploy.ps1 返回 " + $ec + ", 可能需要人工看") }
} else {
  Bad "找不到 deploy.ps1, 无法自动修复"
}
exit 0
