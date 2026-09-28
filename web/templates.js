const tl={items:[],kind:'all',editing:null,applying:null,preview:null,ruleSets:new Map(),subscriptionPreview:null};
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
    const result=await api('operations/execute',{method:'POST',body:JSON.stringify({preview_id:tl.preview.id})});tl.preview=null;
    $('template-preview-result').innerHTML=`<h3>执行结果</h3>${result.results.map(r=>`<div class="template-preview-row"><strong>${esc(r.name)}</strong>${status(r.ok?'成功':'失败',r.ok?'ok':'bad')}<p>${esc(r.message)}</p>${r.backup?`<small>备份：${esc(r.backup)}</small>`:''}</div>`).join('')}`;
  }catch(e){notice('执行失败：'+e.message)}
}
async function tlDelete(id){
  const item=tl.items.find(x=>x.id===id);if(!item||!confirm(`删除模板「${item.name}」？已部署到 S-UI 的配置不会被改动。`))return;
  try{await api('templates/'+id,{method:'DELETE',body:'{}'});await tlLoad();notice('模板已移到隐藏归档')}catch(e){notice('删除失败：'+e.message)}
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
  const copy=e.target.closest('[data-sub-copy]');if(copy){try{await navigator.clipboard.writeText(copy.dataset.subCopy);notice('订阅链接已复制')}catch(err){notice('复制失败：'+err.message)}}
  const change=e.target.closest('[data-sub-state]');if(change){const id=Number($('subscription-server').value),enabled=change.dataset.subEnable==='true';subPreview({server_ids:[id],action:enabled?'client_enable':'client_disable',client_name:change.dataset.subState},`${enabled?'启用':'停用'}用户 ${change.dataset.subState}`)}
  if(e.target.id==='subscription-execute')subExecute();
});
document.addEventListener('change',async e=>{if(e.target.id==='template-kind'){if(e.target.value==='subscription_json'){const rows=await Promise.all(tl.items.filter(x=>x.kind==='rule_set').map(async x=>[x.id,(await api('templates/'+x.id)).payload]));tl.ruleSets=new Map(rows)}tlRenderFields()}if(e.target.id==='tl-type')tlRenderProtocolFields();if(e.target.id==='subscription-server')subLoad()});
$('template-new').onclick=()=>tlOpen().catch(e=>notice(e.message));$('template-close').onclick=()=>$('template-dialog').close();$('template-cancel').onclick=()=>$('template-dialog').close();$('template-form').onsubmit=tlSave;
$('subscriptions-refresh').onclick=subLoad;
$('subscription-content').addEventListener('submit',e=>{if(e.target.id!=='subscription-settings-form')return;e.preventDefault();const id=Number($('subscription-server').value),value=tlValue('subscription-base-input');if(value&&!/^https:\/\/[^/\s?#]+(?:\/[^?#]*)?$/i.test(value)){notice('请输入完整的 HTTPS 基础 URL');return}subPreview({server_ids:[id],action:'config_save',config_target:'settings',config_mode:'set',object:{subURI:value}},'修改订阅公开地址')});
$('template-apply').addEventListener('click',e=>{if(e.target.id==='template-preview')tlPreview();if(e.target.id==='template-execute')tlExecute();if(e.target.id==='template-apply-close')$('template-apply').classList.add('hidden')});
