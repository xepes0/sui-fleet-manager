const $ = id => document.getElementById(id);
const state = {servers: [], dashboard: [], monitorNodes: [], pingHistory: {}, nodes: {}, selected: new Set(), details: {}, preview: null, detailID: null, komariURL: '', refreshing: false};
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bytes = n => {if (!Number.isFinite(+n)) return '—'; let v=+n, u=['B','KB','MB','GB','TB']; let i=0; while(v>=1024&&i<u.length-1){v/=1024;i++} return `${v.toFixed(i?1:0)} ${u[i]}`};
const pct = (a,b) => Number.isFinite(+a)&&a!=null&&Number.isFinite(+b)&&b>0 ? `${Math.round(100*a/b)}%` : '—';
const date = d => new Date(d).toLocaleString('zh-CN');
async function api(path, options={}) {const res=await fetch('/api/'+path,{...options,headers:{'Content-Type':'application/json',...options.headers},cache:'no-store'});let body;try{body=await res.json()}catch{throw Error(`HTTP ${res.status}`)}if(!res.ok)throw Error(body.error||`HTTP ${res.status}`);return body}
const jobDone = status => status==='completed'||status==='interrupted';
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
function jobProgressText(job){return `后台任务 ${job.completed||0} / ${job.total||0} · 成功 ${job.succeeded||0} · 失败 ${job.failed||0}`}
async function executePreview(previewID,onProgress){
  const started=await api('operations/execute',{method:'POST',body:JSON.stringify({preview_id:previewID})});
  if(!started.job_id&&!started.id)return started;
  const id=started.job_id||started.id;let job=started,deadline=Date.now()+20*60*1000;
  while(!jobDone(job.status)){
    if(onProgress)onProgress(job);
    if(Date.now()>deadline)throw Error('任务仍在后台执行，可在“任务”页面继续查看');
    await wait(750);job=await api('jobs/'+encodeURIComponent(id));
  }
  if(onProgress)onProgress(job);
  if(job.status==='interrupted')throw Error('任务因控制器重启而中断，请重新预览后执行');
  return {results:job.results||[],job};
}
function notice(text){$('notice').textContent=text;$('notice').classList.remove('hidden')}
function clearNotice(){$('notice').classList.add('hidden')}
function status(text,type=''){return `<span class="status ${type}">${esc(text)}</span>`}
function metric(label,value,sub=''){return `<div class="metric"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`}
function summary(){let up=state.dashboard.filter(x=>!x.error).length, online=state.monitorNodes.filter(x=>x.status?.online).length, core=state.dashboard.filter(x=>x.sui?.sbd?.running).length;$('summary').innerHTML=metric('探针在线',`${online} / ${state.monitorNodes.length}`,'Komari 实时状态')+metric('已接入 S-UI',state.dashboard.length,'可管理配置的面板')+metric('面板可用',`${up} / ${state.dashboard.length}`,'S-UI API 连接')+metric('sing-box 运行',`${core} / ${state.dashboard.length}`,'已关联的面板')}
function serverCard(x){const s=x.server,k=x.komari||{},kn=x.komari_node||{},sbd=x.sui?.sbd||{};let sui=x.error?status('面板异常','bad'):status('S-UI 在线','ok');let memory=pct(k.ram,k.ram_total||kn.mem_total),disk=pct(k.disk,k.disk_total||kn.disk_total);let net=k.net_out==null&&k.net_in==null?'—':`↑ ${bytes(k.net_out||0)}/s · ↓ ${bytes(k.net_in||0)}/s`;let probe=!s.komari_uuid?'未关联 Komari':k.online===true?'● 探针在线':k.online===false?'○ 探针离线':'探针状态未知';let core=x.error?'API 异常':sbd.running===true?'sing-box 运行':sbd.maintenance===true?'维护中':sbd.running===false?'sing-box 停止':'sing-box 状态未知';return `<article class="server-card" data-detail="${s.id}" tabindex="0" role="button" aria-label="查看 ${esc(s.name)} 详情"><div class="server-title"><div><h3>${esc(s.name)}</h3><small>#${s.id} · ${esc(s.region||'未分组')}</small></div>${sui}</div><div class="stats"><div><span>CPU</span><b>${k.cpu==null?'—':esc(Math.round(k.cpu))+'%'}</b></div><div><span>内存</span><b>${memory}</b></div><div><span>磁盘</span><b>${disk}</b></div></div><div class="server-foot"><span>${probe}</span><span>${core}</span></div><div class="server-foot"><span>${esc(net)}</span><span>${x.error?'—':x.latency_ms+' ms'}</span></div></article>`}
function renderServers(){const groups=new Map();for(const x of state.dashboard){const k=x.server.region||'未分组';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(x)}$('server-list').innerHTML=groups.size?[...groups].map(([region,items])=>`<section><h3 class="region-title">${esc(region)} <span class="region-count">${items.filter(x=>!x.error).length} / ${items.length} 可用</span></h3><div class="region-grid">${items.map(serverCard).join('')}</div></section>`).join(''):'<div class="empty">还没有面板。点击右上角“添加面板”开始。</div>';$('updated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN');$('server-picker').innerHTML=state.servers.map(s=>`<label class="picker-item"><input type="checkbox" data-pick="${s.id}" ${state.selected.has(s.id)?'checked':''}><span>${esc(s.name)}</span><small>#${s.id} · ${esc(s.region)}</small></label>`).join('')||'<p class="muted">先添加面板</p>'}
async function refresh(){if(state.refreshing)return;state.refreshing=true;clearNotice();$('refresh').disabled=true;try{const data=await api('dashboard');state.dashboard=data.servers;state.servers=data.servers.map(x=>x.server);state.monitorNodes=data.monitor_nodes||[];state.komariURL=data.komari_url||'';summary();renderServers();renderMonitorHome();loadPingHistory();if(data.komari_error)notice('Komari: '+data.komari_error)}catch(e){notice('刷新失败：'+e.message)}finally{$('refresh').disabled=false;state.refreshing=false}}
async function loadNodes(){try{state.nodes=await api('komari/nodes')}catch(e){state.nodes={};if(!e.message.includes('not configured'))notice('Komari 节点列表：'+e.message)}const select=$('server-komari');select.innerHTML='<option value="">不关联</option>'+Object.entries(state.nodes).map(([uuid,n])=>`<option value="${esc(uuid)}">${esc(n.name||uuid)} (${esc(uuid.slice(0,8))})</option>`).join('')}
function openServerForm(s){$('server-form').reset();$('server-id').value=s?.id||'';$('dialog-title').textContent=s?'编辑 S-UI 面板':'添加 S-UI 面板';$('server-name').value=s?.name||'';$('server-region').value=s?.region||'';$('server-url').value=s?.sui_url||'';$('server-komari').value=s?.komari_uuid||'';$('server-token').required=!s;$('delete-server').classList.toggle('hidden',!s);$('server-dialog').showModal()}
async function saveServer(e){e.preventDefault();const id=$('server-id').value;const data={name:$('server-name').value,region:$('server-region').value,sui_url:$('server-url').value,token:$('server-token').value,komari_uuid:$('server-komari').value};try{await api('servers'+(id?'/'+id:''),{method:id?'PUT':'POST',body:JSON.stringify(data)});$('server-dialog').close();await refresh()}catch(err){notice('保存失败：'+err.message)}}
async function deleteServer(){const id=$('server-id').value,s=state.servers.find(x=>x.id==id);if(!confirm(`删除 ${s.name} 的控制器登记？不会修改远端 S-UI。`))return;try{await api('servers/'+id,{method:'DELETE',body:'{}'});$('server-dialog').close();state.selected.delete(+id);await refresh()}catch(e){notice('删除失败：'+e.message)}}
async function openDetail(id){
  state.detailID=+id;const s=state.servers.find(x=>x.id===+id);
  if(!s)return;
  $('detail-title').textContent=s.name;$('detail-region').textContent=s.region||'未分组';$('open-sui').href=s.sui_url;
  const komari=$('open-komari');let publicURL='';
  try{const u=new URL(state.komariURL),host=u.hostname.toLowerCase();if(['http:','https:'].includes(u.protocol)&&host!=='localhost'&&!host.endsWith('.localhost')&&!host.startsWith('127.')&&!['::1','[::1]','0.0.0.0'].includes(host))publicURL=u.href.replace(/\/$/,'')}catch{}
  komari.classList.toggle('hidden',!publicURL||!s.komari_uuid);
  if(publicURL&&s.komari_uuid)komari.href=publicURL+'/instance/'+encodeURIComponent(s.komari_uuid);else komari.removeAttribute('href');
  $('detail-content').innerHTML='<p class="muted">正在读取服务器详情…</p>';setDetailTab('overview');$('detail-dialog').showModal();
  try{const d=await api('servers/'+id+'/detail');if(state.detailID===+id&&$('detail-dialog').open)renderServerDetail(d)}catch(e){$('detail-content').innerHTML='<p class="error">'+esc(e.message)+'</p>'}
}
function actionChanged(){
  const a=$('action').value,route=a.startsWith('route_rule_'),creating=a==='inbound_create'||a==='outbound_create';
  $('client-name-wrap').classList.toggle('hidden',!['client_enable','client_disable'].includes(a));
  $('client-create-wrap').classList.toggle('hidden',a!=='client_create');
  $('inbound-patch-wrap').classList.toggle('hidden',a!=='inbound_patch');
  $('object-create-wrap').classList.toggle('hidden',!creating);
  $('outbound-patch-wrap').classList.toggle('hidden',a!=='outbound_patch');
  $('route-wrap').classList.toggle('hidden',!route);
  $('route-rule-wrap').classList.toggle('hidden',a==='route_rule_delete');
  $('route-position-wrap').classList.toggle('hidden',a!=='route_rule_add');
  $('route-index-wrap').classList.toggle('hidden',!['route_rule_replace','route_rule_delete'].includes(a));
  $('object-type').innerHTML=(a==='outbound_create'?[['direct','直连'],['block','阻断'],['socks','SOCKS 代理'],['http','HTTP 代理'],['vless','VLESS'],['trojan','Trojan'],['hysteria2','Hysteria2'],['anytls','AnyTLS']]:[['vless','VLESS'],['trojan','Trojan'],['hysteria2','Hysteria2'],['tuic','TUIC'],['anytls','AnyTLS'],['mixed','Mixed'],['socks','SOCKS'],['http','HTTP']]).map(([v,n])=>`<option value="${v}">${n}</option>`).join('');
  formModeChanged();
  $('preview-box').classList.add('hidden');$('result-box').classList.add('hidden');state.preview=null;
  return loadFormDetails();
}
function optionsFor(select,items,label,value){const before=select.value;select.innerHTML='<option value="">请选择</option>'+items.map(x=>`<option value="${esc(value(x))}">${esc(label(x))}</option>`).join('');if([...select.options].some(x=>x.value===before))select.value=before}
function ruleLabel(rule,i){const match=Object.entries(rule).filter(([k])=>!['action','outbound'].includes(k)).map(([k,v])=>`${k}: ${Array.isArray(v)?v.join(', '):String(v)}`).join(' · ');return `${i+1}. ${match||rule.action||'规则'} → ${rule.outbound||rule.action||'—'}`.slice(0,140)}
async function loadFormDetails(){
  const ids=[...state.selected];if(!ids.length){$('form-source').textContent='先在左侧选择服务器，才能加载已有配置。';return}
  $('form-source').textContent='正在读取所选面板的现有配置…';
  const rows=await Promise.all(ids.map(async id=>{try{return [id,await api(`servers/${id}/detail`)]}catch(e){return [id,{errors:{detail:e.message}}]}}));
  for(const [id,d] of rows)state.details[id]=d;
  const first=state.details[ids[0]],inbounds=first?.inbounds?.inbounds||[],outbounds=first?.outbounds?.outbounds||[],rules=first?.route_rules||[],tls=first?.tls_choices||[];
  $('form-source').textContent=`以下选项来自 ${state.servers.find(s=>s.id===ids[0])?.name||'第一台服务器'}；生成预览时会逐台验证。`;
  optionsFor($('inbound-tag'),inbounds,x=>`${x.tag} · ${x.type} · ${x.listen_port||'—'}`,x=>x.tag);
  optionsFor($('client-name'),first?.clients?.clients||[],x=>x.name,x=>x.name);
  optionsFor($('object-tag'),outbounds.filter(x=>!['direct','block'].includes(x.type)),x=>`${x.tag} · ${x.type}`,x=>x.tag);
  outboundPatchModeChanged();
  optionsFor($('object-source'),$('action').value==='outbound_create'?outbounds:inbounds,x=>`${x.tag} · ${x.type}`,x=>x.tag);
  optionsFor($('route-outbound'),[...outbounds,...(first?.endpoint_choices||[])],x=>`${x.tag} · ${x.type}`,x=>x.tag);
  optionsFor($('route-index'),rules,(x)=>ruleLabel(x,rules.indexOf(x)),x=>rules.indexOf(x));
  optionsFor($('route-before'),rules,(x)=>ruleLabel(x,rules.indexOf(x)),x=>rules.indexOf(x));
  $('new-inbound-tls').innerHTML='<option value="0">不使用 TLS</option>'+tls.map(x=>`<option value="${esc(x.tag?'tag:'+x.tag:x.name?'name:'+x.name:'id:'+x.id)}">${esc(x.tag||x.name||'证书 #'+x.id)}</option>`).join('');
  $('client-inbound-picker').innerHTML=ids.map(id=>{const d=state.details[id],s=state.servers.find(x=>x.id===id);return `<fieldset class="inbound-choice"><legend>${esc(s?.name||'#'+id)}</legend>${(d?.inbounds?.inbounds||[]).map(n=>`<label class="check-line"><input type="checkbox" data-client-inbound="${id}" value="${esc(n.id)}">${esc(n.tag)} · ${esc(n.type)}</label>`).join('')||'<span class="muted">没有可用入站</span>'}</fieldset>`}).join('');
  if(first?.errors&&Object.keys(first.errors).length)$('form-source').textContent+=' 有面板数据读取失败，请查看服务器详情。';
}
function formModeChanged(){const a=$('action').value,copy=$('object-mode').value==='copy',type=$('object-type').value;
  $('object-copy-wrap').classList.toggle('hidden',!copy);$('object-new-wrap').classList.toggle('hidden',copy);
  $('inbound-fields').classList.toggle('hidden',a!=='inbound_create');$('outbound-fields').classList.toggle('hidden',a!=='outbound_create'||copy);
  const remote=!['direct','block'].includes(type);$('new-outbound-server').closest('label').classList.toggle('hidden',!remote);$('new-outbound-port').closest('label').classList.toggle('hidden',!remote);
  $('outbound-auth-fields').classList.toggle('hidden',!['socks','http','vless','trojan','hysteria2','anytls'].includes(type));
  $('outbound-socks-fields').classList.toggle('hidden',type!=='socks');$('outbound-tls-fields').classList.toggle('hidden',!['vless','trojan','hysteria2','anytls'].includes(type));
  $('new-outbound-udp-version-wrap').classList.toggle('hidden',type!=='socks'||!$('new-outbound-udp').checked);
  $('route-before-wrap').classList.toggle('hidden',$('route-position').value!=='before_index');$('route-outbound-wrap').classList.toggle('hidden',$('route-action').value!=='route');
  $('new-inbound-tls-wrap').classList.toggle('hidden',copy);
  $('new-inbound-public-fields').classList.remove('hidden');
}
function outboundPatchModeChanged(){const id=[...state.selected][0],item=state.details[id]?.outbounds?.outbounds?.find(x=>x.tag===$('object-tag').value),type=item?.type;
  $('edit-outbound-user-label').firstChild.textContent=type==='vless'?'UUID':'用户名';
  $('edit-outbound-user-label').classList.toggle('hidden',!['socks','http','vless'].includes(type));
  $('edit-outbound-password-label').classList.toggle('hidden',!['socks','http','trojan','hysteria2','anytls'].includes(type));
  $('edit-outbound-udp-wrap').classList.toggle('hidden',type!=='socks');
  const uot=item?.udp_over_tcp,enabled=uot===true||(uot&&typeof uot==='object'&&uot.enabled===true);
  $('edit-outbound-udp-current').textContent=type==='socks'?`当前：${enabled?'启用'+(uot?.version?' · 版本 '+uot.version:''):'禁用'}`:'';
}
function requiredValue(id,label){const v=$(id).value.trim();if(!v)throw Error(`请填写${label}`);return v}
function portValue(id,label,required=false){const raw=$(id).value.trim();if(!raw){if(required)throw Error(`请填写${label}`);return null}const n=Number(raw);if(!Number.isInteger(n)||n<1||n>65535)throw Error(`${label}须为 1 到 65535`);return n}
function buildCreate(action){const copy=$('object-mode').value==='copy',tag=requiredValue('object-new-tag','新名称 / Tag');
  if(copy){const source=requiredValue('object-source','要复制的对象');const overrides={tag};if(action==='inbound_create'){overrides.listen_port=portValue('new-inbound-port','监听端口',true);const listen=$('new-inbound-listen').value.trim();if(listen&&listen!=='::')overrides.listen=listen;return {source_tag:source,object_overrides:overrides,inbound_public_server:$('new-inbound-server').value.trim(),inbound_public_port:portValue('new-inbound-public-port','公开端口')||overrides.listen_port}}return {source_tag:source,object_overrides:overrides}}
  const type=requiredValue('object-type','类型'),object={type,tag};
  if(action==='inbound_create'){object.listen=requiredValue('new-inbound-listen','监听地址');object.listen_port=portValue('new-inbound-port','监听端口',true);object.tls_id=0;const server=$('new-inbound-server').value.trim(),publicPort=portValue('new-inbound-public-port','公开端口')||object.listen_port;if(server){object.addrs=[{server,server_port:publicPort}];object.out_json={type,server,server_port:publicPort}}}
  else if(!['direct','block'].includes(type)){object.server=requiredValue('new-outbound-server','远端服务器');object.server_port=portValue('new-outbound-port','远端端口',true);const user=$('new-outbound-user').value.trim(),password=$('new-outbound-password').value;if(type==='socks'){object.version=$('new-outbound-version').value;if(user)object.username=user;if(password)object.password=password;if($('new-outbound-udp').checked){if(object.version!=='5')throw Error('UDP over TCP 仅支持 SOCKS5');object.udp_over_tcp={enabled:true,version:Number($('new-outbound-udp-version').value)}}}else if(type==='http'){if(user)object.username=user;if(password)object.password=password}else if(type==='vless'){object.uuid=user||requiredValue('new-outbound-user','UUID')}else{object.password=password||requiredValue('new-outbound-password','密码')}if(['vless','trojan','hysteria2','anytls'].includes(type)&&$('new-outbound-tls').checked)object.tls={enabled:true,...($('new-outbound-sni').value.trim()?{server_name:$('new-outbound-sni').value.trim()}:{})}}
  return {object,...(action==='inbound_create'&&$('new-inbound-tls').value!=='0'?{tls_ref:$('new-inbound-tls').value}:{})};
}
function buildClient(ids){
  const name=requiredValue('new-client-name','用户名称'),remark=$('new-client-remark').value.trim()||name,volume=Number($('new-client-volume').value);
  if(!Number.isFinite(volume)||volume<0)throw Error('流量上限不能为负数');
  const expiry=$('new-client-expiry').value?Math.floor(new Date($('new-client-expiry').value+'T23:59:59').getTime()/1000):0;
  const password=$('new-client-password').value,uuid=$('new-client-uuid').value.trim();
  if(uuid&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid))throw Error('自定义 UUID 格式无效');
  const map={},types=new Set();
  for(const id of ids){
    const picked=[...document.querySelectorAll(`[data-client-inbound="${id}"]:checked`)].map(x=>Number(x.value));
    if(!picked.length)throw Error(`请为 ${state.servers.find(s=>s.id===id)?.name||id} 选择入站`);
    map[id]=picked;
    for(const n of state.details[id]?.inbounds?.inbounds||[])if(picked.includes(n.id))types.add(n.type);
  }
  const config={};
  for(const type of types){
    if(['vless','vmess'].includes(type))config[type]={name,uuid:uuid||crypto.randomUUID()};
    else if(type==='tuic')config[type]={name,uuid:uuid||crypto.randomUUID(),password:password||crypto.randomUUID().replaceAll('-','')};
    else if(['trojan','hysteria2','anytls','shadowsocks'].includes(type))config[type]={name,password:password||crypto.randomUUID().replaceAll('-','')};
    else throw Error(`${type} 用户凭据暂未内置，请先在 S-UI 创建`);
  }
  return {client:{enable:$('new-client-enable').checked,name,remark,volume:Math.round(volume*1073741824),expiry,config,links:[]},inbounds_by_server:map};
}
function buildRoute(){const field=$('route-field').value,values=$('route-values').value.split(/[\n,，]+/).map(x=>x.trim()).filter(Boolean),action=$('route-action').value;if(!values.length)throw Error('请填写匹配值');const rule={action,[field]:field==='port'?values.map(x=>{const n=Number(x);if(!Number.isInteger(n)||n<1||n>65535)throw Error('目标端口无效');return n}):values};if(action==='route')rule.outbound=requiredValue('route-outbound','目标出站');return rule}
function previewRow(c){
  const parsed=value=>typeof value==='string'?JSON.parse(value):value;
  let detail;
  if(c.error)detail=`<p class="error">${esc(c.error)}</p>`;
  else if(c.action==='backup')detail='<p class="muted">下载数据库到控制器备份目录</p>';
  else if(c.action==='restartSb')detail='<p class="muted">重启该面板的 sing-box</p>';
  else if(['client_enable','client_disable'].includes(c.action))detail=`<p class="muted">${esc(parsed(c.before).name)}：${c.action==='client_enable'?'启用':'停用'}</p>`;
  else if(['inbound_create','outbound_create','client_create'].includes(c.action)){const after=parsed(c.after);detail=`<p class="muted">新增 ${esc(after.tag||after.name)}${after.type?' · '+esc(after.type):''}</p><details><summary>查看完整配置</summary><div class="diff">${esc(JSON.stringify(after,null,2))}</div></details>`}
  else if(c.action.startsWith('route_rule_')){const before=parsed(c.before),after=parsed(c.after);detail=`<p class="muted">规则数量 ${before.length} → ${after.length}，请核对顺序</p><details><summary>查看完整规则列表</summary><div class="diff">${esc(JSON.stringify(after,null,2))}</div></details>`}
  else{const before=parsed(c.before),after=parsed(c.after);const keys=Object.keys(after).filter(k=>JSON.stringify(after[k])!==JSON.stringify(before[k]));detail=`<p class="muted">修改 ${esc(keys.join('、')||'配置')}</p><details><summary>查看修改前后</summary><div class="diff">${esc('修改前\n'+JSON.stringify(before,null,2)+'\n\n修改后\n'+JSON.stringify(after,null,2))}</div></details>`}
  return `<div class="preview-row"><strong>${esc(c.server_name||'#'+c.server_id)}</strong>${status(c.error?'不可执行':'可执行',c.error?'bad':'ok')}${detail}</div>`;
}
async function doPreview(){
  const ids=[...state.selected],action=$('action').value;
  let request={server_ids:ids,action,client_name:$('client-name').value};
  try{
    if(action==='client_create')Object.assign(request,buildClient(ids));
    if(action==='inbound_patch'){
      request.inbound_tag=requiredValue('inbound-tag','已有入站');const patch={};
      const listen=$('edit-inbound-listen').value.trim(),port=portValue('edit-inbound-port','监听端口');if(listen)patch.listen=listen;if(port)patch.listen_port=port;
      const server=$('edit-inbound-server').value.trim(),publicPort=portValue('edit-inbound-public-port','公开端口');
      if(server)request.inbound_public_server=server;if(publicPort)request.inbound_public_port=publicPort;
      if(!Object.keys(patch).length&&!server&&!publicPort)throw Error('至少填写一项修改');request.inbound_patch=patch;
    }
    if(['inbound_create','outbound_create'].includes(action))Object.assign(request,buildCreate(action));
    if(action==='outbound_patch'){
      request.object_tag=requiredValue('object-tag','已有出站');const patch={};const server=$('edit-outbound-server').value.trim(),port=portValue('edit-outbound-port','远端端口'),user=$('edit-outbound-user').value.trim(),password=$('edit-outbound-password').value;
      const source=state.details[ids[0]]?.outbounds?.outbounds?.find(x=>x.tag===request.object_tag);if(!source)throw Error('先加载出站配置');
      if(server)patch.server=server;if(port)patch.server_port=port;if(user)patch[source.type==='vless'?'uuid':'username']=user;if(password)patch.password=password;
      if(source.type==='socks'){const udp=$('edit-outbound-udp').value;if(udp==='off')patch.udp_over_tcp=false;else if(udp==='1'||udp==='2')patch.udp_over_tcp={enabled:true,version:Number(udp)}}
      if(!Object.keys(patch).length)throw Error('至少填写一项修改');request.object_patch=patch;
    }
    if(action.startsWith('route_rule_')){
      if(action!=='route_rule_delete')request.route_rule=buildRoute();
      if(action==='route_rule_add')request.route_position=$('route-position').value;
      if(action!=='route_rule_add'||request.route_position==='before_index'){
        const raw=(action==='route_rule_add'?$('route-before'):$('route-index')).value;if(!/^\d+$/.test(raw))throw Error('请选择现有规则');request.route_index=Number(raw);
      }
    }
  }catch(e){notice('请检查表单：'+e.message);return}
  if(!ids.length){notice('请先选择服务器');return}clearNotice();$('preview').disabled=true;
  try{const p=await api('operations/preview',{method:'POST',body:JSON.stringify(request)});state.preview=p;$('preview-box').classList.remove('hidden');$('preview-box').innerHTML=`<h3>变更预览 · ${p.changes.length} 台</h3><p class="hint">预览有效期至 ${esc(date(p.expires))}。执行前逐台核对配置；修改操作会检查预览时的版本。</p>${p.changes.map(previewRow).join('')}<div class="button-row"><button id="execute" class="primary" ${p.changes.every(x=>x.error)?'disabled':''}>执行可用项</button></div>`;$('execute').addEventListener('click',doExecute)}catch(e){notice('预览失败：'+e.message)}finally{$('preview').disabled=false}
}
async function doExecute(){
  const p=state.preview;if(!p)return;const count=p.changes.filter(x=>!x.error).length;
  if(!confirm(`将对 ${count} 台服务器执行 ${$('action').selectedOptions[0].text}。确认？`))return;
  $('execute').disabled=true;$('result-box').classList.remove('hidden');
  try{
    const data=await executePreview(p.id,job=>{$('result-box').innerHTML=`<h3>执行中</h3><p class="hint">${esc(jobProgressText(job))}</p>`});
    state.preview=null;
    $('result-box').innerHTML=`<h3>执行结果</h3>${data.results.map(x=>`<div class="preview-row"><strong>${esc(x.name||'#'+x.server_id)}</strong>${status(x.ok?'成功':'失败',x.ok?'ok':'bad')}<p class="${x.ok?'muted':'error'}">${esc(x.message)}</p>${x.backup?`<small>备份：<a href="/api/backups/${encodeURIComponent(x.backup)}">${esc(x.backup)}</a></small>`:''}</div>`).join('')}`;
    await refresh();
  }catch(e){notice('执行失败：'+e.message)}
}
async function showBackups(){try{const rows=await api('backups');$('backup-list').innerHTML=rows.length?rows.map(x=>`<div class="audit-row"><a href="/api/backups/${encodeURIComponent(x.name)}">${esc(x.name)}</a><span class="muted"> · ${bytes(x.size)} · ${esc(date(x.created))}</span></div>`).join(''):'<div class="empty">尚无备份。可在批量操作中选择“备份数据库”。</div>'}catch(e){notice('备份列表加载失败：'+e.message)}}
async function showAudit(){try{const rows=await api('audit');$('audit-list').innerHTML=rows.length?rows.map(x=>`<div class="audit-row">${status(x.ok?'成功':'失败',x.ok?'ok':'bad')} <strong>${esc(x.action)}</strong> · 服务器 #${esc(x.server_id)} <span class="muted">${esc(date(x.at))}</span><div class="muted">${esc(x.detail)}</div></div>`).join(''):'<div class="empty">尚无操作记录</div>'}catch(e){notice('记录加载失败：'+e.message)}}
async function showJobs(){try{const rows=await api('jobs');$('job-list').innerHTML=rows.length?rows.map(x=>{const running=x.status==='queued'||x.status==='running',kind=x.status==='completed'?(x.failed?'bad':'ok'):x.status==='interrupted'?'bad':'';const label=running?'执行中':x.status==='completed'?'已完成':x.status==='interrupted'?'已中断':x.status;return `<div class="audit-row">${status(label,kind)} <strong>${esc(x.action)}</strong> <span class="muted">· ${esc(x.completed)} / ${esc(x.total)} · 成功 ${esc(x.succeeded)} · 失败 ${esc(x.failed)} · ${esc(date(x.updated_at))}</span><div class="muted">任务 ${esc(x.id)}</div></div>`}).join(''):'<div class="empty">尚无批量任务</div>'}catch(e){notice('任务列表加载失败：'+e.message)}}
document.addEventListener('click',e=>{const edit=e.target.closest('[data-server-action]');if(edit){openSingleEditor(+(edit.dataset.serverId||state.detailID),edit.dataset.serverAction,edit.dataset.target||'');return}const associate=e.target.closest('[data-associate]');if(associate){const node=state.monitorNodes.find(x=>x.uuid===associate.dataset.associate);openServerForm(null);$('server-name').value=node?.name||'';$('server-region').value=node?.region||'';$('server-komari').value=associate.dataset.associate;return}const detail=e.target.closest('[data-open-detail]');if(detail){openDetail(detail.dataset.openDetail);return}if(!e.target.closest('[data-monitor-link]')){const card=e.target.closest('[data-detail]');if(card)openDetail(card.dataset.detail)}const tab=e.target.closest('[data-tab]');if(tab){document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===tab));document.querySelectorAll('.tab-panel').forEach(x=>x.classList.toggle('hidden',x.id!==tab.dataset.tab));if(tab.dataset.tab==='audit')showAudit();if(tab.dataset.tab==='backups')showBackups();if(tab.dataset.tab==='jobs')showJobs()}});
document.addEventListener('change',e=>{if(e.target.matches('[data-pick]')){const id=+e.target.dataset.pick;e.target.checked?state.selected.add(id):state.selected.delete(id);state.preview=null;$('preview-box').classList.add('hidden');loadFormDetails()}if(['object-mode','object-type','route-position','route-action','new-outbound-udp'].includes(e.target.id))formModeChanged();if(e.target.id==='object-tag')outboundPatchModeChanged()});
document.addEventListener('keydown',e=>{const c=e.target.closest('[data-detail]');if(c&&e.target===c&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openDetail(c.dataset.detail)}});
$('refresh').onclick=refresh;$('refresh-backups').onclick=showBackups;$('refresh-jobs').onclick=showJobs;$('add').onclick=()=>openServerForm(null);$('server-form').onsubmit=saveServer;$('close-dialog').onclick=()=>$('server-dialog').close();$('delete-server').onclick=deleteServer;$('close-detail').onclick=()=>$('detail-dialog').close();$('configure-from-detail').onclick=()=>openSingleEditor(state.detailID,'inbound_patch');$('edit-from-detail').onclick=()=>{$('detail-dialog').close();openServerForm(state.servers.find(x=>x.id===state.detailID))};$('action').onchange=actionChanged;$('preview').onclick=doPreview;
$('clock').textContent=new Date().toLocaleDateString('zh-CN');loadNodes().then(refresh);
actionChanged();
setInterval(()=>{if(!document.hidden&&!$('server-dialog').open&&!$('detail-dialog').open&&!$('single-editor-dialog').open)refresh()},20000);
