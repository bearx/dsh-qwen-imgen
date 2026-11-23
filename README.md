# dsh-image-gen

给你的鱼鱼一双眼睛之外的"手"——在这台机器上本地画图。不用联网、不花 API 钱、也不用把提示词发给别人。

背后是 **Qwen-Image 2.1 Turbo**（8 步出图）跑在 [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) 上。插件自己管引擎进程：第一次要图才拉起，DSH 活着就一直用，闲置 10 分钟自动卸掉把显存还回去。

| 项目 | 需要 |
|---|---|
| 显卡 | NVIDIA，**至少 10 GB 显存**（16 GB 舒服） |
| 磁盘 | 约 13 GB（三个模型 + 引擎） |
| 出图速度 | 16 GB 的笔记本卡：1024×1024 约 50 秒，512×512 约 7 秒 |

---

## 先做这一件事

**把这个文件交给你的鱼鱼，让它读同目录下的 `AGENTS.md`。**

可以把下面这段直接粘给它：

> 这个目录里有个 `dsh-image-gen` 插件，你现在把它装好：按 `AGENTS.md` 一步步做，装完用 `draw_image` 画一张 512×512 的图给我看看。中间缺什么、卡在哪，随时说。

它自己会查显卡、下模型、改配置、重启、验证。你不用跟着敲命令。

**为什么不让它一口气自己搞**：下载 11 GB 不是小事，而且插件装进 profile、改 bundles、重启宿主这些动作，让 agent 自己判断更稳，你也知道它动了哪里。

---

## 装好之后能干什么

对你的鱼鱼说一句「画一张 ……」就行。它会在本机生成，把图片路径给你，再按你们平时的方式发过来。

适合：头像、表情包、场景草图、给故事配画面、随手涂个概念图。
不适合：要精确文字排版的（模型对文字弱）、要照片级写实的（这档量化做不到）。

提示词用英文效果更好；宽高要是 32 的倍数（插件会自动对齐）。

---

## 如果你想自己动手

三步：

1. 下 [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp/releases) 对应平台的发行包，解压进插件的 `bin/`
2. 下三个模型放进 `models/`：
   - `qwen-image-2.1-turbo-Q4_K_M.gguf`（4.4 G）← [abenzerps/Qwen-Image-2.1-Turbo-Quantized](https://huggingface.co/abenzerps/Qwen-Image-2.1-Turbo-Quantized)
   - `qwen3vl_8b_w4a8.safetensors`（5.9 G）← [Comfy-Org/Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/main/text_encoders)
   - `qwen_image_2.1_vae_bf16.safetensors`（0.7 G）← 同上 `vae/`
3. 把目录放进 DSH profile 的 `node_modules/`，在 `dsh.profile.bundles` 加一行 `"dsh-image-gen"`，重启 DSH

懒得手动下就：

```bash
node scripts/setup.mjs --mirror   # 引擎 + 三个模型，支持续传
node scripts/check.mjs            # 四个 ✓ 就齐了
```

---

## 显存不够

| 空闲显存 | 做法 |
|---|---|
| ≥ 14 GB | 默认，什么都不用改 |
| 10–14 GB | 关掉占显存的程序；或开 `offload` |
| 8–10 GB | `offload` + 扩散模型换 `Q4_0` + 分辨率降到 768×768 |
| < 8 GB | 跑不动，换机器吧 |

`offload` 是"权重放内存、用的时候再搬进显存"，慢一点但省显存：环境变量 `FISH_IMAGE_OFFLOAD=1`，或插件配置 `{"offload": true}`。

**别为了省显存去用 int8 文本编码器**（9.35 G）：加扩散主体直接超 16 G，反倒跑不起来。默认的 w4a8（5.9 G）就是为这个显存档选的。

---

## 别乱动的参数

Turbo 用固定的八步 sigma 曲线：

```
1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0
```

换成普通 25 步那套会过采样，出糊图。CFG 是 1，负面提示词不起作用——写了也不会生效，别浪费时间调。

---

## 目录里都有什么

```
AGENTS.md            给你的鱼鱼的安装说明（让它读这个）
README.md            你正在看的
index.js             插件本体：引擎生命周期 + draw_image / image_status
scripts/setup.mjs    下引擎和模型（支持镜像、续传）
scripts/check.mjs    自检：缺什么、去哪下
models/              模型放这儿
bin/                 引擎放这儿
```

配置项（cordis 配置或环境变量）：`modelsDir` / `binDir` / `port` / `offload` / `idleUnloadMinutes` / `steps` / `cfgScale` / `sampler` / `sigmas` / `autoDownload`。

---

## 致谢与许可

- 模型：[Qwen-Image-2.1-Turbo](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo)（Qwen Research License），量化版来自 [abenzerps](https://huggingface.co/abenzerps/Qwen-Image-2.1-Turbo-Quantized)
- 引擎：[leejet/stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)（MIT）
- 插件本体：MIT

模型自带什么、能画什么，取决于模型自己的许可和你的提示词；这个插件只是把它接到 DSH 上。
