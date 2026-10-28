const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, dialog, globalShortcut } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const https = require('node:https')
const { execFile } = require('node:child_process')

// 启动探针：确认 main.js 真的被执行（仅打包版，避免污染开发日志）
try {
  if (process.resourcesPath && process.resourcesPath.endsWith('resources')) {
    fs.writeFileSync(path.join(require('node:os').tmpdir(), 'pet-boot-marker.log'),
      `loaded at ${new Date().toISOString()} packaged=${app.isPackaged} root=${__dirname}\n`)
  }
} catch {}

const ROOT = __dirname
const USAGE_SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'tools', 'dsh_usage.mjs')
  : path.join(ROOT, 'tools', 'dsh_usage.mjs')

// 打包后 __dirname 在 asar 内部（只读），配置必须落到 userData
const CONFIG_FILE = app.isPackaged
  ? path.join(app.getPath('userData'), 'config.json')
  : path.join(ROOT, 'config.json')

// --snapshot 用独立 userData，避免和正在运行的桌宠抢缓存锁
// 打包后 Chromium 会拒绝未知参数，所以同时支持环境变量 PET_SNAPSHOT=1
const SNAPSHOT_MODE = process.argv.includes('--snapshot') || process.env.PET_SNAPSHOT === '1'
if (SNAPSHOT_MODE) {
  // 先把日志接上，后面任何一步炸了都能看到
  const logFile = path.join(require('node:os').tmpdir(), 'azurlane-pet-boot.log')
  try { fs.writeFileSync(logFile, `start packaged=${app.isPackaged} root=${ROOT}\n`) } catch {}
  const wrap = (fn, tag) => (...a) => {
    fn(...a)
    try { fs.appendFileSync(logFile, tag + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n') } catch {}
  }
  console.log = wrap(console.log, '')
  console.error = wrap(console.error, '[err] ')

  try {
    app.setPath('userData', app.isPackaged
      ? path.join(require('node:os').tmpdir(), 'azurlane-pet-snapshot')
      : path.join(ROOT, '.snapshot-profile'))
    console.log('[boot] userData =', app.getPath('userData'))
  } catch (e) {
    console.log('[boot] setPath 失败:', e.message)
  }
}

const DEFAULT_CONFIG = {
  // 窗口宽高留空 = 按屏幕自动算（约屏幕宽的 15%，高 1.5 倍，落在桌宠尺寸区间）
  window: { width: 0, height: 0, marginRight: 32, marginBottom: 0 },
  skin: 'lafei_4',
  fit: 'auto', // auto | contain | cover
  hintShown: false, // 首次隐藏时用气泡提示一次怎么恢复
  opacity: 1,
  sizeScale: 1,
  alwaysOnTop: true,
  autoStart: false,
  hideOnFullscreen: true, // 检测到全屏应用/演示模式时自动让位
  bubble: true, // 头顶气泡台词
  hud: 'always', // always | hover | off
  deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com' },
  usage: { refreshMinutes: 5, sessionOnly: false },
}

/** 当前生效的模型目录（loadConfig 之后由 resolveAssetsRoot 填充） */
let ASSETS = ''

/**
 * assets 目录解析，按优先级：
 *  1. 环境变量 PET_ASSETS（调试用）
 *  2. config.json 里用户上次选的 assetsDir（可分发版靠这个）
 *  3. 打包版：exe 所在目录及其上两级各自的 assets（覆盖「exe 放 release、assets 在项目根」这类布局）
 *  4. 开发版：项目自带 assets
 */
function resolveAssetsRoot() {
  if (process.env.PET_ASSETS) return process.env.PET_ASSETS
  if (config?.assetsDir && hasSkins(config.assetsDir)) return config.assetsDir

  if (!app.isPackaged) return path.join(__dirname, 'assets')

  // portable 启动时 exe 会解压到 temp 运行，用户真正放 exe 的目录在 PORTABLE_EXECUTABLE_DIR
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  const bases = [portableDir, path.dirname(app.getPath('exe'))].filter(Boolean)

  const candidates = []
  for (const base of bases) {
    candidates.push(path.join(base, 'assets'))
    candidates.push(path.join(base, '..', 'assets'))
    candidates.push(path.join(base, '..', '..', 'assets'))
  }
  candidates.push(path.join(app.getPath('userData'), 'assets'))

  // 用 hasSkins 而不是 existsSync：上两级可能命中无关目录，得确认里面真有皮肤
  for (const c of candidates) if (hasSkins(c)) return c
  return path.join(portableDir || bases[0], 'assets')
}

/** 目录里是否真有皮肤（至少一个 <dir>/<dir>.model3.json） */
function hasSkins(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .some((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, `${d.name}.model3.json`)))
  } catch { return false }
}

/** 扫描 assets 下所有 <skin>/<skin>.model3.json */
function scanSkins() {
  let dirs = []
  try { dirs = fs.readdirSync(ASSETS, { withFileTypes: true }) } catch { return [] }
  return dirs
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(ASSETS, name, `${name}.model3.json`)))
    .sort()
}

/** 中文名映射：tools/skin_names.json */
let SKIN_NAMES = {}
try {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'tools', 'skin_names.json')
    : path.join(ROOT, 'tools', 'skin_names.json')
  SKIN_NAMES = JSON.parse(fs.readFileSync(p, 'utf8'))
} catch { SKIN_NAMES = {} }
console.log('[names] 中文名映射条数 =', Object.keys(SKIN_NAMES).length)

function skinLabel(prefab) {
  const n = SKIN_NAMES[prefab]
  return n?.label ? `${n.label}  (${prefab})` : prefab
}

function rememberRecent(prefab) {
  const list = Array.isArray(config.recent) ? config.recent.filter((s) => s !== prefab) : []
  list.unshift(prefab)
  config.recent = list.slice(0, 8)
}

function skinRelPath(skin) {
  // 返回 file:// 绝对 URL，开发和打包后都能直接加载
  return require('node:url').pathToFileURL(path.join(ASSETS, skin, `${skin}.model3.json`)).href
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8') } catch {}
}

/** 取某点所在显示器的可用区域（副屏拖动、按屏算尺寸都靠它） */
function workAreaAt(x, y) {
  return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea
}

/** 把窗口夹到「中心所在那块屏」的边界内，这样能跨屏拖，但不会拖丢 */
function clampToDisplay(x, y, w, h) {
  const displays = screen.getAllDisplays()
  const cx = x + w / 2
  const cy = y + h / 2
  let best = displays[0]
  let bestD = Infinity
  for (const d of displays) {
    const a = d.workArea
    const dx = Math.max(a.x - cx, 0, cx - (a.x + a.width))
    const dy = Math.max(a.y - cy, 0, cy - (a.y + a.height))
    const dist = dx * dx + dy * dy
    if (dist < bestD) { bestD = dist; best = d }
  }
  const a = best.workArea
  return {
    x: Math.max(a.x, Math.min(x, a.x + a.width - w)),
    y: Math.max(a.y, Math.min(y, a.y + a.height - h)),
  }
}

/** 把外观相关配置应用到窗口 */
function applyAppearance() {
  if (!win || win.isDestroyed()) return
  const before = win.getBounds()
  const [cx, cy] = win.getPosition()
  const area = workAreaAt(cx + 1, cy + 1)
  const auto = autoSize(area)
  const baseW = config.window?.width || auto.width
  const baseH = config.window?.height || auto.height
  const k = config.sizeScale ?? 1
  const w = Math.round(baseW * k)
  const h = Math.round(baseH * k)

  try { win.setOpacity(Math.max(0.2, Math.min(1, config.opacity ?? 1))) } catch {}
  try { win.setAlwaysOnTop(!!config.alwaysOnTop, 'screen-saver') } catch {}
  try {
    win.setBounds({ x: cx, y: cy, width: w, height: h })
  } catch {}
  if (before.width !== w || before.height !== h) {
    console.log('[window] 尺寸变化', `${before.width}x${before.height}`, '->', `${w}x${h}`, 'scale=', k, 'auto=', auto.width)
  }
}

function applyAutoStart() {
  try {
    if (app.isPackaged) {
      // portable 版 process.execPath 指向临时解压目录，重启就失效，
      // 必须用 electron-builder 给出的「用户双击的那个 exe」
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
      app.setLoginItemSettings({ openAtLogin: !!config.autoStart, path: exe })
    } else {
      // 开发模式指向 electron.exe + 项目目录
      app.setLoginItemSettings({
        openAtLogin: !!config.autoStart,
        path: process.execPath,
        args: [path.join(__dirname)],
      })
    }
    console.log('[autostart]', config.autoStart ? '已开启' : '已关闭')
  } catch (e) { console.error('[autostart] 失败', e.message) }
}

/** 桌宠尺寸：屏幕宽的 14%，夹在 220~320 之间，高宽比 1.5 */
function autoSize(area) {
  const width = Math.round(Math.min(320, Math.max(220, area.width * 0.14)))
  return { width, height: Math.round(width * 1.5) }
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    // 记事本另存的 UTF-8 常带 BOM，直接 JSON.parse 会失败，
    // 失败后会走到下面的兜底分支把配置重写掉——用户填的 Key 就这么没了
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw.replace(/^\uFEFF/, '')) }
  } catch (e) {
    // 解析失败先把原文件留个底，别静默覆盖用户手写坏掉的配置
    try {
      if (fs.existsSync(CONFIG_FILE) && fs.statSync(CONFIG_FILE).size > 0) {
        fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.bad`)
        console.warn('[config] 解析失败，已备份为 config.json.bad:', e.message)
      }
    } catch {}
    try {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8')
    } catch (err) {
      console.warn('[config] 无法写入配置文件，使用内存默认值:', err.message)
    }
    return DEFAULT_CONFIG
  }
}

let win = null
let config = loadConfig()
let tray = null
ASSETS = resolveAssetsRoot()

// ---- 日志落盘 -------------------------------------------------------------
// 打包版没有控制台，出错只能靠这个文件回溯；开发版默认不打，免得多一份噪音
const LOG_MAX_BYTES = 1024 * 1024
let logFilePath = null

function logPath() {
  if (!logFilePath) logFilePath = path.join(app.getPath('userData'), 'pet.log')
  return logFilePath
}

function setupFileLog() {
  try {
    const st = fs.statSync(logPath())
    if (st.size > LOG_MAX_BYTES) fs.renameSync(logPath(), logPath() + '.1')
  } catch {}

  const write = (tag, args) => {
    try {
      const text = args.map((a) => {
        if (typeof a === 'string') return a
        try { return JSON.stringify(a) } catch { return String(a) }
      }).join(' ')
      fs.appendFileSync(logPath(), `[${new Date().toISOString()}]${tag} ${text}\n`)
    } catch {}
  }

  const origLog = console.log.bind(console)
  const origErr = console.error.bind(console)
  console.log = (...a) => { origLog(...a); write('', a) }
  console.error = (...a) => { origErr(...a); write('[err]', a) }
  console.log('[log] 日志文件:', logPath())
}

// ---- 隐藏 / 恢复（中键隐藏，托盘图标恢复）--------------------------------
let hiddenByUser = false   // 区分「用户主动藏起来」和「全屏时自动让位」

/** 窗口透明度渐变：显隐时给一点过渡，别硬切 */
function fadeWindowOpacity(to, ms = 200) {
  if (!win || win.isDestroyed()) return Promise.resolve()
  const from = win.getOpacity()
  if (Math.abs(from - to) < 0.02) {
    try { win.setOpacity(to) } catch {}
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (!win || win.isDestroyed()) { clearInterval(timer); return resolve() }
      const t = Math.min(1, (Date.now() - start) / ms)
      try { win.setOpacity(from + (to - from) * t) } catch {}
      if (t >= 1) { clearInterval(timer); resolve() }
    }, 16)
  })
}

async function hidePet() {
  if (!win || !win.isVisible()) return
  hiddenByUser = true
  await fadeWindowOpacity(0, 180)
  if (!win || win.isDestroyed()) return
  win.hide()
  try { win.setOpacity(config.opacity ?? 1) } catch {}
  if (tray) tray.setToolTip('碧蓝桌宠（已隐藏）— 点图标或 Ctrl+Alt+Z 恢复')
  if (tray && !config.hintShown) {
    try {
      tray.displayBalloon({
        title: '桌宠已隐藏',
        content: '点右下角托盘的小图标，或者按 Ctrl+Alt+Z 叫她回来。',
      })
    } catch {}
    config.hintShown = true
    saveConfig()
  }
}

function showPet() {
  if (!win) return
  hiddenByUser = false
  // 全屏期间用户主动叫她出来，这次全屏就不再自动藏了
  if (fsHidden) fsOverride = true
  try { win.setOpacity(0) } catch {}
  win.showInactive()
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  fadeWindowOpacity(config.opacity ?? 1, 200)
  if (tray) tray.setToolTip('碧蓝桌宠 — 中键隐藏 / Ctrl+Alt+Z 切换')
}

/** 把窗口放回主屏右下角：显示器拔掉或拖丢时的救命入口 */
function resetPosition() {
  if (!win || win.isDestroyed()) return
  const area = screen.getPrimaryDisplay().workArea
  const [w, h] = win.getSize()
  win.setPosition(area.x + area.width - w - 32, area.y + area.height - h)
  console.log('[window] 位置已重置')
}

// 拔掉副屏后窗口可能落在已不存在的区域，自动收回来。
// 注意：screen 模块必须在 app ready 之后才能用，所以注册放在 whenReady 里。
function watchDisplayChanges() {
  screen.on('display-removed', () => {
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    const [w, h] = win.getSize()
    const p = clampToDisplay(x, y, w, h)
    if (p.x !== x || p.y !== y) {
      win.setPosition(p.x, p.y)
      console.log('[window] 显示器变更，已收回可见区域')
    }
  })
}

function togglePet() {
  if (!win) return
  if (win.isVisible()) hidePet()
  else showPet()
}

ipcMain.on('pet:hide', () => hidePet())
ipcMain.on('pet:choose-assets', () => chooseAssetsDir())

// ---- 鼠标穿透：用主进程轮询全局光标位置，不依赖渲染层 mousemove ----
// 渲染层把「模型矩形 + HUD 矩形」发上来，主进程按屏幕坐标判定，避免 mousemove 丢事件时
// 窗口还处于穿透状态导致中键点到下层窗口（DSH 页面自动滚动）。
let interactive = []
let lastInside = null
let hoverTimer = null

ipcMain.on('pet:interactive', (_e, rects) => {
  interactive = Array.isArray(rects) ? rects : []
})

// 像素探测结果：渲染层读光标处 alpha 后回传，决定这个点能不能点
let pixelOpaque = true
let pixelAt = 0
let probeSent = { x: -9999, y: -9999, at: 0 }
let lastProbeLogAt = 0
let hitSwitchCount = 0
let hitSwitchLoggedAt = 0
let pendingInside = null
let pendingSince = 0

ipcMain.on('pet:pixel-result', (_e, opaque) => {
  pixelOpaque = !!opaque
  pixelAt = Date.now()
})

/** 视线跟随状态：光标坐标、最后活动时间、是否已回正 */
let lastFocus = { x: -1, y: -1, at: 0, idle: false }

/**
 * 把光标在窗口内的坐标发给渲染层，让她转头看鼠标。
 * 只在坐标真的变化（超过 1px）时发；3 秒不动或离得太远就回正前方。
 */
function updateFocus(lx, ly, bw, bh) {
  if (!win || win.isDestroyed() || !bw || !bh) return
  const now = Date.now()
  const cx = bw / 2
  const cy = bh / 2

  if (Math.abs(lx - lastFocus.x) > 1 || Math.abs(ly - lastFocus.y) > 1) {
    lastFocus = { x: lx, y: ly, at: now, idle: false }
    // 离窗口超过 1.5 个屏宽就别转了，她看不见那么远
    const maxDist = screen.getPrimaryDisplay().workArea.width * 1.5
    const near = Math.hypot(lx - cx, ly - cy) < maxDist
    try {
      win.webContents.send('pet:focus', near ? { x: Math.round(lx), y: Math.round(ly) } : { x: Math.round(cx), y: Math.round(cy) })
    } catch {}
  } else if (!lastFocus.idle && now - lastFocus.at > 3000) {
    lastFocus.idle = true
    try { win.webContents.send('pet:focus', { x: Math.round(cx), y: Math.round(cy) }) } catch {}
  }
}

function startHoverWatch() {
  if (hoverTimer) clearInterval(hoverTimer)
  hoverTimer = setInterval(() => {
    if (!win || !win.isVisible() || win.isDestroyed()) return
    // 拖动过程中绝不能切换穿透：一旦切成忽略鼠标，pointermove 就断流，
    // 窗口会卡在原地，松手还可能被当成一次点击去播动作（看起来像突然放大）
    if (dragOrigin) return
    let inside = false
    let lx = 0
    let ly = 0
    let bw = 0
    let bh = 0
    try {
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      lx = p.x - b.x
      ly = p.y - b.y
      bw = b.width
      bh = b.height

      const hit = interactive.find((r) => lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h)
      if (!hit) {
        inside = false
      } else if (!hit.type || hit.type === 'hud' || hit.type === 'all') {
        // HUD 是 DOM、标定是整窗，都不需要像素判定
        inside = true
      } else {
        // 模型矩形：外接矩形里大把透明像素，问渲染层这个点画没画东西
        const now = Date.now()
        const moved = Math.abs(lx - probeSent.x) > 2 || Math.abs(ly - probeSent.y) > 2
        const stale = now - probeSent.at > 150 || now - pixelAt > 500
        if (moved || stale) {
          probeSent = { x: lx, y: ly, at: now }
          try { win.webContents.send('pet:probe-pixel', { x: Math.round(lx), y: Math.round(ly) }) } catch {}
          if (now - lastProbeLogAt > 2000) {
            lastProbeLogAt = now
            console.log('[probe] 发送探测', Math.round(lx), Math.round(ly), 'moved=', moved, 'stale=', stale)
          }
        }
        inside = pixelOpaque
      }
    } catch { inside = false }

    // 迟滞：判定结果要连续保持 120ms 才真正切换穿透，
    // 否则在人物边缘来回擦过时会疯狂切换，还会被系统解释成点击
    const now2 = Date.now()
    if (inside !== lastInside) {
      if (pendingInside !== inside) {
        pendingInside = inside
        pendingSince = now2
      } else if (now2 - pendingSince >= 120) {
        lastInside = inside
        pendingInside = null
        hitSwitchCount++
        try { win.setIgnoreMouseEvents(!inside, { forward: true }) } catch {}
        try { win.webContents.send('pet:hover', inside) } catch {}
        if (now2 - hitSwitchLoggedAt > 5000) {
          hitSwitchLoggedAt = now2
          console.log('[hit] 穿透切换累计', hitSwitchCount, '次，当前', inside ? '可点' : '穿透')
        }
      }
    } else {
      pendingInside = null
    }
    updateFocus(lx, ly, bw, bh)
  }, 40)
}

/** 让用户挑 assets 目录，校验通过后保存并热切换，返回是否成功 */
async function chooseAssetsDir() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择 Live2D 模型目录（assets）',
    buttonLabel: '用这个目录',
    properties: ['openDirectory'],
    // 优先落在 exe 所在目录，用户一眼就能看到同级的 assets
    defaultPath: hasSkins(ASSETS)
      ? ASSETS
      : (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')) || app.getPath('home')),
  })
  if (canceled || !filePaths?.length) return false

  // 用户可能直接选 assets，也可能选了它的上一级
  const dir = [filePaths[0], path.join(filePaths[0], 'assets')].find(hasSkins)
  if (!dir) {
    await dialog.showMessageBox({
      type: 'warning',
      message: '这个目录里没有找到皮肤',
      detail: '需要是包含 <皮肤名>/<皮肤名>.model3.json 的 assets 目录。\n可以用 tools/fetch_all.mjs 下载。',
      buttons: ['知道了'],
    })
    return false
  }

  ASSETS = dir
  config.assetsDir = dir
  const list = scanSkins()
  if (!list.includes(config.skin) && list.length) config.skin = list[0]
  saveConfig()
  console.log('[assets] 已切换 ->', dir, '共', list.length, '个皮肤')
  if (win && !win.isDestroyed()) {
    win.webContents.send('pet:assets-changed', skinRelPath(config.skin))
  }
  return true
}

/** 托盘图标：优先用打进 asar 的内置图标，assets 里的仅作回退 */
function trayIcon() {  for (const p of [path.join(ROOT, 'src', 'tray_32.png'), path.join(ASSETS, 'tray_32.png')]) {
    try {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) return img
    } catch {}
  }
  return nativeImage.createEmpty()
}

function createTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('碧蓝桌宠 — 点我显示 / 隐藏')
  tray.on('click', togglePet)
  tray.on('double-click', () => win?.showInactive())
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: togglePet },
    { label: '选择皮肤…', click: () => openSkinsWindow() },
    { label: '用量明细…', click: () => openUsageWindow() },
    { label: '重置位置', click: resetPosition },
    {
      label: '全屏时自动让位',
      type: 'checkbox',
      checked: config.hideOnFullscreen !== false,
      click: (mi) => { config.hideOnFullscreen = mi.checked; saveConfig() },
    },
    { type: 'separator' },
    { label: '选择皮肤目录…', click: () => chooseAssetsDir() },
    { label: '退出', click: () => app.quit() },
  ]))
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea
  const auto = autoSize(area)
  const width = config.window?.width || auto.width
  const height = config.window?.height || auto.height
  const marginRight = config.window?.marginRight ?? 32
  const marginBottom = config.window?.marginBottom ?? 0

  win = new BrowserWindow({
    width,
    height,
    x: area.x + area.width - width - marginRight,
    y: area.y + area.height - height - marginBottom,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    // Windows 上无边框窗口默认带 WS_THICKFRAME，HWND 会比 getBounds 大 16x8 DIP，
    // 拖动时这个偏差会被放大成「越拖越大」。关掉后尺寸才精确等于请求值。
    thickFrame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(path.join(ROOT, 'src', 'index.html'))

  // 默认整窗穿透：鼠标事件转发进来，命中模型后再关掉穿透
  win.setIgnoreMouseEvents(true, { forward: true })

  const SNAPSHOT = SNAPSHOT_MODE
  if (!SNAPSHOT) {
    win.once('ready-to-show', () => {
      console.log('[win] ready-to-show，显示窗口')
      win.showInactive()
    })
  }
  win.on('closed', () => { win = null })

  // 隐藏时让渲染层停掉 ticker：透明窗口不会因为不可见就停止重绘，
  // 不显式暂停的话隐藏一晚上也在烧 CPU 和电。
  win.on('hide', () => {
    console.log('[win] hide 事件')
    if (win && !win.isDestroyed()) win.webContents.send('pet:visible', false)
  })
  win.on('show', () => {
    console.log('[win] show 事件，可见=', win?.isVisible())
    if (win && !win.isDestroyed()) win.webContents.send('pet:visible', true)
  })
  // 尺寸变化记一笔，用来抓「拖动后变大」这类问题（超过 2px 才记，避免 DPI 舍入刷屏）
  let lastLoggedSize = ''
  win.on('resize', () => {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    const tag = `${b.width}x${b.height}`
    if (tag === lastLoggedSize) return
    const [pw, ph] = lastLoggedSize.split('x').map(Number)
    if (lastLoggedSize && Math.abs(b.width - pw) <= 2 && Math.abs(b.height - ph) <= 2) return
    lastLoggedSize = tag
    console.log('[win] resize ->', tag)
  })

  // 把渲染进程的日志转到终端，方便排查
  // Electron 45+ 回调是 (event, params)；旧版是 (event, level, message, line, source)
  win.webContents.on('console-message', (_e, ...args) => {
    const p = args[0]
    if (p && typeof p === 'object') {
      console.log(`[renderer:${p.level}] ${p.message} (${p.sourceId}:${p.lineNumber})`)
    } else {
      const [level, message, line, source] = args
      console.log(`[renderer:${level}] ${message} (${source}:${line})`)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[load-fail]', code, desc, url)
  })

  // --snapshot：后台渲染截图再退出（窗口不显示，不打扰桌面）
  if (SNAPSHOT) {
    // PET_BENCH_SWITCH=N：每 2 秒换一个皮肤共 N 次，用来验证切换后渲染与纹理回收
    const switchTimes = Number(process.env.PET_BENCH_SWITCH || 0)
    if (switchTimes > 0) {
      let i = 0
      const timer = setInterval(() => {
        const list = scanSkins().filter((s) => s !== config.skin)
        const other = list[i % Math.max(1, list.length)]
        if (other && win) {
          console.log(`[bench] 切换 ${i + 1}/${switchTimes} ->`, other)
          win.webContents.send('pet:skin-changed', skinRelPath(other))
        }
        if (++i >= switchTimes) clearInterval(timer)
      }, 2000)
    }
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        let blank = false
        try {
          const img = await win.webContents.capturePage()
          const out = app.isPackaged
            ? path.join(app.getPath('userData'), 'snapshot.png')
            : path.join(ROOT, 'snapshot.png')
          fs.mkdirSync(path.dirname(out), { recursive: true })
          const buf = img.toPNG()
          fs.writeFileSync(out, buf)
          // 空白截图（模型没渲染出来）是这轮踩过的坑，让流程自己盯住
          if (buf.length < 30 * 1024) {
            blank = true
            console.error('[snapshot] 疑似空白：', out, buf.length, 'bytes')
          } else {
            console.log('[snapshot] saved ->', out, buf.length, 'bytes')
          }
        } catch (e) {
          console.error('[snapshot] failed', e)
        }
        // PET_BENCH_HIDE=1：截图后隐藏窗口再观察 9 秒，用来量隐藏态是否真的停渲染
        if (process.env.PET_BENCH_HIDE === '1') {
          console.log('[bench] 隐藏窗口，观察 9 秒')
          win.hide()
          setTimeout(() => app.quit(), 9000)
        } else if (blank) {
          app.exit(1)   // 非零退出码，让脚本/CI 能感知截图异常
        } else {
          app.quit()
        }
      }, Number(process.env.PET_SNAP_DELAY || 6000))
    })
  }

  startHoverWatch()
  startActivityWatch()
  applyAppearance()
}

// ---- 鼠标穿透 ------------------------------------------------------------
// 渲染层仍可主动上报（拖动等场景），但主力是主进程轮询光标位置
ipcMain.on('pet:hit', (_e, hit) => {
  if (!win) return
  lastInside = hit
  win.setIgnoreMouseEvents(!hit, { forward: true })
})

// ---- 拖动 ---------------------------------------------------------------
let dragOrigin = null
let dragSize = null   // 拖动开始时锁定的尺寸

ipcMain.on('pet:drag-start', (_e, { x, y }) => {
  if (!win) return
  const [wx, wy] = win.getPosition()
  const [w, h] = win.getSize()
  dragOrigin = { mx: x, my: y, wx, wy }
  dragSize = { w, h }
  console.log('[drag] 开始', `${w}x${h}`, '@', wx, wy)
})
ipcMain.on('pet:drag-move', (_e, { x, y, clamp }) => {
  if (!win || !dragOrigin || !dragSize) return
  let nx = dragOrigin.wx + (x - dragOrigin.mx)
  let ny = dragOrigin.wy + (y - dragOrigin.my)
  if (clamp) {
    const p = clampToDisplay(Math.round(nx), Math.round(ny), dragSize.w, dragSize.h)
    nx = p.x
    ny = p.y
  }
  // 必须用 setBounds 并带上锁定的宽高：Windows + DPI 缩放下 setPosition
  // 会让窗口尺寸每帧漂移 1px，拖几秒就从小桌宠长成半个屏幕
  win.setBounds({
    x: Math.round(nx),
    y: Math.round(ny),
    width: dragSize.w,
    height: dragSize.h,
  })
})
ipcMain.on('pet:drag-end', () => {
  dragOrigin = null
  dragSize = null
  lastInside = null   // 强制下一轮重新判定穿透
  // 兜底：拖动期间万一窗口尺寸被系统改掉，按配置恢复一次
  applyAppearance()
  snapToEdge()
})

/** 松手后贴近屏幕边缘 16px 内就吸过去，120ms 缓动，别让窗口卡在半路 */
function snapToEdge() {
  if (!win || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  const [w, h] = win.getSize()
  const area = workAreaAt(x + w / 2, y + h / 2)
  const M = 16
  let nx = x
  let ny = y
  if (Math.abs(x - area.x) < M) nx = area.x
  else if (Math.abs(area.x + area.width - (x + w)) < M) nx = area.x + area.width - w
  if (Math.abs(y - area.y) < M) ny = area.y
  else if (Math.abs(area.y + area.height - (y + h)) < M) ny = area.y + area.height - h
  if (nx === x && ny === y) return

  const sx = x
  const sy = y
  const start = Date.now()
  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(timer)
    const t = Math.min(1, (Date.now() - start) / 120)
    const e = 1 - Math.pow(1 - t, 3)   // easeOutCubic
    win.setBounds({
      x: Math.round(sx + (nx - sx) * e),
      y: Math.round(sy + (ny - sy) * e),
      width: w,
      height: h,
    })
    if (t >= 1) clearInterval(timer)
  }, 16)
  console.log('[drag] 吸附到边缘', nx, ny)
}

// ---- 退出 ---------------------------------------------------------------
ipcMain.on('pet:quit', () => app.quit())
// ---- 手动播放动作 --------------------------------------------------------
/** 读当前皮肤的动作组（直接看 motions 目录，比等模型加载完更稳） */
function scanMotionGroups(skin) {
  try {
    return fs.readdirSync(path.join(ASSETS, skin, 'motions'))
      .filter((f) => f.endsWith('.motion3.json'))
      .map((f) => f.replace('.motion3.json', ''))
      // 按数字序号排，否则 touch_drag10 会排在 touch_drag2 前面
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  } catch { return [] }
}

function playMotion(key) {
  if (!win || win.isDestroyed()) return
  win.webContents.send('pet:motion', key)
  console.log('[motion] 手动播放', key)
}

/** 动作菜单：常用的直接列，编号多的收进子菜单 */
function buildMotionMenu() {
  const all = scanMotionGroups(config.skin)
  if (!all.length) return [{ label: '（当前皮肤没有动作文件）', enabled: false }]

  const isDrag = (g) => /^touch_drag\d*$/.test(g)
  const isTouchIdle = (g) => /^touch_idle\d+$/.test(g)
  const isMain = (g) => /^main_\d+$/.test(g)
  const story = ['login', 'home', 'mail', 'mission', 'mission_complete', 'complete', 'effect', 'wedding']

  const drags = all.filter(isDrag)
  const touchIdles = all.filter(isTouchIdle)
  const mains = all.filter(isMain)
  const stories = story.filter((s) => all.includes(s))

  const item = (g) => ({ label: g, click: () => playMotion(g) })

  const items = [
    { label: '选择动作…', click: () => openMotionsWindow() },
    { type: 'separator' },
    { label: '待机 idle', click: () => playMotion('idle') },
    { label: '摸头 touch_head', click: () => playMotion('touch_head') },
    { label: '摸身体 touch_body', click: () => playMotion('touch_body') },
    { label: '特殊 touch_special', click: () => playMotion('touch_special') },
  ]

  if (mains.length) {
    items.push({ type: 'separator' })
    items.push({ label: `待机变化（${mains.length}）`, submenu: mains.map(item) })
  }
  if (drags.length) {
    items.push({ type: 'separator' })
    items.push({ label: `拖动动作（${drags.length}）`, submenu: drags.map(item) })
  }
  if (stories.length) {
    items.push({ type: 'separator' })
    items.push({ label: `剧情 / 其他（${stories.length}）`, submenu: stories.map(item) })
  }
  if (touchIdles.length) {
    items.push({
      label: `触摸待机（${touchIdles.length}）`,
      submenu: touchIdles.map(item),
    })
  }
  return items
}

ipcMain.on('pet:menu', () => {
  if (!win) return
  const skins = scanSkins()
  const current = config.skin

  // 239 个皮肤直接铺一个菜单太长，按首字母分组
  const groups = {}
  for (const s of skins) {
    const k = s[0].toUpperCase()
    ;(groups[k] ??= []).push(s)
  }
  const skinMenu = Object.keys(groups).sort().map((k) => ({
    label: `${k}  (${groups[k].length})`,
    submenu: groups[k].map((s) => ({
      label: skinLabel(s) + (s === current ? '  ✓' : ''),
      click: () => setSkin(s),
    })),
  }))

  // 最近用过的放最上面，省得每次都翻字母
  const recent = (Array.isArray(config.recent) ? config.recent : []).filter((s) => skins.includes(s))
  const recentMenu = recent.length
    ? [{
        label: '最近使用',
        submenu: recent.map((s) => ({
          label: skinLabel(s) + (s === current ? '  ✓' : ''),
          click: () => setSkin(s),
        })),
      }, { type: 'separator' }]
    : []

  Menu.buildFromTemplate([
    { label: '搜索皮肤…', click: () => openSkinsWindow() },
    { type: 'separator' },
    { label: `切换皮肤（${skins.length} 个）`, submenu: [...recentMenu, ...(skinMenu.length ? skinMenu : [{ label: '（无）', enabled: false }])] },
    {
      label: '显示模式',
      submenu: ['auto', 'contain', 'cover'].map((m) => ({
        label: { auto: '自动', contain: '完整显示', cover: '铺满裁切' }[m] + (config.fit === m ? '  ✓' : ''),
        click: () => {
          config.fit = m
          saveConfig()
          if (win) win.webContents.send('pet:fit-changed', m)
        },
      })),
    },
    {
      label: '动作',
      submenu: buildMotionMenu(),
    },
    {
      label: '外观',
      submenu: [
        {
          label: '透明度',
          submenu: [1, 0.9, 0.8, 0.7, 0.6].map((v) => ({
            label: `${Math.round(v * 100)}%` + (Math.abs((config.opacity ?? 1) - v) < 0.01 ? '  ✓' : ''),
            click: () => { config.opacity = v; saveConfig(); applyAppearance() },
          })),
        },
        {
          label: '大小',
          submenu: [0.7, 0.85, 1, 1.2, 1.5].map((v) => ({
            label: ({ 0.7: '小', 0.85: '较小', 1: '标准', 1.2: '较大', 1.5: '大' }[v]) +
              (Math.abs((config.sizeScale ?? 1) - v) < 0.01 ? '  ✓' : ''),
            click: () => { config.sizeScale = v; saveConfig(); applyAppearance() },
          })),
        },
        {
          label: '始终置顶',
          type: 'checkbox',
          checked: config.alwaysOnTop !== false,
          click: (mi) => { config.alwaysOnTop = mi.checked; saveConfig(); applyAppearance() },
        },
        {
          label: '气泡提示',
          type: 'checkbox',
          checked: config.bubble !== false,
          click: (mi) => {
            config.bubble = mi.checked
            saveConfig()
            if (win) win.webContents.send('pet:bubble', mi.checked)
          },
        },
        {
          label: 'HUD 显示',
          submenu: [
            ['always', '常显'],
            ['hover', '悬停时显示'],
            ['off', '隐藏'],
          ].map(([v, label]) => ({
            label: label + ((config.hud ?? 'always') === v ? '  ✓' : ''),
            click: () => {
              config.hud = v
              saveConfig()
              if (win) win.webContents.send('pet:hud', v)
            },
          })),
        },
        { type: 'separator' },
        {
          label: '开机自启',
          type: 'checkbox',
          checked: !!config.autoStart,
          click: (mi) => { config.autoStart = mi.checked; saveConfig(); applyAutoStart() },
        },
      ],
    },
    {
      label: '触摸区',
      submenu: [
        { label: '开始标定…', click: () => { if (win) win.webContents.send('pet:calibrate') } },
        {
          label: '清除当前皮肤标定',
          click: () => {
            try {
              for (const f of [hitAreasFile(config.skin), legacyHitAreasFile(config.skin)]) {
                if (fs.existsSync(f)) fs.unlinkSync(f)
              }
              console.log('[calibrate] 已清除', config.skin)
            } catch {}
            if (win) win.webContents.send('pet:hitareas-cleared')
          },
        },
      ],
    },
    { type: 'separator' },
    { label: '重新加载', click: () => win.reload() },
    { label: '重置位置', click: resetPosition },
    { label: '打开配置', click: () => require('electron').shell.openPath(CONFIG_FILE) },
    { label: '打开日志', click: () => require('electron').shell.openPath(fs.existsSync(logPath()) ? logPath() : app.getPath('userData')) },
    { label: '打开皮肤目录', click: () => require('electron').shell.openPath(ASSETS) },
    { label: '选择皮肤目录…', click: () => chooseAssetsDir() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]).popup({ window: win })
})

ipcMain.handle('pet:skin', () => skinRelPath(config.skin))
ipcMain.handle('pet:skin-label', () => SKIN_NAMES[config.skin]?.label || null)
ipcMain.handle('pet:skins', () => scanSkins())
ipcMain.handle('pet:fit', () => config.fit ?? 'auto')

// ---- 触摸区标定 ----------------------------------------------------------
// 标定数据放 userData 而不是 assets：assets 是 5 GB 资源目录，
// 重下皮肤会连标定一起删掉，目录只读时还会写失败。
function hitAreasDir() {
  return path.join(app.getPath('userData'), 'hitareas')
}

function hitAreasFile(skin) {
  return path.join(hitAreasDir(), `${skin}.json`)
}

/** 旧版本把标定写在 assets/<skin>/hitareas.json，读取时兼容一下 */
function legacyHitAreasFile(skin) {
  return path.join(ASSETS, skin, 'hitareas.json')
}

ipcMain.handle('pet:hitareas', (_e, skin) => {
  for (const f of [hitAreasFile(skin), legacyHitAreasFile(skin)]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  }
  return null
})

ipcMain.handle('pet:save-hitareas', (_e, skin, data) => {
  try {
    fs.mkdirSync(hitAreasDir(), { recursive: true })
    fs.writeFileSync(hitAreasFile(skin), JSON.stringify(data, null, 2), 'utf8')
    console.log('[calibrate] 已保存', skin, JSON.stringify(data.anchors))
    return { ok: true }
  } catch (e) {
    console.error('[calibrate] 保存失败', e.message)
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('pet:clear-hitareas', (_e, skin) => {
  try {
    for (const f of [hitAreasFile(skin), legacyHitAreasFile(skin)]) {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
    return { ok: true }
  } catch (e) { return { ok: false, error: e.message } }
})

// ---- 皮肤加载结果：记住能用的，坏了自动退回 ---------------------------------
ipcMain.on('pet:skin-ok', (_e, skin) => {
  if (skin && config.lastGoodSkin !== skin) {
    config.lastGoodSkin = skin
    saveConfig()
  }
})

let fallbackTried = 0
ipcMain.on('pet:skin-failed', (_e, skin) => {
  if (!win) return
  const list = scanSkins().filter((s) => s !== skin)
  if (!list.length) {
    console.warn('[fallback] 没有其他皮肤可用')
    return
  }
  if (fallbackTried >= 3) {
    console.warn('[fallback] 连续失败，停止自动切换')
    // 兜底也失败（多半是 assets 目录被移走了），让渲染层把自救卡片亮出来
    try { win.webContents.send('pet:no-skins') } catch {}
    return
  }
  fallbackTried++
  const prefer = config.lastGoodSkin && list.includes(config.lastGoodSkin)
    ? config.lastGoodSkin
    : list.includes('lafei_4') ? 'lafei_4' : list[0]
  console.log(`[fallback] ${skin} 加载失败 → 切到 ${prefer}`)
  config.skin = prefer
  saveConfig()
  win.webContents.send('pet:skin-changed', skinRelPath(prefer))
})

// ---- 全屏应用检测 --------------------------------------------------------
// 用 shell32 的 SHQueryUserNotificationState 判断系统是否处于「D3D 全屏」或
// 「演示模式」，是的话自动让位，别压在全屏视频/游戏/PPT 上面。
let fsProbe = null
let fsHidden = false
let fsOverride = false   // 用户在全屏期间手动叫出来，就不再自动藏

function initFullscreenProbe() {
  try {
    const koffi = require('koffi')
    const shell32 = koffi.load('shell32.dll')
    fsProbe = {
      query: shell32.func('int SHQueryUserNotificationState(int *pquns)'),
      buf: new Int32Array(1),
    }
    console.log('[fullscreen] 全屏检测已启用')
    return true
  } catch (e) {
    console.warn('[fullscreen] 全屏检测不可用:', e.message)
    return false
  }
}

function isFullscreenApp() {
  if (!fsProbe) return false
  try {
    if (fsProbe.query(fsProbe.buf) !== 0) return false
    const s = fsProbe.buf[0]
    return s === 3 || s === 4   // QUNS_RUNNING_D3D_FULL_SCREEN / QUNS_PRESENTATION_MODE
  } catch { return false }
}

function startFullscreenWatch() {
  if (!initFullscreenProbe()) return
  setInterval(() => {
    if (!win || win.isDestroyed()) return
    if (config.hideOnFullscreen === false) { fsHidden = false; return }
    const fs = isFullscreenApp()
    if (fs === fsHidden) return
    if (fs && !fsOverride) {
      fsHidden = true
      console.log('[fullscreen] 检测到全屏应用，暂时让位')
      fadeWindowOpacity(0, 180).then(() => {
        if (win && !win.isDestroyed()) {
          win.hide()
          try { win.setOpacity(config.opacity ?? 1) } catch {}
        }
      })
    } else if (!fs) {
      fsHidden = false
      fsOverride = false
      if (!hiddenByUser) {
        console.log('[fullscreen] 全屏结束，恢复显示')
        try { win.setOpacity(0) } catch {}
        win.showInactive()
        fadeWindowOpacity(config.opacity ?? 1, 200)
      }
    }
  }, 3000)
}

// ---- DSH 活动状态（用于待机动作节奏）--------------------------------------
const SESSIONS_ROOT = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'sessions')
  : path.join(require('node:os').homedir(), '.dsh', 'sessions')
const ACTIVE_WINDOW_MS = 20000

/** 扫最近被写过的会话文件（只看目录 + stat，不解压） */
function latestSessionFile() {
  let best = { mtime: 0, file: null }
  let workspaces = []
  try { workspaces = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }) } catch { return best }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    const wsPath = path.join(SESSIONS_ROOT, ws.name)
    let subs = []
    try { subs = fs.readdirSync(wsPath, { withFileTypes: true }) } catch { continue }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue
      const f = path.join(wsPath, sub.name, 'session.v4.jsonl.zstd')
      try {
        const st = fs.statSync(f)
        if (st.mtimeMs > best.mtime) best = { mtime: st.mtimeMs, file: f }
      } catch {}
    }
  }
  return best
}

/**
 * 只读会话文件尾部，解出最后一条事件类型。
 * 目的是把「DSH 正在活动」细分到 思考/执行工具/回复/等待输入，
 * 用来切不同的待机动作，所以不需要全量解析。
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const zlib = require('node:zlib')

function readLastEventType(file) {
  try {
    const st = fs.statSync(file)
    const size = Math.min(st.size, 128 * 1024)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size)
    try { fs.readSync(fd, buf, 0, size, st.size - size) } finally { fs.closeSync(fd) }

    const idx = buf.lastIndexOf(ZSTD_MAGIC)
    if (idx < 0) return null
    const text = zlib.zstdDecompressSync(buf.subarray(idx)).toString('utf8')
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const o = JSON.parse(line)
        if (o.type) return o.type
      } catch {}
    }
  } catch {}
  return null
}

let lastActive = null
let lastStateType = null
let lastStateAt = 0
const STATE_MIN_GAP = 5000   // 状态切换最小间隔，别让动作一直被打断

function startActivityWatch() {
  setInterval(() => {
    if (!win || win.isDestroyed()) return
    const { mtime, file } = latestSessionFile()
    const active = mtime > 0 && (Date.now() - mtime) < ACTIVE_WINDOW_MS
    if (active !== lastActive) {
      lastActive = active
      console.log('[activity]', active ? 'DSH 正在活动' : '空闲')
      try { win.webContents.send('pet:activity', active) } catch {}
    }

    // 活动时再细分阶段，让待机动作跟着 DSH 在干什么走
    if (active && file) {
      const type = readLastEventType(file)
      const now = Date.now()
      if (type && type !== lastStateType && now - lastStateAt > STATE_MIN_GAP) {
        lastStateType = type
        lastStateAt = now
        console.log('[activity] 状态 →', type)
        try { win.webContents.send('pet:state', type) } catch {}
      }
    }
  }, 2500)
}

// ---- DSH token 用量 ------------------------------------------------------
function readUsage(opts = {}) {
  const args = [USAGE_SCRIPT, '--json']
  if (opts.today) args.push('--today')
  else args.push('--days', String(opts.days ?? 14))

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      {
        // 缓存落到 userData：portable 版每次解压到新临时目录，只有 userData 是持久的
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DSH_USAGE_CACHE_DIR: app.getPath('userData'),
        },
        timeout: 60000,
      },
      (err, stdout, stderr) => {
        if (err) {
          console.error('[usage] 执行失败:', err.message, stderr?.slice(0, 300))
          return resolve({ error: String(err.message || err) })
        }
        try {
          const data = JSON.parse(stdout)
          console.log('[usage] ok today=', JSON.stringify(data.today), 'parsed=', data.parsed)
          resolve(data)
        } catch (e) {
          console.error('[usage] 解析失败:', e.message, stdout?.slice(0, 300))
          resolve({ error: 'parse: ' + e.message })
        }
      },
    )
  })
}
ipcMain.handle('pet:usage', () => readUsage({ today: true }))
ipcMain.handle('pet:usage-detail', () => readUsage({ days: 14 }))

// ---- 用量明细窗口 --------------------------------------------------------
let usageWin = null

function openUsageWindow() {
  if (usageWin && !usageWin.isDestroyed()) {
    usageWin.show()
    usageWin.focus()
    return
  }
  usageWin = new BrowserWindow({
    width: 472,
    height: 668,
    minWidth: 420,
    minHeight: 460,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#10131b',
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  usageWin.loadFile(path.join(ROOT, 'src', 'usage.html'))
  usageWin.once('ready-to-show', () => usageWin.show())
  usageWin.on('closed', () => { usageWin = null })
}

ipcMain.on('pet:open-usage', () => openUsageWindow())
ipcMain.on('pet:close-usage', () => { if (usageWin && !usageWin.isDestroyed()) usageWin.close() })

// ---- 皮肤选择窗口（带搜索 / 收藏）-----------------------------------------
let skinsWin = null

function skinsDetail() {
  const favs = Array.isArray(config.favorites) ? config.favorites : []
  const recents = Array.isArray(config.recent) ? config.recent : []
  return scanSkins().map((dir) => ({
    dir,
    label: SKIN_NAMES[dir]?.label || dir,
    fav: favs.includes(dir),
    recent: recents.includes(dir),
    current: dir === config.skin,
  }))
}

/** 统一的切皮肤入口：菜单、搜索窗口、快捷键都走这里 */
function setSkin(dir) {
  if (!dir || !scanSkins().includes(dir)) return false
  config.skin = dir
  rememberRecent(dir)
  saveConfig()
  fallbackTried = 0
  if (win && !win.isDestroyed()) win.webContents.send('pet:skin-changed', skinRelPath(dir))
  console.log('[skin] 已切换 ->', dir)
  return true
}

ipcMain.handle('pet:skins-detail', () => skinsDetail())
ipcMain.handle('pet:set-skin', (_e, dir) => ({ ok: setSkin(dir) }))

/** 查某个动作的时长（login 出场要用，各皮肤从 3.8 秒到 31.8 秒不等） */
ipcMain.handle('pet:motion-duration', (_e, group) => {
  try {
    const p = path.join(ASSETS, config.skin, 'motions', `${group}.motion3.json`)
    return JSON.parse(fs.readFileSync(p, 'utf8')).Meta?.Duration ?? 0
  } catch { return 0 }
})

ipcMain.handle('pet:toggle-fav', (_e, dir) => {
  const list = Array.isArray(config.favorites) ? [...config.favorites] : []
  const i = list.indexOf(dir)
  if (i >= 0) list.splice(i, 1)
  else list.unshift(dir)
  config.favorites = list.slice(0, 40)
  saveConfig()
  return { ok: true, fav: config.favorites.includes(dir) }
})

function openSkinsWindow() {
  if (skinsWin && !skinsWin.isDestroyed()) {
    skinsWin.show()
    skinsWin.focus()
    return
  }
  skinsWin = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 460,
    minHeight: 420,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#10131b',
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  skinsWin.loadFile(path.join(ROOT, 'src', 'skins.html'))
  skinsWin.once('ready-to-show', () => skinsWin.show())
  skinsWin.on('closed', () => { skinsWin = null })
}

ipcMain.on('pet:open-skins', () => openSkinsWindow())
ipcMain.on('pet:close-skins', () => { if (skinsWin && !skinsWin.isDestroyed()) skinsWin.close() })

// ---- 动作选择窗口 --------------------------------------------------------
let motionsWin = null

const MOTION_LABELS = {
  idle: '待机',
  touch_head: '摸头',
  touch_body: '摸身体',
  touch_special: '特殊触摸',
  main_1: '待机动作 1',
  main_2: '待机动作 2',
  main_3: '待机动作 3',
  login: '登场 / 登录',
  home: '主页',
  mail: '邮件',
  mission: '任务',
  mission_complete: '任务完成',
  complete: '完成',
  effect: '特效',
  wedding: '誓约',
}

function motionKind(key) {
  if (/^touch_drag/.test(key)) return 'drag'
  if (/^touch_idle\d/.test(key)) return 'touchIdle'
  if (/^main_\d/.test(key)) return 'main'
  if (['login', 'home', 'mail', 'mission', 'mission_complete', 'complete', 'effect', 'wedding'].includes(key)) return 'story'
  return 'common'
}

function motionsDetail() {
  return scanMotionGroups(config.skin).map((key) => ({
    key,
    label: MOTION_LABELS[key] || key,
    kind: motionKind(key),
  }))
}

ipcMain.handle('pet:motions-detail', () => motionsDetail())
ipcMain.on('pet:play-motion', (_e, key) => playMotion(key))

function openMotionsWindow() {
  if (motionsWin && !motionsWin.isDestroyed()) {
    motionsWin.show()
    motionsWin.focus()
    return
  }
  motionsWin = new BrowserWindow({
    width: 520,
    height: 620,
    minWidth: 420,
    minHeight: 380,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#10131b',
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  motionsWin.loadFile(path.join(ROOT, 'src', 'motions.html'))
  motionsWin.once('ready-to-show', () => motionsWin.show())
  motionsWin.on('closed', () => { motionsWin = null })
}

ipcMain.on('pet:open-motions', () => openMotionsWindow())
ipcMain.on('pet:close-motions', () => { if (motionsWin && !motionsWin.isDestroyed()) motionsWin.close() })
ipcMain.handle('pet:config', () => config)

// 启动时预跑一次，顺便把结果打到终端，便于确认取数链路
readUsage().then((r) => console.log('[usage:boot]', JSON.stringify(r).slice(0, 260)))

// ---- 余额 ---------------------------------------------------------------
function fetchBalance() {
  return new Promise((resolve) => {
    const key = config.deepseek?.apiKey
    if (!key) return resolve({ error: 'config.json 里还没填 deepseek.apiKey' })
    const req = https.get(
      `${config.deepseek.baseUrl}/user/balance`,
      { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, timeout: 10000 },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            const j = JSON.parse(body)
            if (!j.is_available) return resolve({ error: '账户不可用' })
            const info = j.balance_infos?.[0] ?? {}
            resolve({ currency: info.currency ?? 'CNY', total: Number(info.total_balance ?? 0) })
          } catch (e) { resolve({ error: 'parse: ' + e.message }) }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('超时')))
    req.on('error', (e) => {
      console.error('[balance] 失败:', e.message)
      resolve({ error: e.message })
    })
  })
}
ipcMain.handle('pet:balance', () => fetchBalance())

// ---- 生命周期 -----------------------------------------------------------
/** 单实例：第二次双击直接把已有桌宠叫出来，避免开出两只各烧一份资源。
 *  SNAPSHOT/测试要并行跑时用 PET_ALLOW_MULTI=1 放行。 */
const ALLOW_MULTI = process.env.PET_ALLOW_MULTI === '1'
if (!ALLOW_MULTI && !app.requestSingleInstanceLock()) {
  app.quit()
}
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return
  showPet()
  win.focus()
})

/** 全局快捷键：中键隐藏之后，键盘也能把她叫回来 */
const ACCELERATOR = 'Control+Alt+Z'

function registerShortcuts() {
  try {
    const ok = globalShortcut.register(ACCELERATOR, () => {
      if (!win || win.isDestroyed()) return
      if (win.isVisible()) hidePet()
      else showPet()
    })
    console.log('[shortcut]', ACCELERATOR, ok ? '已注册' : '注册失败（可能被占用）')
    if (!ok && tray) {
      tray.setToolTip('碧蓝桌宠 — Ctrl+Alt+Z 被占用，请用托盘图标')
      try {
        tray.displayBalloon({
          title: '快捷键被占用',
          content: 'Ctrl+Alt+Z 已被其他程序占用，暂时用托盘图标或右键菜单操作。',
        })
      } catch {}
    }
  } catch (e) {
    console.warn('[shortcut] 注册失败', e.message)
  }
}

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll() } catch {}
})

app.whenReady().then(async () => {
  // 打包版默认落盘日志；开发版要开的话设 PET_LOG=1
  if (app.isPackaged || process.env.PET_LOG === '1') setupFileLog()

  console.log('[boot] config.deepseek.apiKey 长度 =', (config.deepseek?.apiKey || '').length)
  console.log('[boot] assets =', ASSETS, '皮肤数 =', scanSkins().length)
  fetchBalance().then((r) => console.log('[balance:boot]', JSON.stringify(r)))

  // 性能观测：PET_METRICS=1 时每 3 秒打印各进程 CPU（百分比，单核为 100）
  if (process.env.PET_METRICS === '1') {
    setInterval(() => {
      const rows = app.getAppMetrics()
        .map((m) => `${m.type}=${(m.cpu.percentCPUUsage ?? 0).toFixed(1)}%/${Math.round((m.memory?.workingSetSize ?? 0) / 1024)}MB`)
      console.log('[metrics]', rows.join(' '))
    }, 3000)
  }

  // 截图测试用：只渲染一个子页面（PET_SNAP_USAGE / PET_SNAP_SKINS），不开桌宠窗口
  const snapTarget = process.env.PET_SNAP_SKINS === '1' ? 'skins'
    : process.env.PET_SNAP_MOTIONS === '1' ? 'motions'
      : process.env.PET_SNAP_USAGE === '1' ? 'usage' : null
  if (SNAPSHOT_MODE && snapTarget) {
    const conf = snapTarget === 'skins'
      ? { html: 'skins.html', out: 'skins-snapshot.png', width: 560, height: 640 }
      : snapTarget === 'motions'
        ? { html: 'motions.html', out: 'motions-snapshot.png', width: 520, height: 620 }
        : { html: 'usage.html', out: 'usage-snapshot.png', width: 472, height: 668 }
    const w = new BrowserWindow({
      width: conf.width, height: conf.height, show: false, frame: false,
      backgroundColor: '#10131b',
      webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    })
    let shot = false
    const capture = async () => {
      if (shot) return
      shot = true
      await new Promise((r) => setTimeout(r, Number(process.env.PET_SNAP_WAIT || 3000)))
      try {
        // PET_SNAP_TAB=sessions 时切到会话页再截
        if (process.env.PET_SNAP_TAB) {
          await w.webContents.executeJavaScript(
            `document.querySelector('[data-tab="${process.env.PET_SNAP_TAB}"]')?.click()`,
          )
          await new Promise((r) => setTimeout(r, 400))
        }
        // PET_SNAP_QUERY=拉菲 时先填搜索框再截
        if (process.env.PET_SNAP_QUERY) {
          await w.webContents.executeJavaScript(`
            (() => {
              const q = document.getElementById('q')
              if (!q) return
              q.value = ${JSON.stringify(process.env.PET_SNAP_QUERY)}
              q.dispatchEvent(new Event('input'))
            })()
          `)
          await new Promise((r) => setTimeout(r, 300))
        }
        const img = await w.webContents.capturePage()
        const out = path.join(require('node:os').tmpdir(), conf.out)
        fs.writeFileSync(out, img.toPNG())
        console.log('[snapshot]', snapTarget, '->', out)
      } catch (e) { console.error('[snapshot]', snapTarget, 'failed', e.message) }
      app.quit()
    }
    // 事件可能比 loadFile 返回还早，先挂监听再加载
    w.webContents.once('did-finish-load', capture)
    w.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error('[snapshot] load failed', code, desc)
      app.quit()
    })
    w.loadFile(path.join(ROOT, 'src', conf.html))
    setTimeout(capture, 30000)   // 兜底，别让截图测试挂住
    return
  }

  // 打包版找不到皮肤时引导选目录：
  //  - 首次（没配过）弹一次
  //  - 之前配的目录失效了（用户移走/改名）也弹一次，弹完清掉失效配置免得反复骚扰
  if (!SNAPSHOT_MODE && !hasSkins(ASSETS)) {
    const staleDir = config.assetsDir
    if (!config.assetsPromptShown || staleDir) {
      config.assetsPromptShown = true
      if (staleDir) config.assetsDir = ''
      saveConfig()
      await chooseAssetsDir()
    }
  }

  createWindow()
  createTray()
  registerShortcuts()
  watchDisplayChanges()
  startFullscreenWatch()

  // 拖动路径自检：PET_BENCH_DRAG=1 时模拟 20 次拖动移动，检查尺寸会不会漂移
  if (process.env.PET_BENCH_DRAG === '1') {
    setTimeout(() => {
      if (!win || win.isDestroyed()) return
      const b0 = win.getBounds()
      console.log('[bench] 拖动前', `${b0.width}x${b0.height}`, `@${b0.x},${b0.y}`)
      ipcMain.emit('pet:drag-start', {}, { x: 600, y: 600 })
      for (let i = 1; i <= 20; i++) {
        ipcMain.emit('pet:drag-move', {}, { x: 600 + i * 5, y: 600 + i * 5, clamp: true })
      }
      const bMid = win.getBounds()
      console.log('[bench] 移动 20 次后', `${bMid.width}x${bMid.height}`)
      ipcMain.emit('pet:drag-end', {})
      const b1 = win.getBounds()
      console.log('[bench] 松手后', `${b1.width}x${b1.height}`, `@${b1.x},${b1.y}`)
    }, 6000)
  }

  // 后台预热 14 天用量缓存：首次点 HUD 打开明细窗口时就不用干等解压
  if (!SNAPSHOT_MODE) {
    setTimeout(() => { readUsage({ days: 14 }).catch(() => {}) }, 15000)
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => app.quit())
