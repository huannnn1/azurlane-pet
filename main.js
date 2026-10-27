const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const https = require('node:https')
const { execFile } = require('node:child_process')

const ROOT = __dirname
const USAGE_SCRIPT = path.join(ROOT, 'tools', 'dsh_usage.mjs')
const CONFIG_FILE = path.join(ROOT, 'config.json')

const DEFAULT_CONFIG = {
  // 窗口宽高留空 = 按屏幕自动算（约屏幕宽的 15%，高 1.5 倍，落在桌宠尺寸区间）
  window: { width: 0, height: 0, marginRight: 32, marginBottom: 0 },
  skin: 'lafei_4',
  fit: 'auto', // auto | contain | cover
  hintShown: false, // 首次隐藏时用气泡提示一次怎么恢复
  deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com' },
  usage: { refreshMinutes: 5, sessionOnly: false },
}

const ASSETS = path.join(__dirname, 'assets')

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

function skinRelPath(skin) {
  return `../assets/${skin}/${skin}.model3.json`
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
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2))
    return DEFAULT_CONFIG
  }
}

let win = null
let config = loadConfig()
let tray = null

// ---- 隐藏 / 恢复（中键隐藏，托盘图标恢复）--------------------------------
function hidePet() {
  if (!win || !win.isVisible()) return
  win.hide()
  if (tray) tray.setToolTip('碧蓝桌宠（已隐藏）— 点我恢复')
  if (tray && !config.hintShown) {
    try {
      tray.displayBalloon({ title: '桌宠已隐藏', content: '想找回来？点一下右下角托盘区的蓝色小圆点。' })
    } catch {}
    config.hintShown = true
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8') } catch {}
  }
}

function showPet() {
  if (!win) return
  win.showInactive()
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  if (tray) tray.setToolTip('碧蓝桌宠 — 中键隐藏')
}

function togglePet() {
  if (!win) return
  if (win.isVisible()) hidePet()
  else showPet()
}

ipcMain.on('pet:hide', () => hidePet())

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

function createTray() {
  const iconPath = path.join(ROOT, 'assets', 'tray_32.png')
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) image = nativeImage.createEmpty()
  tray = new Tray(image)
  tray.setToolTip('碧蓝桌宠 — 点我显示 / 隐藏')
  tray.on('click', togglePet)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: togglePet },
    { type: 'separator' },
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

  const SNAPSHOT = process.argv.includes('--snapshot')
  if (!SNAPSHOT) win.once('ready-to-show', () => win.showInactive())
  win.on('closed', () => { win = null })

  // 把渲染进程的日志转到终端，方便排查
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[renderer:${level}] ${message} (${source}:${line})`)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[load-fail]', code, desc, url)
  })

  // --snapshot：后台渲染截图再退出（窗口不显示，不打扰桌面）
  if (SNAPSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage()
          fs.writeFileSync(path.join(ROOT, 'snapshot.png'), img.toPNG())
          console.log('[snapshot] saved')
        } catch (e) {
          console.error('[snapshot] failed', e)
        }
        app.quit()
      }, 6000)
    })
  }

  startHoverWatch()
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
    const area = screen.getPrimaryDisplay().workArea
    const [w, h] = win.getSize()
    nx = Math.max(area.x, Math.min(nx, area.x + area.width - w))
    ny = Math.max(area.y, Math.min(ny, area.y + area.height - h))
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
      label: s + (s === current ? '  ✓' : ''),
      click: () => {
        config.skin = s
        try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8') } catch {}
        if (win) win.webContents.send('pet:skin-changed', skinRelPath(s))
      },
    })),
  }))

  Menu.buildFromTemplate([
    { label: `切换皮肤（${skins.length} 个）`, submenu: skinMenu.length ? skinMenu : [{ label: '（无）', enabled: false }] },
    {
      label: '显示模式',
      submenu: ['auto', 'contain', 'cover'].map((m) => ({
        label: { auto: '自动', contain: '完整显示', cover: '铺满裁切' }[m] + (config.fit === m ? '  ✓' : ''),
        click: () => {
          config.fit = m
          try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8') } catch {}
          if (win) win.webContents.send('pet:fit-changed', m)
        },
      })),
    },
    { type: 'separator' },
    { label: '重新加载', click: () => win.reload() },
    { label: '打开配置', click: () => require('electron').shell.openPath(CONFIG_FILE) },
    { label: '打开皮肤目录', click: () => require('electron').shell.openPath(ASSETS) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]).popup({ window: win })
})

ipcMain.handle('pet:skin', () => skinRelPath(config.skin))
ipcMain.handle('pet:skins', () => scanSkins())
ipcMain.handle('pet:fit', () => config.fit ?? 'auto')

// ---- DSH token 用量 ------------------------------------------------------
function readUsage() {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [USAGE_SCRIPT, '--json', '--days', '1'],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20000 },
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
ipcMain.handle('pet:usage', () => readUsage())
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
app.whenReady().then(() => {
  console.log('[boot] config.deepseek.apiKey 长度 =', (config.deepseek?.apiKey || '').length)
  fetchBalance().then((r) => console.log('[balance:boot]', JSON.stringify(r)))
  createWindow()
  createTray()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => app.quit())
