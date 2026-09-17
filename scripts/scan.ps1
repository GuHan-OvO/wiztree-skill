<#
.SYNOPSIS
  用 WizTree 命令行扫描目标（盘符或文件夹）并导出 CSV，可选立即分析出报告。

.DESCRIPTION
  已验证事实（WizTree 4.32，Windows）：
    * WizTree64.exe "<目标>" /export="<csv>" 会无窗口完成扫描并自行退出。
    * 不需要管理员权限即可读取 MFT（当前用户属 Administrators 组时实测整盘 C: 约 30 秒）。
    * /export 目标文件已存在时会静默覆盖，不会弹窗。
    * 退出码恒为 0，即使目标不存在；因此必须以"CSV 是否生成"判断成功。
    * 绝不能传 /admin=1：实测会立即退出且不生成任何文件。
    * /configfolder="<目录>" 可隔离配置（本脚本默认隔离，避免污染用户 GUI 设置）。

.PARAMETER Target
  要扫描的目标：盘符（如 C:）或文件夹路径。不要传文件路径（传 CSV 会打开 GUI 而不导出）。

.PARAMETER Out
  导出 CSV 的路径。默认写到 $env:TEMP\wiztree\<名称>-<时间戳>.csv 。

.PARAMETER TimeoutSec
  等待扫描完成的秒数，默认 900。超时会杀掉 WizTree。

.PARAMETER Reuse
  若 Out 已存在则直接复用，不重新扫描（适合对同一份数据反复出不同报告）。

.PARAMETER UseUserConfig
  使用 WizTree 当前用户配置，不做 /configfolder 隔离。

.PARAMETER Open
  扫描完成后用 WizTree GUI 打开该 CSV（不重新扫描）。

.PARAMETER Report
  扫描完成后直接调用 analyze.mjs 打印报告。

.PARAMETER Key
  Report 的排序键：size（逻辑大小，默认）或 allocated（实际占盘）。

.PARAMETER Top
  Report 各榜单条数，默认 10。

.PARAMETER Prefix
  Report 只看该路径前缀下的条目。

.PARAMETER Dups
  Report 附加"同名同大小"重复文件候选。

.PARAMETER MinSizeMB
  Dups 时忽略小于该 MB 数的文件。

.EXAMPLE
  .\scan.ps1 -Target C: -Report -Top 10
.EXAMPLE
  .\scan.ps1 -Target "C:\Projects" -Out D:\cache\projects.csv -Report -Dups -MinSizeMB 100
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$Out,
  [string]$Exe,
  [int]$TimeoutSec = 900,
  [switch]$Reuse,
  [switch]$UseUserConfig,
  [switch]$Open,
  [switch]$Report,
  [ValidateSet('size', 'allocated')][string]$Key = 'size',
  [int]$Top = 10,
  [string]$Prefix,
  [switch]$Dups,
  [int]$MinSizeMB = 0
)

$ErrorActionPreference = 'Stop'

function Find-WizTree {
  param([string]$Explicit)
  $candidates = @()
  if ($Explicit) { $candidates += $Explicit }
  $candidates += @(
    'C:\software\tool\WizTree\WizTree64.exe',
    'C:\Program Files\WizTree\WizTree64.exe',
    'C:\Program Files (x86)\WizTree\WizTree64.exe'
  )
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path } }
  $cmd = Get-Command 'WizTree64.exe' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw "找不到 WizTree64.exe。请用 -Exe 指定完整路径，或安装 WizTree（https://diskanalyzer.com）。"
}

function Find-Node {
  $cmd = Get-Command 'node' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($c in @('C:\software\tool\nodejs\node.exe', 'C:\Program Files\nodejs\node.exe')) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  throw "找不到 node（analyze.mjs 需要 Node.js 16+）。"
}

# Start-Process 不会自动为含空格的参数加引号，这里手动加。
function Quote-Arg {
  param([string]$Value)
  if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
  return $Value
}

# 目标校验：必须存在，且不是文件
if (-not (Test-Path -LiteralPath $Target)) {
  throw "目标不存在: $Target"
}
$item = Get-Item -LiteralPath $Target -Force
if (-not $item.PSIsContainer) {
  throw "目标是文件，不是文件夹或盘符: $Target。WizTree 只扫描盘符/目录；传 CSV 路径只会打开 GUI。"
}

# 默认输出位置
if (-not $Out) {
  $safe = ($Target -replace '[\\/:*?"<>|]', '_').Trim('_')
  if (-not $safe) { $safe = 'scan' }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dir = Join-Path $env:TEMP 'wiztree'
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $Out = Join-Path $dir ("$safe-$stamp.csv")
}
$Out = [System.IO.Path]::GetFullPath($Out)
$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$csvReady = $false
if ($Reuse -and (Test-Path -LiteralPath $Out)) {
  if ((Get-Item -LiteralPath $Out).Length -gt 0) { $csvReady = $true }
}
if (-not $csvReady -and (Test-Path -LiteralPath $Out)) { Remove-Item -LiteralPath $Out -Force }

if (-not $csvReady) {
  # 只有真的要扫描时才需要 WizTree：-Reuse 分析已有 CSV 时本机可以没装 WizTree
  $exe = Find-WizTree -Explicit $Exe
  $argList = New-Object System.Collections.Generic.List[string]
  $argList.Add((Quote-Arg $Target))
  if (-not $UseUserConfig) {
    $cfg = Join-Path $env:LOCALAPPDATA 'WizTree3-skill-cfg'
    if (-not (Test-Path -LiteralPath $cfg)) { New-Item -ItemType Directory -Path $cfg -Force | Out-Null }
    $argList.Add((Quote-Arg "/configfolder=$cfg"))
  }
  $argList.Add((Quote-Arg "/export=$Out"))

  Write-Host ("扫描中: {0}  ->  {1}" -f $Target, $Out)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $exe -ArgumentList $argList.ToArray() -PassThru
  $finished = $p.WaitForExit($TimeoutSec * 1000)
  $sw.Stop()
  if (-not $finished) {
    try { $p.Kill() } catch { }
    throw ("扫描超过 {0} 秒仍未完成，已终止 WizTree（目标: {1}）。" -f $TimeoutSec, $Target)
  }

  if (-not (Test-Path -LiteralPath $Out) -or (Get-Item -LiteralPath $Out).Length -eq 0) {
    throw ("WizTree 未生成 CSV（退出码 {0}，耗时 {1:N1}s）。退出码恒为 0，不能作为成功依据。常见原因：目标路径不可访问、被拒绝访问的保护区、或参数写法有误（例如误加 /admin=1）。" -f $p.ExitCode, $sw.Elapsed.TotalSeconds)
  }
  Write-Host ("完成: 耗时 {0:N1}s, CSV {1:N1} MB" -f $sw.Elapsed.TotalSeconds, ((Get-Item -LiteralPath $Out).Length / 1MB))
}

$csv = Get-Item -LiteralPath $Out
Write-Host ("CSV: {0}" -f $csv.FullName)
Write-Host ("大小: {0:N1} MB" -f ($csv.Length / 1MB))

if ($Open) {
  $exe = Find-WizTree -Explicit $Exe  # 打开 GUI 需要 WizTree 本体
  # 传 CSV 路径给 WizTree 会以该数据打开 GUI（不会重新扫描）。
  Start-Process -FilePath $exe -ArgumentList (Quote-Arg $csv.FullName) | Out-Null
  Write-Host '已用 WizTree GUI 打开该 CSV（数据来自文件，未重新扫描）。'
}

if ($Report) {
  $node = Find-Node
  $analyzer = Join-Path $PSScriptRoot 'analyze.mjs'
  if (-not (Test-Path -LiteralPath $analyzer)) { throw "缺少 $analyzer" }
  $a = @($analyzer, $csv.FullName, '--key', $Key, '--top', "$Top")
  if ($Prefix) { $a += @('--prefix', $Prefix) }
  if ($Dups) { $a += '--dups' }
  if ($Dups -and $MinSizeMB -gt 0) { $a += @('--min-size', "$($MinSizeMB * 1MB)") }
  Write-Host ''
  & $node @a
  if ($LASTEXITCODE -ne 0) { throw "analyze.mjs 退出码 $LASTEXITCODE" }
}
