# ============================================================
#  一键下架 (下架.ps1)
# ============================================================
#  用途: 万一收到侵权通知, 30 秒内把线上站点全部关停
#
#  用法:
#    .\下架.ps1                 # 默认: 干跑 (只看会做什么, 不动手)
#    .\下架.ps1 -Go             # 真执行 (需输入确认码)
#    .\下架.ps1 -Go -Force      # 真执行 (跳过确认码, 紧急用)
#
#  下架范围 (按速度排序):
#    1. Cloudflare: 停用 workers.dev 子域    ← 秒生效, 站点立刻 404
#    2. Cloudflare: 删除 Worker 脚本
#    3. GitHub:     停用 Pages 发布
#    4. GitHub:     仓库归档 (需 administration 权限)
#    5. GitHub:     删除仓库 (需 delete_repo 权限)
#    6. 本地:       清部署产物 + 停计划任务
#
#  说明: 每步都是"能删就删, 删不了就跳过并报告", 不会因为权限不足中断
# ============================================================

[CmdletBinding()]
param(
  [switch]$Go,
  [switch]$Force,
  [switch]$KeepLocal,        # 保留下载的剧, 只清部署产物
  [string]$ConfirmWord = '下架'
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$CLIENT = $here
$TOOLS  = Join-Path (Split-Path -Parent $here) '黄果'

# ---------- 凭据 ----------
$cfgPath = Join-Path $here 'deploy.config.psd1'
$cfToken = $null; $cfAccount = $null; $workerName = 'huangguo-web'; $cfSub = $null
if (Test-Path $cfgPath) {
  try {
    $cfg = Import-PowerShellDataFile $cfgPath
    foreach ($k in 'CF_API_TOKEN', 'CLOUDFLARE_API_TOKEN', 'TOKEN') {
      if ($cfg[$k]) { $cfToken = $cfg[$k]; break }
    }
    foreach ($k in 'CF_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID', 'ACCOUNT_ID') {
      if ($cfg[$k]) { $cfAccount = $cfg[$k]; break }
    }
    if ($cfg.WORKER_NAME) { $workerName = $cfg.WORKER_NAME }
    if ($cfg.WORKERS_SUBDOMAIN) { $cfSub = $cfg.WORKERS_SUBDOMAIN }
  } catch { }
}

$gtPath = Join-Path $here 'deploy.github.psd1'
$ghToken = $null; $ghRepo = 'cxykk919169-coder/huangguo-web'
if (Test-Path $gtPath) {
  try {
    $g = Import-PowerShellDataFile $gtPath
    foreach ($k in 'GITHUB_TOKEN', 'GH_TOKEN', 'TOKEN') {
      if ($g[$k]) { $ghToken = $g[$k]; break }
    }
    if ($g.REPO) { $ghRepo = $g.REPO }
  } catch { }
}

# ---------- 输出 ----------
function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function H1($m) { Say ''; Say ('=' * 60) 'Cyan'; Say "  $m" 'Cyan'; Say ('=' * 60) 'Cyan' }
function OK($m) { Say "  [OK]   $m" 'Green' }
function NO($m) { Say "  [跳过] $m" 'Yellow' }
function XX($m) { Say "  [失败] $m" 'Red' }

$DRY = -not $Go

H1 '一键下架'
if ($DRY) {
  Say ''
  Say '  >>> 干跑模式 (只显示会做什么, 不实际执行) <<<' 'Yellow'
  Say '  >>> 真要下架请加 -Go 参数 <<<' 'Yellow'
}

# ============================================================
#  第 0 步: 确认
# ============================================================
if (-not $DRY -and -not $Force) {
  Say ''
  Say '  即将执行下架, 这会:' 'Red'
  Say '    1. 停用 workers.dev 站点 (立刻 404)' 'Red'
  Say '    2. 删除 Cloudflare Worker' 'Red'
  Say '    3. 停用 GitHub Pages' 'Red'
  Say '    4. 清理本地部署产物' 'Red'
  Say ''
  Say "  确认请输入: $ConfirmWord" 'Yellow'
  $ans = Read-Host '  >'
  if ($ans.Trim() -ne $ConfirmWord) {
    Say ''
    Say '  输入不匹配, 已取消。' 'Yellow'
    exit 1
  }
}

$report = @()

# ============================================================
#  1. 停用 Cloudflare workers.dev 子域
# ============================================================
H1 '1/6  停用 Cloudflare workers.dev 子域'
$url1 = "https://api.cloudflare.com/client/v4/accounts/$cfAccount/workers/scripts/$workerName/subdomain"
if ($cfToken -and $cfAccount) {
  if ($DRY) {
    Say "  会 PUT $url1  (enabled=false)" 'Gray'
    $report += "停用 workers.dev 子域 ............ 待执行"
  } else {
    $body = '{"enabled":false,"previews_enabled":false}'
    $tmp = "$env:TEMP\_td1.json"
    [System.IO.File]::WriteAllText($tmp, $body, [System.Text.UTF8Encoding]::new($false))
    $out = & curl.exe -s -m 30 -X POST `
      -H "Authorization: Bearer $cfToken" -H "Content-Type: application/json" `
      --data-binary "@$tmp" $url1 2>&1
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    $j = ($out -join '') | ConvertFrom-Json
    if ($j.success) { OK '子域已停用 (站点立即 404)'; $report += '停用 workers.dev 子域 ............ 成功' }
    else { XX "失败: $($j.errors.message -join '; ')"; $report += "停用 workers.dev 子域 ............ 失败" }
  }
} else {
  NO '没有 Cloudflare 凭据 (deploy.config.psd1)'
  $report += '停用 workers.dev 子域 ............ 无凭据'
}

# ============================================================
#  2. 删除 Cloudflare Worker
# ============================================================
H1 '2/6  删除 Cloudflare Worker'
$url2 = "https://api.cloudflare.com/client/v4/accounts/$cfAccount/workers/scripts/$workerName"
if ($cfToken -and $cfAccount) {
  if ($DRY) {
    Say "  会 DELETE $url2" 'Gray'
    $report += "删除 Cloudflare Worker ............ 待执行"
  } else {
    $out = & curl.exe -s -m 30 -X DELETE -H "Authorization: Bearer $cfToken" $url2 2>&1
    $j = ($out -join '') | ConvertFrom-Json
    if ($j.success) { OK "Worker '$workerName' 已删除"; $report += '删除 Cloudflare Worker ............ 成功' }
    else { NO "无法删除: $($j.errors.message -join '; ')"; $report += '删除 Cloudflare Worker ............ 失败/跳过' }
  }
} else {
  NO '没有 Cloudflare 凭据'
  $report += '删除 Cloudflare Worker ............ 无凭据'
}

# ============================================================
#  3. 停用 GitHub Pages
# ============================================================
H1 '3/6  停用 GitHub Pages'
$url3 = "https://api.github.com/repos/$ghRepo/pages"
if ($ghToken) {
  if ($DRY) {
    Say "  会 DELETE $url3" 'Gray'
    $report += '停用 GitHub Pages ................ 待执行'
  } else {
    $out = & curl.exe -s -m 30 -X DELETE `
      -H "Authorization: Bearer $ghToken" -H "Accept: application/vnd.github+json" `
      -H "User-Agent: hg" $url3 2>&1
    if ($LASTEXITCODE -eq 0 -and -not (($out -join '') -match 'message')) {
      OK 'GitHub Pages 已停用'
      $report += '停用 GitHub Pages ................ 成功'
    } else {
      $msg = try { (($out -join '') | ConvertFrom-Json).message } catch { '未知' }
      NO "无法停用: $msg"
      $report += '停用 GitHub Pages ................ 失败/无权限'
    }
  }
} else {
  NO '没有 GitHub 凭据'
  $report += '停用 GitHub Pages ................ 无凭据'
}

# ============================================================
#  4. 归档 GitHub 仓库
# ============================================================
H1 '4/6  归档 GitHub 仓库'
$url4 = "https://api.github.com/repos/$ghRepo"
if ($ghToken) {
  if ($DRY) {
    Say "  会 PATCH $url4  (archived=true)" 'Gray'
    $report += '归档 GitHub 仓库 .................. 待执行'
  } else {
    $tmp = "$env:TEMP\_td4.json"
    [System.IO.File]::WriteAllText($tmp, '{"archived":true}', [System.Text.UTF8Encoding]::new($false))
    $out = & curl.exe -s -m 30 -X PATCH `
      -H "Authorization: Bearer $ghToken" -H "Accept: application/vnd.github+json" `
      -H "User-Agent: hg" -H "Content-Type: application/json" `
      --data-binary "@$tmp" $url4 2>&1
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    $j = try { ($out -join '') | ConvertFrom-Json } catch { $null }
    if ($j.archived) { OK '仓库已归档 (只读)'; $report += '归档 GitHub 仓库 .................. 成功' }
    else { NO "无法归档: $($j.message)"; $report += '归档 GitHub 仓库 .................. 失败/无权限' }
  }
} else {
  NO '没有 GitHub 凭据'
  $report += '归档 GitHub 仓库 .................. 无凭据'
}

# ============================================================
#  5. 删除 GitHub 仓库
# ============================================================
H1 '5/6  删除 GitHub 仓库'
if ($ghToken) {
  if ($DRY) {
    Say "  会 DELETE $url4" 'Gray'
    Say '  (需要 delete_repo 权限, 你现在没有)' 'Gray'
    $report += '删除 GitHub 仓库 .................. 待执行'
  } else {
    $out = & curl.exe -s -m 30 -w "`n%{http_code}" -X DELETE `
      -H "Authorization: Bearer $ghToken" -H "Accept: application/vnd.github+json" `
      -H "User-Agent: hg" $url4 2>&1
    $txt = ($out -join "`n")
    $code = ($txt -split "`n")[-1].Trim()
    if ($code -eq '204') { OK '仓库已删除'; $report += '删除 GitHub 仓库 .................. 成功' }
    else {
      $msg = try { ($txt | ConvertFrom-Json).message } catch { "HTTP $code" }
      NO "无法删除: $msg (需 delete_repo 权限)"
      $report += '删除 GitHub 仓库 .................. 无权限'
    }
  }
} else {
  NO '没有 GitHub 凭据'
  $report += '删除 GitHub 仓库 .................. 无凭据'
}

# ============================================================
#  6. 本地清理
# ============================================================
H1 '6/6  本地清理'
# 注意: 刻意不删 deploy.config.psd1 / deploy.github.psd1
#       那是密钥文件, 留着以后想重新上线还能用
$localTargets = @('_assets', '_site', '_worker_deploy.js', 'wrangler.toml', '_w.mjs', '_t2.mjs')
foreach ($t in $localTargets) {
  $p = Join-Path $CLIENT $t
  if (Test-Path $p) {
    if ($DRY) { Say "  会删除: $t" 'Gray'; $report += "本地清理 $t ...................... 待执行" }
    else {
      try { Remove-Item $p -Recurse -Force -ErrorAction Stop; OK "已删除 $t"; $report += "本地清理 $t ...................... 成功" }
      catch { NO "删除 $t 失败: $_"; $report += "本地清理 $t ...................... 失败" }
    }
  }
}
Say '  已保留密钥文件 (deploy.config.psd1 / deploy.github.psd1), 重新上线还要用' 'DarkGray'

# 卸载追更计划任务
$taskName = '黄果工具链追更'
$st = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($st) {
  if ($DRY) { Say "  会卸载计划任务: $taskName" 'Gray'; $report += '卸载追更计划任务 .................. 待执行' }
  else {
    try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; OK "已卸载 $taskName"; $report += '卸载追更计划任务 .................. 成功' }
    catch { NO "卸载失败: $_"; $report += '卸载追更计划任务 .................. 失败' }
  }
}

# 停止本地服务进程
$procs = @(Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'local_server|hg_spider.*--serve' })
foreach ($p in $procs) {
  if ($p.ProcessId -ne $PID) {
    if ($DRY) { Say "  会停止进程 PID $($p.ProcessId)" 'Gray' }
    else { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; OK "已停止 PID $($p.ProcessId)" }
  }
}

if ($KeepLocal) {
  NO '按 -KeepLocal 保留下载的剧集文件'
}

# ============================================================
#  汇总
# ============================================================
H1 '下架报告'
$report | ForEach-Object { Say "  $_" }
Say ''

if ($DRY) {
  Say '  这是干跑, 什么都没做。' 'Yellow'
  Say '  真要下架, 执行:  .\下架.ps1 -Go' 'Yellow'
  Say '  紧急情况:        .\下架.ps1 -Go -Force' 'Red'
} else {
  Say '  下架流程已执行完毕。' 'Green'
  Say ''
  Say '  请手动确认:' 'White'
  Say '    - 打开 workers.dev 地址, 应该 404' 'Gray'
  Say '    - 打开 GitHub Pages 地址, 应该 404' 'Gray'
  Say '    - 若仍有残留, 去 Cloudflare / GitHub 网页后台手动删' 'Gray'
}
Say ''
