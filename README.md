# wiztree-skill

> 给 AI Agent 用的 **Windows 磁盘占用分析 skill**：把 [WizTree](https://diskanalyzer.com) 的命令行全量导出，
> 和一个流式 CSV 分析器组合起来，让「C 盘怎么又满了 / 帮我看看哪里能清理」变成一条可复现、可复用的命令。

`Windows` · `Node 16+` · `WizTree 4.x` · `只读` · [AGPL-3.0-or-later](LICENSE)

- **不开 GUI** —— WizTree 无窗口扫描 + 导出全量 CSV（整盘 C: 实测约 30 秒 / 262 MB / 138 万行）
- **不炸上下文** —— 导出的 CSV 绝不读进模型上下文，一律交给 `analyze.mjs` 流式统计，压成几十行报告
- **不重复扫描** —— `--reuse` 让同一份 CSV 被反复换视角查询（换排序键、换前缀、找重复、按年份），秒回
- **只读** —— 本 skill 只做分析与建议；删除任何文件都必须先给出「路径 + 体积 + 后果」并得到用户明确确认

## 目录

- [为什么是这样设计的](#为什么是这样设计的)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [命令参考](#命令参考)
- [报告长这样](#报告长这样)
- [硬规则（值得单独抄走的部分）](#硬规则值得单独抄走的部分)
- [结果怎么解读](#结果怎么解读)
- [排错](#排错)
- [安全红线](#安全红线)
- [目录结构](#目录结构)
- [English summary](#english-summary)
- [许可与致谢](#许可与致谢)

## 为什么是这样设计的

WizTree 的树图、过滤器、重复查找只存在于 GUI，命令行里**没有等价物**；
命令行真正能做的、也是自动化最需要的事只有一件 —— **扫描 + 导出全量 CSV**。

所以本 skill 的取舍是：**扫描交给 WizTree，统计交给自带的分析器**，中间用一份 CSV 解耦：

```text
WizTree64.exe <目标> /export=<csv>      ← 唯一的"重"操作，约 30 秒，整盘一次
        │
        ├─ analyze.mjs --report --top 15          → 谁最占空间
        ├─ analyze.mjs --reuse --prefix <子目录>   → 某个游戏/项目占多少
        ├─ analyze.mjs --reuse --dups --min-size 100 → 重复文件候选
        └─ analyze.mjs --reuse --key allocated     → 按真实占盘排（压缩/稀疏/VHD）
```

代价是放弃了 GUI 可视化，换来的是：可复现、可脚本化、不污染上下文，以及**同一份数据可以无限次换视角**。

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows（读 NTFS 的 MFT，实测于 Windows 11） |
| WizTree | **4.x**（开发与实测版本 **4.32**）。`WizTree64.exe` 由脚本自动查找：`C:\Program Files\WizTree\`、`C:\Program Files (x86)\WizTree\`、以及 `PATH`；装在别处用 `--exe <path>` 指定 |
| Node.js | **16+**（`analyze.mjs` / `scan.mjs`，`node --version`） |
| 权限 | **不需要提权**。属 Administrators 组的普通会话即可直接读 MFT 扫整盘 |
| PowerShell | 主入口是 Node 脚本，**不受 .ps1 执行策略限制**；`scan.ps1` 是备选实现，需显式 `-ExecutionPolicy Bypass` |

CSV 落在 `%TEMP%\wiztree\`，扫描时默认用 `/configfolder` 隔离配置（`%LOCALAPPDATA%\WizTree3-skill-cfg`），
不会污染你的 WizTree GUI 设置；需要沿用用户配置时加 `--user-config`。

## 安装

把整个目录放进你的 agent 的 skills 目录，**目录名用 `wiztree`**：

```text
%USERPROFILE%\.dsh\skills\wiztree\      # DSH 示例，其它平台换成对应的 skills 根目录
├── SKILL.md
├── scripts\
│   ├── scan.mjs
│   ├── analyze.mjs
│   └── scan.ps1
└── references\
    ├── cli.md
    ├── csv-format.md
    └── recipes.md
```

或者 clone 到任意位置直接用（脚本之间用相对路径互相 import，**不要拆散目录结构**）：

```powershell
git clone https://github.com/GuHan-OvO/wiztree-skill.git
```

要求 `SKILL.md` 在根目录、`scripts\` 与 `references\` 与它并列。

> `scripts\scan.ps1` 必须是 **UTF-8 带 BOM**。Windows PowerShell 5.1 会把无 BOM 的 .ps1 按系统 ANSI
> （中文环境即 GBK）解码，脚本里的中文会变乱码并直接抛语法错误。`.mjs` 不受影响。
> 如果编辑器默认输出无 BOM UTF-8，重新保存会让这个坑复现。

## 快速开始

```powershell
$S = "$env:USERPROFILE\.dsh\skills\wiztree\scripts"   # 或你自己的 clone 路径

# 1) 扫描整盘并直接出报告（约 30 秒）
node "$S\scan.mjs" "C:" --out "$env:TEMP\wiztree\c.csv" --report --top 15

# 2) 之后换视角复用同一份 CSV —— 不重扫，秒回
node "$S\scan.mjs" "C:" --out "$env:TEMP\wiztree\c.csv" --reuse --report --prefix "D:\Games" --top 20
node "$S\scan.mjs" "C:" --out "$env:TEMP\wiztree\c.csv" --reuse --report --dups --min-size 100
node "$S\scan.mjs" "C:" --out "$env:TEMP\wiztree\c.csv" --reuse --report --key allocated --top 15

# 3) 只分析已有的 CSV（例如用户自己在 GUI 里导出的）
node "$S\analyze.mjs" "D:\some\export.csv" --top 20 --dups --age
```

三点注意：**不要**把导出的 CSV 读进上下文（整盘可达 262 MB）；**不要**加 `/admin=1`；
**不要**用退出码判断成功。理由见[硬规则](#硬规则值得单独抄走的部分)。

> 只分析已有 CSV 时**本机可以没装 WizTree**：`analyze.mjs <csv>` 独立可用，
> `scan.mjs ... --reuse --report` 也不会去查找 `WizTree64.exe`（只有真的要扫描、或 `--open` 才需要它）。

## 命令参考

### `scripts\scan.mjs` —— 主入口

```text
node scan.mjs <盘符或文件夹> [选项]
```

目标必须存在且是**目录/盘符**（传文件路径只会让 WizTree 打开 GUI）。

| 选项 | 作用 |
| --- | --- |
| `--report` | 扫描后直接打印分析报告（默认只给 CSV 路径） |
| `--reuse` | `--out` 已存在且非空则复用，**不重新扫描** |
| `--out <csv>` | 导出路径（默认 `%TEMP%\wiztree\<名称>-<时间戳>.csv`） |
| `--key size\|allocated` | 报告排序键：逻辑大小（默认）/ 实际占盘 |
| `--top N` | 报告各榜单条数（默认 10） |
| `--prefix <path>` | 报告只看该前缀下的条目 |
| `--dups` | 追加「同名 + 同大小」重复文件候选 |
| `--min-size <MB>` | `--dups` 时忽略小于该值的文件（单位 **MB**） |
| `--age` | 追加按修改年份的分布 |
| `--json` | 以 JSON 输出报告，便于程序处理 |
| `--open` | 用 WizTree GUI 打开已有 CSV（**不重扫**） |
| `--user-config` | 不隔离配置（默认用 `/configfolder` 隔离） |
| `--exe <path>` | 指定 `WizTree64.exe` |
| `--timeout <秒>` | 扫描超时（默认 900） |

### `scripts\analyze.mjs` —— 只分析已有 CSV

```text
node analyze.mjs <file.csv> [选项]
```

| 选项 | 作用 |
| --- | --- |
| `--format md\|json\|text` | 输出格式（默认 `md`；`--json` / `--md` 是快捷写法） |
| `--top N` / `--top-files` / `--top-dirs` / `--top-ext` | 各榜单条数 |
| `--key size\|allocated` | 排序键 |
| `--prefix <path>` | 只看该路径下的条目 |
| `--dups` | 重复文件候选 |
| `--min-size <bytes>` | `--dups` 的下限（单位 **字节**，与 `scan.mjs` 不同，注意区分） |
| `--age` | 按修改年份分布 |

也可以当库用：`import { analyze, printMarkdown } from './analyze.mjs'`。

### `scripts\scan.ps1` —— PowerShell 备选实现

纯 PowerShell 版（不依赖 Node 做扫描，只分析时才调 `analyze.mjs`），适合不允许装 Node 的场景：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$S\scan.ps1" -Target C: -Report -Top 10
```

参数与 `scan.mjs` 基本对应（`-Target/-Out/-Reuse/-Report/-Key/-Top/-Prefix/-Dups/-MinSizeMB/-Open/-UseUserConfig/-Exe/-TimeoutSec`）。

## 报告长这样

```text
## WizTree 磁盘占用报告

- 目标: `C:\`
- 文件夹: 230179 个 | 文件: 1377577 个
- 总大小: 856.2 GB | 实际占盘: 851.9 GB
- 卷容量: 930.6 GB | 已用: 862.6 GB | 可用: 68.2 GB | 保留: 0 B

### 最大文件 Top 3
1. **36.3 GB**  `C:\pagefile.sys`
2. **12.4 GB**  `C:\some\big-file.bin`
3. **8.1 GB**   `C:\some\other.bin`

### 文件夹独占占用 Top 3（不含子文件夹）
1. **177.0 GB**  `C:\Games\<游戏 A>\`  (1234 文件 / 156 子目录)
2. **63.2 GB**   `C:\Users\<user>\AppData\Local\<应用>\`  (8901 文件 / 402 子目录)
3. **41.7 GB**   `C:\Windows\WinSxS\`  (98765 文件 / 321 子目录)

### 文件类型 Top 3
1. 312.4 GB  .pak  (842 个, 占盘 310.1 GB)
2. 44.0 GB   .log  (12043 个, 占盘 44.0 GB)
3. 36.3 GB   .sys  (312 个, 占盘 36.3 GB)
```

`stats.selfCheck` 是免费的自检：等于 `ok` 说明「根行递归总计 == 所有文件行之和」，
CSV 完整可信；否则说明导出被截断或格式意外（markdown 里也会打警告）。

## 硬规则（值得单独抄走的部分）

1. **绝不把导出 CSV 读进上下文** —— 整盘 CSV 实测 262 MB / 138 万行，某些大目录导出也有 68 MB。
   一律走分析器，它流式处理并把结果压成几十行。
2. **不要用 `/admin=1`** —— 加上它 WizTree 会 0.2 秒静默退出且**不生成任何文件**（退出码仍是 0）。
   本机不需要提权即可扫描。
3. **不要用退出码判断成功** —— WizTree 退出码恒为 0，连目标不存在也是 0。
   唯一判据是「**CSV 是否真的生成且非空**」（脚本已内建该校验并在失败时报错）。
4. **不要把文件路径当扫描目标** —— 传 CSV 路径会让 WizTree 打开 GUI 并把它当数据源（`--open` 才是这个用途）。
5. **只读分析，不自动删除** —— 永远不要建议删 `pagefile.sys`、`hiberfil.sys`、`C:\Windows\WinSxS`、
   `System Volume Information`、`$Recycle.Bin` 里的系统项。
6. **重复文件是启发式候选** —— 「同名 + 同大小」，**不是哈希校验**；同名 DLL 多为不同软件各自的运行时，删了会坏。
7. **别用 PowerShell 的 `>` 存 JSON** —— Windows PowerShell 5.1 会写成 UTF-16 导致读不回来，用 `cmd /c "..." > out.json`。

## 结果怎么解读

- **`size` vs `allocated`**：`size` 是文件逻辑大小，`allocated` 是实际占盘（簇对齐）。
  回收站、压缩、稀疏文件、VHD 上两者可能差很多，判断"删了能回收多少"要看 `allocated`。
- **「文件夹独占占用」= 该目录递归总计 − 其子文件夹递归总计**，即**这一层自己的体积**。
  报的是这一层，不是整棵子树 —— 所以它才是"该动哪个目录"的答案。
  （注意不要减掉直属文件，直属文件正是这个目录自己的占用。）
- **`pagefile.sys` 常是"最大文件"第一名**（实测 36.3 GB），这是**正常的**，要主动解释而不是建议删。
- **重复文件**给出结论时必须说明是启发式候选，且同一软件的多个版本目录（如浏览器/启动器的多份 `libcef.dll`）通常**不能删**。
- 目录行的"大小/分配/文件/文件夹"都是**递归总计**，CSV 是**先序深度优先**展开的树（解析细节见
  [references/csv-format.md](references/csv-format.md)）。

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| 报「WizTree 未生成 CSV」 | 目标不可访问 / 被系统保护，或误加了 `/admin=1`；换目标或去掉该参数 |
| 找不到 `WizTree64.exe` | 装在非标准位置；用 `--exe "D:\...\WizTree64.exe"` 指定 |
| 报告数字明显偏小 | 无提权时系统保护区（WinSxS、部分 AppData）可能统计不全，这是 WizTree 的已知行为 |
| 扫描卡住 | 网络盘 / USB / 被独占的卷很慢；用 `--timeout 60` 限制，或改扫子目录 |
| 想扫 `D:` 等其它盘 | 直接换目标即可；先确认该盘已挂载（`Get-PSDrive -PSProvider FileSystem`） |
| `selfCheck` 不是 `ok` | CSV 被截断或 WizTree 格式变了；重扫一次，若仍 MISMATCH 请提 issue |
| `.ps1` 跑不动 | 执行策略禁止；改用 `scan.mjs`，或加 `-ExecutionPolicy Bypass`（改这个 .ps1 时必须保持 UTF-8 **带 BOM**） |

更多实战配方见 [references/recipes.md](references/recipes.md)；命令行实测记录（含坑）见 [references/cli.md](references/cli.md)。

## 安全红线

- 本 skill **只读**：只做扫描、统计与建议，从不删除、移动或写入用户文件（除了导出 CSV 与隔离配置目录）。
- 任何清理动作都必须先把「**路径 + 体积 + 后果**」摆给用户，得到**明确确认**再执行。
- 永远不要建议删：`pagefile.sys`、`hiberfil.sys`、`swapfile.sys`、`C:\Windows\WinSxS`、
  `System Volume Information`、`$Recycle.Bin` 里的系统项、`C:\Windows\Installer`。
- 导出的 CSV 含完整文件清单（**路径可能包含用户名等个人信息**），属于敏感本地数据：
  已在 [.gitignore](.gitignore) 里排除 `*.csv` / `report.json`，也请不要粘贴进对话或提交到仓库。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `SKILL.md` | skill 主说明：何时用、三步流程、硬规则、结果解读、排错表 |
| `scripts\scan.mjs` | **主入口**：扫描 + 可选报告 |
| `scripts\analyze.mjs` | 流式分析已有 CSV，也可 `import` 复用 |
| `scripts\scan.ps1` | PowerShell 备选实现（需 `-ExecutionPolicy Bypass`，且必须保持 UTF-8 带 BOM） |
| `references\cli.md` | WizTree 命令行实测记录：哪些开关有效、哪些是坑（含 `/admin=1` 静默失败） |
| `references\csv-format.md` | 导出 CSV 的列定义、递归语义与解析陷阱 |
| `references\recipes.md` | 实战配方、GUI 玩法、安全红线 |

## English summary

A Windows disk-usage analysis **skill for AI agents**, built on [WizTree](https://diskanalyzer.com)'s
command-line export. WizTree scans the NTFS MFT and dumps a full CSV (a whole `C:` drive: ~30 s, 262 MB,
1.38 M rows); `scripts/analyze.mjs` then streams that CSV into a compact report — top files, per-folder
*exclusive* usage, extension breakdown, duplicate candidates, age distribution — so the raw CSV never
enters the model's context.

```powershell
node scripts/scan.mjs "C:" --out "$env:TEMP\wiztree\c.csv" --report --top 15
node scripts/scan.mjs "C:" --out "$env:TEMP\wiztree\c.csv" --reuse --report --dups --min-size 100
node scripts/analyze.mjs "D:\export.csv" --top 20 --key allocated --age
```

Read-only by design: it never deletes anything, and it refuses to judge success by WizTree's exit code
(always 0) — only a non-empty CSV counts. Requires Windows, WizTree 4.x and Node 16+.

## 许可与致谢

本仓库以 [GNU Affero General Public License v3.0 or later](LICENSE)（AGPL-3.0-or-later）许可发布，即许可第 3 版或（由你选择）任何更新版本；Copyright (C) 2026 GuHan-OvO。

[WizTree](https://diskanalyzer.com) 是 **Antibody Software** 的独立产品，本仓库**不含**其任何二进制文件；
`references/` 里的命令行行为与 CSV 格式结论均来自对 WizTree **4.32** 导出的实测。
