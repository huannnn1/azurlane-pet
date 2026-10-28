/* 动作选择窗口：搜索、点击立即播放、回待机 */

const el = (id) => document.getElementById(id)
const listEl = el('list')

const KIND_TITLE = {
  common: '常用',
  main: '待机变化',
  drag: '拖动动作',
  story: '剧情 / 其他',
  touchIdle: '触摸待机',
}
const KIND_ORDER = ['common', 'main', 'drag', 'story', 'touchIdle']

let all = []
let playing = null

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function rowHtml(m) {
  return `<div class="row ${m.key === playing ? 'playing' : ''}" data-key="${escapeHtml(m.key)}">
    <span class="label">${escapeHtml(m.label)}</span>
    <span class="key">${escapeHtml(m.key)}</span>
  </div>`
}

function render() {
  const q = el('q').value.trim().toLowerCase()
  const filtered = q
    ? all.filter((m) => m.label.toLowerCase().includes(q) || m.key.toLowerCase().includes(q))
    : all

  el('count').textContent = q ? `${filtered.length} / ${all.length} 个` : `${all.length} 个动作`

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty">没找到匹配的动作</div>'
    return
  }

  // 常用动作里 idle / touch_* 排前面，其余按分组
  const groups = {}
  for (const m of filtered) (groups[m.kind] ??= []).push(m)

  listEl.innerHTML = KIND_ORDER
    .filter((k) => groups[k]?.length)
    .map((k) => `<div class="group">${KIND_TITLE[k]}（${groups[k].length}）</div>`
      + groups[k].map(rowHtml).join(''))
    .join('')
}

async function load() {
  try {
    all = await window.pet.motionsDetail()
  } catch (e) {
    listEl.innerHTML = '<div class="empty">读取动作列表失败</div>'
    return
  }
  render()
}

listEl.addEventListener('click', (e) => {
  const row = e.target.closest('[data-key]')
  if (!row) return
  const key = row.dataset.key
  playing = key
  window.pet.playMotion(key)
  render()
})

el('q').addEventListener('input', render)
el('close').addEventListener('click', () => window.pet.closeMotions())
el('rest').addEventListener('click', () => {
  playing = 'idle'
  window.pet.playMotion('idle')
  render()
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.pet.closeMotions()
})

load()
