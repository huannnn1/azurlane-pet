/* 用量明细窗口：按天 / 按会话展示 token 与按官方价折算的费用 */

const el = (id) => document.getElementById(id)

const fmtTok = (n) => {
  if (!Number.isFinite(n) || n === 0) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

const fmtYuan = (c) => {
  const v = Number(c) || 0
  if (v > 0 && v < 0.01) return '<¥0.01'
  return '¥' + v.toFixed(2)
}

/** 10-28 这种短日期 */
const shortDate = (s) => (s.length >= 10 ? s.slice(5) : s)

/** 10-28 15:04 */
function shortTime(ts) {
  if (!ts) return '--'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]))
}

function renderDaily(daily, todayDate) {
  const tbody = el('dailyTable').querySelector('tbody')
  if (!daily?.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">这个时间段还没有用量记录</td></tr>'
    return
  }
  tbody.innerHTML = daily.map((d) => {
    const isToday = d.date === todayDate
    return `<tr class="${isToday ? 'today' : ''}">
      <td>${shortDate(d.date)}${isToday ? ' · 今天' : ''}</td>
      <td class="muted">${d.calls ?? 0}</td>
      <td>${fmtTok(d.inputTokens)}</td>
      <td class="muted">${fmtTok(d.cacheReadTokens)}</td>
      <td>${fmtTok(d.outputTokens)}</td>
      <td class="cost">${fmtYuan(d.cost)}</td>
    </tr>`
  }).join('')
}

function renderSessions(sessions) {
  const tbody = el('sessionTable').querySelector('tbody')
  if (!sessions?.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">这个时间段还没有会话记录</td></tr>'
    return
  }
  tbody.innerHTML = sessions.map((s) => `<tr>
    <td><span class="name" title="${escapeHtml(s.title || '未命名会话')}">${escapeHtml(s.title || '未命名会话')}</span></td>
    <td class="muted">${shortTime(s.last)}</td>
    <td class="muted">${s.calls ?? 0}</td>
    <td>${fmtTok(s.totalTokens)}</td>
    <td class="cost">${fmtYuan(s.cost)}</td>
  </tr>`).join('')
}

function renderPrice(price) {
  if (!price) return
  el('modelName').textContent = price.model ?? 'deepseek-flash'
  el('pIdleHit').textContent = price.idle?.cacheHit ?? '-'
  el('pIdleMiss').textContent = price.idle?.cacheMiss ?? '-'
  el('pIdleOut').textContent = price.idle?.output ?? '-'
}

async function load(silent) {
  // 首次要多解压一些会话文件，先给个加载态；静默刷新时不闪
  if (!silent) {
    el('todayCost').textContent = '计算中…'
    el('todayCost').classList.add('loading')
    el('totalCost').textContent = '计算中…'
    el('totalCost').classList.add('loading')
  }

  let data
  try {
    data = await window.pet.usageDetail()
  } catch (e) {
    el('todayCost').textContent = '读取失败'
    el('todayCost').style.color = '#ff9b8f'
    return
  }

  el('todayCost').classList.remove('loading')
  el('totalCost').classList.remove('loading')

  if (!data || data.error) {
    el('todayCost').textContent = '读取失败'
    el('todayCost').style.color = '#ff9b8f'
    el('todayTok').textContent = data?.error ?? ''
    return
  }

  const today = data.today ?? {}
  const grand = data.grand ?? {}
  const daily = data.daily ?? []
  const todayDate = data.todayDate ?? ''

  el('todayCost').textContent = fmtYuan(today.cost)
  el('todayTok').textContent = `${fmtTok(today.totalTokens)} tok · ${today.calls ?? 0} 次调用`

  el('totalCost').textContent = fmtYuan(grand.cost)
  el('totalTok').textContent = `${fmtTok(grand.totalTokens)} tok · ${grand.calls ?? 0} 次调用`

  el('range').textContent = daily.length ? `${daily[daily.length - 1].date} ~ ${daily[0].date}` : ''
  renderPrice(data.price)
  renderDaily(daily, todayDate)
  renderSessions(data.sessions ?? [])
}

// 标签页切换
let currentTab = 'daily'
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab
    if (tab === currentTab) return
    currentTab = tab
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b === btn))
    el('dailyTable').style.display = tab === 'daily' ? '' : 'none'
    el('sessionTable').style.display = tab === 'sessions' ? '' : 'none'
  })
})

el('close').addEventListener('click', () => window.pet.closeUsage())
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.pet.closeUsage() })

load()

// 窗口开着的时候每分钟刷新，重新聚焦时也立刻拉一次
setInterval(() => load(true), 60_000)
window.addEventListener('focus', () => load(true))
