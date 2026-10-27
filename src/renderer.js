/* 桌宠渲染层：PIXI + pixi-live2d-display(Cubism4)
 * 模型来自 azlassets.nagami.moe：动作按游戏原生命名分组（touch_head / touch_body / touch_special / idle / main_1..3）
 */

let MODEL_URL = null

/** 命中区 → 动作组名（碧蓝航线的组名就是游戏里的动作名） */
const HIT_MOTION = {
  head: 'touch_head',
  body: 'touch_body',
  special: 'touch_special',
}

/** 无内置 HitAreas 时按包围盒比例划区（y 从上到下 0~1） */
const REGIONS = [
  { name: 'head', y0: 0.00, y1: 0.32 },
  { name: 'body', y0: 0.32, y1: 0.60 },
  { name: 'special', y0: 0.60, y1: 0.90 },
]

const el = (id) => document.getElementById(id)
const canvas = el('stage')

const app = new PIXI.Application({
  view: canvas,
  transparent: true,
  backgroundAlpha: 0,
  resizeTo: window,
  antialias: true,
  autoDensity: true,
  resolution: window.devicePixelRatio || 1,
})

let model = null
let modelRect = null
let dragging = false
let dragMoved = false
let downAt = null
let lastOver = null
let hasHitAreas = false
let groups = {}
let fitMode = 'auto'
let anchors = null        // 标定后的触摸锚点 { head:{x,y,r}, body:..., special:... }
let skinName = null       // 当前皮肤目录名
let calibrating = null    // 标定中的临时状态

/** 标定步骤：依次点三个位置 */
const CAL_STEPS = [
  { key: 'head', label: '头部', hint: '点一下她的头顶附近', r: 0.11 },
  { key: 'body', label: '身体', hint: '点一下胸口或躯干', r: 0.14 },
  { key: 'special', label: '特殊', hint: '点一下腿、裙摆这类位置', r: 0.16 },
]

// ---------- 模型 ----------------------------------------------------------
async function loadModel(url) {
  if (model) {
    try { app.stage.removeChild(model); model.destroy({ children: true }) } catch {}
    model = null
    modelRect = null
  }
  model = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false, idleMotionGroup: 'idle' })
  app.stage.addChild(model)

  groups = model.internalModel.motionManager.definitions ?? {}
  hasHitAreas = (model.internalModel.settings?.hitAreas?.length ?? 0) > 0

  // 读取该皮肤的标定数据（有就用锚点，没有就走兜底）
  skinName = url.match(/assets\/([^/]+)\//)?.[1] ?? null
  anchors = null
  if (skinName) {
    try {
      const saved = await window.pet.hitareas(skinName)
      if (saved?.anchors && Object.keys(saved.anchors).length) anchors = saved.anchors
    } catch {}
  }

  layout()
  startIdle()
}

async function switchSkin(url) {
  MODEL_URL = url
  try { await loadModel(url) } catch (e) { console.log('[skin] 加载失败:', e.message) }
}

function layout() {
  if (!model) return
  const W = app.screen.width
  const H = app.screen.height
  const rawW = model.internalModel?.originalWidth || 1024
  const rawH = model.internalModel?.originalHeight || 2048

  // auto：横幅场景图（宽高比 > 1.15）铺满，竖版立绘完整显示
  const mode = fitMode === 'auto' ? (rawW / rawH > 1.15 ? 'cover' : 'contain') : fitMode
  const scale = mode === 'cover'
    ? Math.max(W / rawW, H / rawH)
    : Math.min(W / rawW, (H * 0.98) / rawH)

  if (!Number.isFinite(scale) || scale <= 0) return
  model.scale.set(scale)
  model.x = (W - rawW * scale) / 2
  model.y = mode === 'cover' ? (H - rawH * scale) / 2 : H - rawH * scale
  modelRect = { x: model.x, y: model.y, w: rawW * scale, h: rawH * scale }
  publishInteractive()
}

window.addEventListener('resize', layout)

function hitAt(x, y) {
  if (!model) return []
  if (!modelRect) return []
  const { x: rx, y: ry, w, h } = modelRect

  // 标定过：按锚点算最近区域（x 按宽高比换算成"高度单位"，避免竖图横向误差）
  if (anchors) {
    const nx = (x - rx) / w
    const ny = (y - ry) / h
    const aspect = w / h
    let best = null
    let bestD = Infinity
    for (const [k, a] of Object.entries(anchors)) {
      const dx = (nx - a.x) * aspect
      const dy = ny - a.y
      const d = Math.hypot(dx, dy)
      if (d < bestD) { bestD = d; best = k }
    }
    if (best && bestD <= (anchors[best].r ?? 0.14)) return [best]
    return []
  }

  // 内置 HitAreas（官方模型）
  if (hasHitAreas) {
    try { return model.hitTest(x, y) ?? [] } catch { return [] }
  }

  // 兜底：按身高比例切三段
  if (x < rx || x > rx + w || y < ry || y > ry + h) return []
  const rel = (y - ry) / h
  const r = REGIONS.find((r) => rel >= r.y0 && rel < r.y1)
  return r ? [r.name] : []
}

// ---------- 穿透：把可交互矩形交给主进程 ----------
// 主进程轮询全局光标位置来切换穿透，避免 mousemove 丢事件时中键穿透到下层窗口
function publishInteractive() {
  const rects = []
  // 标定时整窗接收点击，否则只认模型矩形和气泡
  if (calibrating) {
    rects.push({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight })
  } else if (modelRect) {
    rects.push({ x: modelRect.x, y: modelRect.y, w: modelRect.w, h: modelRect.h })
  }
  const hud = el('hud')
  if (hud) {
    const r = hud.getBoundingClientRect()
    rects.push({ x: r.x, y: r.y, w: r.width, h: r.height })
  }
  try { window.pet.interactive(rects) } catch {}
}

// ---------- 触摸区标定 ----------------------------------------------------
const calBar = el('calbar')

function setCalBar(text) {
  if (!calBar) return
  calBar.textContent = text || ''
  calBar.classList.toggle('on', !!text)
}

function startCalibration() {
  if (!model || !modelRect) return
  calibrating = { step: 0, collected: {} }
  publishInteractive()
  setCalBar(`标定 1/3 · ${CAL_STEPS[0].hint}`)
  console.log('[calibrate] 开始标定', skinName)
}

function cancelCalibration(msg) {
  calibrating = null
  setCalBar('')
  publishInteractive()
  if (msg) {
    setCalBar(msg)
    setTimeout(() => setCalBar(''), 2500)
  }
}

async function handleCalibrateClick(e) {
  if (!calibrating || !modelRect) return
  const { x: rx, y: ry, w, h } = modelRect
  const nx = Math.min(1, Math.max(0, (e.clientX - rx) / w))
  const ny = Math.min(1, Math.max(0, (e.clientY - ry) / h))
  const step = CAL_STEPS[calibrating.step]
  calibrating.collected[step.key] = { x: +nx.toFixed(4), y: +ny.toFixed(4), r: step.r }
  calibrating.step++

  if (calibrating.step < CAL_STEPS.length) {
    setCalBar(`标定 ${calibrating.step + 1}/3 · ${CAL_STEPS[calibrating.step].hint}`)
    return
  }

  const data = { version: 1, skin: skinName, anchors: calibrating.collected, updatedAt: new Date().toISOString() }
  const res = await window.pet.saveHitareas(skinName, data)
  if (res?.ok) {
    anchors = data.anchors
    cancelCalibration('✓ 已保存，点哪里都对了')
  } else {
    cancelCalibration('✗ 保存失败：' + (res?.error ?? '未知错误'))
  }
}

// 中键：一键隐藏（托盘图标或 Ctrl+Alt+Z 恢复）
window.addEventListener('pointerdown', (e) => {
  if (e.button === 1) {
    e.preventDefault()
    e.stopPropagation()
    window.pet.hide()
  }
}, true)
window.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault() })

// ---------- 拖动 / 点击 ---------------------------------------------------
canvas.addEventListener('pointerdown', (e) => {
  if (calibrating) {
    e.preventDefault()
    handleCalibrateClick(e)
    return
  }
  if (e.button !== 0) return
  if (!hitAt(e.clientX, e.clientY).length) return
  dragging = true
  dragMoved = false
  downAt = { x: e.screenX, y: e.screenY }
  window.pet.dragStart({ x: e.screenX, y: e.screenY })
  canvas.setPointerCapture?.(e.pointerId)
})

window.addEventListener('pointermove', (e) => {
  if (!dragging) return
  if (!dragMoved && Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y) > 4) dragMoved = true
  if (dragMoved) window.pet.dragMove({ x: e.screenX, y: e.screenY, clamp: true })
})

window.addEventListener('pointerup', (e) => {
  if (!dragging) return
  dragging = false
  window.pet.dragEnd()
  if (!dragMoved) {
    const hit = hitAt(e.clientX, e.clientY)
    if (hit.length) playHit(hit[0])
  }
})

window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  window.pet.menu()
})

// ---------- 动作 ----------------------------------------------------------
function play(groupName) {
  if (!model || !groups[groupName]?.length) return false
  try { model.motion(groupName); return true } catch { return false }
}

function playHit(area) {
  const named = HIT_MOTION[area]
  if (named && play(named)) return
  const fallback = ['touch_head', 'touch_body', 'touch_special', 'main_1'].find(play)
  return fallback
}

function startIdle() {
  play('idle')
}

// 空闲时随机小动作（游戏里的 main_1/2/3 就是待机轮换动作）
setInterval(() => {
  if (!model || dragging) return
  const keys = ['main_1', 'main_2', 'main_3'].filter((k) => groups[k]?.length)
  if (keys.length) {
    try { model.motion(keys[Math.floor(Math.random() * keys.length)]) } catch {}
  }
}, 50_000)

// ---------- HUD -----------------------------------------------------------
const fmt = (n) => {
  if (!Number.isFinite(n)) return '--'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

async function refreshUsage() {
  let u
  try {
    u = await window.pet.usage()
  } catch (e) {
    el('tok').textContent = '调用失败'
    el('tok').className = 'val bad'
    return
  }
  if (!u || u.error) {
    el('tok').textContent = '读取失败'
    el('tok').className = 'val bad'
    el('calls').textContent = '—'
    return
  }
  const t = u.today ?? {}
  const total = t.totalTokens ?? ((t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cacheReadTokens ?? 0))
  el('tok').textContent = fmt(total)
  el('tok').className = 'val'
  el('calls').textContent = `${t.calls ?? 0} 次`

  const s = u.latestSession
  el('hud').title = s
    ? `今日合计 ${total.toLocaleString()} tok（含缓存读 ${fmt(t.cacheReadTokens ?? 0)}）\n` +
      `本窗口 ${(s.totalTokens ?? 0).toLocaleString()} tok / ${s.calls} 次`
    : ''
}

async function refreshBalance() {
  const b = await window.pet.balance()
  const dot = el('dot')
  if (!b || b.error) {
    dot.classList.add('err')
    el('bal').textContent = '未配置'
    el('bal').className = 'val dim'
    el('bal').title = b?.error ?? ''
    return
  }
  dot.classList.remove('err')
  const sym = b.currency === 'CNY' ? '¥' : b.currency === 'USD' ? '$' : (b.currency + ' ')
  el('bal').textContent = `${sym}${b.total.toFixed(2)}`
  el('bal').className = 'val ' + (b.total < 5 ? 'bad' : b.total < 10 ? 'warn' : 'ok')
}

function boot() {
  window.pet.skin().then((url) => {
    MODEL_URL = url
    return loadModel(url)
  }).catch((e) => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div style="position:absolute;left:6px;top:6px;color:#ec7063;font:11px monospace;white-space:pre-wrap">模型加载失败: ${e.message}</div>`,
    )
  })

  window.pet.onSkin((rel) => switchSkin(rel))

  window.pet.onCalibrate(() => startCalibration())
  window.pet.onHitareasCleared(async () => {
    anchors = null
    if (skinName) {
      try {
        const saved = await window.pet.hitareas(skinName)
        anchors = saved?.anchors ?? null
      } catch {}
    }
    setCalBar('已清除标定，回到默认分区')
    setTimeout(() => setCalBar(''), 2200)
  })
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && calibrating) cancelCalibration('已取消标定')
  })

  window.pet.fit().then((m) => { fitMode = m || 'auto'; layout() }).catch(() => {})
  window.pet.onFit((m) => { fitMode = m; layout() })

  refreshBalance()
  refreshUsage()
  setTimeout(publishInteractive, 400)
  setInterval(refreshBalance, 30 * 60 * 1000)
  setInterval(refreshUsage, 5 * 60 * 1000)
}

boot()
