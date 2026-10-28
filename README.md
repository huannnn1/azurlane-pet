# 碧蓝航线 Live2D 桌宠

一个跑在 Windows 桌面上的碧蓝航线 Live2D 皮肤桌宠：透明置顶、可拖动、点击触发表情动作，同时挂一个实时气泡显示 DeepSeek 余额和 DSH 的 token 消耗。

## 功能

- **Live2D 渲染**：pixi-live2d-display（Cubism 4），原生 `model3.json`，带物理、眨眼、口型
- **游戏同款动作**：直接调用模型自带的动作组 `touch_head` / `touch_body` / `touch_special` / `idle` / `main_1..3` / `login` / `wedding` 等
- **触摸区标定**：右键菜单进标定模式，依次点头部 / 身体 / 特殊三处，按皮肤存成 `hitareas.json`；没标过的皮肤按身高比例兜底
- **DSH 活动联动**：监测 DSH 会话是否在写，思考中待机动作加快到 12 秒一次，空闲时放慢到 50 秒
- **鼠标穿透**：人物以外的区域不挡桌面操作，主进程按光标位置轮询切换，不依赖 mousemove
- **拖动**：按住人物拖动，松开不动则视为点击（触发动作）
- **中键隐藏**：鼠标中键点人物即刻隐藏，点托盘图标恢复
- **皮肤切换**：右键菜单按首字母分组列出本地皮肤，点了即时换，不用重启
- **显示模式**：自动 / 完整显示 / 铺满裁切
- **外观配置**：透明度、窗口大小、始终置顶、开机自启，全部在托盘菜单里
- **失败回退**：皮肤加载失败自动切到上次能用的那个，连续失败三次停止
- **HUD 气泡**：DeepSeek 余额、当日 token 合计、调用次数；悬停看明细
- **用量明细**：点 HUD 打开独立窗口，按天 / 按会话看 token 分项和按 DeepSeek 官方价折算的费用（工作日高峰时段自动按两倍价）

## 目录结构

```
main.js                 Electron 主进程（窗口、穿透、托盘、菜单、IPC、外观、标定、资源定位）
preload.js              contextBridge 暴露的 pet.* API
src/index.html          页面骨架 + HUD / 标定提示 / 找不到模型时的自救卡片
src/renderer.js         PIXI + Live2D 渲染、交互、标定、HUD 刷新
src/usage.html          用量明细窗口（按天 / 按会话、费用折算）
src/usage.js            明细窗口的渲染与标签页
src/live2dcubismcore.min.js  Cubism 4 Core（Live2D 官方运行时）
src/tray_32.png         托盘图标（打进 asar，保证打包后不依赖 assets）
tools/dsh_usage.mjs     统计 ~/.dsh/sessions 里的 token 用量
tools/fetch_skin.mjs    下载单个皮肤
tools/fetch_all.mjs     批量下载（可断点续跑）
tools/verify_all.mjs    本地皮肤完整性校验
tools/build_skin_names.mjs  生成皮肤中文名映射
tools/skin_index.json   皮肤清单（来自 data.nagami.moe）
assets/                 模型资源（不入库，自己下）
build/icon.png          应用图标
```

## 快速开始

```bash
npm install
# 把 config.example.json 复制成 config.json，填上 DeepSeek API Key
npm run fetch:skin lafei_4     # 先下一个皮肤（或 npm run fetch:all 全量）
```

然后双击 `启动.bat`，或 `npm start`。

## 皮肤资源

模型来自 `azlassets.nagami.moe`（第三方粉丝站，数据随游戏更新）：

```
https://azlassets.nagami.moe/{EN|CN|JP}/live2d/{皮肤名}/{皮肤名}.model3.json
```

- 三个服的同一皮肤内容完全一致（文件数、大小、纹理 MD5 都相同）
- 皮肤名**不带 `_hx`** 是原版，`_hx` 是和谐版
- 全量 239 个皮肤约 5 GB，下载 30 分钟上下，无频率限制

```bash
npm run fetch:all      # 全量（已下过的自动跳过）
npm run verify         # 校验完整性（查依赖、moc3 魔数、纹理头）
```

## 配置

`config.json`（不入库）：

| 字段 | 说明 |
|---|---|
| `skin` | 当前皮肤目录名 |
| `lastGoodSkin` | 上次成功加载的皮肤，失败时回退用 |
| `recent` | 最近用过的皮肤，菜单置顶 |
| `assetsDir` | 用户选过的模型目录，打包版靠它找 assets |
| `fit` | `auto` / `contain` / `cover` |
| `opacity` | 窗口不透明度 0.2~1 |
| `sizeScale` | 窗口缩放倍率 |
| `alwaysOnTop` | 是否始终置顶 |
| `autoStart` | 开机自启 |
| `window` | 宽高，0 表示按屏幕自动算（约屏宽 14%） |
| `deepseek.apiKey` | 余额查询用 |
| `usage.refreshMinutes` | token 刷新间隔 |

打包版的 `config.json` 在 `%APPDATA%\azurlane-pet\config.json`（开发模式在项目根目录）。托盘菜单和 HUD 里的「打开配置」会直接打开它。

## 费用是怎么算的

按 DeepSeek 官方价（`deepseek-flash`，元 / 百万 tokens）：

- 输入·缓存命中：空闲 ¥0.02，高峰 ¥0.04
- 输入·缓存未命中：空闲 ¥1，高峰 ¥2
- 输出：空闲 ¥4，高峰 ¥8

高峰时段是北京时间周一至周五 9:00-12:00、14:00-18:00，其余时间（含周末）按空闲价。法定节假日本地判断不了，按工作日近似。

每条消息按它发生的时刻各自套价，所以同一天的费用是分段累加出来的。价格写死在 `tools/dsh_usage.mjs` 的 `PRICE` 常量里，官方调价后改这里即可。

## 打包与分发

```bash
npm run dist
```

输出 `release/AzurLanePet-<version>.exe`（portable 单文件，约 110 MB）。

**assets 不打进包**（5 GB 塞不进去）。发布时把 exe 和 `assets` 目录放在同一个文件夹里：

```
AzurLanePet.exe
assets/
  lafei_4/
    lafei_4.model3.json
    ...
```

程序按这个顺序找模型目录：

1. 环境变量 `PET_ASSETS`（调试用）
2. `config.json` 里记下的 `assetsDir`（选过一次就一直用）
3. exe 同级的 `assets`（portable 版会根据 `PORTABLE_EXECUTABLE_DIR` 定位真实位置）
4. exe 上一级的 `assets`

都没有的话，第一次启动会弹窗让你选目录；选完记进配置，以后不再问。也可以随时在**托盘菜单 → 选择皮肤目录…** 里改。

打包配置写在 `package.json` 的 `build` 字段里（文件白名单、`tools/` 解包、图标），不依赖命令行参数，换台机器 `npm run dist` 结果一致。

## 已知限制

- 未标定的皮肤按身体比例划分触摸区，复杂构图（横幅场景图）可能不准，标定一次即可
- 只有鼠标在人物或气泡范围内时窗口才接收点击，点透明区域会穿透到下层
- 部分皮肤是 Spine 而不是 Live2D，这套运行时用不了
- 首次统计 token 要解压当天写入过的会话文件（约 2 秒），之后走缓存几乎瞬时

## 数据来源

- 模型与皮肤清单：`azlassets.nagami.moe` / `data.nagami.moe`
- token 用量：本机 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 里 `assistant/message` 事件的 `data.usage`

素材版权归原作者，仅本地自用。
