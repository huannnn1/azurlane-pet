/**
 * verify_all.mjs — 校验本地皮肤完整性（不联网、不改文件，只读）
 *
 * 检查项：
 *   1. <skin>/<skin>.model3.json 存在且能解析
 *   2. 所有依赖文件存在且非空
 *   3. moc3 文件头是 MOC3 魔数（防止把错误页存成模型）
 *   4. 纹理是 PNG/WebP 头
 *
 * 用法：node tools/verify_all.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const OUT = path.resolve('assets')
const skins = fs.readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)

const bad = []
let ok = 0
let totalBytes = 0

function deps(j) {
  const fr = j.FileReferences || {}
  const rel = []
  if (fr.Moc) rel.push(fr.Moc)
  for (const t of fr.Textures || []) rel.push(t)
  if (fr.Physics) rel.push(fr.Physics)
  if (fr.Pose) rel.push(fr.Pose)
  for (const g of Object.values(fr.Motions || {})) for (const m of g) if (m.File) rel.push(m.File)
  for (const e of fr.Expressions || []) if (e.File) rel.push(e.File)
  return [...new Set(rel)]
}

function head(p, n = 4) {
  const fd = fs.openSync(p, 'r')
  const b = Buffer.alloc(n)
  fs.readSync(fd, b, 0, n, 0)
  fs.closeSync(fd)
  return b
}

for (const skin of skins) {
  const dir = path.join(OUT, skin)
  const m3 = path.join(dir, `${skin}.model3.json`)
  if (!fs.existsSync(m3)) { bad.push(`${skin}: 缺 model3.json`); continue }
  let j
  try { j = JSON.parse(fs.readFileSync(m3, 'utf8')) } catch (e) { bad.push(`${skin}: model3.json 解析失败 ${e.message}`); continue }

  const list = deps(j)
  const miss = []
  for (const rel of list) {
    const p = path.join(dir, rel)
    try {
      const st = fs.statSync(p)
      if (st.size === 0) miss.push(rel + ' (空)')
      else totalBytes += st.size
    } catch { miss.push(rel) }
  }
  if (miss.length) { bad.push(`${skin}: 缺 ${miss.length} 个文件 (${miss.slice(0, 3).join(', ')})`); continue }

  // 魔数检查
  const moc = path.join(dir, j.FileReferences.Moc)
  if (head(moc, 4).toString('ascii') !== 'MOC3') bad.push(`${skin}: moc3 魔数不对`)

  for (const t of j.FileReferences.Textures || []) {
    const h = head(path.join(dir, t), 8)
    const isPng = h[0] === 0x89 && h[1] === 0x50
    const isWebp = h.subarray(0, 4).toString('ascii') === 'RIFF'
    if (!isPng && !isWebp) { bad.push(`${skin}: 纹理 ${t} 不是图片`); break }
  }
  ok++
}

console.log(`校验 ${skins.length} 个目录：正常 ${ok}，异常 ${bad.length}`)
console.log(`资源合计 ${(totalBytes / 1073741824).toFixed(2)} GB`)
if (bad.length) {
  console.log('\n异常明细（前 30 条）：')
  for (const b of bad.slice(0, 30)) console.log('  ' + b)
}
