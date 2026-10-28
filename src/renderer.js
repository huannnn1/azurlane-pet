/* 桌宠渲染层：PIXI + pixi-live2d-display(Cubism4)
 * 模型来自 azlassets.nagami.moe：动作按游戏原生命名分组（touch_head / touch_body / touch_special / idle / main_1..3）
 */

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
  // 桌宠窗口只有两三百像素宽，1.25 倍渲染（系统缩放）要多占三成显存和带宽，
  // 肉眼在这个尺寸下几乎分辨不出来，直接按 1 倍渲染
  resolution: 1,
  // 和 Live2DModel 共用同一个 ticker，才能一处控帧、一处暂停
  sharedTicker: true,
})

// 桌宠是静态陪伴场景，30fps 视觉上足够，功耗能砍掉近一半
PIXI.Ticker.shared.autoStart = false
PIXI.Ticker.shared.maxFPS = 30
PIXI.Ticker.shared.start()

/** 窗口隐藏时把渲染彻底停掉，别在后台空转 */
let rendering = true
function setRendering(on) {
  if (on === rendering) return
  rendering = on
  if (on) PIXI.Ticker.shared.start()
  else PIXI.Ticker.shared.stop()
  console.log('[render]', on ? '恢复' : '暂停')
}

let model = null
let modelRect = null
let dragging = false
let dragMoved = false
let downAt = null
let hoverInside = false   // 光标是否在人物上（穿透判定回传，HUD hover 模式与抓取手势都用它）
let hasHitAreas = false

/** 鼠标在人物身上时显示抓取手势，拖动中换成抓紧 */
function updateCursor() {
  if (!canvas) return
  canvas.style.cursor = dragging ? 'grabbing' : (hoverInside ? 'grab' : 'default')
}
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
/** 加载中的轻量提示 */
function showLoading(on) {
  const e = el('loading')
  if (e) e.classList.toggle('off', !on)
}

async function loadModel(url) {
  showLoading(true)
  if (model) {
    try { app.stage.removeChild(model) } catch {}
    // 库的 destroy 只有传 texture/baseTexture 才会释放 GPU 纹理，
    // 不传的话切一次皮肤就泄漏一份贴图（实测切 6 次 GPU 内存 128MB→339MB）
    try {
      model.destroy({ children: true, texture: true, baseTexture: true })
      console.log('[skin] 已释放旧模型', skinName)
    } catch (e) {
      console.log('[skin] 释放失败，退化处理', e.message)
      try { model.destroy({ children: true }) } catch {}
    }
    model = null
    modelRect = null
  }

  skinName = decodeURIComponent(url).match(/assets[\/\\]([^\/\\]+)[\/\\]/)?.[1] ?? null

  try {
    model = await PIXI.live2d.Live2DModel.from(url, { autoInteract: false, idleMotionGroup: 'idle' })
  } catch (e) {
    console.log('[skin] 加载失败:', skinName, e.message)
    showLoading(false)
    if (skinName) { try { window.pet.skinFailed(skinName) } catch {} }
    throw e
  }

  app.stage.addChild(model)

  groups = model.internalModel.motionManager.definitions ?? {}
  hasHitAreas = (model.internalModel.settings?.hitAreas?.length ?? 0) > 0

  // 读取该皮肤的标定数据（有就用锚点，没有就走兜底）
  anchors = null
  if (skinName) {
    try {
      const saved = await window.pet.hitareas(skinName)
      if (saved?.anchors && Object.keys(saved.anchors).length) anchors = saved.anchors
    } catch {}
    try { window.pet.skinOk(skinName) } catch {}
  }

  layout()
  startIdle()
  setCalBar('')
  showEmpty(false)
  showLoading(false)
  // 换皮肤后冒一句中文名，方便确认换的是谁
  window.pet.skinLabel()
    .then((label) => { if (label) say(label, 2000) })
    .catch(() => {})
  playLoginEntrance()
}

/**
 * 播一次动作，按实际时长收回待机。
 * 皮肤里的触摸/剧情动作几乎都是 Loop 的，不显式收回会一直循环下去。
 * group 可以是单个名字或候选数组（按顺序取第一个当前皮肤有的）。
 */
let onceTimer = null
async function playOnce(group, { min = 3, max = 8 } = {}) {
  if (!model) return false
  const key = Array.isArray(group)
    ? group.find((g) => groups[g]?.length)
    : (groups[group]?.length ? group : null)
  if (!key) return false
  if (key === 'idle') { play('idle'); return true }

  let dur = 0
  try { dur = await window.pet.motionDuration(key) } catch {}
  try { model.motion(key) } catch { return false }
  console.log('[motion] 播放一次', key, (dur || 0).toFixed(1) + 's')

  const waitMs = Math.min(Math.max(dur || 4, min), max) * 1000
  if (onceTimer) clearTimeout(onceTimer)
  onceTimer = setTimeout(() => {
    onceTimer = null
    if (!dragging && model) play('idle')
  }, waitMs)
  return true
}

/** 出场动作：每个皮肤都有 login，播完回待机 */
async function playLoginEntrance() {
  if (!model || !groups?.login?.length) return
  await playOnce('login', { min: 3, max: 8 })
}

async function switchSkin(url) {
  // 旧模型留在画面上，直到新模型加载完成再替换，避免换皮肤时出现空白。
  // 这里的 old 必须是局部变量：loadModel 里会把全局 model 换成新模型，
  // 如果异步回来再去销毁 model，很可能销毁的是刚加载好的新模型。
  const old = model
  if (old) model = null
  try {
    await loadModel(url)
  } catch (e) {
    console.log('[skin] 加载失败:', e.message)
  }
  if (old && old !== model) {
    try {
      app.stage.removeChild(old)
      old.destroy({ children: true, texture: true, baseTexture: true })
      console.log('[skin] 旧模型已卸载')
    } catch {}
  }
}

/** HUD 铭牌的大致高度：contain 时给底部留出来，别把脚挡住；HUD 关掉时不留 */
const HUD_RESERVE_BASE = 24
let hudMode = 'always'

function hudReserve() {
  return hudMode === 'off' ? 0 : HUD_RESERVE_BASE
}

/** 按 hud 模式切换铭牌显示：常显 / 悬停才显示 / 隐藏 */
function applyHudMode() {
  const hud = el('hud')
  if (!hud) return
  hud.style.display = hudMode === 'off' ? 'none' : ''
  hud.classList.toggle('hud-hidden', hudMode === 'hover' && !hoverInside)
  publishInteractive()
}

function layout() {
  if (!model) return
  const W = app.screen.width
  const H = app.screen.height
  const rawW = model.internalModel?.originalWidth || 1024
  const rawH = model.internalModel?.originalHeight || 2048

  // auto：横幅场景图（宽高比 > 1.15）铺满，竖版立绘完整显示
  const mode = fitMode === 'auto' ? (rawW / rawH > 1.15 ? 'cover' : 'contain') : fitMode
  const reserve = hudReserve()
  // 完整显示时把底部铭牌的高度让出来；铺满裁切时本来就会盖住，不额外处理
  const usableH = mode === 'cover' ? H : Math.max(1, H - reserve)
  const scale = mode === 'cover'
    ? Math.max(W / rawW, H / rawH)
    : Math.min(W / rawW, usableH / rawH)

  if (!Number.isFinite(scale) || scale <= 0) return
  model.scale.set(scale)
  model.x = (W - rawW * scale) / 2
  model.y = mode === 'cover' ? (H - rawH * scale) / 2 : H - reserve - rawH * scale + 2
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
  // type 决定主进程怎么判定：all 直接可点，hud 是 DOM 直接可点，
  // model 要走像素探测（外接矩形里大片透明区域不该挡住桌面）
  if (calibrating) {
    rects.push({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, type: 'all' })
  } else if (modelRect) {
    rects.push({ x: modelRect.x, y: modelRect.y, w: modelRect.w, h: modelRect.h, type: 'model' })
  }
  // 没找到模型时，整窗可点，方便点提示卡去选目录
  const empty = el('empty')
  if (empty?.classList.contains('on')) {
    rects.push({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, type: 'all' })
  }
  const hud = el('hud')
  if (hud && hud.style.display !== 'none') {
    const r = hud.getBoundingClientRect()
    rects.push({ x: r.x, y: r.y, w: r.width, h: r.height, type: 'hud' })
  }
  // 气泡显示期间也占一小块可交互区，避免鼠标移上去穿透到桌面
  const bubble = el('bubble')
  if (bubble?.classList.contains('on')) {
    const r = bubble.getBoundingClientRect()
    rects.push({ x: r.x, y: r.y, w: r.width, h: r.height, type: 'hud' })
  }
  try { window.pet.interactive(rects) } catch {}
}

/** 没模型时的自救提示卡 */
function showEmpty(on) {
  const e = el('empty')
  if (!e) return
  e.classList.toggle('on', !!on)
  if (on) setCalBar('')
  publishInteractive()
}

// ---------- 像素级穿透探测 ------------------------------------------------
// 外接矩形里大片是透明的，按矩形判定会把桌面图标挡住。
// 主进程问「这个点能不能点」，这里在渲染完这一帧后读 3x3 邻域的 alpha。
let pendingProbe = null
let lastProbeLog = 0

window.pet.onProbePixel(({ x, y }) => { pendingProbe = { x, y } })

app.renderer.on('postrender', () => {
  if (!pendingProbe) return
  const { x, y } = pendingProbe
  pendingProbe = null
  try {
    const gl = app.renderer.gl
    const res = app.renderer.resolution || 1
    const W = app.renderer.width
    const H = app.renderer.height
    const rx = Math.max(1, Math.min(W - 2, Math.round(x * res)))
    const ry = Math.max(1, Math.min(H - 2, Math.round(H - y * res)))
    const px = new Uint8Array(3 * 3 * 4)
    gl.readPixels(rx - 1, ry - 1, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let maxA = 0
    for (let i = 3; i < px.length; i += 4) if (px[i] > maxA) maxA = px[i]
    const opaque = maxA > 25   // alpha > 0.1 才算画了东西
    window.pet.pixelResult(opaque)
    const now = Date.now()
    if (now - lastProbeLog > 1500) {
      lastProbeLog = now
      console.log('[pixel] alpha=', maxA, 'opaque=', opaque)
    }
  } catch (e) {
    window.pet.pixelResult(true)   // 读失败就当作可点，别把交互弄没
  }
})
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
/** 超过这个像素就算拖动，不再当作点击去播动作 */
const DRAG_THRESHOLD = 5

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
  updateCursor()
  window.pet.dragStart({ x: e.screenX, y: e.screenY })
  canvas.setPointerCapture?.(e.pointerId)
})

window.addEventListener('pointermove', (e) => {
  if (!dragging) return
  const dist = Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y)
  if (!dragMoved && dist > DRAG_THRESHOLD) {
    dragMoved = true
    playDragReaction()   // 确认是拖动而不是点击，给一次被拎起来的反应
  }
  if (dragMoved) window.pet.dragMove({ x: e.screenX, y: e.screenY, clamp: true })
})

window.addEventListener('pointerup', (e) => {
  if (!dragging) return
  dragging = false
  window.pet.dragEnd()
  updateCursor()
  // 松手时按总位移再复核一次：拖动途中指针事件可能丢，
  // 只看 dragMoved 会把一次真拖动误判成点击，从而播出带镜头的触摸动作
  const total = Math.hypot(e.screenX - downAt.x, e.screenY - downAt.y)
  console.log('[drag] 松手 位移=', Math.round(total), 'dragMoved=', dragMoved)
  if (!dragMoved && total <= DRAG_THRESHOLD) {
    const hit = hitAt(e.clientX, e.clientY)
    if (hit.length) playHit(hit[0])
  } else if (dragMoved) {
    // 触摸/拖动动作都是 Loop 的，不回待机会一直循环下去
    play('idle')
  }
})

/** 拖动被系统打断（指针被抢走、窗口失焦）时复位，别卡在拖动状态 */
function abortDrag() {
  if (!dragging) return
  dragging = false
  window.pet.dragEnd()
  updateCursor()
}
window.addEventListener('pointercancel', abortDrag)
window.addEventListener('blur', abortDrag)

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
  console.log('[hit] 播放触摸动作', area, 'dragMoved=', dragMoved)
  const named = HIT_MOTION[area]
  if (named && play(named)) return
  const fallback = ['touch_head', 'touch_body', 'touch_special', 'main_1'].find(play)
  return fallback
}

/**
 * 开始拖动时的反应：优先用游戏原生的 touch_drag*（约四成皮肤有，多的能到 26 个），
 * 没有就退到 touch_body（被抱起来的感觉）。
 * 多个动作按编号轮询，保证每个都能轮到，而不是随机到某几个反复播。
 */
let dragCursor = 0
let dragCursorSkin = null

function playDragReaction() {
  if (!model) return false
  const drags = Object.keys(groups)
    .filter((k) => /^touch_drag\d*$/.test(k) && groups[k]?.length)
    .sort((a, b) => (Number(a.replace('touch_drag', '')) || 0) - (Number(b.replace('touch_drag', '')) || 0))

  if (drags.length) {
    // 换皮肤后从头开始轮，不然游标会串到别的角色身上
    if (dragCursorSkin !== skinName) {
      dragCursorSkin = skinName
      dragCursor = 0
    }
    const key = drags[dragCursor % drags.length]
    dragCursor = (dragCursor + 1) % drags.length
    try {
      model.motion(key)
      console.log(`[drag] 播放拖动动作 ${key}（${drags.length} 个中的第 ${dragCursor || drags.length} 个）`)
      return true
    } catch {}
  }
  if (play('touch_body')) {
    console.log('[drag] 无专用拖动动作，退到 touch_body')
    return true
  }
  return false
}

function startIdle() {
  play('idle')
}

// 空闲时随机小动作（游戏里的 main_1/2/3 就是待机轮换动作）
// DSH 正在跑任务时节奏加快，摸鱼时放慢，系统长时间没人动则像打盹一样更慢
let activityActive = false
let drowsy = false
let idleTimer = null

function playRandomMain() {
  if (!model || dragging) return
  const keys = ['main_1', 'main_2', 'main_3'].filter((k) => groups[k]?.length)
  if (keys.length) {
    try { model.motion(keys[Math.floor(Math.random() * keys.length)]) } catch {}
  }
}

function scheduleIdleTick() {
  if (idleTimer) clearTimeout(idleTimer)
  const delay = drowsy ? 180_000 : (activityActive ? 12_000 : 50_000)
  idleTimer = setTimeout(() => {
    playRandomMain()
    scheduleIdleTick()
  }, delay)
}

function setActivity(active) {
  if (active === activityActive) return
  activityActive = active
  scheduleIdleTick()
  if (active) playRandomMain()
}

/**
 * DSH 阶段 → 待机动作。只挑变化明显、不频繁的几个事件，
 * tool/result、step/* 这类高频事件忽略掉，否则动作会被切得稀碎。
 * 用上 skin 里原本闲置的 mission_complete / complete / mail / home。
 */
const STATE_MOTION = {
  'tool/call': ['touch_special', 'main_2'],       // 执行工具：抬手干活
  'assistant/message': ['main_3'],                // 写回复
  'user/message': ['home', 'main_1'],             // 等用户说话，别再用摸头
  'job/registered': ['main_2'],                   // 起后台任务
  'job/settled': ['mail', 'complete', 'idle'],    // 后台任务结束
  'turn/end': ['mission_complete', 'complete', 'idle'],  // 干完了，该有反馈
}

function onDsState(type) {
  if (!model || dragging) return
  // 回合结束是最该有反馈的时刻，给一句台词
  if (type === 'turn/end') {
    say(TURN_END_LINES[Math.floor(Math.random() * TURN_END_LINES.length)])
  }
  const candidates = STATE_MOTION[type]
  if (!candidates) return
  playOnce(candidates, { min: 3, max: 6 })
}

// ---------- 气泡台词 -------------------------------------------------------
// 没有音效，台词是唯一的"说话"反馈，所以只在少数时机出现，别刷屏。
const TURN_END_LINES = ['搞定啦～', '这一轮做完咯', '呼…收工', '还有别的吗？', '交给我吧']
let bubbleOn = true
let bubbleTimer = null

function say(text, ms = 2600) {
  if (!bubbleOn || !text) return
  const b = el('bubble')
  if (!b) return
  b.textContent = text
  if (modelRect) {
    b.style.left = `${Math.round(modelRect.x + modelRect.w / 2)}px`
    b.style.top = `${Math.max(30, Math.round(modelRect.y + 8))}px`
  }
  b.classList.add('on')
  publishInteractive()
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => {
    bubbleTimer = null
    b.classList.remove('on')
    publishInteractive()
  }, ms)
}

/** 余额跌破阈值时提醒，每个档位当天只提醒一次 */
let lowWarned = { level: 0, date: '' }
function checkLowBalance(total) {
  const today = new Date().toLocaleDateString('sv-SE')
  if (lowWarned.date !== today) lowWarned = { level: 0, date: today }
  if (total < 5 && lowWarned.level < 5) {
    lowWarned.level = 5
    say('余额快见底啦…')
  } else if (total < 10 && lowWarned.level < 10) {
    lowWarned.level = 10
    say('余额不多了哦')
  }
}

// ---------- 视线跟随 -------------------------------------------------------
// pixi-live2d-display 的 model.focus() 只驱动眼球（ParamEyeBallX/Y），
// 不改头部角度，所以看不出「转头」。这里自己写 ParamAngleX/Y，
// 并用 LOW 优先级挂在 motion 之后，避免被动作每帧覆盖。
let focusTarget = { x: 0, y: 0 }
const curFocus = { x: 0, y: 0 }

PIXI.Ticker.shared.add(() => {
  if (!model || model.destroyed) return
  const dx = focusTarget.x - curFocus.x
  const dy = focusTarget.y - curFocus.y
  if (Math.abs(dx) < 0.002 && Math.abs(dy) < 0.002) return
  // 0.35 的追帧系数，几帧内就能跟上，转头看起来是"跟手"而不是"慢慢飘"
  curFocus.x += dx * 0.35
  curFocus.y += dy * 0.35
  try {
    const cm = model.internalModel.coreModel
    cm.setParameterValueById('ParamAngleX', curFocus.x * 30)
    cm.setParameterValueById('ParamAngleY', -curFocus.y * 30)
    cm.setParameterValueById('ParamEyeBallX', curFocus.x)
    cm.setParameterValueById('ParamEyeBallY', -curFocus.y)
  } catch {}
}, null, PIXI.UPDATE_PRIORITY.LOW)

// ---------- Ctrl + 滚轮连续调大小 ------------------------------------------
let sizeScale = 1
let sizeDraft = null
let sizeSaveTimer = null

window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return
  e.preventDefault()
  const base = sizeDraft ?? sizeScale
  const next = Math.min(1.6, Math.max(0.6, base + (e.deltaY < 0 ? 0.05 : -0.05)))
  sizeDraft = Math.round(next * 100) / 100
  window.pet.setScale(sizeDraft, false)
  // 停下来 350ms 才写配置，避免滚动时狂写文件
  if (sizeSaveTimer) clearTimeout(sizeSaveTimer)
  sizeSaveTimer = setTimeout(() => {
    sizeSaveTimer = null
    if (sizeDraft != null) {
      sizeScale = sizeDraft
      sizeDraft = null
      window.pet.setScale(sizeScale, true)
    }
  }, 350)
}, { passive: false })

// ---------- HUD -----------------------------------------------------------
const fmt = (n) => {
  if (!Number.isFinite(n)) return '--'
  // 桌宠气泡空间小，大数字优先取整，别把右边缘挤出去
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e8) return Math.round(n / 1e6) + 'M'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

let usageLoaded = false

async function refreshUsage() {
  // 只有第一次才显示「统计中」：定时刷新时也闪一下会很烦
  if (!usageLoaded) {
    el('tok').textContent = '统计中'
    el('tok').className = 'val dim'
  }
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
  usageLoaded = true
  const total = t.totalTokens ?? ((t.inputTokens ?? 0) + (t.outputTokens ?? 0) + (t.cacheReadTokens ?? 0))
  el('tok').textContent = fmt(total)
  el('tok').className = 'val'
  el('calls').textContent = `${t.calls ?? 0} 次`

  const s = u.latestSession
  el('hud').title =
    (s
      ? `今日合计 ${total.toLocaleString()} tok（含缓存读 ${fmt(t.cacheReadTokens ?? 0)}）\n` +
        `本窗口 ${(s.totalTokens ?? 0).toLocaleString()} tok / ${s.calls} 次\n`
      : '') + '点击查看用量明细，右键打开菜单'
}

async function refreshBalance() {
  const b = await window.pet.balance()
  const dot = el('dot')
  if (!b || b.error) {
    dot.classList.add('err')
    // 没填 Key 和网络请求失败要分开说，别都显示「未配置」误导人
    const noKey = /apiKey/i.test(b?.error ?? '')
    el('bal').textContent = noKey ? '未配置' : '读取失败'
    el('bal').className = 'val ' + (noKey ? 'dim' : 'bad')
    el('bal').title = b?.error ?? ''
    return
  }
  dot.classList.remove('err')
  const sym = b.currency === 'CNY' ? '¥' : b.currency === 'USD' ? '$' : (b.currency + ' ')
  el('bal').textContent = `${sym}${b.total.toFixed(2)}`
  el('bal').className = 'val ' + (b.total < 5 ? 'bad' : b.total < 10 ? 'warn' : 'ok')
  checkLowBalance(b.total)
}

function boot() {
  window.pet.skins().then((list) => {
    if (!list || !list.length) showEmpty(true)
  }).catch(() => {})

  window.pet.skin().then((url) => {
    return loadModel(url)
  }).catch((e) => {
    console.log('[boot] 模型加载失败:', e.message)
    // 没有文件可换时给用户一个能自救的入口，而不是一直空白
    showEmpty(true)
  })

  window.pet.onSkin((rel) => switchSkin(rel))
  // 菜单里手动挑的动作：直接播，不经过命中区逻辑
  window.pet.onMotion((key) => {
    console.log('[motion] 手动播放', key)
    try { model?.motion(key) } catch (e) { console.log('[motion] 播放失败', key, e.message) }
  })
  window.pet.onVisible((v) => setRendering(v))
  // 视线跟随：把窗口内坐标归一化到 -1~1 交给模型
  let lastFocusLog = 0
  window.pet.onFocus(({ x, y }) => {
    if (!model) return
    const W = window.innerWidth
    const H = window.innerHeight
    if (!W || !H) return
    const nx = Math.max(-1, Math.min(1, (x / W) * 2 - 1))
    const ny = Math.max(-1, Math.min(1, (y / H) * 2 - 1))
    focusTarget = { x: nx, y: ny }
    try { model.focus(nx, ny) } catch {}
    const now = Date.now()
    if (now - lastFocusLog > 1500) {
      lastFocusLog = now
      console.log('[focus]', nx.toFixed(2), ny.toFixed(2))
    }
  })
  window.pet.onNoSkins(() => showEmpty(true))
  window.pet.onAssetsChanged((rel) => {
    showEmpty(false)
    if (rel) switchSkin(rel)
  })
  window.pet.onActivity((active) => setActivity(active))
  window.pet.onState((type) => onDsState(type))
  window.pet.onBubble((on) => { bubbleOn = !!on })
  // 测试用：外部可通过 executeJavaScript 调 window.__petFocus(x,y) 强制视线
  window.__petFocus = (x, y) => {
    focusTarget = { x, y }
    try { model?.focus(x, y) } catch {}
  }

  window.pet.onHud((mode) => { hudMode = mode || 'always'; applyHudMode(); layout() })
  window.pet.onHover((inside) => { hoverInside = !!inside; applyHudMode(); updateCursor() })
  // 系统空闲时降帧 + 拉长动作间隔；人一回来立刻恢复
  window.pet.onDrowsy((on) => {
    drowsy = !!on
    PIXI.Ticker.shared.maxFPS = drowsy ? 15 : 30
    scheduleIdleTick()
  })
  window.pet.config().then((c) => {
    bubbleOn = c?.bubble !== false
    hudMode = c?.hud ?? 'always'
    sizeScale = c?.sizeScale ?? 1
    applyHudMode()
    layout()
  }).catch(() => {})
  scheduleIdleTick()

  el('empty')?.addEventListener('click', () => window.pet.chooseAssets())
  // 点 HUD 打开用量明细（余额未配置时也能从这里看到 token 花费）
  el('hud')?.addEventListener('click', () => window.pet.openUsage())

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
