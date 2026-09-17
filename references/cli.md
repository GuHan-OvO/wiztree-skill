# WizTree 命令行：实测记录

环境：WizTree **4.32**，Windows 11，
中文界面（`WizTree3.ini` 里 `Language=zh_CHS`），2026-09 实测。
以下每条都经过实际运行验证，未验证的会明确标注。

## 已验证有效的调用形式

```
WizTree64.exe "<目标>" /export="<输出.csv>"
WizTree64.exe "<目标>" /configfolder="<配置目录>" /export="<输出.csv>"
```

| 行为 | 实测结果 |
| --- | --- |
| 进程是否弹窗 | **不弹**。无窗口、无对话框，跑完自行退出 |
| 是否需要提权 | **不需要**。当前用户属 Administrators，未提权直接扫整盘 C: |
| 整盘 C: 耗时 | 约 **29.8 s**（863 GB 已用 / 1,377,577 文件 / 230,179 文件夹）→ CSV **262 MB** |
| `C:\Projects`（39 万文件）耗时 | 约 **7.4 s** → CSV **68 MB** |
| 重复导出到同名文件 | **静默覆盖**，不弹"文件已存在"确认框 |
| 退出码 | **恒为 0**，目标不存在也是 0 → 不能作为成功判据 |
| 目标不存在（如 `Z:\nope`） | 0.2 s 退出，**不生成文件**，退出码仍 0 |
| CSV 编码 | **UTF-8 带 BOM**（`EF BB BF`） |
| 命令行配置隔离 | `/configfolder=<目录>` 生效：在指定目录创建/使用 `WizTree3.ini`，不动用户原设置 |

### 耗时参考（决定该怎么用）

| 目标 | 规模 | 耗时 | CSV |
| --- | --- | --- | --- |
| 单目录 `<WizTree 安装目录>` | 69 文件 | <1 s | 12 KB |
| `C:\Projects` | 39 万文件 | 7.4 s | 68 MB |
| `C:` 整盘 | 138 万文件 | 29.8 s | 262 MB |

结论：**整盘扫描完全可以直接做**，不必先缩范围。真正需要小心的是"别把 CSV 读进上下文"。

## 明确是坑的参数

| 参数 | 实测结果 | 结论 |
| --- | --- | --- |
| `/admin=1` | 0.2 s 退出，退出码 0，**不生成任何文件** | **禁用**。本机不需要提权，加了反而静默失败 |
| 传文件路径作目标 | 不导出，改为打开 GUI 显示该文件（CSV 会被当数据源载入） | 别把文件当目标；要开 GUI 才用 `--open` |

> `/admin=1` 的语义来自 WizTree 的 "Always Run as Administrator" 设置项，不是命令行导出开关。
> 网上流传的命令行示例里偶见此参数，在本版本上会导致导出静默失败。

## 从二进制里挖出的其它开关（未验证）

对 `WizTree64.exe` 做字符串提取，除 `configfolder` 外还发现这三个参数名：

```
/substlist=
/networklist=
/runningas
```

它们出现在 "Restarting with 64 bit version" / "RunAs" 附近，判断是 WizTree **自身重启为实现提权时内部传递**的参数
（把 SUBST 盘、网络盘列表和新身份传给重启后的实例），**不是给外部用户用的**。
没有实测，不要依赖。

同时确认了内部选择类型常量：`DT_SUBST`、`DT_NETWORK`、`DT_FOLDER`、`DT_MFTFILE`、`DT_CSVFILE`、`DT_MULTIPLE` —— 
说明 WizTree 支持把 CSV 文件当作扫描数据源（这正是"传 CSV 打开 GUI"能成立的原因）。

## 版本差异提醒

WizTree 的图形功能（树图 PNG 导出、文件类型 CSV、过滤器、重复查找）**没有命令行等价物**，
只能通过 GUI 操作。命令行能做的核心只有一件：**扫描 + 导出全量 CSV** —— 这也正是自动化最需要的部分。

## 主程序 32/64 位引导行为
`WizTree.exe`（32 位）带参数启动时会**自行退出**，真正的 GUI 跑在它拉起的 `WizTree64.exe` 子进程里
（对应字符串 "Restarting with 64 bit version"）。所以：

- 想抓窗口做自动化时，盯着启动的那个进程会误判为"秒退"；
- **直接调用 `WizTree64.exe` 更省事**（`scan.mjs` 就是这么做的）；
- 用 `Get-Process WizTree*` 观察真实状态。

## 维护提醒（踩过的坑）

### `scan.ps1` 必须是 UTF-8 **带 BOM**

本机 Windows PowerShell 5.1 在读取**无 BOM** 的 .ps1 时按系统 ANSI（本机 GBK）解码。
脚本里有中文，结果中文被解成乱码、引号错位，直接抛一堆语法错误：

```
Unexpected token '鎵句笉鍒?node锛坅nalyze.mjs' in expression or statement.
```

修复：保证文件头三字节是 `EF BB BF`。转换命令：

```powershell
$p = "...\scripts\scan.ps1"
$t = [System.IO.File]::ReadAllText($p, [System.Text.UTF8Encoding]::new($false))
[System.IO.File]::WriteAllText($p, $t, [System.Text.UTF8Encoding]::new($true))
```

**注意**：如果用的编辑器/write 工具默认输出无 BOM UTF-8，重新保存会让这个坑复现。
`.mjs` 不受影响（Node 一律按 UTF-8 读）。

### 本机执行策略默认禁止 .ps1

所有作用域均为 `Undefined`（客户端默认 Restricted），因此 .ps1 需要显式 Bypass：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "...\scripts\scan.ps1" -Target C: -Report
```

这也是把 `scan.mjs` 作为主入口的原因 —— Node 不受执行策略限制。
