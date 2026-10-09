# 黄果客户端 · 安装无人值守守护
# ================================
# 做三件事:
#   1. 注册 Windows 计划任务 (开机自启 + 每10分钟兜底检查)
#   2. 立即启动守护进程 (后台隐藏窗口)
#   3. 验证任务已生效
#
# 用法 (需管理员):
#   .\install_watch.ps1           # 安装
#   .\install_watch.ps1 -Remove   # 卸载

[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$script:HereDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$here = $script:HereDir

function Head([string]$m) { Write-Host ""; Write-Host ("=" * 58) -ForegroundColor DarkCyan; Write-Host ("  " + $m) -ForegroundColor Cyan; Write-Host ("=" * 58) -ForegroundColor DarkCyan }
function Step([string]$m) { Write-Host ""; Write-Host ("-> " + $m) -ForegroundColor Cyan }
function Good([string]$m) { Write-Host ("   [OK] " + $m) -ForegroundColor Green }
function Warn([string]$m) { Write-Host ("   [!]  " + $m) -ForegroundColor Yellow }
function Bad([string]$m)  { Write-Host ("   [X]  " + $m) -ForegroundColor Red }

$TASK_NAME = 'HuangguoGuard'
$WATCH = Join-Path $here 'watch.ps1'

Head "黄果客户端 · 无人值守守护安装"

# ---- 管理员检查 ----
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$pr = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Bad "需要管理员权限。请右键 PowerShell -> 以管理员身份运行, 再执行本脚本。"
  exit 1
}
Good "管理员权限确认"

# ==================== 卸载 ====================
if ($Remove) {
  Step "卸载守护"
  try {
    Stop-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
    Good "计划任务已删除"
  } catch { Warn ("删除任务: " + $_.Exception.Message) }

  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*watch.ps1*' } |
    ForEach-Object {
      try { Stop-Process -Id $_.ProcessId -Force; Good ("已停止守护进程 PID " + $_.ProcessId) } catch { }
    }
  Write-Host ""
  Good "卸载完成"
  exit 0
}

# ==================== 安装 ====================
if (-not (Test-Path $WATCH)) { Bad "找不到 watch.ps1"; exit 1 }
Good ("守护脚本: " + $WATCH)

# ---- 1. 注册计划任务 ----
Step "注册计划任务: $TASK_NAME"

$existing = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
if ($existing) {
  Warn "已存在同名任务, 先删除旧的"
  Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false -ErrorAction SilentlyContinue
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $WATCH + '" -Interval 600 -MaxFails 2') `
  -WorkingDirectory $here

# 触发器1: 开机后 1 分钟启动
$t1 = New-ScheduledTaskTrigger -AtStartup
$t1.Delay = 'PT1M'

# 触发器2: 每 30 分钟兜底检查一次守护是否还活着
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 2) `
  -ExecutionTimeLimit (New-TimeSpan -Days 0) `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $id.Name -LogonType S4U -RunLevel Highest

try {
  Register-ScheduledTask -TaskName $TASK_NAME `
    -Action $action -Trigger @($t1, $t2) -Settings $settings -Principal $principal `
    -Description '黄果客户端守护: 站点挂了自动重新部署' -Force | Out-Null
  Good "计划任务注册成功"
} catch {
  Bad ("注册失败: " + $_.Exception.Message)
  Warn "尝试改用 SYSTEM 账户..."
  try {
    $p2 = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TASK_NAME `
      -Action $action -Trigger @($t1, $t2) -Settings $settings -Principal $p2 `
      -Description '黄果客户端守护: 站点挂了自动重新部署' -Force | Out-Null
    Good "以 SYSTEM 账户注册成功"
  } catch {
    Bad ("仍然失败: " + $_.Exception.Message)
    exit 1
  }
}

# ---- 2. 立即启动 ----
Step "立即启动守护"
try {
  Start-ScheduledTask -TaskName $TASK_NAME
  Start-Sleep -Seconds 3
  Good "已触发启动"
} catch { Warn ("启动: " + $_.Exception.Message) }

# ---- 3. 验证 ----
Step "验证"
Start-Sleep -Seconds 5
$task = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
if ($task) {
  Good ("任务状态: " + $task.State)
  $info = Get-ScheduledTaskInfo -TaskName $TASK_NAME -ErrorAction SilentlyContinue
  if ($info) { Good ("下次运行: " + $info.NextRunTime) }
} else { Bad "任务没找到!" }

# 看守护进程在不在
$procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*watch.ps1*' })
if ($procs.Count -gt 0) {
  foreach ($p in $procs) { Good ("守护进程运行中: PID " + $p.ProcessId) }
} else {
  Warn "没检测到守护进程, 可能刚启动还在初始化; 稍后可用 -Once 手动验证"
}

# ---- 汇总 ----
Write-Host ""
Write-Host ("=" * 58) -ForegroundColor Green
Write-Host "  无人值守守护已安装" -ForegroundColor Green
Write-Host ("=" * 58) -ForegroundColor Green
Write-Host ""
Write-Host "  做什么 : 每 10 分钟检查站点, 挂了自动重新部署" -ForegroundColor White
Write-Host "  开机   : 自动启动, 无需登录" -ForegroundColor White
Write-Host "  日志   : " -NoNewline -ForegroundColor Gray
Write-Host (Join-Path $here '_logs\watch.log') -ForegroundColor Gray
Write-Host ""
Write-Host "  查看日志 : Get-Content '" -NoNewline -ForegroundColor Gray
Write-Host (Join-Path $here '_logs\watch.log') -NoNewline -ForegroundColor Gray
Write-Host "' -Tail 50" -ForegroundColor Gray
Write-Host "  卸载     : .\install_watch.ps1 -Remove" -ForegroundColor Gray
Write-Host ""
