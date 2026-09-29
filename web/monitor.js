let pingHistoryAt = 0;
let pingHistoryLoading = false;
let monitorRegion = 'all';

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
  return `<article class="monitor-card ${online ? '' : 'offline'}" ${cardAction}>
    <div class="monitor-card-head"><div class="monitor-name"><span class="monitor-region-flag">${esc(node.region || '🌐')}</span><div><h3>${esc(name)}</h3><small>${esc(node.cpu_name || node.os || 'Komari 探针')}</small></div></div>${status(online ? '在线' : '离线', online ? 'ok' : 'bad')}</div>
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
  const term = ($('monitor-search').value || '').trim().toLowerCase();
  const nodes = state.monitorNodes.filter(node => {
    const matchesRegion = monitorRegion === 'all' || String(node.region || '其他').toUpperCase() === monitorRegion;
    const matchesTerm = !term || `${node.name || ''} ${node.region || ''} ${node.group || ''}`.toLowerCase().includes(term);
    return matchesRegion && matchesTerm;
  });
  $('monitor-count').textContent = `显示 ${nodes.length} / ${state.monitorNodes.length} 台`;
  if (!state.monitorNodes.length) {
    $('server-list').innerHTML = state.dashboard.length ? `<div class="empty">Komari 探针数据暂不可用；下方仍可打开已登记的 S-UI 面板。</div><div class="monitor-grid">${state.dashboard.map(serverCard).join('')}</div>` : '<div class="empty">暂无探针。先检查 Komari 连接或添加 S-UI 面板。</div>';
    return;
  }
  $('server-list').innerHTML = nodes.length ? `<div class="monitor-grid">${nodes.map(monitorCard).join('')}</div>` : '<div class="empty">没有匹配的服务器</div>';
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
