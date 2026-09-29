const tl={items:[],kind:'all',editing:null,applying:null,preview:null,ruleSets:new Map(),subscriptionPreview:null,subscriptionExportRows:[],subscriptionExportGroups:[]};
const tlKinds=[['all','全部'],['rule_set','规则集'],['outbound','出站'],['subscription_json','sing-box 订阅'],['subscription_clash','Mihomo 订阅']];
const tlLabel=kind=>tlKinds.find(row=>row[0]===kind)?.[1]||kind;
const tlValue=id=>$(id)?.value.trim()||'';
const tlField=(label,id,value='',extra='')=>`<label>${label}<input id="${id}" value="${esc(value)}" ${extra}></label>`;

function tlRender(){
  $('template-kinds').innerHTML=tlKinds.map(([kind,label])=>`<button data-template-kind="${kind}" class="${tl.kind===kind?'active':''}">${label} <small>${kind==='all'?tl.items.length:tl.items.filter(x=>x.kind===kind).length}</small></button>`).join('');
  const items=tl.items.filter(x=>tl.kind==='all'||x.kind===tl.kind);
  $('template-list').innerHTML=items.length?items.map(item=>`<article class="template-card"><div class="eyebrow">${tlLabel(item.kind)}</div><h3>${esc(item.name)}</h3><p>更新于 ${esc(date(item.updated_at))}</p><div class="button-row"><button class="primary" data-template-apply="${item.id}">选择服务器套用</button><button class="secondary" data-template-edit="${item.id}">编辑</button><button class="danger" data-template-delete="${item.id}">删除</button></div></article>`).join(''):'<div class="empty">这个类别还没有模板。点右上角新建。</div>';
}
async function tlLoad(){try{tl.items=await api('templates');tlRender()}catch(e){notice('模板库读取失败：'+e.message)}}
async function tlOpen(item=null){
  tl.editing=item;tl.preview=null;
  if((item?.kind||$('template-kind').value)==='subscription_json'){
    const rows=await Promise.all(tl.items.filter(x=>x.kind==='rule_set').map(async x=>[x.id,(await api('templates/'+x.id)).payload]));
    tl.ruleSets=new Map(rows);
  }
  $('template-dialog-title').textContent=item?'编辑模板':'新建模板';
  $('template-name').value=item?.name||'';$('template-kind').value=item?.kind||'rule_set';$('template-kind').disabled=!!item;
  tlRenderFields();$('template-dialog').showModal();
}
function tlRenderFields(){
  const kind=$('template-kind').value,p=tl.editing?.payload||{},box=$('template-fields');
  if(kind==='rule_set'){
    box.innerHTML=`<div class="template-form-grid">${tlField('规则集 Tag','tl-tag',p.tag||'','required pattern="[A-Za-z0-9_.-]+"')}${tlField('远程规则文件 URL','tl-url',p.url||'','required type="url" class="full" placeholder="https://example.com/rules.srs"')}<label>格式<select id="tl-format"><option value="binary">二进制 .srs</option><option value="source">源码 JSON</option></select></label></div><p class="template-hint">仅记录公开 HTTPS 地址；控制台不会下载远程文件。套用前会逐台预览 S-UI 核心配置。</p>`;
    $('tl-format').value=p.format||'binary';
  }else if(kind==='outbound'){
    box.innerHTML=`<div class="template-form-grid">${tlField('出站 Tag','tl-tag',p.tag||'','required pattern="[A-Za-z0-9_.-]+"')}<label>协议<select id="tl-type">${[['direct','直连'],['block','阻断'],['socks','SOCKS5'],['http','HTTP'],['vless','VLESS'],['trojan','Trojan'],['hysteria2','Hysteria2'],['anytls','AnyTLS']].map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label></div><div id="tl-protocol-fields"></div><p class="template-hint">凭据在控制台数据库中加密保存；选择服务器后仍须预览并执行，套用时会先备份 S-UI。</p>`;
    $('tl-type').value=p.type||'socks';tlRenderProtocolFields();
  }else if(kind==='subscription_json'){
    const existing=p.rule_set||[];
    box.innerHTML=`<div class="template-form-grid"><label>未匹配流量<select id="tl-final"><option value="proxy">代理</option><option value="direct">直连</option><option value="auto">自动选择</option></select></label><label class="check-line"><input id="tl-sniff" type="checkbox" ${!p.rules||p.rules.some(x=>x.action==='sniff')?'checked':''}> 自动识别协议</label></div><h3>按规则集分流</h3><p class="template-hint">选择已保存的规则集，按顺序加入订阅。规则集定义会放在 S-UI 所要求的模板顶层。</p><div class="template-rule-rows">${tl.items.filter(x=>x.kind==='rule_set').map(item=>{const found=existing.find(x=>x.tag===tl.ruleSets.get(item.id)?.tag);return `<div class="template-rule-row"><label class="check-line"><input data-tl-ruleset="${item.id}" type="checkbox" ${found?'checked':''}> ${esc(item.name)}</label><label>处理方式<select data-tl-ruleset-action="${item.id}"><option value="proxy">代理</option><option value="direct">直连</option><option value="reject">拒绝</option></select></label></div>`}).join('')||'<p class="hint">请先建立规则集模板。</p>'}</div>`;
    $('tl-final').value=p.final||'proxy';
    for(const item of tl.items.filter(x=>x.kind==='rule_set')){const tag=tl.ruleSets.get(item.id)?.tag;const rule=p.rules?.find(x=>x.rule_set===tag);if(rule){const select=document.querySelector(`[data-tl-ruleset-action="${item.id}"]`);select.value=rule.action==='reject'?'reject':rule.outbound||'proxy'}}
  }else{
    const yaml=typeof p==='string'?p:'';
    const port=/^mixed-port:\s*(\d+)/m.exec(yaml)?.[1]||'7890';
    box.innerHTML=`<div class="template-form-grid">${tlField('混合监听端口','tl-mixed-port',port,'required type="number" min="1" max="65535"')}<label>未匹配流量<select id="tl-clash-final"><option value="Proxy">代理</option><option value="DIRECT">直连</option></select></label><label class="check-line"><input id="tl-clash-lan" type="checkbox" ${/^allow-lan:\s*true/m.test(yaml)?'checked':''}> 允许局域网连接</label><label class="check-line"><input id="tl-clash-dns" type="checkbox" ${!yaml||/^\s*enhanced-mode:\s*fake-ip/m.test(yaml)?'checked':''}> 启用 Fake-IP DNS</label><label class="check-line"><input id="tl-clash-ads" type="checkbox" ${/^\s*- GEOSITE,category-ads-all,REJECT/m.test(yaml)?'checked':''}> 拦截广告域名</label></div><p class="template-hint">S-UI 会把用户节点加入此模板并生成 Proxy、Auto 分组。套用前可查看每台面板的设置变更。</p>`;
    $('tl-clash-final').value=/^\s*- MATCH,DIRECT/m.test(yaml)?'DIRECT':'Proxy';
  }
}
function tlRenderProtocolFields(){
  const type=tlValue('tl-type'),p=tl.editing?.payload?.type===type?tl.editing.payload:{},remote=!['direct','block'].includes(type);
  $('tl-protocol-fields').innerHTML=remote?`<div class="template-form-grid">${tlField('远端服务器','tl-server',p.server||'','required')}${tlField('远端端口','tl-port',p.server_port||'','required type="number" min="1" max="65535"')}${type==='vless'?tlField('UUID','tl-user',p.uuid||'','required'):['socks','http'].includes(type)?tlField('用户名','tl-user',p.username||''):''}${type!=='vless'?tlField('密码 / 密钥','tl-password','','type="password" autocomplete="new-password" placeholder="留空保留原密码"'):''}${['vless','trojan','hysteria2','anytls'].includes(type)?`<label class="check-line"><input id="tl-tls" type="checkbox" ${p.tls?.enabled!==false?'checked':''}> TLS</label>${tlField('TLS 服务器名（SNI）','tl-sni',p.tls?.server_name||'')}`:''}${type==='socks'?`<label class="check-line"><input id="tl-udp" type="checkbox" ${p.udp_over_tcp?.enabled?'checked':''}> UDP over TCP</label><label>封装版本<select id="tl-udp-version"><option value="2">版本 2</option><option value="1">版本 1</option></select></label>`:''}</div>`:'<p class="template-hint">直连和阻断出站只需设置 Tag。</p>';
  if(type==='socks'&&$('tl-udp-version'))$('tl-udp-version').value=String(p.udp_over_tcp?.version||2);
}
async function tlPayload(){
  const kind=$('template-kind').value,old=tl.editing?.payload||{};
  if(kind==='rule_set')return {type:'remote',tag:tlValue('tl-tag'),format:tlValue('tl-format'),url:tlValue('tl-url')};
  if(kind==='outbound'){
    const type=tlValue('tl-type'),p={type,tag:tlValue('tl-tag')};
    if(!['direct','block'].includes(type)){
      p.server=tlValue('tl-server');p.server_port=Number(tlValue('tl-port'));
      if(!Number.isInteger(p.server_port)||p.server_port<1||p.server_port>65535)throw Error('远端端口无效');
      if(type==='vless')p.uuid=tlValue('tl-user');
      if(['socks','http'].includes(type)&&tlValue('tl-user'))p.username=tlValue('tl-user');
      if(type==='socks'){
        p.version='5';if($('tl-udp').checked)p.udp_over_tcp={enabled:true,version:Number(tlValue('tl-udp-version'))};
      }
      if(type!=='vless'){p.password=tlValue('tl-password')||(old.type===type?old.password:'')||'';if(!p.password&&['trojan','hysteria2','anytls'].includes(type))throw Error('请填写密码 / 密钥');if(!p.password)delete p.password}
      if(['vless','trojan','hysteria2','anytls'].includes(type)&&$('tl-tls').checked)p.tls={enabled:true,...(tlValue('tl-sni')?{server_name:tlValue('tl-sni')}:{})};
    }
    return p;
  }
  if(kind==='subscription_clash'){
    const port=Number(tlValue('tl-mixed-port'));
    if(!Number.isInteger(port)||port<1||port>65535)throw Error('混合监听端口无效');
    const lines=[`mixed-port: ${port}`,`allow-lan: ${$('tl-clash-lan').checked?'true':'false'}`,'mode: rule','log-level: info'];
    if($('tl-clash-dns').checked)lines.push('dns:','  enable: true','  enhanced-mode: fake-ip','  fake-ip-range: 198.18.0.1/16','  nameserver:','    - https://1.1.1.1/dns-query');
    lines.push('rules:','  - GEOIP,Private,DIRECT');
    if($('tl-clash-ads').checked)lines.push('  - GEOSITE,category-ads-all,REJECT');
    lines.push(`  - MATCH,${tlValue('tl-clash-final')}`);
    return lines.join('\n')+'\n';
  }
  const p={...old,final:tlValue('tl-final'),rule_set:[],rules:[]};
  if($('tl-sniff').checked)p.rules.push({action:'sniff'});
  for(const checked of document.querySelectorAll('[data-tl-ruleset]:checked')){
    const id=Number(checked.dataset.tlRuleset),ruleSet=tl.ruleSets.get(id)||(await api('templates/'+id)).payload,action=document.querySelector(`[data-tl-ruleset-action="${id}"]`).value;
    p.rule_set.push(ruleSet);p.rules.push(action==='reject'?{rule_set:ruleSet.tag,action:'reject'}:{rule_set:ruleSet.tag,action:'route',outbound:action});
  }
  if(!p.rule_set.length)delete p.rule_set;
  if(!p.rules.length)delete p.rules;
  return p;
}
async function tlSave(e){
  e.preventDefault();
  try{
    const body={name:tlValue('template-name'),kind:tlValue('template-kind'),payload:await tlPayload()};
    await api('templates'+(tl.editing?'/'+tl.editing.id:''),{method:tl.editing?'PUT':'POST',body:JSON.stringify(body)});
    $('template-dialog').close();await tlLoad();notice('模板已保存');
  }catch(err){notice('保存模板失败：'+err.message)}
}
async function tlApply(id){
  try{
    tl.applying=await api('templates/'+id);tl.preview=null;
    const item=tl.applying;
    $('template-apply').classList.remove('hidden');
    $('template-apply').innerHTML=`<div class="section-head"><div><div class="eyebrow">${tlLabel(item.kind)}</div><h3>${esc(item.name)} · 选择服务器</h3></div><button id="template-apply-close" class="secondary">关闭</button></div><div class="template-targets">${state.servers.map(s=>`<label><input type="checkbox" data-template-target="${s.id}"><span>${esc(s.name)} <small>#${s.id}</small></span></label>`).join('')||'<p class="muted">先添加 S-UI 面板。</p>'}</div><button id="template-preview" class="primary">生成逐台预览</button><div id="template-preview-result" class="template-preview"></div>`;
    $('template-apply').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){notice('读取模板失败：'+e.message)}
}
async function tlPreview(){
  const item=tl.applying,ids=[...document.querySelectorAll('[data-template-target]:checked')].map(x=>Number(x.dataset.templateTarget));
  if(!item||!ids.length){notice('请先选择目标服务器');return}
  let req={server_ids:ids};
  if(item.kind==='rule_set')Object.assign(req,{action:'rule_set_apply',object:item.payload});
  else if(item.kind==='outbound')Object.assign(req,{action:'config_save',config_target:'outbounds',config_mode:'new',object:item.payload});
  else if(item.kind==='subscription_json')Object.assign(req,{action:'config_save',config_target:'settings',config_mode:'set',object:{subJsonExt:JSON.stringify(item.payload)}});
  else Object.assign(req,{action:'config_save',config_target:'settings',config_mode:'set',object:{subClashExt:item.payload}});
  try{
    tl.preview=await api('operations/preview',{method:'POST',body:JSON.stringify(req)});
    $('template-preview-result').innerHTML=`<h3>变更预览 · ${tl.preview.changes.length} 台</h3><p class="hint">仅本次有效，五分钟后失效。执行时会再次检查版本并先备份。</p>${tl.preview.changes.map(c=>`<div class="template-preview-row"><strong>${esc(c.server_name||'#'+c.server_id)}</strong>${status(c.error?'不可执行':'可执行',c.error?'bad':'ok')}${c.error?`<p class="error">${esc(c.error)}</p>`:`<details><summary>查看变更配置</summary><div class="diff">${esc(JSON.stringify(c.after,null,2))}</div></details>`}</div>`).join('')}<div class="button-row"><button id="template-execute" class="primary" ${tl.preview.changes.every(c=>c.error)?'disabled':''}>执行可用项</button></div>`;
  }catch(e){notice('生成预览失败：'+e.message)}
}
async function tlExecute(){
  if(!tl.preview)return;
  if(!confirm(`将模板套用到 ${tl.preview.changes.filter(c=>!c.error).length} 台服务器。每台会先备份，确认执行？`))return;
  try{
    const box=$('template-preview-result');
    const result=await executePreview(tl.preview.id,job=>{box.innerHTML=`<h3>执行中</h3><p class="hint">${esc(jobProgressText(job))}</p>`});tl.preview=null;
    box.innerHTML=`<h3>执行结果</h3>${result.results.map(r=>`<div class="template-preview-row"><strong>${esc(r.name)}</strong>${status(r.ok?'成功':'失败',r.ok?'ok':'bad')}<p>${esc(r.message)}</p>${r.backup?`<small>备份：${esc(r.backup)}</small>`:''}</div>`).join('')}`;
  }catch(e){notice('执行失败：'+e.message)}
}
async function tlDelete(id){
  const item=tl.items.find(x=>x.id===id);if(!item||!confirm(`删除模板「${item.name}」？已部署到 S-UI 的配置不会被改动。`))return;
  try{await api('templates/'+id,{method:'DELETE',body:'{}'});await tlLoad();notice('模板已移到隐藏归档')}catch(e){notice('删除失败：'+e.message)}
}

function subExportURL(client,format){
  if(format==='json')return client.json_url||'';
  if(format==='clash')return client.clash_url||'';
  return client.plain_url||'';
}
function subBuildExportRows(results,format='plain',enabledOnly=true){
  const rows=[],seen=new Set();
  for(const result of results){
    if(!result||result.error)continue;
    for(const client of result.clients||[]){
      if(enabledOnly&&!client.enabled)continue;
      const link=subExportURL(client,format);
      if(!link||seen.has(link))continue;
      seen.add(link);
      rows.push({
        server_id:result.server_id,
        server:result.server||('服务器 #'+result.server_id),
        name:client.name,
        remark:client.remark||client.name,
        enabled:!!client.enabled,
        url:link
      });
    }
  }
  return rows;
}
function subGroupExportRows(rows){
  const groups=new Map();
  for(const row of rows){
    const key=String(row.name||'').trim();
    if(!key)continue;
    let group=groups.get(key);
    if(!group){group={name:key,remark:row.remark||key,rows:[],servers:new Set()};groups.set(key,group)}
    group.rows.push(row);group.servers.add(row.server_id);
    if(group.remark===group.name&&row.remark&&row.remark!==row.name)group.remark=row.remark;
  }
  return [...groups.values()].map(group=>({...group,server_count:group.servers.size,link_count:group.rows.length,servers:[...group.servers]})).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true,sensitivity:'base'}));
}
function subExportSelectedRows(){
  const names=new Set([...document.querySelectorAll('[data-sub-export-user]:checked')].map(x=>decodeURIComponent(x.dataset.subExportUser)));
  return tl.subscriptionExportRows.filter(row=>names.has(row.name));
}
function subExportUpdateSelection(){
  const rows=subExportSelectedRows(),users=new Set(rows.map(row=>row.name));
  const count=$('subscription-export-selection-count');
  if(count)count.textContent=`已选 ${users.size} 个用户名 · ${rows.length} 条链接`;
  const copy=$('subscription-export-copy'),download=$('subscription-export-download');
  if(copy)copy.disabled=!rows.length;
  if(download)download.disabled=!rows.length;
}
function subExportFilterUsers(){
  const query=String($('subscription-export-user-search')?.value||'').trim().toLowerCase();
  document.querySelectorAll('[data-sub-export-user-row]').forEach(row=>{
    const haystack=String(row.dataset.subExportSearch||'').toLowerCase();
    row.classList.toggle('hidden',!!query&&!haystack.includes(query));
  });
}
function subExportText(rows){return rows.map(row=>row.url).join('\n')+(rows.length?'\n':'')}
function subExportFilename(format){
  const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/T/,'-').slice(0,15);
  return `sui-subscriptions-${format}-${stamp}.txt`;
}
function subExportRender(open=true){
  const box=$('subscription-export');
  if(!open){box.classList.add('hidden');return}
  const checked=new Set([...box.querySelectorAll?.('[data-sub-export-server]:checked')||[]].map(x=>Number(x.dataset.subExportServer)));
  const current=Number($('subscription-server')?.value||0);
  const selected=checked.size?checked:new Set(current?[current]:state.servers.map(s=>s.id));
  box.classList.remove('hidden');
  box.innerHTML=`<div class="section-head"><div><h3>批量导出订阅</h3><p>选择多个 S-UI 面板，把用户订阅链接汇总成一个 TXT 文件。</p></div><button id="subscription-export-close" class="text-button" type="button">✕</button></div>
    <div class="subscription-export-grid">
      <section><div class="subscription-export-title"><strong>目标服务器</strong><div><button id="subscription-export-all" class="text-button" type="button">全选</button><button id="subscription-export-none" class="text-button" type="button">清空</button></div></div><div class="subscription-export-targets">${state.servers.map(s=>`<label><input type="checkbox" data-sub-export-server="${s.id}" ${selected.has(s.id)?'checked':''}><span><b>${esc(s.name)}</b><small>${esc(s.region||'未分组')}</small></span></label>`).join('')||'<p class="muted">先添加 S-UI 面板。</p>'}</div></section>
      <section class="subscription-export-options"><label>订阅格式<select id="subscription-export-format"><option value="plain">通用链接</option><option value="json">sing-box</option><option value="clash">Mihomo</option></select></label><label class="check-line"><input id="subscription-export-enabled" type="checkbox" checked> 只导出已启用用户</label><p class="hint">导出的 TXT 每行一个订阅 URL，可直接批量复制或保存。订阅 URL 可读取用户节点配置，请像密码一样保管。</p><button id="subscription-export-generate" class="primary" type="button">生成批量导出</button></section>
    </div><div id="subscription-export-result"></div>`;
}
async function subExportGenerate(){
  const ids=[...document.querySelectorAll('[data-sub-export-server]:checked')].map(x=>Number(x.dataset.subExportServer));
  if(!ids.length){notice('请至少选择一台服务器');return}
  const format=$('subscription-export-format').value,enabledOnly=$('subscription-export-enabled').checked;
  const button=$('subscription-export-generate'),box=$('subscription-export-result');button.disabled=true;
  box.innerHTML=`<div class="subscription-export-progress">正在读取 ${ids.length} 台面板的订阅…</div>`;
  const results=await Promise.all(ids.map(async id=>{
    try{
      const result=await api('subscriptions?server_id='+encodeURIComponent(id));
      return {...result,server_id:id};
    }catch(error){
      const server=state.servers.find(s=>s.id===id);
      return {server_id:id,server:server?.name||('服务器 #'+id),error:error.message,clients:[]};
    }
  }));
  tl.subscriptionExportRows=subBuildExportRows(results,format,enabledOnly);
  tl.subscriptionExportGroups=subGroupExportRows(tl.subscriptionExportRows);
  const failures=results.filter(x=>x.error),missing=results.filter(x=>!x.error&&(x.clients||[]).some(client=>(!enabledOnly||client.enabled)&&!subExportURL(client,format))).length;
  const rows=tl.subscriptionExportRows,groups=tl.subscriptionExportGroups;
  box.innerHTML=`<div class="subscription-export-summary"><div><h4>读取完成 · ${groups.length} 个用户名 · ${rows.length} 条链接</h4><p class="hint">成功读取 ${results.length-failures.length} / ${results.length} 台服务器${missing?` · ${missing} 台存在未配置公开订阅地址的用户`:''}</p></div></div>
    ${failures.length?`<div class="template-warning">${failures.map(x=>`${esc(x.server)}：${esc(x.error)}`).join('<br>')}</div>`:''}
    ${groups.length?`<div class="subscription-export-user-toolbar"><input id="subscription-export-user-search" type="search" placeholder="搜索用户名或备注"><div><button id="subscription-export-user-all" class="text-button" type="button">全选当前结果</button><button id="subscription-export-user-none" class="text-button" type="button">清空</button></div></div>
      <div class="subscription-export-user-list">${groups.map(group=>`<article class="subscription-export-user" data-sub-export-user-row data-sub-export-search="${esc(group.name+' '+group.remark)}"><label><input type="checkbox" data-sub-export-user="${encodeURIComponent(group.name)}"><span><b>${esc(group.name)}</b><small>${group.remark!==group.name?esc(group.remark)+' · ':''}覆盖 ${group.server_count} 台 · ${group.link_count} 条链接</small></span></label><details><summary>查看服务器与链接</summary><div class="subscription-export-user-links">${group.rows.map(row=>`<div><span>${esc(row.server)}</span><code>${esc(row.url)}</code></div>`).join('')}</div></details></article>`).join('')}</div>
      <div class="subscription-export-actions"><span id="subscription-export-selection-count">已选 0 个用户名 · 0 条链接</span><div class="button-row"><button id="subscription-export-copy" class="secondary" type="button" disabled>复制所选用户名链接</button><button id="subscription-export-download" class="primary" type="button" disabled>下载所选 TXT</button></div></div>`:'<div class="empty">没有可导出的订阅链接。请检查公开订阅地址或筛选条件。</div>'}`;
  button.disabled=false;
}
async function subExportCopy(){
  const rows=subExportSelectedRows();if(!rows.length){notice('请先选择用户名');return}
  try{await navigator.clipboard.writeText(subExportText(rows));notice(`已复制 ${new Set(rows.map(row=>row.name)).size} 个用户名、${rows.length} 条订阅链接`)}catch(e){notice('复制失败：'+e.message)}
}
function subExportDownload(){
  const rows=subExportSelectedRows();if(!rows.length){notice('请先选择用户名');return}
  const format=$('subscription-export-format')?.value||'plain',blob=new Blob([subExportText(rows)],{type:'text/plain;charset=utf-8'});
  const href=URL.createObjectURL(blob),a=document.createElement('a');a.href=href;a.download=subExportFilename(format);document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),0);
}

function subServerOptions(){
  const selected=$('subscription-server').value;
  $('subscription-server').innerHTML='<option value="">请选择面板</option>'+state.servers.map(s=>`<option value="${s.id}">${esc(s.name)} · ${esc(s.region)}</option>`).join('');
  if([...$('subscription-server').options].some(x=>x.value===selected))$('subscription-server').value=selected;
  else if(state.servers.length)$('subscription-server').value=String(state.servers[0].id);
}
async function subLoad(){
  subServerOptions();const id=$('subscription-server').value;tl.subscriptionPreview=null;if(!id){$('subscription-content').innerHTML='<div class="empty">先添加 S-UI 面板。</div>';return}
  $('subscription-content').innerHTML='<div class="card muted">正在读取订阅…</div>';
  try{
    const result=await api('subscriptions?server_id='+encodeURIComponent(id));
    $('subscription-content').innerHTML=`${result.base_error?`<div class="template-warning">${esc(result.base_error)}，请在 S-UI 订阅设置中填写公开地址。</div>`:''}<div class="template-warning">S-UI 用用户名称作为订阅标识。知道可用链接的人就能取得该用户的节点配置；请使用难猜的名称与 HTTPS。</div><form id="subscription-settings-form" class="card subscription-settings"><div class="section-head"><div><h3>订阅公开地址</h3><p>修改 S-UI 的 subURI 设置。保存前先预览，执行前自动备份。</p></div></div><label>公开基础 URL<input id="subscription-base-input" type="url" value="${esc(result.settings?.subURI||'')}" placeholder="https://sub.example.com/sub/"></label><p class="hint">当前解析地址：${esc(result.base_url||'未设置')}。留空可恢复 S-UI 按域名、端口和路径自动生成的地址。</p><button class="secondary" type="submit">预览地址变更</button></form><div id="subscription-operation"></div><div class="subscription-list">${result.clients.length?result.clients.map(c=>`<article class="subscription-card"><div class="server-title"><div><h3>${esc(c.remark||c.name)}</h3><small>${esc(c.name)}</small></div>${status(c.enabled?'启用':'停用',c.enabled?'ok':'bad')}</div><p>已用 ${bytes(c.used)}${c.limit?` / ${bytes(c.limit)}`:' · 不限流量'}${c.expiry?` · 到期 ${esc(new Date(c.expiry*1000).toLocaleDateString('zh-CN'))}`:''}</p><div class="subscription-links"><button data-sub-state="${esc(c.name)}" data-sub-enable="${c.enabled?'false':'true'}">${c.enabled?'停用用户':'启用用户'}</button>${c.plain_url?`<button data-sub-copy="${esc(c.plain_url)}">复制通用链接</button><button data-sub-copy="${esc(c.json_url)}">复制 sing-box</button><button data-sub-copy="${esc(c.clash_url)}">复制 Mihomo</button>`:''}</div>${!c.plain_url?'<p class="muted">尚未配置可用的公开订阅地址</p>':''}</article>`).join(''):'<div class="empty">这台面板还没有用户。</div>'}</div>`;
  }catch(e){$('subscription-content').innerHTML=`<div class="card error">订阅读取失败：${esc(e.message)}</div>`}
}

async function subPreview(req,description){
  try{
    tl.subscriptionPreview=await api('operations/preview',{method:'POST',body:JSON.stringify(req)});
    const c=tl.subscriptionPreview.changes[0];
    $('subscription-operation').innerHTML=`<div class="card subscription-operation"><h3>${esc(description)}</h3>${status(c.error?'不可执行':'可执行',c.error?'bad':'ok')}${c.error?`<p class="error">${esc(c.error)}</p>`:'<p class="hint">预览五分钟有效；执行前会检查配置版本并备份。</p><button id="subscription-execute" class="primary">确认执行</button>'}</div>`;
    $('subscription-operation').scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(e){notice('生成预览失败：'+e.message)}
}

async function subExecute(){
  if(!tl.subscriptionPreview||!confirm('确认执行刚预览的订阅变更？'))return;
  try{
    const result=await api('operations/execute',{method:'POST',body:JSON.stringify({preview_id:tl.subscriptionPreview.id})});
    tl.subscriptionPreview=null;
    const failed=result.results.find(x=>!x.ok);
    if(failed){$('subscription-operation').innerHTML=`<div class="card error">执行失败：${esc(failed.message)}</div>`;return}
    await subLoad();notice('订阅变更已保存，S-UI 已完成验证');
  }catch(e){notice('执行失败：'+e.message)}
}

document.addEventListener('click',async e=>{
  const tab=e.target.closest('[data-tab]');if(tab?.dataset.tab==='templates')tlLoad();if(tab?.dataset.tab==='subscriptions')subLoad();
  const kind=e.target.closest('[data-template-kind]');if(kind){tl.kind=kind.dataset.templateKind;tlRender()}
  const edit=e.target.closest('[data-template-edit]');if(edit){try{await tlOpen(await api('templates/'+edit.dataset.templateEdit))}catch(err){notice(err.message)}}
  const apply=e.target.closest('[data-template-apply]');if(apply)tlApply(Number(apply.dataset.templateApply));
  const remove=e.target.closest('[data-template-delete]');if(remove)tlDelete(Number(remove.dataset.templateDelete));
  if(e.target.id==='subscriptions-export-toggle'){subExportRender(true);return}
  if(e.target.id==='subscription-export-close'){subExportRender(false);return}
  if(e.target.id==='subscription-export-all'){document.querySelectorAll('[data-sub-export-server]').forEach(x=>x.checked=true);return}
  if(e.target.id==='subscription-export-none'){document.querySelectorAll('[data-sub-export-server]').forEach(x=>x.checked=false);return}
  if(e.target.id==='subscription-export-generate'){subExportGenerate();return}
  if(e.target.id==='subscription-export-user-all'){document.querySelectorAll('[data-sub-export-user-row]:not(.hidden) [data-sub-export-user]').forEach(x=>x.checked=true);subExportUpdateSelection();return}
  if(e.target.id==='subscription-export-user-none'){document.querySelectorAll('[data-sub-export-user]').forEach(x=>x.checked=false);subExportUpdateSelection();return}
  if(e.target.id==='subscription-export-copy'){subExportCopy();return}
  if(e.target.id==='subscription-export-download'){subExportDownload();return}
  const copy=e.target.closest('[data-sub-copy]');if(copy){try{await navigator.clipboard.writeText(copy.dataset.subCopy);notice('订阅链接已复制')}catch(err){notice('复制失败：'+err.message)}}
  const change=e.target.closest('[data-sub-state]');if(change){const id=Number($('subscription-server').value),enabled=change.dataset.subEnable==='true';subPreview({server_ids:[id],action:enabled?'client_enable':'client_disable',client_name:change.dataset.subState},`${enabled?'启用':'停用'}用户 ${change.dataset.subState}`)}
  if(e.target.id==='subscription-execute')subExecute();
});
document.addEventListener('change',async e=>{if(e.target.id==='template-kind'){if(e.target.value==='subscription_json'){const rows=await Promise.all(tl.items.filter(x=>x.kind==='rule_set').map(async x=>[x.id,(await api('templates/'+x.id)).payload]));tl.ruleSets=new Map(rows)}tlRenderFields()}if(e.target.id==='tl-type')tlRenderProtocolFields();if(e.target.id==='subscription-server')subLoad();if(e.target.matches('[data-sub-export-user]'))subExportUpdateSelection()});
document.addEventListener('input',e=>{if(e.target.id==='subscription-export-user-search')subExportFilterUsers()});
$('template-new').onclick=()=>tlOpen().catch(e=>notice(e.message));$('template-close').onclick=()=>$('template-dialog').close();$('template-cancel').onclick=()=>$('template-dialog').close();$('template-form').onsubmit=tlSave;
$('subscriptions-refresh').onclick=subLoad;
$('subscription-content').addEventListener('submit',e=>{if(e.target.id!=='subscription-settings-form')return;e.preventDefault();const id=Number($('subscription-server').value),value=tlValue('subscription-base-input');if(value&&!/^https:\/\/[^/\s?#]+(?:\/[^?#]*)?$/i.test(value)){notice('请输入完整的 HTTPS 基础 URL');return}subPreview({server_ids:[id],action:'config_save',config_target:'settings',config_mode:'set',object:{subURI:value}},'修改订阅公开地址')});
$('template-apply').addEventListener('click',e=>{if(e.target.id==='template-preview')tlPreview();if(e.target.id==='template-execute')tlExecute();if(e.target.id==='template-apply-close')$('template-apply').classList.add('hidden')});
