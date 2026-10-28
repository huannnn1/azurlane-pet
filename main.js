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
  deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com' },
  usage: { refreshMinutes: 5, sessionOnly: false },
}

/** 当前生效的模型目录（loadConfig 之后由 resolveAssetsRoot 填充） */
let ASSETS = ''

/**
 * assets 目录解析，按优先级：
 *  1. 环境变量 PET_ASSETS（调试用）
 *  2. config.json 里用户上次选的 assetsDir（可分发版靠这个）
 *  3. 打包版：portable 的 exe 所在目录 / exe 同级 / exe 上一级 / userData
 *  4. 开发版：项目自带 assets
 */
function resolveAssetsRoot() {
  if (process.env.PET_ASSETS) return process.env.PET_ASSETS
  if (config?.assetsDir && fs.existsSync(config.assetsDir)) return config.assetsDir

  if (!app.isPackaged) return path.join(__dirname, 'assets')

  // portable 启动时 exe 会解压到 temp 运行，用户放 exe 的目录在 PORTABLE_EXECUTABLE_DIR
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  const exeDir = path.dirname(app.getPath('exe'))
  const candidates = [
    portableDir && path.join(portableDir, 'assets'),
    path.join(exeDir, 'assets'),
    path.join(exeDir, '..', 'assets'),
    path.join(app.getPath('userData'), 'assets'),
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  return path.join(portableDir || exeDir, 'assets')
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

/** 把外观相关配置应用到窗口 */function applyAppearance() {
  if (!win || win.isDestroyed()) return
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
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
  } catch {
    try {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8')
    } catch (e) {
      console.warn('[config] 无法写入配置文件，使用内存默认值:', e.message)
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
function hidePet() {
  if (!win || !win.isVisible()) return
  win.hide()
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
  win.showInactive()
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
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

function startHoverWatch() {
  if (hoverTimer) clearInterval(hoverTimer)
  hoverTimer = setInterval(() => {
    if (!win || !win.isVisible() || win.isDestroyed()) return
    let inside = false
    try {
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const lx = p.x - b.x
      const ly = p.y - b.y
      inside = interactive.some((r) => lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h)
    } catch { inside = false }
    if (inside !== lastInside) {
      lastInside = inside
      try { win.setIgnoreMouseEvents(!inside, { forward: true }) } catch {}
    }
  }, 40)
}

/** 让用户挑 assets 目录，校验通过后保存并热切换，返回是否成功 */
async function chooseAssetsDir() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '选择 Live2D 模型目录（assets）',
    buttonLabel: '用这个目录',
    properties: ['openDirectory'],
    defaultPath: fs.existsSync(ASSETS) ? ASSETS : app.getPath('home'),
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
  if (!SNAPSHOT) win.once('ready-to-show', () => win.showInactive())
  win.on('closed', () => { win = null })

  // 隐藏时让渲染层停掉 ticker：透明窗口不会因为不可见就停止重绘，
  // 不显式暂停的话隐藏一晚上也在烧 CPU 和电。
  win.on('hide', () => {
    if (win && !win.isDestroyed()) win.webContents.send('pet:visible', false)
  })
  win.on('show', () => {
    if (win && !win.isDestroyed()) win.webContents.send('pet:visible', true)
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
        try {
          const img = await win.webContents.capturePage()
          const out = app.isPackaged
            ? path.join(app.getPath('userData'), 'snapshot.png')
            : path.join(ROOT, 'snapshot.png')
          fs.mkdirSync(path.dirname(out), { recursive: true })
          fs.writeFileSync(out, img.toPNG())
          console.log('[snapshot] saved ->', out)
        } catch (e) {
          console.error('[snapshot] failed', e)
        }
        // PET_BENCH_HIDE=1：截图后隐藏窗口再观察 9 秒，用来量隐藏态是否真的停渲染
        if (process.env.PET_BENCH_HIDE === '1') {
          console.log('[bench] 隐藏窗口，观察 9 秒')
          win.hide()
          setTimeout(() => app.quit(), 9000)
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
ipcMain.on('pet:drag-start', (_e, { x, y }) => {
  if (!win) return
  const [wx, wy] = win.getPosition()
  dragOrigin = { mx: x, my: y, wx, wy }
})
ipcMain.on('pet:drag-move', (_e, { x, y, clamp }) => {
  if (!win || !dragOrigin) return
  let nx = dragOrigin.wx + (x - dragOrigin.mx)
  let ny = dragOrigin.wy + (y - dragOrigin.my)
  if (clamp) {
    const [w, h] = win.getSize()
    const p = clampToDisplay(Math.round(nx), Math.round(ny), w, h)
    nx = p.x
    ny = p.y
  }
  win.setPosition(Math.round(nx), Math.round(ny))
})
ipcMain.on('pet:drag-end', () => { dragOrigin = null })

// ---- 退出 ---------------------------------------------------------------
ipcMain.on('pet:quit', () => app.quit())
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

// ---- DSH 活动状态（用于待机动作节奏）--------------------------------------
const SESSIONS_ROOT = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'sessions')
  : path.join(require('node:os').homedir(), '.dsh', 'sessions')
const ACTIVE_WINDOW_MS = 20000

/** 扫最近被写过的会话文件时间戳（只看目录 + stat，不解压） */
function latestSessionMtime() {
  let latest = 0
  let workspaces = []
  try { workspaces = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }) } catch { return 0 }
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
        if (st.mtimeMs > latest) latest = st.mtimeMs
      } catch {}
    }
  }
  return latest
}

let lastActive = null
function startActivityWatch() {
  setInterval(() => {
    if (!win || win.isDestroyed()) return
    const latest = latestSessionMtime()
    const active = latest > 0 && (Date.now() - latest) < ACTIVE_WINDOW_MS
    if (active !== lastActive) {
      lastActive = active
      console.log('[activity]', active ? 'DSH 正在活动' : '空闲')
      try { win.webContents.send('pet:activity', active) } catch {}
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
    : process.env.PET_SNAP_USAGE === '1' ? 'usage' : null
  if (SNAPSHOT_MODE && snapTarget) {
    const conf = snapTarget === 'skins'
      ? { html: 'skins.html', out: 'skins-snapshot.png', width: 560, height: 640 }
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

  // 打包版第一次跑、又没找到皮肤：引导选目录（只自动打扰一次，之后走托盘菜单）
  if (!SNAPSHOT_MODE && !hasSkins(ASSETS) && !config.assetsPromptShown) {
    config.assetsPromptShown = true
    saveConfig()
    await chooseAssetsDir()
  }

  createWindow()
  createTray()
  registerShortcuts()
  watchDisplayChanges()

  // 后台预热 14 天用量缓存：首次点 HUD 打开明细窗口时就不用干等解压
  if (!SNAPSHOT_MODE) {
    setTimeout(() => { readUsage({ days: 14 }).catch(() => {}) }, 15000)
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => app.quit())
