#!/usr/bin/env node
/**
 * 一键把引擎和模型下下来。
 *
 *   node scripts/setup.mjs                 # 引擎 + 模型，全部
 *   node scripts/setup.mjs --mirror        # 走 hf-mirror.com（国内快）
 *   node scripts/setup.mjs --models-only   # 只要模型
 *   node scripts/setup.mjs --engine-only   # 只要引擎
 *   node scripts/setup.mjs --dry-run       # 只说要下什么，不真下
 *   node scripts/setup.mjs --gpu vulkan    # 引擎换后端：cuda12(默认) / vulkan / cpu
 *
 * 已经下完的文件会跳过；下了一半的会续传（HTTP Range）。
 * 模型放 models/，引擎解压到 bin/。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const IS_WIN = process.platform === 'win32';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const mirror = has('--mirror') ? 'https://hf-mirror.com' : 'https://huggingface.co';
const gpu = val('--gpu', 'cuda12');
const dry = has('--dry-run');
const modelsDir = process.env.FISH_IMAGE_MODELS || path.join(ROOT, 'models');
const binDir = process.env.FISH_IMAGE_BIN || path.join(ROOT, 'bin');

const MODELS = [
  {
    name: '扩散主体',
    url: `${mirror}/abenzerps/Qwen-Image-2.1-Turbo-Quantized/resolve/main/qwen-image-2.1-turbo-Q4_K_M.gguf`,
    dest: path.join(modelsDir, 'qwen-image-2.1-turbo-Q4_K_M.gguf'),
    gb: 4.4,
  },
  {
    name: '文本编码器',
    url: `${mirror}/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_w4a8.safetensors`,
    dest: path.join(modelsDir, 'text_encoders', 'qwen3vl_8b_w4a8.safetensors'),
    gb: 5.9,
  },
  {
    name: 'VAE',
    url: `${mirror}/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors`,
    dest: path.join(modelsDir, 'vae', 'qwen_image_2.1_vae_bf16.safetensors'),
    gb: 0.7,
  },
];

const ENGINE_PATTERNS = {
  cuda12: { win: /bin-win-cuda12-x64\.zip$/, linux: /bin-Linux.*x86_64\.zip$/, mac: null },
  vulkan: { win: /bin-win-vulkan-x64\.zip$/, linux: /vulkan.*\.zip$/, mac: null },
  cpu: { win: /bin-win-cpu-x64\.zip$/, linux: /bin-Linux.*x86_64\.zip$/, mac: null },
}[gpu] || {};

const fmt = (n) => (n / 1024 ** 3).toFixed(2) + ' GB';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function head(url) {
  // 有的 CDN 不认 HEAD（返回 403/405），退一步用 Range: bytes=0-0 探长度
  for (const u of [url, 'https://gh-proxy.org/' + url]) {
    try {
      const r = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20000) });
      const len = Number(r.headers.get('content-length') || 0);
      if (r.ok && len) return { url: u, len };
    } catch {}
    try {
      const r = await fetch(u, { headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      if (r.ok || r.status === 206) {
        const cr = r.headers.get('content-range') || '';
        const m = /\/(\d+)\s*$/.exec(cr);
        const len = m ? Number(m[1]) : Number(r.headers.get('content-length') || 0);
        if (len) return { url: u, len };
      }
    } catch {}
  }
  return null;
}

/** 断点续传下载，返回最终路径 */
async function download({ name, url, dest, gb }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const exist = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  const probe = await head(url);
  if (!probe) throw new Error(`${name}：拿不到文件信息（网络或镜像问题）`);
  if (probe.len && exist === probe.len) {
    console.log(`  ✓ ${name} 已完整（${fmt(exist)}）`);
    return dest;
  }
  if (!probe.len) console.log(`  · ${name} 大小未知，直接下`);
  let offset = exist > 0 && probe.len ? exist : 0;
  if (offset) console.log(`  ↻ ${name} 续传，从 ${fmt(offset)} 开始`);
  else console.log(`  ↓ ${name}（约 ${gb} GB）`);

  const headers = offset ? { Range: `bytes=${offset}-` } : {};
  const res = await fetch(probe.url, { headers, redirect: 'follow', signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!res.ok && res.status !== 206) throw new Error(`${name}：HTTP ${res.status}`);
  if (offset && res.status !== 206) offset = 0;   // 服务器不认范围请求，从头来

  const out = fs.createWriteStream(dest, { flags: offset ? 'a' : 'w' });
  let got = offset;
  let last = Date.now();
  let lastBytes = got;
  const total = probe.len || 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (Date.now() - last > 2000) {
      const speed = (got - lastBytes) / 2 / 1024 / 1024;
      const pct = total ? ((got / total) * 100).toFixed(1) + '%' : fmt(got);
      process.stdout.write(`\r    ${name} ${pct}  ${fmt(got)}  ${speed.toFixed(1)} MB/s   `);
      last = Date.now();
      lastBytes = got;
    }
  }
  await new Promise((r) => out.end(r));
  process.stdout.write('\n');
  if (total && got !== total) throw new Error(`${name}：下完 ${got} 字节，应到 ${total}（重跑一次会续传）`);
  console.log(`  ✓ ${name} ${fmt(got)}`);
  return dest;
}

function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const cmd = IS_WIN
    ? ['powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`]]
    : ['unzip', ['-o', '-q', zip, '-d', dest]];
  const r = spawnSync(cmd[0], cmd[1], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('解压失败，手动解压：' + zip);
}

async function engine() {
  const pat = IS_WIN ? ENGINE_PATTERNS.win : process.platform === 'darwin' ? ENGINE_PATTERNS.mac : ENGINE_PATTERNS.linux;
  if (!pat) { console.log('这个平台没有现成发行包，请自行编译 stable-diffusion.cpp 放进 bin/'); return; }
  const local = path.join(binDir, IS_WIN ? 'sd-server.exe' : 'sd-server');
  if (fs.existsSync(local)) { console.log('  ✓ 引擎已在（' + local + '）'); return; }

  const api = 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest';
  let release = null;
  for (const u of [api, 'https://gh-proxy.org/' + api]) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'dsh-image-gen' }, signal: AbortSignal.timeout(20000) });
      if (r.ok) { release = await r.json(); break; }
    } catch {}
  }
  if (!release) throw new Error('拿不到 stable-diffusion.cpp 的发行信息');
  const asset = (release.assets || []).find((a) => pat.test(a.name));
  if (!asset) throw new Error('这个后端没有对应发行包：' + gpu);
  console.log(`  ↓ 引擎 ${asset.name}（约 ${Math.round(asset.size / 1024 / 1024)} MB）`);
  const zip = path.join(binDir, asset.name);
  fs.mkdirSync(binDir, { recursive: true });
  await download({ name: '引擎', url: asset.browser_download_url, dest: zip, gb: 0.4 });
  unzip(zip, binDir);
  fs.rmSync(zip, { force: true });
  console.log('  ✓ 引擎就绪');
}

const onlyModels = has('--models-only');
const onlyEngine = has('--engine-only');

console.log(`目标目录  models: ${modelsDir}`);
console.log(`          bin   : ${binDir}`);
console.log(`          镜像  : ${mirror}   后端: ${gpu}${dry ? '   [dry-run]' : ''}`);
console.log('');

if (dry) {
  if (!onlyModels) console.log('会下：stable-diffusion.cpp 的 ' + gpu + ' 发行包 → bin/');
  if (!onlyEngine) for (const m of MODELS) console.log(`会下：${m.name} ${fmt(m.gb * 1024 ** 3)} → ${m.dest}`);
  process.exit(0);
}

let failed = 0;
if (!onlyModels) {
  console.log('引擎');
  try { await engine(); } catch (e) { console.log('  ✗ ' + e.message); failed++; }
}
if (!onlyEngine) {
  console.log('模型');
  for (const m of MODELS) {
    try { await download(m); } catch (e) { console.log('  ✗ ' + e.message); failed++; }
  }
}

console.log('');
if (failed) { console.log(`${failed} 项没成功，重跑一次会续传。`); process.exit(1); }
console.log('都齐了。跑 node scripts/check.mjs 确认，然后重启 DSH。');
