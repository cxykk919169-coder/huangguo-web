# 黄果客户端 · 全自动部署 (v2)
# ==============================
# 一条命令搞定: 准备文件 -> 部署 -> 校验绑定 -> 回填 -> 验证 -> 失败自动重试
#
# 用法:
#   .\deploy.ps1              # 全自动
#   .\deploy.ps1 -NoVerify    # 跳过部署后验证
#   .\deploy.ps1 -Proxy on    # 强制走代理
#
# 配置在 deploy.config.psd1 里, 不需要改本文件

[CmdletBinding()]
param(
  [switch]$NoVerify,
  [ValidateSet('auto','on','off')][string]$Proxy = ''
)

$ErrorActionPreference = 'Stop'
$script:HereDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$here = $script:HereDir
Set-Location $here

# ============ 输出助手 ============
function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Head([string]$m) { Write-Host ""; Write-Host ("=" * 58) -ForegroundColor DarkCyan; Write-Host ("  " + $m) -ForegroundColor Cyan; Write-Host ("=" * 58) -ForegroundColor DarkCyan }
function Step([string]$m) { Write-Host ""; Write-Host ("-> " + $m) -ForegroundColor Cyan }
function Good([string]$m) { Write-Host ("   [OK] " + $m) -ForegroundColor Green }
function Warn([string]$m) { Write-Host ("   [!]  " + $m) -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host ("   [X]  " + $m) -ForegroundColor Red }

function Cleanup {
  foreach ($f in '_worker_deploy.js','wrangler.toml','_deploy.log','_assets') {
    Remove-Item -Force -Recurse -ErrorAction SilentlyContinue (Join-Path $script:HereDir $f)
  }
}
function Die([string]$m) { Bad $m; Cleanup; exit 1 }

# ============ 0. 读配置 ============
Head "黄果客户端 · 自动部署"

$cfgFile = Join-Path $here 'deploy.config.psd1'
if (-not (Test-Path $cfgFile)) { Die "找不到 deploy.config.psd1" }

Step "读取配置"
$cfg = Import-PowerShellDataFile -Path $cfgFile
$TOKEN  = $cfg.CF_API_TOKEN
$AID    = $cfg.CF_ACCOUNT_ID
$WNAME  = if ($cfg.WORKER_NAME) { $cfg.WORKER_NAME } else { 'huangguo-web' }
$USE_PROXY = if ($Proxy) { $Proxy } else { $cfg.USE_PROXY }
$PROXY_CANDS = if ($cfg.PROXY_CANDIDATES) { $cfg.PROXY_CANDIDATES -split ',' } else { @() }
$MAX_RETRY = if ($cfg.MAX_RETRY) { [int]$cfg.MAX_RETRY } else { 3 }

if (-not $TOKEN -or $TOKEN -match '在这里填|YOUR_') { Die "deploy.config.psd1 里没填 CF_API_TOKEN" }
if (-not $AID   -or $AID   -match '在这里填|YOUR_') { Die "deploy.config.psd1 里没填 CF_ACCOUNT_ID" }

Good ("Worker: " + $WNAME)
Good ("账户:   " + $AID)
Good ("Token:  " + $TOKEN.Substring(0, [Math]::Min(12, $TOKEN.Length)) + "...")

# ============ 1. 自动检测代理 ============
Step "检测网络代理"

# 端口探测 (快速筛掉明显不可用的)
function Test-ProxyPort([string]$hp) {
  try {
    $parts = $hp.Split(':')
    $c = New-Object System.Net.Sockets.TcpClient
    $ar = $c.BeginConnect($parts[0], [int]$parts[1], $null, $null)
    $ok = $ar.AsyncWaitHandle.WaitOne(800)
    if ($ok) { $c.EndConnect($ar) }
    $c.Close()
    return $ok
  } catch { return $false }
}

# 真实可用性验证: 代理能不能真的访问 Cloudflare API
function Test-ProxyWorks([string]$px) {
  try {
    $r = Invoke-WebRequest -Uri 'https://api.cloudflare.com/client/v4/' `
      -Proxy $px -TimeoutSec 12 -UseBasicParsing -ErrorAction Stop
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
  } catch {
    # 能拿到 HTTP 响应(哪怕 4xx)也算代理通
    if ($_.Exception.Response) { return $true }
    return $false
  }
}

# 直连 Cloudflare 能不能通
function Test-DirectWorks {
  try {
    $r = Invoke-WebRequest -Uri 'https://api.cloudflare.com/client/v4/' `
      -TimeoutSec 12 -UseBasicParsing -ErrorAction Stop
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
  } catch {
    if ($_.Exception.Response) { return $true }
    return $false
  }
}

$proxyUrl = $null
if ($USE_PROXY -eq 'off') {
  Warn "配置为不使用代理"
} else {
  # ---- 先试直连 (国内 CF API 通常可直连, 代理反而可能是坏的) ----
  if (Test-DirectWorks) {
    Good "直连 Cloudflare 可用 (优先直连)"
    if ($USE_PROXY -eq 'on') {
      Warn "配置要求走代理, 忽略直连结果"
    } else {
      $proxyUrl = $null
    }
  }

  # ---- 直连不行 / 强制代理时, 逐个真实测试候选代理 ----
  if ((-not $proxyUrl) -and ($USE_PROXY -eq 'on' -or -not (Test-DirectWorks))) {
    foreach ($cand in $PROXY_CANDS) {
      $cand = $cand.Trim()
      if (-not $cand) { continue }
      if (-not (Test-ProxyPort $cand)) { continue }
      $u = "http://$cand"
      if (Test-ProxyWorks $u) {
        $proxyUrl = $u
        Good ("发现可用代理: " + $proxyUrl)
        break
      } else {
        Warn ("代理端口开着但不可用: " + $u)
      }
    }
    if (-not $proxyUrl) {
      if ($USE_PROXY -eq 'on') { Die "要求走代理但没找到真正可用的代理" }
      Warn "无可用代理, 将直连"
    }
  }
}

if ($proxyUrl) {
  $env:HTTPS_PROXY = $proxyUrl
  $env:HTTP_PROXY  = $proxyUrl
  $env:ALL_PROXY   = $proxyUrl
}

# wrangler 需要的凭据环境变量 (必须设, 否则非交互环境会报缺 Token)
$env:CLOUDFLARE_API_TOKEN  = $TOKEN
$env:CLOUDFLARE_ACCOUNT_ID = $AID

# ============ 2. 预检: Token 能不能用 + 查真实子域名 ============
Step "预检 Cloudflare 权限"
$subdomain = $cfg.WORKERS_SUBDOMAIN
try {
  $null = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$AID/workers/services" `
    -Headers @{ Authorization = "Bearer $TOKEN" } -TimeoutSec 40
  Good "Token 可用, 账户可访问"
} catch {
  Die ("Token 无效或权限不足: " + $_.Exception.Message + " | 需要权限: Account -> Workers Scripts -> Edit")
}

# 查真实 workers.dev 子域名 (不能用 Account ID 猜, 两者通常不同)
try {
  $sd = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$AID/workers/subdomain" `
    -Headers @{ Authorization = "Bearer $TOKEN" } -TimeoutSec 30
  if ($sd.result.subdomain) { $subdomain = $sd.result.subdomain }
} catch { }
if ($subdomain) { Good ("子域名: " + $subdomain) } else { Warn "拿不到子域名, 将从部署输出提取" }

# ============ 3. 准备部署文件 ============
Step "准备部署文件"
$assetsDir = Join-Path $here '_assets'
Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $assetsDir
New-Item -ItemType Directory -Path $assetsDir -Force | Out-Null

Copy-Item "$here\worker.js" "$here\_worker_deploy.js" -Force
Copy-Item "$here\index.html" (Join-Path $assetsDir 'index.html') -Force
Copy-Item "$here\site.json"  (Join-Path $assetsDir 'site.json')  -Force

$pwaCount = 0
if (Test-Path "$here\pwa") {
  Copy-Item "$here\pwa\*" $assetsDir -Force
  $pwaCount = (Get-ChildItem "$here\pwa").Count
}
$extra = if ($pwaCount) { " + PWA(" + $pwaCount + ")" } else { "" }
Good ("静态文件: index.html + site.json" + $extra)

# 写 wrangler 配置 (关键: [assets] 绑定, 丢了 /api 就全 404)
# 注意: 必须用 List[string] —— 裸数组里的空字符串会让 PowerShell 把整组塌缩成一行
$tl = [System.Collections.Generic.List[string]]::new()
$tl.Add('name = "' + $WNAME + '"')
$tl.Add('main = "_worker_deploy.js"')
$tl.Add('compatibility_date = "2025-01-01"')
$tl.Add('')
$tl.Add('[assets]')
$tl.Add('directory = "_assets"')
$tl.Add('binding = "ASSETS"')
$tl.Add('')
$tl.Add('# 云端定时自检 (Cron Trigger) —— 跑在 Cloudflare 上, 不依赖本地电脑')
$tl.Add('[triggers]')
$tl.Add('crons = ["*/10 * * * *"]')

$tomlPath = Join-Path $here 'wrangler.toml'
[System.IO.File]::WriteAllLines($tomlPath, $tl, (New-Object System.Text.UTF8Encoding($false)))

# 自检: 校验关键内容都在, 且没被塌缩成一行
$written = Get-Content $tomlPath -Raw
$lineCount = @(Get-Content $tomlPath).Count
if ($lineCount -lt 8) { Die ("wrangler.toml 疑似被塌缩: 只有 " + $lineCount + " 行") }
if ($written -notmatch '\[assets\]') { Die "wrangler.toml 缺少 [assets] 段" }
if ($written -notmatch 'binding\s*=\s*"ASSETS"') { Die "wrangler.toml 缺少 ASSETS 绑定" }
if ($written -notmatch 'main\s*=\s*"_worker_deploy\.js"') { Die "wrangler.toml 缺少 main 入口" }
Good ("wrangler.toml 已生成 (" + $lineCount + " 行, 含 ASSETS 绑定 + Cron)")

# ============ 4. 部署 (带重试) ============
# URL 优先用查到的子域名; 拿不到就先留空, 部署后从 wrangler 输出提取
$url = if ($subdomain) { "https://$WNAME.$subdomain.workers.dev" } else { '' }
$deployed = $false
$attempt = 0
$wp = 'wrangler' + [char]64 + '4'

while (-not $deployed -and $attempt -lt $MAX_RETRY) {
  $attempt++
  Step ("部署 Worker (第 " + $attempt + "/" + $MAX_RETRY + " 次)")

  $logFile = Join-Path $here '_deploy.log'
  $null = cmd /c ('npx --yes ' + $wp + ' deploy > "' + $logFile + '" 2>&1')
  $ec = $LASTEXITCODE
  $out = if (Test-Path $logFile) { Get-Content $logFile -Raw -Encoding UTF8 } else { '' }
  Remove-Item -Force -ErrorAction SilentlyContinue $logFile

  if ($out -match 'https://[a-zA-Z0-9\-\.]+\.workers\.dev') { $url = $Matches[0] }

  if ($ec -eq 0 -and $out -match 'Uploaded|Deployed') {
    $deployed = $true
    Good "部署成功"
    if ($out -match 'Version ID:\s*([a-f0-9\-]+)') { Good ("版本: " + $Matches[1]) }
  } else {
    Warn ("第 " + $attempt + " 次失败")
    $errLines = @($out -split "`r?`n" | Where-Object { $_ -match 'ERROR|error|failed|No access' } | Select-Object -First 3)
    foreach ($e in $errLines) { Say ("      " + $e.Trim()) 'DarkYellow' }
    if ($attempt -lt $MAX_RETRY) {
      Warn "5 秒后重试..."
      Start-Sleep -Seconds 5
      if (-not $proxyUrl) {
        foreach ($cand in $PROXY_CANDS) {
          $cand = $cand.Trim()
          if ($cand -and (Test-ProxyPort $cand)) {
            $proxyUrl = "http://$cand"
            $env:HTTPS_PROXY = $proxyUrl; $env:HTTP_PROXY = $proxyUrl; $env:ALL_PROXY = $proxyUrl
            Warn ("改用代理重试: " + $proxyUrl)
            break
          }
        }
      }
    }
  }
}

if (-not $deployed) { Die ("部署失败 (已重试 " + $MAX_RETRY + " 次)。检查 Token 权限和网络。") }

# ============ 5. 校验 ASSETS 绑定 ============
Step "校验 ASSETS 绑定"
$bindOk = $false
for ($i = 1; $i -le 6; $i++) {
  try {
    $s = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$AID/workers/scripts/$WNAME/settings" `
      -Headers @{ Authorization = "Bearer $TOKEN" } -TimeoutSec 30
    $names = @($s.result.bindings | ForEach-Object { $_.name })
    if ($names -contains 'ASSETS') { $bindOk = $true; Good "ASSETS 绑定正常"; break }
    else { Warn ("第 " + $i + " 次: 绑定还没生效..."); Start-Sleep -Seconds 4 }
  } catch {
    Warn ("第 " + $i + " 次查询失败"); Start-Sleep -Seconds 4
  }
}
if (-not $bindOk) { Warn "ASSETS 绑定未确认, 继续验证看实际效果" }

# ============ 6. 回填前端地址 ============
Step "回填 Worker 地址到前端"
$idx = Join-Path $assetsDir 'index.html'
$html = Get-Content $idx -Raw -Encoding UTF8
$pattern = "const DEFAULT_API = '[^']*';"
$repl = "const DEFAULT_API = '$url';"
$html2 = $html -replace $pattern, $repl

if ($html2 -ne $html) {
  $u8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($idx, $html2, $u8)
  [System.IO.File]::WriteAllText((Join-Path $here 'index.html'), $html2, $u8)
  Good ("DEFAULT_API = " + $url)

  Step "重新部署 (应用回填)"
  $logFile = Join-Path $here '_deploy.log'
  $null = cmd /c ('npx --yes ' + $wp + ' deploy > "' + $logFile + '" 2>&1')
  Remove-Item -Force -ErrorAction SilentlyContinue $logFile
  if ($LASTEXITCODE -eq 0) { Good "回填后部署成功" } else { Warn "回填后部署可能失败" }
} else {
  Good "DEFAULT_API 已是目标值, 跳过"
}

# ============ 7. 验证 ============
$verifyPass = $false
if (-not $NoVerify) {
  Step "部署后验证"
  Start-Sleep -Seconds 5

  $paths = @(
    @{ p = '/';                     must = '200'; what = '首页' },
    @{ p = '/api/health';           must = '200'; what = '健康检查' },
    @{ p = '/api/list?cat=&page=1'; must = '200'; what = '列表接口' },
    @{ p = '/manifest.json';        must = '200'; what = 'PWA清单' },
    @{ p = '/sw.js';                must = '200'; what = 'SW' },
    @{ p = '/worker.js';            must = '404'; what = '源码保护' }
  )

  $pass = 0; $fail = 0
  foreach ($t in $paths) {
    $code = '000'
    for ($k = 1; $k -le 3; $k++) {
      try {
        $r = Invoke-WebRequest -Uri ($url + $t.p) -TimeoutSec 40 -UseBasicParsing -ErrorAction Stop
        $code = [string]$r.StatusCode
      } catch {
        if ($_.Exception.Response) { $code = [string][int]$_.Exception.Response.StatusCode }
      }
      if ($code -eq $t.must) { break }
      Start-Sleep -Seconds 2
    }
    if ($code -eq $t.must) { $pass++; Good ($t.what + " -> " + $code) }
    else { $fail++; Warn ($t.what + " 期望 " + $t.must + " 实际 " + $code) }
  }

  try {
    $htxt = Invoke-RestMethod -Uri ($url + '/api/health') -TimeoutSec 40
    if ($htxt.ok) { Good ("上游镜像: " + $htxt.mirror) } else { Warn "健康检查 ok=false" }
  } catch { }

  $verifyPass = ($fail -eq 0)
  if ($verifyPass) { Good ("验证全部通过 (" + $pass + "/" + ($pass + $fail) + ")") }
  else { Warn ("验证 " + $pass + " 通过 / " + $fail + " 失败") }
}

# ============ 8. 汇总 ============
Cleanup
Head "部署完成"
Write-Host ""
$pxTxt = if ($proxyUrl) { $proxyUrl } else { "直连" }
$vfTxt = if ($NoVerify) { "已跳过" } elseif ($verifyPass) { "通过" } else { "有问题, 见上面 [!]" }
Write-Host ("  访问地址 : " + $url) -ForegroundColor White
Write-Host ("  健康检查 : " + $url + "/api/health") -ForegroundColor Gray
Write-Host ("  代理状态 : " + $pxTxt) -ForegroundColor Gray
Write-Host ("  验证结果 : " + $vfTxt) -ForegroundColor Gray
Write-Host ""

if (-not $NoVerify -and -not $verifyPass) { exit 2 }
exit 0
