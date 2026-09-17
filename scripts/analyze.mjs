#!/usr/bin/env node
/*
 * analyze.mjs - 流式解析 WizTree /export= 导出的 CSV，输出紧凑报告。
 *
 * 用法:
 *   node analyze.mjs <file.csv> [选项]
 *
 * 选项:
 *   --format md|json|text   输出格式（默认 md）
 *   --top N                 各榜单条数（文件/文件夹/扩展名统一设为 N）
 *   --top-files/--top-dirs/--top-ext N   分别设置
 *   --key size|allocated    排序键（默认 size 逻辑大小；allocated 为占盘大小）
 *   --prefix <path>         只看该路径下的条目（如 D:\Games）
 *   --dups                  找出"同名同大小"的重复文件候选
 *   --min-size <bytes>      --dups 时忽略小于该值的文件
 *   --age                   附加按修改年份的分布
 *
 * CSV 事实（在 WizTree 4.32 /export 导出上实测）:
 *   - UTF-8 带 BOM；第 1 行是 "生成由 WizTree ..." 注释行。
 *   - 第 2 行是表头: 文件名称,大小,分配,修改时间,属性,文件,文件夹[,DRIVECAPACITY,...]
 *   - 文件夹行的路径以反斜杠结尾，其"大小/分配/文件/文件夹"是递归总计（含所有子孙）。
 *   - 仅根行额外带 DRIVECAPACITY/FREESPACE/USEDSPACE/RESERVEDSPACE。
 *   - 文件行最后两列（文件/文件夹）为 0,0。
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const opts = {
    format: 'md', topFiles: 10, topDirs: 15, topExt: 15,
    key: 'size', dups: false, age: false, prefix: null, minSize: 0,
  };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--format') opts.format = next();
    else if (a === '--json') opts.format = 'json';
    else if (a === '--md') opts.format = 'md';
    else if (a === '--top') { const n = parseInt(next(), 10); opts.topFiles = n; opts.topDirs = n; opts.topExt = n; }
    else if (a === '--top-files') opts.topFiles = parseInt(next(), 10);
    else if (a === '--top-dirs') opts.topDirs = parseInt(next(), 10);
    else if (a === '--top-ext') opts.topExt = parseInt(next(), 10);
    else if (a === '--key') opts.key = next();
    else if (a === '--prefix') opts.prefix = next();
    else if (a === '--min-size') opts.minSize = parseInt(next(), 10) || 0;
    else if (a === '--dups') opts.dups = true;
    else if (a === '--age') opts.age = true;
    else if (a.startsWith('--')) throw new Error('未知选项: ' + a);
    else files.push(a);
  }
  if (files.length !== 1) throw new Error('用法: node analyze.mjs <file.csv> [选项]');
  opts.file = files[0];
  if (opts.key !== 'size' && opts.key !== 'allocated') throw new Error('--key 只能是 size 或 allocated');
  return opts;
}

// 遵循双引号与 "" 转义的最小 CSV 分词器
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function fmtBytes(n) {
  const v0 = Number(n);
  if (!isFinite(v0)) return '-';
  const neg = v0 < 0;
  let v = Math.abs(v0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  const s = (u === 0) ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1);
  return (neg ? '-' : '') + s + ' ' + units[u];
}

// 有界 top-N：维持一个以 key 升序的最小堆（用数组 + 常规排序，N 很小，足够快）
function pushTop(heap, item, limit, key) {
  if (limit <= 0) return;
  if (heap.length < limit) {
    heap.push(item);
    heap.sort((a, b) => a[key] - b[key]);
    return;
  }
  if (item[key] > heap[0][key]) {
    heap[0] = item;
    heap.sort((a, b) => a[key] - b[key]);
  }
}

function dirOfFile(path) {
  const idx = path.lastIndexOf('\\');
  return idx >= 0 ? path.slice(0, idx + 1) : '';
}

function isAncestor(folderPathWithSlash, childDirWithSlash) {
  return childDirWithSlash === folderPathWithSlash || childDirWithSlash.startsWith(folderPathWithSlash);
}

async function analyze(opts) {
  const rl = createInterface({ input: createReadStream(opts.file, { encoding: 'utf8' }), crlfDelay: Infinity });

  let lineNo = 0;
  let headerSeen = false;
  let badLines = 0;
  let unattributed = 0;
  let rootDirect = null;
  let root = null;

  const totals = { files: 0, dirs: 0, size: 0n, allocated: 0n, zeroByte: 0 };
  const fileTop = { size: [], allocated: [] };
  const dirTop = { size: [], allocated: [] };
  const extMap = new Map();   // 小写扩展名(无点)或 '' -> {count,size,allocated}
  const ageMap = new Map();   // 年份 -> {count,size}
  const dupMap = new Map();   // size|小写文件基名 -> [{path,size,allocated}]
  const stack = [];

  function finalize(folder) {
    if (folder.isRoot) {
      // 根节点只是栈基准；单独记录"根目录直属文件"合计，
      // 这样扫描一个只含直属文件、没有子目录的文件夹时也有可用信息。
      let rs = folder.size - folder.childFoldersSize;
      if (rs < 0n) rs = 0n;
      rootDirect = Number(rs);
      return;
    }
    // 独占占用 = 该文件夹递归总计 - 其子文件夹递归总计。
    // 注意：不能减掉"直属文件"，直属文件正是该文件夹自身的占用。
    let exclSize = folder.size - folder.childFoldersSize;
    let exclAlloc = folder.allocated - folder.childFoldersAlloc;
    if (exclSize < 0n) exclSize = 0n;
    if (exclAlloc < 0n) exclAlloc = 0n;
    const item = {
      path: folder.path,
      size: Number(exclSize),
      allocated: Number(exclAlloc),
      files: folder.files,
      folders: folder.folders,
    };
    pushTop(dirTop.size, item, opts.topDirs, 'size');
    pushTop(dirTop.allocated, item, opts.topDirs, 'allocated');
  }

  for await (const rawLine of rl) {
    lineNo++;
    let line = rawLine;
    if (lineNo === 1 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    if (!line) continue;

    const f = parseCsvLine(line);

    if (!headerSeen) {
      const first = (f[0] || '').trim();
      if (first === '文件名称' || first === 'File Name') { headerSeen = true; continue; }
      // 生成器注释行 / 其它非表头行：只有确实像数据行时才继续当作数据
      if (f.length >= 6 && /^\d+$/.test((f[1] || '').trim())) headerSeen = true;
      else continue;
    }

    if (f.length < 6) { badLines++; continue; }

    const path = (f[0] || '').trim();
    if (!path) continue;
    if (opts.prefix && !path.toLowerCase().startsWith(opts.prefix.toLowerCase())) continue;

    let size, allocated;
    try {
      size = BigInt((f[1] || '0').trim() || '0');
      allocated = BigInt((f[2] || '0').trim() || '0');
    } catch {
      badLines++;
      continue;
    }

    const isDir = path.endsWith('\\');
    const isRootRow = f.length >= 11 && f[7] !== '' && f[7] !== undefined;

    if (isRootRow && isDir) {
      // 根行的 size/allocated 是整棵树的递归总计（= 所有文件行之和），
      // 因此绝不能累加进 totals，否则总量会翻倍。
      root = {
        path,
        capacity: BigInt((f[7] || '0').trim() || '0'),
        free: BigInt((f[8] || '0').trim() || '0'),
        used: BigInt((f[9] || '0').trim() || '0'),
        reserved: BigInt((f[10] || '0').trim() || '0'),
        size,
        allocated,
      };
      // 不把根行计入 folders：WizTree 自身的"文件夹"列也不含被扫描的根目录本身
      // 压栈作为基准节点：这样"根目录直属文件"的归属计算才成立；
      // finalize() 会跳过 isRoot 节点，不把它当成一个可报告的文件夹。
      stack.push({
        path,
        size,
        allocated,
        files: parseInt(f[5] || '0', 10) || 0,
        folders: parseInt(f[6] || '0', 10) || 0,
        childFoldersSize: 0n,
        childFoldersAlloc: 0n,
        isRoot: true,
      });
      continue;
    }

    if (isDir) {
      totals.dirs++;
      while (stack.length && !isAncestor(stack[stack.length - 1].path, path)) finalize(stack.pop());
      const node = {
        path,
        size,
        allocated,
        files: parseInt(f[5] || '0', 10) || 0,
        folders: parseInt(f[6] || '0', 10) || 0,
        childFoldersSize: 0n,
        childFoldersAlloc: 0n,
      };
      if (stack.length) {
        stack[stack.length - 1].childFoldersSize += size;
        stack[stack.length - 1].childFoldersAlloc += allocated;
      }
      stack.push(node);
      continue;
    }

    // 文件行
    totals.files++;
    totals.size += size;
    totals.allocated += allocated;
    if (size === 0n) totals.zeroByte++;

    const parentDir = dirOfFile(path);
    while (stack.length && !isAncestor(stack[stack.length - 1].path, parentDir)) finalize(stack.pop());
    if (!stack.length) unattributed++; // 例如按 --prefix 过滤时，父目录行不在结果集中

    const sNum = Number(size);
    const aNum = Number(allocated);
    const item = { path, size: sNum, allocated: aNum };
    pushTop(fileTop.size, item, opts.topFiles, 'size');
    pushTop(fileTop.allocated, item, opts.topFiles, 'allocated');

    const leaf = path.slice(path.lastIndexOf('\\') + 1);
    const dot = leaf.lastIndexOf('.');
    const extKey = dot > 0 ? leaf.slice(dot + 1).toLowerCase() : '';
    let e = extMap.get(extKey);
    if (!e) { e = { count: 0, size: 0n, allocated: 0n }; extMap.set(extKey, e); }
    e.count++; e.size += size; e.allocated += allocated;

    if (opts.age) {
      const y = (f[3] || '').trim().slice(0, 4);
      if (/^\d{4}$/.test(y)) {
        let a = ageMap.get(y);
        if (!a) { a = { count: 0, size: 0n }; ageMap.set(y, a); }
        a.count++; a.size += size;
      }
    }

    if (opts.dups && size > 0n && Number(size) >= opts.minSize) {
      const key = size.toString() + '|' + leaf.toLowerCase();
      let arr = dupMap.get(key);
      if (!arr) { arr = []; dupMap.set(key, arr); }
      if (arr.length < 40) arr.push(item);
    }
  }
  while (stack.length) finalize(stack.pop());

  const byDesc = (arr, key) => arr.slice().sort((a, b) => b[key] - a[key]);

  const extensions = byDesc(Array.from(extMap.entries()).map(([k, v]) => ({
    name: k === '' ? '(无扩展名)' : '.' + k,
    count: v.count,
    size: Number(v.size),
    allocated: Number(v.allocated),
  })), 'size').slice(0, opts.topExt);

  let duplicates = null;
  if (opts.dups) {
    duplicates = [];
    for (const [key, arr] of dupMap) {
      if (arr.length < 2) continue;
      const size = Number(key.split('|')[0]);
      duplicates.push({ size, count: arr.length, paths: arr.map(x => x.path).slice(0, 12) });
      if (duplicates.length >= 400) break;
    }
    duplicates.sort((a, b) => b.size * b.count - a.size * a.count);
    duplicates = duplicates.slice(0, 12).map(d => ({ ...d, reclaimable: d.size * (d.count - 1) }));
  }

  return {
    file: opts.file,
    key: opts.key,
    target: root ? root.path : (opts.prefix || '(未知)'),
    stats: {
      folders: totals.dirs,
      files: totals.files,
      totalSize: fmtBytes(totals.size),
      totalAllocated: fmtBytes(totals.allocated),
      totalSizeBytes: Number(totals.size),
      totalAllocatedBytes: Number(totals.allocated),
      drive: root ? {
        capacity: fmtBytes(root.capacity),
        used: fmtBytes(root.used),
        free: fmtBytes(root.free),
        reserved: fmtBytes(root.reserved),
      } : null,
      zeroByteFiles: totals.zeroByte,
      malformedLines: badLines,
      unattributedFiles: unattributed,
      rootDirectSize: rootDirect === null ? null : fmtBytes(rootDirect),
      rootRecursiveSize: root ? fmtBytes(root.size) : null,
      selfCheck: root && Number(root.size) === Number(totals.size) ? 'ok' : (root ? 'MISMATCH(root行 vs 文件求和)' : 'no-root-row'),
    },
    topFiles: byDesc(fileTop[opts.key], 'size').map(x => ({
      path: x.path, size: fmtBytes(x.size), allocated: fmtBytes(x.allocated), sizeBytes: x.size,
    })),
    topFolders: byDesc(dirTop[opts.key], 'size').map(x => ({
      path: x.path, exclusiveSize: fmtBytes(x.size), sizeBytes: x.size, files: x.files, folders: x.folders,
    })),
    extensions: extensions.map(x => ({ name: x.name, count: x.count, size: fmtBytes(x.size), allocated: fmtBytes(x.allocated) })),
    age: opts.age ? byDesc(Array.from(ageMap.entries()).map(([y, v]) => ({ year: y, count: v.count, size: Number(v.size) })), 'size')
      .slice(0, 12)
      .map(x => ({ year: x.year, count: x.count, size: fmtBytes(x.size) })) : null,
    duplicates: duplicates ? duplicates.map(d => ({ size: fmtBytes(d.size), count: d.count, reclaimable: fmtBytes(d.reclaimable), paths: d.paths })) : null,
  };
}

function printMarkdown(o) {
  const L = [];
  L.push('## WizTree 磁盘占用报告');
  L.push('');
  L.push(`- 目标: \`${o.target}\``);
  L.push(`- 文件夹: ${o.stats.folders} 个 | 文件: ${o.stats.files} 个`);
  L.push(`- 总大小: ${o.stats.totalSize} | 实际占盘: ${o.stats.totalAllocated}`);
  if (o.stats.drive) {
    L.push(`- 卷容量: ${o.stats.drive.capacity} | 已用: ${o.stats.drive.used} | 可用: ${o.stats.drive.free} | 保留: ${o.stats.drive.reserved}`);
  }
  if (o.stats.zeroByteFiles) L.push(`- 零字节文件: ${o.stats.zeroByteFiles} 个`);
  if (o.stats.rootDirectSize) L.push(`- 根目录直属文件合计: ${o.stats.rootDirectSize}（散落在扫描根目录、不在任何子文件夹里）`);
  if (o.stats.selfCheck && o.stats.selfCheck !== 'ok' && o.stats.selfCheck !== 'no-root-row') {
    L.push(`- ⚠️ 自检异常: ${o.stats.selfCheck}（根行递归总计 ${o.stats.rootRecursiveSize}）`);
  }
  if (o.stats.malformedLines) L.push(`- ⚠️ 跳过无法解析的行: ${o.stats.malformedLines}`);
  if (o.stats.unattributedFiles) L.push(`- 注: ${o.stats.unattributedFiles} 个文件未归属到任何文件夹（父目录行不在结果集内）`);
  L.push('');

  L.push(`### 最大文件 Top ${o.topFiles.length}`);
  o.topFiles.forEach((x, i) => L.push(`${i + 1}. **${x.size}**  \`${x.path}\``));
  L.push('');

  L.push(`### 文件夹独占占用 Top ${o.topFolders.length}（不含子文件夹）`);
  o.topFolders.forEach((x, i) => L.push(`${i + 1}. **${x.exclusiveSize}**  \`${x.path}\`  (${x.files} 文件 / ${x.folders} 子目录)`));
  L.push('');

  L.push(`### 文件类型 Top ${o.extensions.length}`);
  o.extensions.forEach((x, i) => L.push(`${i + 1}. ${x.size}  ${x.name}  (${x.count} 个, 占盘 ${x.allocated})`));
  L.push('');

  if (o.age) {
    L.push('### 按修改年份分布');
    o.age.forEach(x => L.push(`- ${x.year}: ${x.size} (${x.count} 个)`));
    L.push('');
  }
  if (o.duplicates && o.duplicates.length) {
    L.push('### 重复文件候选（同名同大小）');
    o.duplicates.forEach(g => {
      L.push(`- ${g.size} × ${g.count}（可回收约 ${g.reclaimable}）`);
      g.paths.forEach(p => L.push(`  - \`${p}\``));
    });
    L.push('');
  }
  console.log(L.join('\n'));
}

export { analyze, printMarkdown, parseArgs };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await analyze(opts);
  if (opts.format === 'json') console.log(JSON.stringify(result, null, 2));
  else if (opts.format === 'text') {
    console.log(`${result.target}: ${result.stats.files} 文件 / ${result.stats.folders} 文件夹, 总计 ${result.stats.totalSize}`);
    result.topFiles.forEach((x, i) => console.log(`${i + 1}. ${x.size}  ${x.path}`));
  } else printMarkdown(result);
}

// 仅在被直接执行时作为 CLI 运行；被 scan.mjs import 时只导出函数。
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error('analyze.mjs 失败: ' + err.message);
    process.exit(1);
  });
}
