---
name: wiztree
version: 1.0.0
description: Windows 磁盘占用分析（基于本机 WizTree 4.32 命令行）。用于回答"什么占了 C 盘""哪个文件夹最大""帮我清理磁盘""找出重复文件""某个游戏/项目占多少空间"等问题：先用 WizTree 无窗口扫描导出 CSV，再用自带分析器流式统计，输出最大文件、文件夹独占占用、文件类型分布、重复文件候选。当用户提到磁盘空间、C 盘满了、清理、大文件、重复文件、占用排行、WizTree，或需要在不打开 GUI 的情况下做只读空间体检时使用。硬约束：绝不把导出 CSV 原文读入上下文（整盘可达数百 MB、上百万行），一律用 scripts/analyze.mjs；本 skill 只做只读分析，删除任何文件前必须经用户明确确认。
metadata:
  openclaw:
    emoji: "🧭"
    requires:
      bins: ["node"]
---

# WizTree 磁盘占用分析（Windows）

WizTree 是本机已安装的磁盘空间分析工具，它读 NTFS 的主文件表（MFT），扫整盘只需几十秒。
本 skill 把它的**命令行导出**能力和一个**流式 CSV 分析器**组合起来，让"磁盘体检"变成一条可复现的命令，
不需要打开 GUI，也不会把几百 MB 的清单灌进上下文。

## 何时使用

- "C 盘怎么又满了""什么占了硬盘""帮我看看哪里能清理"
- "找出最大的文件/文件夹""哪些文件重复"
- "某个游戏/项目/软件占了多大空间"
- 任何需要**只读**磁盘占用结论的场景

## 环境要求（Windows 11 + WizTree 4.32 + Node 24 实测）

| 项目 | 值 |
| --- | --- |
| WizTree | 需 **4.x**（开发环境为 4.32）。`WizTree64.exe` 由脚本自动查找：`C:\Program Files\WizTree\`、（x86）目录、`PATH`；其它位置用 `--exe <path>` 指定 |
| Node.js | 分析器需要 **Node 16+**（`node --version`） |
| 提权 | **不需要**。已属 Administrators 的普通会话即可直读 MFT 扫整盘 |
| PowerShell | 主入口是 Node 脚本，**不受 .ps1 执行策略限制**；`scan.ps1` 是备选实现，需显式 `-ExecutionPolicy Bypass` |

## 标准流程（三步）

**第 1 步 · 扫描 + 出报告**（一条命令，整盘约 30 秒）

```powershell
node "$env:USERPROFILE\.dsh\skills\wiztree\scripts\scan.mjs" "C:" --out "$env:TEMP\wiztree\c.csv" --report --top 15
```

**第 2 步 · 换视角时复用同一份 CSV**（不要重复扫描，`--reuse` 秒回）

```powershell
# 只看某个子树
node ...scan.mjs "C:" --out "$env:TEMP\wiztree\c.csv" --reuse --report --prefix "D:\Games" --top 20
# 换排序键为"实际占盘"，找重复，按年份看
node ...scan.mjs "C:" --out "$env:TEMP\wiztree\c.csv" --reuse --report --key allocated --dups --min-size 100
```

**第 3 步 · 汇报结论**：把报告提炼成"谁最占、占多少、建议怎么办"，不要原样粘贴整份报告。

只分析已有的 CSV（例如用户自己从 GUI 导出的）时，直接用分析器：

```powershell
node "$env:USERPROFILE\.dsh\skills\wiztree\scripts\analyze.mjs" "D:\some\export.csv" --top 20 --dups --age
```

## 硬规则（必须遵守）

1. **绝不把导出 CSV 读进上下文。** 整盘 CSV 实测 262 MB / 138 万行；一个 39 万文件的目录导出也有 68 MB。
   一律用 `analyze.mjs` / `scan.mjs --report`，它们流式处理并把结果压缩成几十行。
2. **不要用 `/admin=1`。** 实测加上该参数 WizTree 会 0.2 秒静默退出且**不生成任何文件**。
   本机不需要提权即可扫描。
3. **不要用退出码判断成功。** WizTree 退出码恒为 0，连目标不存在也是 0。
   成功依据只有一个：**CSV 是否真的生成且非空**（脚本已内建该校验并在失败时报错）。
4. **不要传文件路径当扫描目标。** WizTree 只扫描盘符/目录；传 CSV 路径会以该数据打开 GUI（`--open` 才是这个用途）。
5. **只读分析，不自动删除。** 任何清理动作都要先把"路径 + 体积"摆给用户，得到明确确认再执行。
   尤其别建议删 `pagefile.sys`、`hiberfil.sys`、`C:\Windows\WinSxS`、`$Recycle.Bin` 里的系统项。
6. **别用 PowerShell 的 `>` 存 JSON**（Windows PowerShell 5.1 会写成 UTF-16，导致读不回来）。
   用 `cmd /c "... > out.json"`，或让 node 自己写文件。

## 常用配方

| 目标 | 命令要点 |
| --- | --- |
| 整盘体检 | `scan.mjs "C:" --report --top 15` |
| 只要最大文件 | `--top 30`，看"最大文件"段 |
| 找最能清理的目录 | 看"文件夹独占占用"（已扣掉子文件夹，就是这一层自己的体积） |
| 找重复文件 | `--dups --min-size 100`（100 MB 以上） |
| 某个项目/游戏占多少 | `--prefix "C:\Games\SomeGame"` |
| 按真实占盘排序 | `--key allocated`（默认 `size` 是逻辑大小，稀疏/压缩文件会偏大） |
| 老文件堆积 | `--age` 看按修改年份分布 |
| 交给程序处理 | `--json`（字段稳定：`stats`/`topFiles`/`topFolders`/`extensions`/`duplicates`） |
| 用户想看图形化树图 | `scan.mjs ... --open`，用 GUI 打开已有 CSV（不重扫）|

## 结果怎么解读

- **`size` vs `allocated`**：`size` 是文件逻辑大小，`allocated` 是实际占盘（簇对齐）。
  回收站、压缩、稀疏文件、VHD 上两者差别可能很大。
- **"文件夹独占占用"** = 该目录递归总计 − 其子文件夹递归总计，即**这一层自己的体积**。
  报的是这一层，不是整棵子树，所以它才是"该动哪个目录"的答案。
- **报告顶部有个自检**：`stats.selfCheck` 为 `ok` 表示"根行递归总计 == 所有文件行之和"，
  否则说明 CSV 被截断或格式意外（markdown 输出里也会打警告）。
- **重复文件是"同名 + 同大小"候选，不是哈希验证**。给出结论时要说明这一点，
  并且提醒同一软件的多个版本目录（如 Edge/Ubisoft 的多份 `libcef.dll`）通常**不能删**。

## 文件清单

| 文件 | 用途 |
| --- | --- |
| `scripts/scan.mjs` | **主入口**：扫描 + 可选报告。参数见 `--help` 或 [references/cli.md](references/cli.md) |
| `scripts/analyze.mjs` | 只分析已有 CSV（也可被 import 复用） |
| `scripts/scan.ps1` | PowerShell 备选实现，**需** `-ExecutionPolicy Bypass` 才能跑 |
| `references/cli.md` | WizTree 命令行实测记录：哪些开关有效、哪些是坑 |
| `references/csv-format.md` | 导出 CSV 的列定义、递归语义与解析陷阱 |
| `references/recipes.md` | 更多实战配方 + GUI 玩法（树图、过滤器、重复查找） |

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| 报"WizTree 未生成 CSV" | 目标不可访问 / 被保护，或误加了 `/admin=1`；换目标或去掉该参数 |
| 报告数字明显偏小 | 无提权时系统保护区（WinSxS、部分 AppData）可能统计不全；这是 WizTree 的已知行为 |
| 扫描卡住 | 网络盘/USB/被独占的卷很慢；用 `--timeout 60` 限制并改扫子目录 |
| 想扫 `D:` 等其它盘 | 直接换目标即可；先确认该盘已挂载（`Get-PSDrive -PSProvider FileSystem`）|
| 本机没装 WizTree | 只分析已有 CSV 完全可以：`analyze.mjs <csv> …`，或 `scan.mjs … --reuse --report`（`--reuse`/只分析路径不查找 `WizTree64.exe`；真要扫描或 `--open` 才需要本体） |
| .ps1 跑不动 | 执行策略禁止；改用 `scan.mjs`，或 `powershell -ExecutionPolicy Bypass -File scan.ps1`（改这个 .ps1 时必须保持 UTF-8 **带 BOM**，否则 5.1 按 GBK 解码会报语法错，详见 references/cli.md） |
