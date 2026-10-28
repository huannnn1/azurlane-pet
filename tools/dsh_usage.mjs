/**
 * dsh_usage.mjs — 统计 DeepSeek Harness 本地会话的 token 用量
 *
 * 数据源：~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd
 * 格式：多个独立 zstd 帧拼接（每批一个帧），每帧内是若干 JSONL 行
 * 取数：assistant/message 事件 → data.usage
 *       { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
 *
 * 用法：
 *   node dsh_usage.mjs               # 人类可读汇总
 *   node dsh_usage.mjs --json        # 输出 JSON（给桌宠消费）
 *   node dsh_usage.mjs --today       # 只统计今天（本地自然日）
 *   node dsh_usage.mjs --days 7      # 最近 7 天
 *   node dsh_usage.mjs --no-cache    # 跳过增量缓存，全量重算
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const noCache = args.includes('--no-cache')
const todayOnly = args.includes('--today')
const daysArg = args.indexOf('--days')
const DAYS = todayOnly ? 1 : daysArg >= 0 ? Number(args[daysArg + 1]) || 1 : 1

const ROOT = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'sessions')
  : path.join(os.homedir(), '.dsh', 'sessions')

// portable 版每次启动都会解压到新的临时目录，缓存不能写在脚本旁边，
// 否则永远命中不了、每次都要全量解压几千个会话文件。
const CACHE_DIR = process.env.DSH_USAGE_CACHE_DIR
  || path.dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = path.join(CACHE_DIR, '.usage-cache.json')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// ---- 计价 ----------------------------------------------------------------
// DeepSeek 官方定价（元 / 百万 tokens），来源：
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 高峰时段是空闲时段的两倍：北京时间周一至周五 9:00-12:00、14:00-18:00；
// 周末与其余时段按空闲价。法定节假日无法从本地时区判断，这里按工作日近似。
const PRICE = {
  model: 'deepseek-flash',
  peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  idle: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
}

/** 该时刻是否落在工作日高峰时段 */
function isPeakHour(ts) {
  const d = new Date(ts)
  const wd = d.getDay()
  if (wd === 0 || wd === 6) return false
  const h = d.getHours() + d.getMinutes() / 60
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/** 单条 usage 的费用（元）：未命中输入 + 缓存命中输入 + 输出，三段各自计价 */
function tokenCost(u, ts) {
  const p = isPeakHour(ts) ? PRICE.peak : PRICE.idle
  return (
    (u.inputTokens ?? 0) * p.cacheMiss +
    (u.cacheReadTokens ?? 0) * p.cacheHit +
    (u.outputTokens ?? 0) * p.output
  ) / 1e6
}

/** 按 zstd 帧魔数切片后逐帧解压，返回所有非空行 */
function readFrames(file) {
  let buf
  try { buf = fs.readFileSync(file) } catch { return [] }
  const starts = []
  let i = 0
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { starts.push(i); i += 4 }
  const lines = []
  for (let k = 0; k < starts.length; k++) {
    const seg = buf.subarray(starts[k], starts[k + 1] ?? buf.length)
    try {
      const txt = zlib.zstdDecompressSync(seg).toString('utf8')
      for (const l of txt.split('\n')) if (l.trim()) lines.push(l)
    } catch { /* 撕裂的最后一帧：跳过 */ }
  }
  return lines
}

function walk(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/^session.*\.jsonl(\.zstd)?$/.test(e.name)) out.push(p)
  }
  return out
}

/** 解析单个会话文件 → { title, byDay: {day: totals}, last } */
function parseSession(file) {
  const rows = readFrames(file)
  const byDay = {}
  let title = null
  let last = 0
  for (const line of rows) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'session/title' && o.data?.title) title = o.data.title
    if (o.type !== 'assistant/message') continue
    const u = o.data?.usage
    if (!u) continue
    const t = o.time ?? 0
    if (t > last) last = t
    const day = new Date(t).toLocaleDateString('sv-SE') // YYYY-MM-DD（本地时区）
    const b = (byDay[day] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, calls: 0, cost: 0 })
    b.inputTokens += u.inputTokens ?? 0
    b.outputTokens += u.outputTokens ?? 0
    b.cacheReadTokens += u.cacheReadTokens ?? 0
    b.cacheWriteTokens += u.cacheWriteTokens ?? 0
    b.totalTokens += u.totalTokens ?? 0
    b.cost += tokenCost(u, t)
    b.calls++
  }
  return { title, byDay, last }
}

// ---- 增量缓存：按 path+mtime+size 只重算变动的文件 -------------------------
let cache = {}
if (!noCache) {
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) } catch { cache = {} }
}
const nextCache = { ...cache }   // 保留窗口期外文件的旧缓存，下次仍能复用
let parsed = 0

// 会话文件的 mtime ≈ 最后一次写入时间，据此只加载窗口期内动过的文件。
// 否则「今日」统计也要先解压全部几千个历史会话，首次启动会卡几十秒。
let files = walk(ROOT)
const todayStart = new Date()
todayStart.setHours(0, 0, 0, 0)
const cutoff = todayOnly ? todayStart.getTime() : Date.now() - DAYS * 86400000
files = files.filter((f) => {
  try { return fs.statSync(f).mtimeMs >= cutoff } catch { return false }
})

for (const file of files) {
  let st
  try { st = fs.statSync(file) } catch { continue }
  const key = `v2:${st.mtimeMs}:${st.size}`
  const hit = cache[file]
  if (hit && hit.key === key) { nextCache[file] = hit; continue }   // 命中，跳过解压
  nextCache[file] = { key, ...parseSession(file) }
  parsed++
}

if (!noCache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(nextCache)) } catch { /* 缓存失败不影响统计 */ }
}

// ---- 汇总（只算本次窗口期内的文件）---------------------------------------
const ZERO = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, calls: 0, cost: 0 })
const buckets = new Map()
const sessions = []
const grand = ZERO()
const today = new Date().toLocaleDateString('sv-SE')
// 自然日窗口的起点（含今天）。文件 mtime 过滤只能挡住整体太旧的文件，
// 一个近期还在写的会话文件里可能带着几十天前的数据，这里再按日期收一次口。
const cutoffDay = (() => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (DAYS - 1))
  return d.toLocaleDateString('sv-SE')
})()

for (const file of files) {
  const v = nextCache[file]
  if (!v?.byDay) continue
  const acc = ZERO()
  for (const [day, b] of Object.entries(v.byDay)) {
    if (todayOnly ? day !== today : day < cutoffDay) continue
    let bucket = buckets.get(day)
    if (!bucket) {
      bucket = ZERO()
      buckets.set(day, bucket)
    }
    for (const k of Object.keys(bucket)) {
      bucket[k] += b[k] ?? 0
      acc[k] += b[k] ?? 0
      grand[k] += b[k] ?? 0
    }
  }
  if (acc.calls) sessions.push({ title: v.title, last: v.last, ...acc })
}

const daily = [...buckets.entries()].sort((a, b) => b[0].localeCompare(a[0]))
sessions.sort((a, b) => b.last - a.last)

if (asJson) {
  const latest = sessions.find(s => s.last > 0) ?? null
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    price: PRICE,
    today: daily[0]?.[1] ?? null,
    todayDate: daily[0]?.[0] ?? today,
    daily: daily.map(([date, b]) => ({ date, ...b })),
    grand,
    parsed,
    latestSession: latest
      ? { title: latest.title, calls: latest.calls, totalTokens: latest.totalTokens,
          inputTokens: latest.inputTokens, outputTokens: latest.outputTokens,
          cacheReadTokens: latest.cacheReadTokens, last: latest.last, cost: latest.cost }
      : null,
    sessions: sessions.map((s) => ({
      title: s.title, last: s.last, calls: s.calls, totalTokens: s.totalTokens,
      inputTokens: s.inputTokens, outputTokens: s.outputTokens,
      cacheReadTokens: s.cacheReadTokens, cost: s.cost,
    })),
  }, null, 2))
} else {
  const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n)
  const yuan = c => '¥' + (c ?? 0).toFixed(2)
  console.log(`数据源: ${ROOT}`)
  console.log(`范围: ${todayOnly ? '今天' : `最近 ${DAYS} 天`}  调用: ${grand.calls}  本次解析文件: ${parsed}/${files.length}`)
  console.log(`计价: ${PRICE.model}（空闲 缓存${PRICE.idle.cacheHit}/未命中${PRICE.idle.cacheMiss}/输出${PRICE.idle.output} 元每百万）\n`)
  console.log('日期          输入      输出      缓存读     合计      调用     费用')
  for (const [day, b] of daily) {
    console.log(`${day}  ${fmt(b.inputTokens).padStart(9)}  ${fmt(b.outputTokens).padStart(8)}  ${fmt(b.cacheReadTokens).padStart(9)}  ${fmt(b.totalTokens).padStart(8)}  ${String(b.calls).padStart(5)}  ${yuan(b.cost).padStart(9)}`)
  }
  console.log(`\n合计: 输入 ${fmt(grand.inputTokens)} / 输出 ${fmt(grand.outputTokens)} / 缓存命中 ${fmt(grand.cacheReadTokens)} / 总计 ${fmt(grand.totalTokens)} / 费用 ${yuan(grand.cost)}`)
  console.log('\n最近会话:')
  for (const s of sessions.slice(0, 8)) {
    const when = s.last ? new Date(s.last).toLocaleString('zh-CN') : '-'
    console.log(`  ${fmt(s.totalTokens).padStart(8)}  ${String(s.calls).padStart(3)}次  ${yuan(s.cost).padStart(8)}  ${when}  ${s.title ?? '-'}`)
  }
}
