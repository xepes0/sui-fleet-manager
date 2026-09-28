function setDetailTab(name) {
  document.querySelectorAll('[data-detail-tab]').forEach(button => {
    const selected = button.dataset.detailTab === name;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.detail-panel').forEach(panel => {
    panel.classList.toggle('hidden', panel.dataset.detailPanel !== name);
  });
  $('detail-dialog').scrollTop = 0;
}

function renderServerDetail(d) {
  const row = state.dashboard.find(x => x.server.id === d.server.id) || {};
  const k = row.komari || {}, kn = row.komari_node || {}, sbd = d.status?.sbd || {};
  const inbounds = d.inbounds?.inbounds || [], outbounds = d.outbounds?.outbounds || [];
  const clients = d.clients?.clients || [], rules = d.route_rules || [];
  const value = (label, val) => `<div class="detail-value"><span>${esc(label)}</span><b>${esc(val)}</b></div>`;
  const count = (label, val) => `<div class="detail-count"><b>${esc(val)}</b><span>${esc(label)}</span></div>`;
  const manage = (label, action, target = '') => `<button class="secondary detail-edit" data-server-action="${action}" data-server-id="${d.server.id}" data-target="${esc(target)}">${esc(label)}</button>`;
  const tools = (title, actions) => `<div class="detail-list-head"><h3 class="detail-section-title">${esc(title)}</h3><div class="detail-list-actions">${actions.join('')}</div></div>`;
  const empty = label => `<div class="detail-empty">暂无${esc(label)}</div>`;
  const list = (items, draw, label) => items.length ? `<div class="detail-list">${items.map(draw).join('')}</div>` : empty(label);
  const probe = !d.server.komari_uuid ? '未绑定' : k.online === true ? '在线' : k.online === false ? '离线' : '状态未知';
  const core = sbd.running === true ? '运行中' : sbd.maintenance === true ? '维护中' : sbd.running === false ? '已停止' : '状态未知';
  const errors = Object.entries(d.errors || {});
  const overview = `<div class="detail-counts">${count('入站', inbounds.length)}${count('出站', outbounds.length)}${count('路由规则', rules.length)}${count('用户', clients.length)}</div>
    <h3 class="detail-section-title">运行状态</h3><div class="detail-grid">${value('Komari 探针', probe)}${value('sing-box', core)}${value('CPU', k.cpu == null ? '—' : Math.round(k.cpu) + '%')}${value('内存', pct(k.ram, k.ram_total || kn.mem_total))}${value('磁盘', pct(k.disk, k.disk_total || kn.disk_total))}${value('负载', k.load ?? '—')}${value('API 延迟', row.error ? '异常' : row.latency_ms + ' ms')}${value('网络发送', k.net_out == null ? '—' : bytes(k.net_out) + '/s')}</div>
    <div class="detail-quick-actions"><h3 class="detail-section-title">配置操作</h3><div>${manage('新增入站', 'inbound_create')}${manage('新增出站', 'outbound_create')}${manage('新增路由规则', 'route_rule_add')}${manage('创建用户', 'client_create')}${manage('备份数据库', 'backup')}</div></div>
    ${errors.length ? `<div class="detail-alert">${errors.map(([key, message]) => `<p>${esc(key)}：${esc(message)}</p>`).join('')}</div>` : ''}`;
  const inboundList = list(inbounds, n => `<div class="detail-item"><div class="detail-item-head"><strong>${esc(n.tag || n.name || '未命名')}</strong>${status(n.enable === false ? '停用' : '启用', n.enable === false ? 'warn' : 'ok')}</div><div class="detail-item-meta"><span>${esc(n.type || n.protocol || '—')}</span><span>端口 ${esc(n.listen_port || n.port || '—')}</span><span>ID ${esc(n.id)}</span></div><div class="detail-item-actions">${manage('编辑入站', 'inbound_patch', n.tag)}</div></div>`, '入站');
  const outboundList = list(outbounds, o => `<div class="detail-item"><div class="detail-item-head"><strong>${esc(o.tag || '未命名')}</strong><span class="pill">${esc(o.type || '—')}</span></div><div class="detail-item-meta"><span>ID ${esc(o.id)}</span>${o.server ? `<span>${esc(o.server)}${o.server_port ? ':' + esc(o.server_port) : ''}</span>` : ''}</div>${['direct','block'].includes(o.type) ? '' : `<div class="detail-item-actions">${manage('编辑出站', 'outbound_patch', o.tag)}</div>`}</div>`, '出站');
  const ruleList = list(rules, (rule, index) => `<div class="detail-item"><div class="detail-item-head"><strong><span class="rule-index">${index + 1}</span>${esc(rule.outbound || rule.action || '未指定动作')}</strong><span class="pill">路由</span></div><div class="detail-item-meta">${esc(Object.entries(rule).filter(([key]) => !['action', 'outbound'].includes(key)).map(([key, val]) => `${key}: ${Array.isArray(val) ? val.join(', ') : String(val)}`).join(' · ') || '无匹配条件')}</div><div class="detail-item-actions">${manage('修改规则', 'route_rule_replace', index)}${manage('删除规则', 'route_rule_delete', index)}</div><details><summary>完整规则</summary><pre>${esc(JSON.stringify(rule, null, 2))}</pre></details></div>`, '路由规则');
  const clientList = list(clients, c => `<div class="detail-item"><div class="detail-item-head"><strong>${esc(c.name || '未命名')}</strong>${status(c.enable ? '启用' : '停用', c.enable ? 'ok' : 'warn')}</div><div class="detail-item-meta"><span>用量 ${bytes((+c.up || 0) + (+c.down || 0))} / ${(+c.volume || 0) ? bytes(c.volume) : '不限'}</span><span>入站 ${esc((c.inbounds || []).join(', ') || '—')}</span></div><div class="detail-item-actions">${manage(c.enable ? '停用用户' : '启用用户', c.enable ? 'client_disable' : 'client_enable', c.name)}</div></div>`, '用户');
  $('detail-content').innerHTML = `<section class="detail-panel" data-detail-panel="overview">${overview}</section><section class="detail-panel hidden" data-detail-panel="inbounds">${tools(`入站 · ${inbounds.length}`, [manage('新增入站','inbound_create')])}${inboundList}</section><section class="detail-panel hidden" data-detail-panel="outbounds">${tools(`出站 · ${outbounds.length}`, [manage('新增出站','outbound_create')])}${outboundList}</section><section class="detail-panel hidden" data-detail-panel="routes">${tools(`路由规则 · ${rules.length}`, [manage('新增规则','route_rule_add')])}${ruleList}</section><section class="detail-panel hidden" data-detail-panel="clients">${tools(`用户 · ${clients.length}`, [manage('创建用户','client_create')])}${clientList}</section>`;
  setDetailTab('overview');
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-detail-tab]');
  if (button) setDetailTab(button.dataset.detailTab);
});
