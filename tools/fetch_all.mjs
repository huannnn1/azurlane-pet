/**
 * fetch_all.mjs — 批量下载碧蓝航线 Live2D 皮肤（可断点续跑、只补缺失）
 *
 * 安全约定：
 *   - 只写入 assets/<皮肤>/ 目录，不删除、不改动任何已有文件
 *   - 已存在且非空的文件一律跳过（不覆盖）
 *   - 失败只记录到 tools/failures.json，不中断其他皮肤
 *
 * 用法：
 *   node tools/fetch_all.mjs            # 下载全部缺失皮肤
 *   node tools/fetch_all.mjs --dry      # 只报告缺哪些，不下载
 *   AL_SERVER=JP node tools/fetch_all.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve('.')
const OUT = path.join(ROOT, 'assets')
const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'skin_index.json'), 'utf8'))
const SERVER = process.env.AL_SERVER || 'EN'
const CDN = (s) => `https://azlassets.nagami.moe/${SERVER}/live2d/${encodeURIComponent(s)}/`
const CONC_SKIN = Number(process.env.AL_CONC || 4)
const DRY = process.argv.includes('--dry')
const LOG = path.join(ROOT, 'tools', 'download.log')

const skins = Object.keys(INDEX.skins)
const t0 = Date.now()

function log(line) {
  const s = `[${new Date().toLocaleTimeString('zh-CN')}] ${line}`
  console.log(s)
  try { fs.appendFileSync(LOG, s + '\n') } catch {}
}

/** model3.json 里所有需要下载的相对路径 */
function deps(j) {
  const fr = j.FileReferences || {}
  const rel = []
  if (fr.Moc) rel.push(fr.Moc)
  for (const t of fr.Textures || []) rel.push(t)
  if (fr.Physics) rel.push(fr.Physics)
  if (fr.Pose) rel.push(fr.Pose)
  if (fr.DisplayInfo) rel.push(fr.DisplayInfo)
  for (const g of Object.values(fr.Motions || {})) for (const m of g) if (m.File) rel.push(m.File)
  for (const e of fr.Expressions || []) if (e.File) rel.push(e.File)
  return [...new Set(rel)]
}

function missingFiles(skin) {
  const dir = path.join(OUT, skin)
  const m3 = path.join(dir, `${skin}.model3.json`)
  if (!fs.existsSync(m3)) return null // 需要全量下载
  let j
  try { j = JSON.parse(fs.readFileSync(m3, 'utf8')) } catch { return null }
  const miss = []
  for (const rel of deps(j)) {
    const p = path.join(dir, rel)
    let ok = false
    try { ok = fs.statSync(p).size > 0 } catch { ok = false }
    if (!ok) miss.push(rel)
  }
  return miss
}

async function get(url, binary) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return binary ? Buffer.from(await r.arrayBuffer()) : await r.text()
    } catch (e) {
      if (i === 3) throw e
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
}

async function fetchSkin(skin) {
  const dir = path.join(OUT, skin)
  const miss = missingFiles(skin)

  if (miss === null) {
    // 首次：拿 model3.json，再拉全部依赖
    const text = await get(`${CDN(skin)}${skin}.model3.json`, false)
    const j = JSON.parse(text)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${skin}.model3.json`), text)
    const list = deps(j)
    let bytes = 0
    let i = 0
    async function worker() {
      while (i < list.length) {
        const rel = list[i++]
        const target = path.join(dir, rel)
        if (fs.existsSync(target) && fs.statSync(target).size > 0) continue
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const buf = await get(`${CDN(skin)}${rel.split('/').map(encodeURIComponent).join('/')}`, true)
        fs.writeFileSync(target, buf)
        bytes += buf.length
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker))
    return { skin, mode: 'full', files: list.length, bytes }
  }

  if (miss.length === 0) return { skin, mode: 'skip', files: 0, bytes: 0 }

  // 断点续跑：只补缺失文件
  let bytes = 0
  let i = 0
  async function worker() {
    while (i < miss.length) {
      const rel = miss[i++]
      const target = path.join(dir, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const buf = await get(`${CDN(skin)}${rel.split('/').map(encodeURIComponent).join('/')}`, true)
      fs.writeFileSync(target, buf)
      bytes += buf.length
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, miss.length) }, worker))
  return { skin, mode: 'repair', files: miss.length, bytes }
}

// ---- 先盘点 -------------------------------------------------------------
const todo = []
let done = 0
for (const s of skins) {
  const miss = missingFiles(s)
  if (miss === null) todo.push({ skin: s, kind: 'full' })
  else if (miss.length) todo.push({ skin: s, kind: 'repair', n: miss.length })
  else done++
}
log(`清单 ${skins.length} 个 | 本地完整 ${done} | 待处理 ${todo.length}（新 ${todo.filter(t => t.kind === 'full').length} / 补漏 ${todo.filter(t => t.kind === 'repair').length}）`)

if (DRY) {
  for (const t of todo.slice(0, 30)) log(`  待${t.kind === 'full' ? '下载' : '补齐'} ${t.skin}${t.n ? ` (${t.n} 文件)` : ''}`)
  if (todo.length > 30) log(`  ...还有 ${todo.length - 30} 个`)
  process.exit(0)
}

// ---- 并发执行 -----------------------------------------------------------
const failures = []
let idx = 0
let totalBytes = 0
let okCount = 0

async function runner() {
  while (idx < todo.length) {
    const task = todo[idx++]
    try {
      const r = await fetchSkin(task.skin)
      totalBytes += r.bytes || 0
      if (r.mode !== 'skip') {
        okCount++
        log(`✓ ${task.skin.padEnd(26)} ${r.mode === 'full' ? '下载' : '补齐'} ${String(r.files).padStart(3)} 文件 ${(r.bytes / 1048576).toFixed(1)} MB  [${idx}/${todo.length}]`)
      }
    } catch (e) {
      failures.push({ skin: task.skin, error: e.message })
      log(`✗ ${task.skin.padEnd(26)} ${e.message}`)
    }
  }
}

await Promise.all(Array.from({ length: CONC_SKIN }, runner))

fs.writeFileSync(path.join(ROOT, 'tools', 'failures.json'), JSON.stringify(failures, null, 2))
const mins = ((Date.now() - t0) / 60000).toFixed(1)
log(`\n完成：成功 ${okCount} 个，失败 ${failures.length} 个，共 ${(totalBytes / 1073741824).toFixed(2)} GB，用时 ${mins} 分钟`)
if (failures.length) log(`失败清单见 tools/failures.json，重跑本脚本会自动只补失败项`)
