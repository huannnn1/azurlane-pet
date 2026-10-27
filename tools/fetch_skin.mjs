/**
 * fetch_skin.mjs — 从 azlassets.nagami.moe 下载碧蓝航线 Live2D 皮肤
 *
 * 用法：
 *   node tools/fetch_skin.mjs lafei_4 dafeng_4
 *   AL_SERVER=JP node tools/fetch_skin.mjs lafei_4      # 换服（三服内容一致，默认 EN）
 *   AL_OUT=assets node tools/fetch_skin.mjs <skin>      # 输出目录
 *
 * 说明：
 *   - 皮肤名不带 _hx 后缀 = 原版；带 _hx = 和谐版
 *   - 自动读 model3.json 拉取 moc3 / textures / physics / motions 全部依赖
 */
import fs from 'node:fs'
import path from 'node:path'

const SERVER = process.env.AL_SERVER || 'EN'
const OUT = process.env.AL_OUT || path.resolve(process.cwd(), 'assets')
const CONCURRENCY = Number(process.env.AL_CONC || 4)
const CDN = (skin) => `https://azlassets.nagami.moe/${SERVER}/live2d/${encodeURIComponent(skin)}/`

const skins = process.argv.slice(2)
if (!skins.length) {
  console.error('用法: node tools/fetch_skin.mjs <skin1> [skin2 ...]')
  process.exit(1)
}

async function download(skin) {
  const dir = path.join(OUT, skin)
  const m3url = `${CDN(skin)}${skin}.model3.json`
  const res = await fetch(m3url)
  if (!res.ok) return { skin, status: res.status, files: 0, bytes: 0 }
  const text = await res.text()
  const j = JSON.parse(text)

  const fr = j.FileReferences || {}
  const rel = []
  if (fr.Moc) rel.push(fr.Moc)
  for (const t of fr.Textures || []) rel.push(t)
  if (fr.Physics) rel.push(fr.Physics)
  if (fr.Pose) rel.push(fr.Pose)
  if (fr.DisplayInfo) rel.push(fr.DisplayInfo)
  for (const g of Object.values(fr.Motions || {})) for (const m of g) if (m.File) rel.push(m.File)
  for (const e of fr.Expressions || []) if (e.File) rel.push(e.File)

  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${skin}.model3.json`), text)

  let bytes = 0
  let done = 0
  let i = 0
  const queue = [...new Set(rel)]

  async function worker() {
    while (i < queue.length) {
      const relPath = queue[i++]
      const url = `${CDN(skin)}${relPath.split('/').map(encodeURIComponent).join('/')}`
      const target = path.join(dir, relPath)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(url)
          if (!r.ok) throw new Error(String(r.status))
          const buf = Buffer.from(await r.arrayBuffer())
          fs.writeFileSync(target, buf)
          bytes += buf.length
          done++
          break
        } catch (e) {
          if (attempt === 2) console.error(`  ! ${skin}/${relPath} 失败: ${e.message}`)
          else await new Promise((r) => setTimeout(r, 600))
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))
  return { skin, status: 200, files: done, bytes, total: queue.length }
}

let sum = 0
for (const skin of skins) {
  const t0 = Date.now()
  const r = await download(skin)
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  if (r.status !== 200) {
    console.log(`✗ ${skin.padEnd(26)} HTTP ${r.status}`)
    continue
  }
  sum += r.bytes
  console.log(`✓ ${skin.padEnd(26)} ${String(r.files).padStart(3)}/${r.total} 文件  ${(r.bytes / 1048576).toFixed(2)} MB  ${secs}s`)
}
console.log(`\n合计 ${(sum / 1048576).toFixed(1)} MB → ${OUT}`)
