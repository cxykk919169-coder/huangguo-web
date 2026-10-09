# 黄果客户端 · 守护进程 (常驻运行)
# ================================
# 循环检测站点健康; 挂了自动重新部署
# 由 Windows 计划任务拉起, 或手动跑着放后台
#
# 用法:
#   .\watch.ps1                # 前台常驻, Ctrl+C 停止
#   .\watch.ps1 -Once          # 只检查一次
#   .\watch.ps1 -Interval 300  # 每 300 秒检查一次 (默认 600)

[CmdletBinding()]
param(
  [switch]$Once,
  [int]$Interval = 600,
  [int]$MaxFails = 2
)

$ErrorActionPreference = 'Continue'
$script:HereDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$here = $script:HereDir
Set-Location $here

$logDir = Join-Path $here '_logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'watch.log'

function Log([string]$m, [string]$level = 'INFO') {
  $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $line = "[$ts] [$level] $m"
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  # 日志超过 5000 行就截断
  $c = @(Get-Content $logFile -ErrorAction SilentlyContinue).Count
  if ($c -gt 5000) {
    $keep = Get-Content $logFile | Select-Object -Last 2000
    Set-Content -Path $logFile -Value $keep -Encoding UTF8
  }
}

# ---- 读配置 ----
$cfgFile = Join-Path $here 'deploy.config.psd1'
if (-not (Test-Path $cfgFile)) { Log "找不到 deploy.config.psd1" 'FATAL'; exit 1 }
$cfg = Import-PowerShellDataFile -Path $cfgFile
$TOKEN = $cfg.CF_API_TOKEN
$AID   = $cfg.CF_ACCOUNT_ID
$WNAME = if ($cfg.WORKER_NAME) { $cfg.WORKER_NAME } else { 'huangguo-web' }

# ---- 自动探测代理 ----
$proxyCands = if ($cfg.PROXY_CANDIDATES) { $cfg.PROXY_CANDIDATES -split ',' } else { @() }
$proxyUrl = $null
function Detect-Proxy {
  $script:proxyUrl = $null
  foreach ($cand in $proxyCands) {
    $cand = $cand.Trim()
    if (-not $cand) { continue }
    try {
      $parts = $cand.Split(':')
      $c = New-Object System.Net.Sockets.TcpClient
      $ar = $c.BeginConnect($parts[0], [int]$parts[1], $null, $null)
      $ok = $ar.AsyncWaitHandle.WaitOne(600)
      if ($ok) { $c.EndConnect($ar); $c.Close(); $script:proxyUrl = "http://$cand"; return $true }
      $c.Close()
    } catch { }
  }
  return $false
}

# ---- 查子域名 ----
$subdomain = $cfg.WORKERS_SUBDOMAIN
try {
  $sd = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$AID/workers/subdomain" `
    -Headers @{ Authorization = "Bearer $TOKEN" } -TimeoutSec 30
  if ($sd.result.subdomain) { $subdomain = $sd.result.subdomain }
} catch { }
if (-not $subdomain) { Log "拿不到子域名, 无法守护" 'FATAL'; exit 1 }

$url = "https://$WNAME.$subdomain.workers.dev"

# ---- 健康检查函数: 返回 @{ ok = $bool; reason = "..." } ----
function Test-Health {
  # 1. API 健康检查
  $apiCode = '000'
  try {
    $r = Invoke-WebRequest -Uri "$url/api/health" -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
    $apiCode = [string]$r.StatusCode
    if ($apiCode -eq '200') {
      $j = $r.Content | ConvertFrom-Json
      if ($j.ok) {
        return @{ ok = $true; reason = "健康 (镜像 $($j.mirror))" }
      } else {
        return @{ ok = $false; reason = "上游全挂 (ok=false)" }
      }
    }
  } catch {
    if ($_.Exception.Response) { $apiCode = [string][int]$_.Exception.Response.StatusCode }
  }

  # 2. 首页兜底
  $homeCode = '000'
  try {
    $r2 = Invoke-WebRequest -Uri $url -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
    $homeCode = [string]$r2.StatusCode
  } catch {
    if ($_.Exception.Response) { $homeCode = [string][int]$_.Exception.Response.StatusCode }
  }

  return @{ ok = $false; reason = "API 不可用 (HTTP $apiCode), 首页 HTTP $homeCode" }
}

# ---- 自愈: 调用 deploy.ps1 ----
function Invoke-Heal {
  Log "触发自动修复: 调用 deploy.ps1" 'HEAL'
  try {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'deploy.ps1') 2>&1 | Out-String
    $ec = $LASTEXITCODE
    # 只把关键行写日志
    $keyLines = @($out -split "`r?`n" | Where-Object { $_ -match '\[OK\]|\[X\]|\[!\]|部署成功|部署失败|验证' })
    foreach ($l in $keyLines) { Log ("  " + $l.Trim()) 'HEAL' }
    Log ("deploy.ps1 退出码: " + $ec) 'HEAL'
    return ($ec -eq 0)
  } catch {
    Log ("修复失败: " + $_.Exception.Message) 'ERROR'
    return $false
  }
}

# ============ 单实例锁 (防止多个守护同时跑) ============
$mutexName = 'Global\HuangguoGuardMutex'
$createdNew = $false
$script:mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)

if (-not $createdNew) {
  Log "已有守护在运行, 本实例退出 (避免重复)" 'SKIP'
  exit 0
}

# ============ 主循环 ============
Log "===== 守护启动 ====="
Log ("目标: " + $url)
Log ("检查间隔: " + $Interval + " 秒   连续失败阈值: " + $MaxFails)
Log ("PID: " + $PID)

if (Detect-Proxy) { Log ("代理: " + $proxyUrl) } else { Log "无代理, 直连" }

$failCount = 0
$healCount = 0
$round = 0

try {
while ($true) {
  $round++
  $hres = Test-Health

  if ($hres.ok) {
    if ($failCount -gt 0) { Log ("恢复正常: " + $hres.reason) 'OK' }
    else { Log ("第 " + $round + " 轮: " + $hres.reason) }
    $failCount = 0
  } else {
    $failCount++
    Log ("检查失败 " + $failCount + "/" + $MaxFails + ": " + $hres.reason) 'WARN'

    if ($failCount -ge $MaxFails) {
      # 重新探测代理 (可能代理重启了)
      if (-not $proxyUrl) { if (Detect-Proxy) { Log ("代理恢复: " + $proxyUrl) } }

      $ok = Invoke-Heal
      $healCount++
      if ($ok) {
        Log ("修复 #" + $healCount + " 完成, 等待生效...") 'HEAL'
        Start-Sleep -Seconds 20
        $hres2 = Test-Health
        if ($hres2.ok) {
          Log ("修复成功: " + $hres2.reason) 'OK'
          $failCount = 0
        } else {
          Log ("修复后仍不健康: " + $hres2.reason) 'ERROR'
        }
      } else {
        Log "修复未成功, 下轮继续尝试" 'ERROR'
      }
      # 修复后多等一会再进下一轮
      Start-Sleep -Seconds 30
    }
  }

  if ($Once) { break }
  Start-Sleep -Seconds $Interval
}
} finally {
  Log "===== 守护退出 ====="
  try { $script:mutex.ReleaseMutex() } catch { }
  try { $script:mutex.Dispose() } catch { }
}
