// 从已下载的 l2d_mapping_cn.json 生成 tools/skin_names.json
import fs from 'node:fs'

const ROOT = 'D:/project/azurlane-pet'
const raw = JSON.parse(fs.readFileSync(`${ROOT}/tools/l2d_mapping_cn.json`, 'utf8'))
let nameCode = {}
try { nameCode = JSON.parse(fs.readFileSync(`${ROOT}/tools/name_code.json`, 'utf8')) } catch {}

/** 把 {namecode:22} 这类占位符换成真实船名 */
function fixName(s) {
  if (!s) return s
  return s.replace(/\{namecode:(\d+)\}/gi, (_, id) => {
    const n = nameCode[id]
    return n?.CN ?? n?.EN ?? `未命名(${id})`
  })
}

const out = {}
for (const [shipId, ship] of Object.entries(raw)) {
  const shipCn = fixName(ship?.names?.CN ?? ship?.names?.EN ?? shipId)
  const shipEn = ship?.names?.EN ?? ''
  for (const skin of ship?.skins ?? []) {
    const prefab = skin?.prefab
    if (!prefab) continue
    const skinCn = fixName(skin?.names?.CN ?? '')
    const skinEn = skin?.names?.EN ?? ''
    out[prefab] = {
      ship: shipCn,
      shipEn,
      skin: skinCn && skinCn !== shipCn ? skinCn : '',
      skinEn,
      label: skinCn && skinCn !== shipCn ? `${shipCn} · ${skinCn}` : shipCn,
    }
  }
}

fs.writeFileSync(`${ROOT}/tools/skin_names.json`, JSON.stringify(out, null, 1), 'utf8')

const local = fs.readdirSync(`${ROOT}/assets`, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((n) => fs.existsSync(`${ROOT}/assets/${n}/${n}.model3.json`))

const missing = local.filter((n) => !out[n])
console.log('皮肤条目:', Object.keys(out).length, '| 本地:', local.length, '| 缺中文名:', missing.length)
console.log('示例:')
for (const n of ['lafei_4', 'xuefeng_3', 'shuixinghao_2', 'zhangwu_2', 'ougen_8']) {
  if (out[n]) console.log(`  ${n.padEnd(16)} → ${out[n].label}`)
}
if (missing.length) console.log('缺名:', missing.slice(0, 8).join(', '))
