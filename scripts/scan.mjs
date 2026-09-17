#!/usr/bin/env node
/*
 * scan.mjs - 用 WizTree 命令行扫描并（可选）直接输出报告。本 skill 的主入口。
 *
 * 用法:
 *   node scan.mjs <目标> [选项]
 *
 * 目标: 盘符（C:）或文件夹路径。不要传文件路径。
 *
 * 选项:
 *   --out <csv>        导出 CSV 路径（默认 %TEMP%\wiztree\<名称>-<时间戳>.csv）
 *   --reuse            若 --out 已存在且非空，直接复用，不重新扫描
 *   --report           扫描后直接打印分析报告（默认不打印，只给 CSV 路径）
 *   --key size|allocated   报告排序键（默认 size 逻辑大小；allocated 为实际占盘）
 *   --top N            报告各榜单条数（默认 10）
 *   --prefix <path>    报告只看该前缀下的条目
 *   --dups             报告附加"同名同大小"重复文件候选
 *   --min-size <MB>    --dups 时忽略小于该值的文件
 *   --age              报告附加按修改年份分布
 *   --json             以 JSON 输出报告（便于程序处理）
 *   --open             扫描后用 WizTree GUI 打开该 CSV（不重新扫描）
 *   --user-config      不隔离配置（默认用 /configfolder 隔离，避免污染 GUI 设置）
 *   --exe <path>       指定 WizTree64.exe
 *   --timeout <秒>     扫描超时（默认 900）
 *
 * 已实测（WizTree 4.32 / Windows / 本机）:
 *   - WizTree64.exe "<目标>" /export="<csv>" 无窗口跑完并自行退出。
 *   - 无需提权即可读 MFT：整盘 C:（约 86 万 MB 已用、137 万文件）约 30 秒。
 *   - /export 目标已存在会静默覆盖；退出码恒为 0（目标不存在也是 0），
 *     所以成功与否只能靠"CSV 是否真的生成"判断。
 *   - 不要加 /admin=1：实测立即退出且不生成文件。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { analyze, printMarkdown } from './analyze.mjs';

const EXE_CANDIDATES = [
  'C:\\software\\tool\\WizTree\\WizTree64.exe',
  'C:\\Program Files\\WizTree\\WizTree64.exe',
  'C:\\Program Files (x86)\\WizTree\\WizTree64.exe',
];

function findExe(explicit) {
  const cands = explicit ? [explicit, ...EXE_CANDIDATES] : EXE_CANDIDATES;
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  // PATH 查找
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of pathDirs) {
    const p = path.join(d, 'WizTree64.exe');
    try { if (fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
  }
  throw new Error('找不到 WizTree64.exe。请用 --exe 指定，或安装 WizTree（https://diskanalyzer.com）。');
}

function parseArgs(argv) {
  const o = {
    target: null, out: null, reuse: false, report: false, key: 'size', top: 10,
    prefix: null, dups: false, minSizeMB: 0, age: false, json: false, open: false,
    userConfig: false, exe: null, timeout: 900,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') o.out = next();
    else if (a === '--reuse') o.reuse = true;
    else if (a === '--report') o.report = true;
    else if (a === '--key') o.key = next();
    else if (a === '--top') o.top = parseInt(next(), 10);
    else if (a === '--prefix') o.prefix = next();
    else if (a === '--dups') o.dups = true;
    else if (a === '--min-size') o.minSizeMB = parseFloat(next());
    else if (a === '--age') o.age = true;
    else if (a === '--json') o.json = true;
    else if (a === '--open') o.open = true;
    else if (a === '--user-config') o.userConfig = true;
    else if (a === '--exe') o.exe = next();
    else if (a === '--timeout') o.timeout = parseInt(next(), 10);
    else if (a.startsWith('--')) throw new Error('未知选项: ' + a);
    else if (!o.target) o.target = a;
    else throw new Error('只能指定一个目标（收到额外参数: ' + a + '）');
  }
  if (!o.target) {
    throw new Error('用法: node scan.mjs <盘符或文件夹> [--report] [--out file.csv] [--top N] [--dups] [--json] ...');
  }
  return o;
}

function defaultOut(target) {
  const safe = target.replace(/[\\/:*?"<>|]/g, '_').replace(/^_+|_+$/g, '') || 'scan';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return path.join(os.tmpdir(), 'wiztree', `${safe}-${stamp}.csv`);
}

function runWizTree(exe, args, timeoutSec) {
  return new Promise((resolve, reject) => {
    // stdio: 'ignore' —— 不建立管道，兼容受限沙箱，也让 WizTree 无法弹窗阻塞我们的读取
    const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    const started = Date.now();
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`扫描超过 ${timeoutSec} 秒仍未完成，已终止 WizTree。可用 --timeout 调整。`));
    }, timeoutSec * 1000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, seconds: (Date.now() - started) / 1000 });
    });
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));

  let st;
  try { st = fs.statSync(o.target); }
  catch { throw new Error(`目标不存在: ${o.target}`); }
  if (!st.isDirectory()) {
    throw new Error(`目标是文件而不是文件夹/盘符: ${o.target}。WizTree 只扫描目录；传 CSV 路径只会打开 GUI（用 --open 才是有意为之）。`);
  }

  const out = path.resolve(o.out || defaultOut(o.target));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  let ready = false;
  if (o.reuse && fs.existsSync(out) && fs.statSync(out).size > 0) ready = true;
  if (!ready && fs.existsSync(out)) fs.rmSync(out, { force: true });

  if (!ready) {
    // 只有真的要扫描时才要求 WizTree 存在：--reuse 分析已有 CSV 时本机可以没装 WizTree
    const exe = findExe(o.exe);
    const args = [o.target];
    if (!o.userConfig) {
      const cfg = path.join(process.env.LOCALAPPDATA || os.homedir(), 'WizTree3-skill-cfg');
      fs.mkdirSync(cfg, { recursive: true });
      args.push(`/configfolder=${cfg}`);
    }
    args.push(`/export=${out}`);

    process.stderr.write(`扫描中: ${o.target}  ->  ${out}\n`);
    const { code, seconds } = await runWizTree(exe, args, o.timeout);

    if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
      throw new Error(
        `WizTree 未生成 CSV（退出码 ${code}，耗时 ${seconds.toFixed(1)}s）。` +
        `退出码恒为 0，不能作为成功依据。常见原因：目标不可访问、被系统保护、或参数写法有误（例如误加 /admin=1，实测会直接失败且不产出文件）。`
      );
    }
    process.stderr.write(`完成: 耗时 ${seconds.toFixed(1)}s, CSV ${(fs.statSync(out).size / 1048576).toFixed(1)} MB\n`);
  } else {
    process.stderr.write(`复用已有 CSV: ${out}\n`);
  }

  process.stderr.write(`CSV: ${out}\n`);

  if (o.open) {
    const exe = findExe(o.exe); // 用 GUI 打开时需要 WizTree 本体
    const child = spawn(exe, [out], { stdio: 'ignore', detached: true, windowsHide: false });
    child.unref();
    process.stderr.write('已用 WizTree GUI 打开该 CSV（数据来自文件，未重新扫描）。\n');
  }

  if (o.report) {
    const result = await analyze({
      file: out,
      format: o.json ? 'json' : 'md',
      topFiles: o.top, topDirs: o.top, topExt: o.top,
      key: o.key, prefix: o.prefix, dups: o.dups, age: o.age,
      minSize: Math.round((o.minSizeMB || 0) * 1048576),
    });
    if (o.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else printMarkdown(result);
  }
}

main().catch((err) => {
  process.stderr.write('scan.mjs 失败: ' + err.message + '\n');
  process.exit(1);
});
