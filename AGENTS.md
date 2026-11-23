# AGENTS.md — 给鱼鱼看的安装说明

你是一个跑在 DSH（DeepSeek Harness）里的 agent。这个包是给你的：装好之后你会多一个 `draw_image` 工具，能在这台机器上本地出图，不需要联网、不需要外部 API。

**目标**：让 `draw_image` 在这台机器上跑通，并把结论交给你的伙伴（人类）。

按顺序做，每步都有验收标准。**不要跳步**，也不要凭猜测改参数。

---

## 0. 先问清楚（只在信息缺失时）

需要知道三件事，能从环境里读出来就别问：

| 需要 | 怎么查 |
|---|---|
| 显卡和显存 | `nvidia-smi --query-gpu=name,memory.total --format=csv` |
| 磁盘剩余 | 模型约 11 GB，引擎约 0.4 GB，解压后留 13 GB |
| DSH profile 位置 | 通常 `~/.dsh/profiles/desktop`（Windows: `C:\Users\<你>.dsh\profiles\desktop`） |

没有 NVIDIA 卡、显存 < 8 GB、或者没有独立显卡：**先停下来告诉伙伴**这机器跑不动这个模型，别硬装。

## 1. 放到 profile 里

```bash
# 解包后把整个目录放进 profile 的 node_modules
cp -r package "<profile>/node_modules/dsh-image-gen"
```

验收：`<profile>/node_modules/dsh-image-gen/index.js` 存在。

## 2. 下引擎和模型（自动）

```bash
cd "<profile>/node_modules/dsh-image-gen"
node scripts/setup.mjs --mirror      # 中国网络加 --mirror（走 hf-mirror.com）
```

- 会下 stable-diffusion.cpp 的 `sd-server`（按平台自动挑 cuda12 / vulkan / cpu）和三个模型文件
- 支持续传：中断了重跑同一条命令即可
- 国内没加 `--mirror` 会很慢，这是最常见的一次失败

验收：

```bash
node scripts/check.mjs
# 四个 ✓，退出码 0
```

## 3. 注册进 profile

编辑 `<profile>/package.json`，在 `dsh.profile.bundles` 数组末尾加一行：

```json
"dsh-image-gen"
```

如果 profile 用 `cordis.patch.yml` 管理插件，也可以手写：

```yaml
- insert:
    - id: dsh-image-gen
      name: dsh-image-gen
```

验收：`node -e "JSON.parse(require('fs').readFileSync('<profile>/package.json','utf8'))"` 不报错。

## 4. 重启 DSH

**插件代码不热更新**，改完必须重启宿主进程才装载。

验收：新会话里工具列表出现 `draw_image` 和 `image_status`。

## 5. 真跑一张

```
image_status            → 应该看到 missing: []，dirs 指向你放模型的目录
draw_image {prompt: "a tiny blue fish sticker, flat vector, white background", width: 512, height: 512}
```

验收：返回 `ok: true` 和一个 `.png` 的绝对路径，512×512 在 16 GB 卡上约 7 秒、首次带加载约 11 秒。

把这张图发给伙伴看，装好之后别只报"装完了"。

---

## 显存不够怎么办

按顺序试，每次只改一项，改完重跑第 5 步：

| 显存 | 做法 |
|---|---|
| ≥ 14 GB 空闲 | 默认全 GPU，什么都不用改 |
| 10–14 GB | 关掉浏览器/游戏再试；或配置 `offload: true` |
| 8–10 GB | `offload: true` + 扩散模型换 `Q4_0`（3.9 GB）+ 分辨率 768×768 |
| < 8 GB | 这模型跑不动，如实说 |

`offload` 的两种写法：环境变量 `FISH_IMAGE_OFFLOAD=1`，或 cordis 里给插件配置 `{ "offload": true }`。

## 故障对照

| 症状 | 原因 | 处理 |
|---|---|---|
| `missing: ["文本编码器"]` | 只下了 diffusers 目录结构 | 跑 `scripts/check.mjs` 看它找的是哪个目录，把 `.safetensors` 放进去 |
| 引擎 90 秒没就绪 | 首次加载 + 机械盘 | 等；或把模型放 SSD |
| `CUDA out of memory` | 显存不够 | 见上一节 |
| `HTTP 503` 短暂出现 | 引擎还在加载 | 重试一次；连续失败看 `image.log` |
| 找不到 `sd-server` | 引擎包没解压到 `bin/` | 解压后确认 `bin/sd-server(.exe)` 存在 |
| 下载卡住不动 | 走了 huggingface.co | 加 `--mirror` 重跑（会续传） |
| 端口 18901 被占 | 上一份引擎没退干净 | 杀掉残留的 `sd-server` 进程 |

日志在插件目录的上级：`<modelsDir>/../image.log`。引擎自己的输出也转进去了。

## 不要做的事

- **不要改 `--sigmas` / `--steps` / `--cfg-scale`**。Turbo 用固定的八步 sigma 曲线，改成普通 25 步会过采样出糊图。CFG 是 1 时负面提示词不起作用，写了也没用。
- 不要把模型放系统盘根目录或临时目录——重启就没了，而且 11 GB。
- 不要同时跑其它吃显存的本地模型（TTS、别的推理服务）。16 GB 卡上它们会互相挤爆。
- 不要为了"省显存"去用 int8 文本编码器：9.35 GB，加扩散主体直接超 16 GB，反而跑不起来（除非 `offload`）。

## 装完之后

给伙伴的回报要具体，别只说"好了"：

> draw_image 装好了。模型在 `<路径>`，全 GPU，1024×1024 约 50 秒。要不要现在画一张试试？

如果中途停下（跑不动、缺东西），也要说清楚**卡在哪一步、缺什么**，别含糊过去。
