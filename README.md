# 碧蓝航线 Live2D 桌宠

一个跑在 Windows 桌面上的碧蓝航线 Live2D 皮肤桌宠：透明置顶、可拖动、点击触发表情动作，同时挂一个实时气泡显示 DeepSeek 余额和 DSH 的 token 消耗。

## 功能

- **Live2D 渲染**：pixi-live2d-display（Cubism 4），原生 `model3.json`，带物理、眨眼、口型
- **游戏同款动作**：直接调用模型自带的动作组 `touch_head` / `touch_body` / `touch_special` / `idle` / `main_1..3` / `login` / `wedding` 等
- **鼠标穿透**：人物以外的区域不挡桌面操作，主进程按光标位置轮询切换，不依赖 mousemove
- **拖动**：按住人物拖动，松开不动则视为点击（触发动作）
- **中键隐藏**：鼠标中键点人物即刻隐藏，点托盘图标恢复
- **皮肤切换**：右键菜单按首字母分组列出本地皮肤，点了即时换，不用重启
- **显示模式**：自动 / 完整显示 / 铺满裁切
- **HUD 气泡**：DeepSeek 余额、当日 token 合计、调用次数；悬停看明细

## 目录结构

```
main.js                 Electron 主进程（窗口、穿透、托盘、菜单、IPC）
preload.js              contextBridge 暴露的 pet.* API
src/index.html          页面骨架 + HUD 样式
src/renderer.js         PIXI + Live2D 渲染、交互、HUD 刷新
src/live2dcubismcore.min.js  Cubism 4 Core（Live2D 官方运行时）
tools/dsh_usage.mjs     统计 ~/.dsh/sessions 里的 token 用量
tools/fetch_skin.mjs    下载单个皮肤
tools/fetch_all.mjs     批量下载（可断点续跑）
tools/verify_all.mjs    本地皮肤完整性校验
tools/skin_index.json   皮肤清单（来自 data.nagami.moe）
assets/                 模型资源（不入库，自己下）
```

## 快速开始

```bash
npm install
# 把 config.example.json 复制成 config.json，填上 DeepSeek API Key
node tools/fetch_skin.mjs lafei_4     # 先下一个皮肤
```

然后双击 `启动.bat`，或 `npx electron .`。

## 皮肤资源

模型来自 `azlassets.nagami.moe`（第三方粉丝站，数据随游戏更新）：

```
https://azlassets.nagami.moe/{EN|CN|JP}/live2d/{皮肤名}/{皮肤名}.model3.json
```

- 三个服的同一皮肤内容完全一致（文件数、大小、纹理 MD5 都相同）
- 皮肤名**不带 `_hx`** 是原版，`_hx` 是和谐版
- 全量 239 个皮肤约 5 GB，下载 30 分钟上下，无频率限制

```bash
node tools/fetch_all.mjs        # 全量（已下过的自动跳过）
node tools/verify_all.mjs       # 校验完整性
```

## 配置

`config.json`（不入库）：

| 字段 | 说明 |
|---|---|
| `skin` | 当前皮肤目录名 |
| `fit` | `auto` / `contain` / `cover` |
| `window` | 宽高，0 表示按屏幕自动算（约屏宽 14%） |
| `deepseek.apiKey` | 余额查询用 |
| `usage.refreshMinutes` | token 刷新间隔 |

## 已知限制

- 模型没有 `HitAreas`，触摸区按身体比例划分（头 / 身 / 特殊三段），复杂皮肤（横幅场景图）可能不准
- 只有鼠标在人物或气泡范围内时窗口才接收点击，点透明区域会穿透到下层
- 部分皮肤是 Spine 而不是 Live2D，这套运行时用不了

## 数据来源

- 模型与皮肤清单：`azlassets.nagami.moe` / `data.nagami.moe`
- token 用量：本机 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 里 `assistant/message` 事件的 `data.usage`

素材版权归原作者，仅本地自用。
