/* 皮肤选择窗口：搜索、收藏、点击套用 */

const el = (id) => document.getElementById(id)
const listEl = el('list')

let all = []

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function rowHtml(s) {
  return `<div class="row ${s.current ? 'current' : ''}" data-dir="${escapeHtml(s.dir)}">
    <span class="star ${s.fav ? 'on' : ''}" data-fav="${escapeHtml(s.dir)}" title="${s.fav ? '取消收藏' : '收藏'}">${s.fav ? '★' : '☆'}</span>
    <span class="label">${escapeHtml(s.label)}</span>
    <span class="dir">${escapeHtml(s.dir)}</span>
    ${s.current ? '<span class="cur">使用中</span>' : ''}
  </div>`
}

function renderGroup(title, items) {
  if (!items.length) return ''
  return `<div class="group">${title}（${items.length}）</div>` + items.map(rowHtml).join('')
}

function render() {
  const q = el('q').value.trim().toLowerCase()
  const filtered = q
    ? all.filter((s) => s.label.toLowerCase().includes(q) || s.dir.toLowerCase().includes(q))
    : all

  el('count').textContent = q
    ? `${filtered.length} / ${all.length} 个`
    : `${all.length} 个皮肤`

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty">没找到匹配的皮肤</div>'
    return
  }

  const favs = filtered.filter((s) => s.fav)
  const recents = filtered.filter((s) => s.recent && !s.fav)
  const rest = filtered.filter((s) => !s.fav && !s.recent)

  listEl.innerHTML =
    renderGroup('收藏', favs) +
    renderGroup('最近使用', recents) +
    renderGroup('全部', rest)
}

async function load() {
  try {
    all = await window.pet.skinsDetail()
  } catch (e) {
    listEl.innerHTML = '<div class="empty">读取皮肤列表失败</div>'
    return
  }
  render()
}

// 点星：收藏 / 取消收藏（不关闭窗口）
listEl.addEventListener('click', async (e) => {
  const star = e.target.closest('[data-fav]')
  if (star) {
    e.stopPropagation()
    const dir = star.dataset.fav
    await window.pet.toggleFav(dir)
    await load()
    return
  }
  const row = e.target.closest('[data-dir]')
  if (row) {
    const ok = await window.pet.setSkin(row.dataset.dir)
    if (ok?.ok) window.pet.closeSkins()
  }
})

el('q').addEventListener('input', render)
el('close').addEventListener('click', () => window.pet.closeSkins())
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.pet.closeSkins()
})

load()
