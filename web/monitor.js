let pingHistoryAt = 0;
let pingHistoryLoading = false;
let monitorRegion = 'all';
let monitorOrder = [];
let monitorSortMode = 'custom';
let monitorDraggingUUID = '';
let monitorOrderSaveChain = Promise.resolve();

try {
  const savedMode = localStorage.getItem('monitorSortMode');
  if (['custom','default','name','region','latency','expiry'].includes(savedMode)) monitorSortMode = savedMode;
} catch {}

function monitorPercent(used, total) {
  const a = Number(used), b = Number(total);
  return Number.isFinite(a) && Number.isFinite(b) && b > 0 ? Math.max(0, Math.min(100, a / b * 100)) : null;
}

function monitorMeter(label, amount, tone) {
  const width = amount == null ? 0 : amount;
  const text = amount == null ? '—' : `${Math.round(amount)}%`;
  return `<div class="monitor-meter monitor-meter-${tone}"><div class="monitor-meter-head"><span>${esc(label)}</span><b>${text}</b></div><div class="monitor-meter-track"><i style="width:${width}%"></i></div></div>`;
}

function monitorLoadMeter(load) {
  const amount = load == null ? null : Math.max(0, Number(load) || 0);
  const width = amount == null ? 0 : Math.min(100, amount * 25);
  const text = amount == null ? '—' : amount.toFixed(2);
  return `<div class="monitor-meter monitor-meter-load"><div class="monitor-meter-head"><span>负载</span><b>${esc(text)}</b></div><div class="monitor-meter-track"><i style="width:${width}%"></i></div></div>`;
}

function monitorLatencyClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 'ping-value-muted';
  return n < 100 ? 'ping-value-good' : n < 200 ? 'ping-value-warn' : 'ping-value-bad';
}

function monitorLossClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'ping-value-muted';
  return n <= 0.1 ? 'ping-loss-good' : n <= 5 ? 'ping-loss-warn' : 'ping-loss-bad';
}

function monitorRegionFlag(region) {
  const flags = {CN:'🇨🇳',HK:'🇭🇰',SG:'🇸🇬',JP:'🇯🇵',US:'🇺🇸',TW:'🇹🇼',KR:'🇰🇷',DE:'🇩🇪',GB:'🇬🇧',FR:'🇫🇷',CA:'🇨🇦',AU:'🇦🇺'};
  return flags[String(region || '').toUpperCase()] || '🌐';
}

function renderMonitorRegions() {
  const box = $('monitor-regions');
  if (!box) return;
  const counts = new Map();
  for (const node of state.monitorNodes) {
    const region = String(node.region || '其他').toUpperCase();
    counts.set(region, (counts.get(region) || 0) + 1);
  }
  if (monitorRegion !== 'all' && !counts.has(monitorRegion)) monitorRegion = 'all';
  const chips = [...counts.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([region,count]) =>
    `<button type="button" data-monitor-region="${esc(region)}" class="${monitorRegion===region?'active':''}"><span>${monitorRegionFlag(region)}</span><b>${esc(region)}</b><em>${count}</em></button>`
  ).join('');
  box.innerHTML = `<button type="button" data-monitor-region="all" class="${monitorRegion==='all'?'active':''}"><b>全部</b><em>${state.monitorNodes.length}</em></button>${chips}`;
}

function monitorUptime(seconds) {
  if (!Number.isFinite(+seconds) || +seconds < 0) return '—';
  const days = Math.floor(+seconds / 86400);
  const hours = Math.floor((+seconds % 86400) / 3600);
  return days ? `${days} 天 ${hours} 小时` : `${hours} 小时`;
}

function monitorExpiry(raw) {
  const time = new Date(raw).getTime();
  if (!Number.isFinite(time)) return '未设置到期日';
  const days = Math.ceil((time - Date.now()) / 86400000);
  if (days > 36500) return '长期有效';
  return days < 0 ? `已到期 ${-days} 天` : `剩 ${days} 天`;
}

function monitorPrice(node) {
  if (node.price == null || !Number.isFinite(+node.price) || +node.price <= 0) return '—';
  const cycle = Number(node.billing_cycle);
  const suffix = cycle >= 360 ? '/年' : cycle >= 28 && cycle <= 31 ? '/月' : cycle > 0 ? `/${cycle}天` : '';
  return `${node.currency || ''}${node.price}${suffix}`;
}

function monitorPing(uuid, live) {
  const tasks = Object.entries(live.ping || {}).sort(([a], [b]) => Number(a) - Number(b));
  if (!tasks.length) return '<div class="monitor-ping-empty">尚无 Ping 任务数据</div>';
  return `<div class="monitor-pings">${tasks.map(([id, info]) => {
    const history = state.pingHistory[uuid]?.[id] || [];
    const bars = history.length ? `<div class="monitor-ping-bars" aria-label="近一小时 Ping 历史">${history.slice(-12).map(value => `<i class="${value == null || +value < 0 ? 'missing' : +value < 100 ? 'fast' : +value < 200 ? 'medium' : 'slow'}" title="${value == null ? '无数据' : +value < 0 ? '丢包' : Math.round(+value) + ' ms'}"></i>`).join('')}</div>` : '<div class="monitor-ping-bars muted-bars">历史数据加载中</div>';
    const loss = Number(info.loss), rawLatency = Number(info.latest);
    const latency = info.latest == null || rawLatency < 0 ? '—' : `${Math.round(rawLatency)} ms`;
    return `<div class="monitor-ping-row"><div class="monitor-ping-label"><span>${esc(info.name || '任务 '+id)}</span><b class="${monitorLatencyClass(rawLatency)}">${esc(latency)}</b><span class="${monitorLossClass(loss)}">${Number.isFinite(loss) ? loss.toFixed(1) + '%' : '—'}</span></div>${bars}</div>`;
  }).join('')}</div>`;
}

function monitorLink(uuid) {
  try {
    const url = new URL(state.komariURL), host = url.hostname.toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || host === 'localhost' || host.startsWith('127.') || host === '[::1]') return '';
    return url.href.replace(/\/$/, '') + '/instance/' + encodeURIComponent(uuid);
  } catch { return ''; }
}

function monitorAverageLatency(node) {
  const values = Object.values(node.status?.ping || {}).map(info => Number(info.latest)).filter(value => Number.isFinite(value) && value >= 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.POSITIVE_INFINITY;
}

function monitorExpiryTimestamp(node) {
  const value = new Date(node.expired_at).getTime();
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function monitorFullOrder() {
  const liveIDs = state.monitorNodes.map(node => String(node.uuid));
  const liveSet = new Set(liveIDs);
  const order = monitorOrder.filter(id => liveSet.has(id));
  const known = new Set(order);
  for (const id of liveIDs) if (!known.has(id)) order.push(id);
  return order;
}

function monitorSortedNodes(nodes) {
  const rows = [...nodes];
  const byName = (a, b) => String(a.name || a.uuid).localeCompare(String(b.name || b.uuid), 'zh-CN', {numeric:true});
  if (monitorSortMode === 'custom') {
    const rank = new Map(monitorFullOrder().map((id, index) => [id, index]));
    return rows.sort((a, b) => (rank.get(String(a.uuid)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(String(b.uuid)) ?? Number.MAX_SAFE_INTEGER) || byName(a,b));
  }
  if (monitorSortMode === 'name') return rows.sort(byName);
  if (monitorSortMode === 'region') return rows.sort((a,b) => String(a.region || '').localeCompare(String(b.region || ''), 'zh-CN') || byName(a,b));
  if (monitorSortMode === 'latency') return rows.sort((a,b) => monitorAverageLatency(a) - monitorAverageLatency(b) || byName(a,b));
  if (monitorSortMode === 'expiry') return rows.sort((a,b) => monitorExpiryTimestamp(a) - monitorExpiryTimestamp(b) || byName(a,b));
  return rows;
}

function monitorMergeVisibleOrder(visibleOrder) {
  const base = monitorFullOrder();
  const visible = new Set(visibleOrder);
  let next = 0;
  return base.map(id => visible.has(id) ? visibleOrder[next++] : id);
}

function syncMonitorToolbar() {
  const sort = $('monitor-sort');
  if (sort && sort.value !== monitorSortMode) sort.value = monitorSortMode;
  $('monitor-order-reset')?.classList.toggle('hidden', monitorOrder.length === 0);
  $('monitor-order-hint')?.classList.toggle('hidden', monitorSortMode !== 'custom');
}

async function loadMonitorOrder() {
  try {
    const pref = await api('preferences/monitor-order');
    monitorOrder = Array.isArray(pref.order) ? pref.order.map(String) : [];
  } catch (error) {
    console.warn('Monitor order:', error.message);
  }
  if (state.monitorNodes.length) renderMonitorHome();
}

function saveMonitorOrder() {
  const snapshot = [...monitorOrder];
  monitorOrderSaveChain = monitorOrderSaveChain.catch(() => {}).then(async () => {
    try {
      const saved = await api('preferences/monitor-order', {method:'PUT', body:JSON.stringify({order:snapshot})});
      monitorOrder = Array.isArray(saved.order) ? saved.order.map(String) : snapshot;
      syncMonitorToolbar();
    } catch (error) {
      notice('保存探针排序失败：' + error.message);
      throw error;
    }
  });
  return monitorOrderSaveChain;
}

function monitorCard(node) {
  const live = node.status || {};
  const linked = state.dashboard.find(row => row.server.komari_uuid === node.uuid);
  const mem = monitorPercent(live.ram, live.ram_total || node.mem_total);
  const disk = monitorPercent(live.disk, live.disk_total || node.disk_total);
  const cpu = live.cpu == null ? null : Math.max(0, Math.min(100, +live.cpu));
  const limit = +node.traffic_limit || 0;
  const link = monitorLink(node.uuid);
  const name = node.name || node.uuid;
  const online = live.online === true;
  const cardAction = linked ? `data-detail="${linked.server.id}" tabindex="0" role="button" aria-label="管理 ${esc(name)}"` : '';
  const upload = live.net_out == null ? '—' : bytes(live.net_out)+'/s';
  const download = live.net_in == null ? '—' : bytes(live.net_in)+'/s';
  const totalTraffic = live.net_total_up == null && live.net_total_down == null ? '—' : bytes((+live.net_total_up || 0) + (+live.net_total_down || 0));
  const expiry = monitorExpiry(node.expired_at), price = monitorPrice(node);
  const load = live.load == null ? null : Math.max(0, Number(live.load) || 0);
  return `<article class="monitor-card ${online ? '' : 'offline'}" data-monitor-uuid="${esc(node.uuid)}" ${cardAction}>
    <div class="monitor-card-head"><div class="monitor-head-main"><button type="button" class="monitor-drag-handle" data-monitor-drag draggable="true" aria-label="拖动调整顺序" title="拖动调整顺序">⋮⋮</button><div class="monitor-name"><span class="monitor-region-flag">${esc(node.region || '🌐')}</span><div><h3>${esc(name)}</h3><small>${esc(node.cpu_name || node.os || 'Komari 探针')}</small></div></div></div>${status(online ? '在线' : '离线', online ? 'ok' : 'bad')}</div>
    <div class="monitor-meters">${monitorMeter('CPU', cpu, 'cpu')}${monitorMeter('内存', mem, 'memory')}${monitorMeter('磁盘', disk, 'disk')}${monitorLoadMeter(load)}</div>
    <div class="monitor-facts">
      <div class="monitor-fact monitor-fact-traffic"><span>实时流量</span><b><em class="traffic-up">↑ ${esc(upload)}</em><em class="traffic-down">↓ ${esc(download)}</em></b></div>
      <div class="monitor-fact"><span>连接</span><b>TCP ${esc(live.connections ?? '—')} · UDP ${esc(live.connections_udp ?? '—')}</b></div>
      <div class="monitor-fact"><span>在线</span><b>${monitorUptime(live.uptime)}</b></div>
      <div class="monitor-fact"><span>到期 / 价格</span><b>${esc(expiry)} · ${esc(price)}</b></div>
      <div class="monitor-fact"><span>本次流量</span><b>${esc(totalTraffic)}</b></div>
      <div class="monitor-fact"><span>套餐上限</span><b>${limit ? bytes(limit) : '不限'}</b></div>
    </div>
    ${monitorPing(node.uuid, live)}
    <div class="monitor-card-actions">${linked ? `<button class="primary" data-server-action="inbound_patch" data-server-id="${linked.server.id}">管理 S-UI</button><button class="secondary" data-open-detail="${linked.server.id}">详情</button>` : `<button class="secondary" data-associate="${esc(node.uuid)}">关联 S-UI</button>`}${link ? `<a class="secondary link-button" data-monitor-link href="${esc(link)}" target="_blank" rel="noopener noreferrer">探针 ↗</a>` : ''}</div>
  </article>`;
}

function renderMonitorHome() {
  renderMonitorRegions();
  syncMonitorToolbar();
  const term = ($('monitor-search').value || '').trim().toLowerCase();
  let nodes = state.monitorNodes.filter(node => {
    const matchesRegion = monitorRegion === 'all' || String(node.region || '其他').toUpperCase() === monitorRegion;
    const matchesTerm = !term || `${node.name || ''} ${node.region || ''} ${node.group || ''}`.toLowerCase().includes(term);
    return matchesRegion && matchesTerm;
  });
  nodes = monitorSortedNodes(nodes);
  $('monitor-count').textContent = `显示 ${nodes.length} / ${state.monitorNodes.length} 台`;
  if (!state.monitorNodes.length) {
    $('server-list').innerHTML = state.dashboard.length ? `<div class="empty">Komari 探针数据暂不可用；下方仍可打开已登记的 S-UI 面板。</div><div class="monitor-grid">${state.dashboard.map(serverCard).join('')}</div>` : '<div class="empty">暂无探针。先检查 Komari 连接或添加 S-UI 面板。</div>';
    return;
  }
  $('server-list').innerHTML = nodes.length ? `<div class="monitor-grid ${monitorSortMode === 'custom' ? 'monitor-reorder' : ''}">${nodes.map(monitorCard).join('')}</div>` : '<div class="empty">没有匹配的服务器</div>';
}

async function loadPingHistory() {
  if (pingHistoryLoading || Date.now() - pingHistoryAt < 60000 || !state.monitorNodes.length) return;
  pingHistoryLoading = true;
  try {
    const data = await api('komari/ping-history');
    const history = {};
    for (const series of data.series || []) {
      const id = series.entity_id, task = String(series.tags?.task_id || '');
      if (!id || !task) continue;
      (history[id] ||= {})[task] = (series.points || []).map(point => point.value);
    }
    state.pingHistory = history;
    pingHistoryAt = Date.now();
    renderMonitorHome();
  } catch (error) {
    pingHistoryAt = Date.now();
    console.warn('Komari Ping history:', error.message);
  } finally { pingHistoryLoading = false; }
}

$('monitor-search').addEventListener('input', renderMonitorHome);
$('monitor-regions')?.addEventListener('click', event => {
  const button = event.target.closest('[data-monitor-region]');
  if (!button) return;
  monitorRegion = button.dataset.monitorRegion || 'all';
  renderMonitorHome();
});

$('monitor-sort')?.addEventListener('change', event => {
  monitorSortMode = event.target.value;
  try { localStorage.setItem('monitorSortMode', monitorSortMode); } catch {}
  renderMonitorHome();
});

$('monitor-order-reset')?.addEventListener('click', async () => {
  if (!confirm('恢复探针默认顺序？已保存的自定义顺序会被清空。')) return;
  monitorOrder = [];
  await saveMonitorOrder().catch(() => {});
  renderMonitorHome();
});

document.addEventListener('click', event => {
  if (event.target.closest('[data-monitor-drag]')) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);

$('server-list')?.addEventListener('dragstart', event => {
  const handle = event.target.closest('[data-monitor-drag]');
  if (!handle || monitorSortMode !== 'custom') {
    event.preventDefault();
    return;
  }
  const card = handle.closest('.monitor-card[data-monitor-uuid]');
  if (!card) return;
  monitorDraggingUUID = card.dataset.monitorUuid || '';
  card.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', monitorDraggingUUID);
});

$('server-list')?.addEventListener('dragover', event => {
  if (!monitorDraggingUUID || monitorSortMode !== 'custom') return;
  const grid = event.target.closest('.monitor-grid.monitor-reorder');
  const over = event.target.closest('.monitor-card[data-monitor-uuid]');
  const dragging = grid?.querySelector('.monitor-card.dragging');
  if (!grid || !over || !dragging || over === dragging) return;
  event.preventDefault();
  grid.querySelectorAll('.drag-over').forEach(card => card.classList.remove('drag-over'));
  over.classList.add('drag-over');
  const rect = over.getBoundingClientRect();
  const verticalDelta = event.clientY - (rect.top + rect.height / 2);
  const horizontalDelta = event.clientX - (rect.left + rect.width / 2);
  const sameRow = Math.abs(verticalDelta) < rect.height * .45;
  const before = sameRow ? horizontalDelta < 0 : verticalDelta < 0;
  grid.insertBefore(dragging, before ? over : over.nextSibling);
});

$('server-list')?.addEventListener('dragend', async event => {
  const card = event.target.closest('.monitor-card[data-monitor-uuid]');
  if (card) card.classList.remove('dragging');
  document.querySelectorAll('.monitor-card.drag-over').forEach(item => item.classList.remove('drag-over'));
  if (!monitorDraggingUUID || monitorSortMode !== 'custom') {
    monitorDraggingUUID = '';
    return;
  }
  monitorDraggingUUID = '';
  const visibleOrder = [...document.querySelectorAll('#server-list .monitor-grid .monitor-card[data-monitor-uuid]')].map(card => String(card.dataset.monitorUuid));
  if (visibleOrder.length) {
    monitorOrder = monitorMergeVisibleOrder(visibleOrder);
    await saveMonitorOrder().catch(() => {});
    renderMonitorHome();
  }
});

loadMonitorOrder();
