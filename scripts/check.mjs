#!/usr/bin/env node
/**
 * 自检：模型、可执行文件、目录都到位没有。
 *   node scripts/check.mjs
 * 退出码 0 = 齐了，1 = 缺东西（会打印缺什么、去哪下）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const IS_WIN = process.platform === 'win32';

const modelsDir = process.env.FISH_IMAGE_MODELS || path.join(ROOT, 'models');
const binDir = process.env.FISH_IMAGE_BIN || path.join(ROOT, 'bin');

function walk(dir, depth = 0, out = []) {
  if (depth > 3) return out;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1, out);
    else out.push(full);
  }
  return out;
}

const files = walk(modelsDir);
const gb = (n) => (n / 1024 ** 3).toFixed(2) + ' GB';

const checks = [
  { label: 'sd-server 可执行', ok: fs.existsSync(path.join(binDir, IS_WIN ? 'sd-server.exe' : 'sd-server')), hint: 'stable-diffusion.cpp 的发行包，解压到 bin/' },
  { label: '扩散主体 .gguf', ok: files.some((f) => /qwen.image.*\.gguf$/i.test(f)), hint: 'qwen-image-2.1-turbo-Q4_K_M.gguf（4.4G）' },
  { label: '文本编码器', ok: files.some((f) => /qwen3.*vl.*\.(safetensors|gguf)$/i.test(f)), hint: 'qwen3vl_8b_w4a8.safetensors（5.9G，int8 那个 9.35G 在 16G 显存上放不下）' },
  { label: 'VAE', ok: files.some((f) => /vae.*\.safetensors$/i.test(f)), hint: 'qwen_image_2.1_vae_bf16.safetensors（0.7G）' },
];

console.log('models:', modelsDir);
console.log('bin   :', binDir);
console.log('');

let bad = 0;
for (const c of checks) {
  console.log(`${c.ok ? '✓' : '✗'} ${c.label}${c.ok ? '' : '   → ' + c.hint}`);
  if (!c.ok) bad++;
}

if (files.length) {
  console.log('\n找到的文件：');
  for (const f of files) {
    if (!/\.(gguf|safetensors)$/i.test(f)) continue;
    console.log(`  ${gb(fs.statSync(f).size).padStart(8)}  ${path.relative(modelsDir, f)}`);
  }
}

if (bad) {
  console.log('\n下载地址：');
  console.log('  扩散主体/VAE  https://huggingface.co/abenzerps/Qwen-Image-2.1-Turbo-Quantized');
  console.log('  文本编码器    https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/main/text_encoders');
  console.log('  引擎          https://github.com/leejet/stable-diffusion.cpp/releases');
}

process.exit(bad ? 1 : 0);
