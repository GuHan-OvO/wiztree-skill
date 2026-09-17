# 实战配方

命令里的 `$S` 指本 skill 的脚本目录：

```powershell
$S = "$env:USERPROFILE\.dsh\skills\wiztree\scripts"
```

## 一、常见问题怎么答

### "C 盘怎么满了，帮我看看"

```powershell
node "$S\scan.mjs" "C:" --out "$env:TEMP\wiztree\c.csv" --report --top 15
```

拿到报告后**不要原样贴**，提炼成：
1. 结论一句话（"主要是游戏 213 GB 的 .pak + 星铁资源 76 GB"）；
2. 最能动的三五个目录（路径 + 体积）；
3. 可回收估算与风险提示（哪些能动、哪些绝对不能动）。

### "某个目录/游戏占多大"

```powershell
node "$S\scan.mjs" "C:" --out "$env:TEMP\wiztree\c.csv" --reuse --report --prefix "C:\Games\SomeGame" --top 20
```

`--reuse` 复用整盘 CSV，**不重新扫描**，秒回。适合对同一份数据反复换视角问。

### "帮我找重复文件 / 哪里能省空间"

```powershell
node "$S\scan.mjs" "C:" --out "$env:TEMP\wiztree\c.csv" --reuse --report --dups --min-size 100 --top 5
```

输出是**同名 + 同大小**候选，按"可回收体积"排序。
必须同时说明：这是启发式候选，**不是哈希校验**；且同名 DLL 多为不同软件/版本的运行时，删了会坏。

### "哪些老文件在占地方"

```powershell
node "$S\scan.mjs" "C:" --out "$env:TEMP\wiztree\c.csv" --reuse --report --age --top 5
```

### "按真实占盘算"（压缩/稀疏/VHD 场景）

```powershell
node "$S\scan.mjs" "C:" --out "$env:TEMP\wiztree\c.csv" --reuse --report --key allocated --top 15
```

### 只要数据、要自己处理

```powershell
cmd /c "node `"$S\scan.mjs`" C: --out $env:TEMP\wiztree\c.csv --reuse --report --json > $env:TEMP\wiztree\report.json"
```

字段：`stats`（含 `selfCheck`、`zeroByteFiles`、`rootDirectSize`、磁盘容量）、
`topFiles`、`topFolders`、`extensions`、`age`、`duplicates`。

> 用 `cmd /c` 重定向而不是 PowerShell 的 `>` —— 后者在 Windows PowerShell 5.1 下写 UTF-16，JSON 会读不回来。

## 二、多命令组合：定期体检

```powershell
$csv = "$env:TEMP\wiztree\c-$(Get-Date -Format yyyyMMdd).csv"
node "$S\scan.mjs" "C:" --out $csv --report --top 10
```

同一目标每天一份，之后可以对比体积变化（直接比 `stats.totalSizeBytes`）。

## 三、只分析用户自己导出的 CSV

用户在 WizTree GUI 里右键 →「导出到 .CSV 文件」得到文件后：

```powershell
node "$S\analyze.mjs" "D:\some\export.csv" --top 25 --dups --age
```

`analyze.mjs` 可以独立使用，也可被别的 Node 脚本 `import { analyze } from '.../analyze.mjs'`。

## 四、GUI 玩法（命令行做不到的部分）

命令行只负责"扫描 + 全量导出"。想看视觉化结果时用 GUI：

```powershell
node "$S\scan.mjs" "C:" --out "$env:TEMP\wiztree\c.csv" --reuse --open
```

`--open` 把**已有 CSV** 交给 WizTree 打开（数据来自文件，不重扫——因为 WizTree 支持 CSV 作为数据源）。
GUI 里可以做命令行做不到的事：

| 功能 | 位置 |
| --- | --- |
| 树图（Treemap） | 工具栏「Show Treemap」，彩色方块按体积分配面积 |
| 另存树图为 PNG | 树图上右键 → Save Treemap Image |
| 过滤扫描结果 | 「Filter Scan Results」Include/Exclude（如 `*.log`） |
| 文件类型统计 | 「Show File Types」→ 可再导出为 CSV |
| 可视化找重复 | 「Duplicate Files」→ Locate by Name/Size(/Date)，带 Dup Count / Dup Size 列 |
| 右键定位 | 右键条目可「Command Prompt Here」「Explorer」|

## 五、安全红线

- 本 skill **只读**。删除/移动文件一律要用户明确确认，并且先列出"路径 + 体积 + 后果"。
- 以下永远不要建议删：`pagefile.sys`、`hiberfil.sys`、`swapfile.sys`、`C:\Windows\WinSxS`、
  `System Volume Information`、`$Recycle.Bin` 里的系统项、`C:\Windows\Installer`。
- `pagefile.sys` 常是"最大文件"第一名（本机 36.3 GB），这是**正常的**，要主动解释而不是建议删。
- 回收站体积大是"可回收"的真候选，但也要先让用户确认再清空。
- 判据永远给体积和路径，让用户决定。
