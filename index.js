/**
 * dsh-image-gen —— 本地画图插件（自带引擎，不起独立服务）
 *
 * 里面管着一个 sd-server.exe（stable-diffusion.cpp）子进程：
 *   调用 draw_image 时才拉起（约 4 秒加载）
 *   DSH 活着就一直复用，第二次出图不再加载
 *   闲置 N 分钟卸掉，把显存还回去
 *   DSH 关掉时子进程一起收掉
 *
 * 模型：Qwen-Image 2.1 Turbo（GGUF）+ Qwen3-VL 文本编码器 + 对应 VAE。
 * Turbo 的采样参数是固定的，别乱改：
 *   --sigmas qwen-image-2.1-turbo --steps 8 --cfg-scale 1.0 --sampling-method euler
 * 用普通 25 步会过采样出糊图。CFG 1 时负面提示词不起作用。
 *
 * 目录约定（都可以用 config 或环境变量覆盖）：
 *   modelsDir/  *.gguf                      扩散主体
 *               text_encoders/*.safetensors 文本编码器（也可以直接放 modelsDir 下）
 *               vae/*.safetensors           VAE
 *   binDir/     sd-server(.exe) + ggml-cuda.dll 等
 *
 * 环境变量：FISH_IMAGE_MODELS / FISH_IMAGE_BIN / FISH_IMAGE_PORT /
 *           FISH_IMAGE_OFFLOAD=1 / FISH_IMAGE_IDLE_MS
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-image-gen';
export const inject = ['tools'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const BIN_NAME = IS_WIN ? 'sd-server.exe' : 'sd-server';

/**
 * 依次找目录，但只认「真的装了东西」的那个：
 * 插件自带的 models/ 可能只放了个说明文件，不能被它挡住真正的模型目录。
 */
function resolveModelsDir(candidates) {
  let fallback = null;
  for (const d of candidates) {
    if (!d) continue;
    let isDir = false;
    try { isDir = fs.statSync(d).isDirectory(); } catch {}
    if (!isDir) continue;
    const list = walk(d);
    if (list.some((f) => /\.(gguf|safetensors)$/i.test(f))) return { dir: d, files: list };
    if (!fallback) fallback = { dir: d, files: list };
  }
  return fallback || { dir: null, files: [] };
}

function resolveBinDir(candidates, binName) {
  let fallback = null;
  for (const d of candidates) {
    if (!d) continue;
    let isDir = false;
    try { isDir = fs.statSync(d).isDirectory(); } catch {}
    if (!isDir) continue;
    if (fs.existsSync(path.join(d, binName))) return d;
    if (!fallback) fallback = d;
  }
  return fallback;
}

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

/** 按偏好顺序从候选里挑一个文件 */
function pick(files, patterns) {
  for (const re of patterns) {
    const hit = files.filter((f) => re.test(path.basename(f)));
    if (hit.length) {
      // 大文件优先（同一模型的不同量化，通常是想要更大的那个）
      hit.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
      return hit[0];
    }
  }
  return null;
}

export function apply(ctx, config = {}) {
  const log = (...a) => {
    const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
    try { if (LOG_FILE) fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
    try { ctx.logger?.info?.('[image-gen]', ...a); } catch {}
  };

  // 模型和引擎目录：配置 → 环境变量 → 插件自己的 models/。老版本还会兜到作者本机的固定路径，
  // 公开之后这条去掉了 —— 别人机器上不存在，写死在仓库里只会误导。
  const modelCandidates = [
    config.modelsDir, process.env.FISH_IMAGE_MODELS, path.join(HERE, 'models'),
  ];
  const binCandidates = [
    config.binDir, process.env.FISH_IMAGE_BIN, path.join(HERE, 'bin'),
  ];
  // 懒解析：模型可能是第一次调用时才下下来的，下完 cache 置空重扫一次
  let cache = null;
  function rescan() { cache = null; }
  function layout() {
    if (!cache) {
      const resolved = resolveModelsDir(modelCandidates);
      const files = resolved.files;
      cache = {
        modelsDir: resolved.dir,
        binDir: resolveBinDir(binCandidates, BIN_NAME),
        files,
        model: {
          diffusion: config.diffusion && path.resolve(config.diffusion)
            || pick(files, [/qwen.image.*turbo.*q4_k_m.*\.gguf$/i, /qwen.image.*q4_k_m.*\.gguf$/i, /qwen.image.*\.gguf$/i]),
          llm: config.llm && path.resolve(config.llm)
            || pick(files, [/qwen3.*vl.*w4a8.*\.(safetensors|gguf)$/i, /qwen3.*vl.*int8.*\.safetensors$/i, /qwen3.*vl.*\.(safetensors|gguf)$/i]),
          vae: config.vae && path.resolve(config.vae)
            || pick(files, [/vae.*qwen.*image.*\.safetensors$/i, /qwen.*image.*vae.*\.safetensors$/i, /vae.*\.safetensors$/i]),
        },
      };
    }
    return cache;
  }

  const firstLayout = layout();
  const outDir = config.outDir || process.env.FISH_IMAGE_OUT
    || (firstLayout.modelsDir ? path.join(path.dirname(firstLayout.modelsDir), 'out') : path.join(os.tmpdir(), 'dsh-image-out'));
  const port = Number(config.port || process.env.FISH_IMAGE_PORT || 18901);
  const base = `http://127.0.0.1:${port}`;
  const offload = config.offload === true || process.env.FISH_IMAGE_OFFLOAD === '1';
  const idleMs = Number(config.idleUnloadMinutes ? config.idleUnloadMinutes * 60_000 : process.env.FISH_IMAGE_IDLE_MS || 10 * 60_000);
  const steps = Number(config.steps || 8);
  const cfgScale = Number(config.cfgScale || 1.0);
  const sampler = String(config.sampler || 'Euler');
  const sigmas = String(config.sigmas || 'qwen-image-2.1-turbo');
  // 缺东西时自动下（11 GB，只发生一次）。config.autoDownload:false 关掉。
  const autoDownload = config.autoDownload !== false && process.env.FISH_IMAGE_NO_DOWNLOAD !== '1';
  // 日志文件：默认放在模型目录旁边，出问题时唯一能看的地方
  const LOG_FILE = config.logFile || process.env.FISH_IMAGE_LOG
    || (firstLayout.modelsDir ? path.join(path.dirname(firstLayout.modelsDir), 'image.log') : null);

  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}

  let child = null;
  let starting = null;
  let disposed = false;
  let lastUsed = 0;
  let busy = false;   // 正在出图
  let lastMs = 0;
  let lastSeed = null;
  let downloading = null;

  function missing() {
    const { model, binDir } = layout();
    const miss = [];
    const bin = binDir ? path.join(binDir, config.binName || BIN_NAME) : null;
    if (!bin || !fs.existsSync(bin)) miss.push('sd-server 可执行文件（binDir）');
    for (const [k, label] of [['diffusion', '扩散主体 .gguf'], ['llm', '文本编码器'], ['vae', 'VAE']]) {
      if (!model[k] || !fs.existsSync(model[k])) miss.push(label);
    }
    return miss;
  }

  /** 缺东西就跑 scripts/setup.mjs 补上（含引擎）。已经有东西就直接跳过。 */
  async function ensureAssets() {
    if (!missing().length) return;
    if (!autoDownload) throw new Error('缺少：' + missing().join('、') + '（跑 node scripts/setup.mjs 下载）');
    if (!downloading) {
      downloading = (async () => {
        const script = path.join(HERE, 'scripts', 'setup.mjs');
        if (!fs.existsSync(script)) throw new Error('缺 setup.mjs，无法自动下载');
        const flags = [];
        if (config.mirror) flags.push('--mirror');
        if (config.gpu) flags.push('--gpu', String(config.gpu));
        log('缺模型/引擎，开始自动下载（一次性，约 11 GB）', flags.join(' '));
        const code = await new Promise((resolve) => {
          const p = spawn(process.execPath, [script, ...flags], { cwd: HERE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          const tail = (b) => {
            for (const line of b.toString().replace(/\r/g, '\n').split('\n')) if (line.trim()) log('setup:', line.trim().slice(0, 200));
          };
          p.stdout.on('data', tail);
          p.stderr.on('data', tail);
          p.on('exit', resolve);
        });
        rescan();
        if (code !== 0) throw new Error('自动下载没完成（退出码 ' + code + '），重试一次会续传');
        if (missing().length) throw new Error('下载后仍缺：' + missing().join('、'));
        log('自动下载完成');
      })().finally(() => { downloading = null; });
    }
    await downloading;
  }

  const up = async () => {
    try {
      const r = await fetch(base + '/sdapi/v1/options', { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch { return false; }
  };

  function spawnEngine() {
    const { model, modelsDir, binDir } = layout();
    const bin = path.join(binDir, config.binName || BIN_NAME);
    const args = [
      '--listen-ip', '127.0.0.1',
      '--listen-port', String(port),
      '--model-dir', modelsDir,
      '--diffusion-model', model.diffusion,
      '--llm', model.llm,
      '--vae', model.vae,
      '--sigmas', sigmas,
      '--steps', String(steps),
      '--cfg-scale', String(cfgScale),
      // CLI 只认小写（Euler 会被判成非法值，直接打印用法退出）——API 那边反而是首字母大写
      '--sampling-method', sampler.toLowerCase(),
      ...(offload ? ['--offload-to-cpu'] : []),
      '--vae-tiling',
      '--flash-attn', 'auto',
      '--model-args', 'qwen_image_2_1_prefix_cache_type=q8_0',
      '--log-level', 'warn',
    ];
    log('起引擎', offload ? '(offload-to-cpu)' : '(全 GPU)', path.basename(model.diffusion));
    child = spawn(bin, args, { cwd: binDir || HERE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = (buf) => {
      for (const line of buf.toString().split('\n')) if (line.trim()) log('sd:', line.trim().slice(0, 200));
    };
    child.stdout.on('data', tail);
    child.stderr.on('data', tail);
    child.on('error', (e) => { log('引擎启动失败：' + e.message); child = null; });
    child.on('exit', (code) => {
      if (!disposed && code !== 0) log('引擎退出 code=' + code);
      child = null;
    });
  }

  function stopEngine() {
    if (!child) return;
    log('卸引擎');
    try { child.kill(); } catch {}
    child = null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function ensureEngine() {
    if (disposed) throw new Error('插件已卸载');
    await ensureAssets();                       // 缺模型/引擎就先补，补完再起
    if (await up()) return;
    if (!starting) {
      starting = (async () => {
        spawnEngine();
        for (let i = 0; i < 180; i++) {          // 最多等 90 秒（大模型 + 慢盘）
          await sleep(500);
          if (await up()) { log('引擎就绪'); return; }
          if (!child) { log('引擎没起来，再试一次'); spawnEngine(); }
        }
        throw new Error('引擎 90 秒内没就绪');
      })().finally(() => { starting = null; });
    }
    await starting;
  }

  const idleTimer = setInterval(() => {
    // 正在加载 / 正在出图时绝对不能收 —— 否则会把刚从盘里读到一半的权重掐掉
    if (!child || starting || busy) return;
    if (lastUsed && Date.now() - lastUsed > idleMs) {
      log(`闲置 ${Math.round((Date.now() - lastUsed) / 1000)} 秒，收引擎`);
      stopEngine();
    }
  }, 30_000);
  idleTimer.unref?.();

  const clampDim = (v, def) => {
    const n = Number(v);
    const b = Number.isFinite(n) && n > 0 ? n : def;
    return Math.min(1536, Math.max(256, Math.round(b / 32) * 32)); // 模型要求 32 的倍数
  };

  async function draw({ prompt, width, height, seed }) {
    await ensureEngine();
    busy = true;
    lastUsed = Date.now();          // 一开始出图就算"在用"，别让闲置计时器动手
    try {
      const w = clampDim(width, 1024);
      const h = clampDim(height, 1024);
      const s = Number.isFinite(Number(seed)) && Number(seed) >= 0 ? Math.floor(Number(seed)) : Math.floor(Math.random() * 1e9);
      const started = Date.now();
      const res = await fetch(base + '/sdapi/v1/txt2img', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          negative_prompt: '',
          steps,
          cfg_scale: cfgScale,
          width: w, height: h,
          sampler_name: sampler,
          seed: s,
          batch_size: 1, n_iter: 1,
          send_images: true, save_images: false,
        }),
        signal: AbortSignal.timeout(20 * 60_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`引擎 HTTP ${res.status}: ${text.slice(0, 300)}`);
      const body = JSON.parse(text);
      const b64 = body?.images?.[0];
      if (!b64) throw new Error('引擎没返回图像');
      const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.png`);
      fs.writeFileSync(file, Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      lastMs = Date.now() - started;
      lastSeed = s;
      log('出图', path.basename(file), Math.round(lastMs / 1000) + 's');
      return { path: file, width: w, height: h, ms: lastMs, seed: s };
    } finally {
      busy = false;
      lastUsed = Date.now();
    }
  }

  ctx.tools.register(defineTool({
    name: 'draw_image',
    description:
      '在本机生成图片（Qwen-Image 2.1 Turbo，8 步）。返回 PNG 的绝对路径；' +
      '要给人看就用发文件的工具送出去。提示词用英文效果更好，写清主体、风格、光线、构图。' +
      '1024×1024 在 16G 显存上约 50 秒；引擎闲置会自动卸掉以释放显存，下次再画会重新加载。',
    parameters: {
      prompt: { type: 'string', required: true, description: '画面描述，建议英文' },
      width: { type: 'number', description: '宽，32 的倍数，默认 1024，上限 1536' },
      height: { type: 'number', description: '高，32 的倍数，默认 1024，上限 1536' },
      seed: { type: 'number', description: '固定种子（可选，同种子可复现）' },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) {
      const prompt = String(args.prompt || '').trim();
      if (!prompt) return { ok: false, message: 'prompt 为空' };
      try {
        const r = await draw({ prompt, width: args.width, height: args.height, seed: args.seed });
        return { ok: true, ...r, seconds: Math.round(r.ms / 100) / 10 };
      } catch (e) {
        return { ok: false, message: e.message, hint: '用 image_status 看引擎与模型状态' };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'image_status',
    description: '看画图引擎状态：引擎是否在跑、显存模式、模型文件齐不齐、上一张耗时。出图失败先用它排查。',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute() {
      const running = await up();
      const { model, modelsDir, binDir } = layout();
      return {
        engine: running ? 'running' : child ? 'starting' : downloading ? 'downloading' : 'stopped',
        mode: offload ? 'offload-to-cpu' : 'full-gpu',
        sampling: { sigmas, steps, cfgScale, sampler },
        idleUnloadMinutes: Math.round(idleMs / 60000),
        autoDownload,
        lastSeconds: lastMs ? Math.round(lastMs / 100) / 10 : null,
        lastSeed,
        dirs: { modelsDir, binDir, outDir },
        models: Object.entries(model).map(([part, f]) => ({
          part, file: f ? path.basename(f) : null, exists: Boolean(f && fs.existsSync(f)),
        })),
        missing: missing(),
      };
    },
  }));

  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => { disposed = true; clearInterval(idleTimer); stopEngine(); });
  }
}
