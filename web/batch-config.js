const bc={tab:'inbounds',mode:'edit',source:null,data:null,index:0,form:null,original:null,ops:new Map(),preview:null,version:0,tlsName:'none',publicAddrs:{},inboundCopy:false,sourceTag:'',copyOriginal:null,inboundOptions:{},clientTagsByServer:{},inboundLoading:false,inboundVersion:0};
const bcKey=path=>JSON.stringify(path);
const bcPath=path=>encodeURIComponent(JSON.stringify(path));
const bcRead=path=>path.reduce((value,key)=>value?.[key],bc.form);
const bcParent=path=>path.slice(0,-1).reduce((value,key)=>value?.[key],bc.form);
const bcItems=()=>Array.isArray(bc.data?.[bc.tab])?bc.data[bc.tab]:[];
const bcIdentity=item=>`${fcNames.name&&['clients','tls'].includes(bc.tab)?'name':'tag'}:${['clients','tls'].includes(bc.tab)?item.name:item.tag}`;
const bcDefault=type=>type==='text'?'':type==='number'?0:type==='boolean'?false:type==='list'?[]:{};
const bcOutboundTypes=[['socks','SOCKS'],['http','HTTP'],['vless','VLESS'],['trojan','Trojan'],['hysteria2','Hysteria2'],['anytls','AnyTLS'],['shadowsocks','Shadowsocks'],['direct','直连'],['block','阻断']];
const bcInboundTypes=[['vless','VLESS'],['vmess','VMess'],['trojan','Trojan'],['hysteria2','Hysteria2'],['tuic','TUIC'],['anytls','AnyTLS'],['shadowsocks','Shadowsocks'],['mixed','Mixed'],['socks','SOCKS'],['http','HTTP']];
const bcGiB=1073741824;
const bcInboundList=()=>Array.isArray(bc.data?.inbounds)?bc.data.inbounds:[];
const bcTLSList=()=>Array.isArray(bc.data?.tls)?bc.data.tls:[];
const bcClientKey=inbound=>inbound.type==='shadowsocks'&&inbound.method==='2022-blake3-aes-128-gcm'?'shadowsocks16':inbound.type;
const bcClientSupported=inbound=>['vless','vmess','trojan','hysteria2','tuic','anytls','shadowsocks','shadowsocks16'].includes(bcClientKey(inbound));
function bcInboundForm(type,current={}){
  const object={tag:current.tag||'',type,listen:'::',listen_port:['mixed','socks','http'].includes(type)?1080:443,tls_id:0,addrs:[],out_json:{}};
  if(type==='shadowsocks')object.method='aes-256-gcm';
  return object;
}
const bcInboundManaged=new Set(['id','tag','type','listen','listen_port','tls_id','addrs','out_json']);
function bcCopyInboundForm(source,tag=''){
  const form=structuredClone(source);delete form.id;form.tag=tag;form.listen=source.listen||'::';form.listen_port=Math.min(65535,Number(source.listen_port||443)+1);return form;
}
function bcCopiedFieldPatch(before,after,path=[]){
  const patches=[];
  for(const [key,value] of Object.entries(after)){
    if(path.length===0&&bcInboundManaged.has(key))continue;
    const next=[...path,key],old=before?.[key];
    if(value&&old&&typeof value==='object'&&typeof old==='object'&&!Array.isArray(value)&&!Array.isArray(old))patches.push(...bcCopiedFieldPatch(old,value,next));
    else if(JSON.stringify(value)!==JSON.stringify(old))patches.push({op:'set',path:next,value:structuredClone(value)});
  }
  return patches;
}
function bcClientForm(){return {name:'',remark:'',desc:'',group:'',enable:true,volume:0,expiry:0,delayStart:false,autoReset:false,resetDays:0,config:{},inbounds:[],links:[]}}
function bcNewCredential(key){
  if(['vless','vmess'].includes(key))return {uuid:crypto.randomUUID()};
  if(key==='tuic')return {uuid:crypto.randomUUID(),password:crypto.randomUUID().replaceAll('-','')};
  if(key==='shadowsocks16')return {password:btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))};
  return {password:crypto.randomUUID().replaceAll('-','')};
}
function bcSyncClientCredentials(){
  const next={};
  const chosen=bc.clientTagsByServer&&Object.keys(bc.clientTagsByServer).length?Object.entries(bc.clientTagsByServer).flatMap(([id,tags])=>(bc.inboundOptions[id]?.items||[]).filter(item=>tags.includes(item.tag))):bcInboundList().filter(item=>bc.form.inbounds.includes(item.tag));
  for(const inbound of chosen){
    const key=bcClientKey(inbound);if(!bcClientSupported(inbound))continue;
    next[key]={name:bc.form.name,...(bc.form.config[key]||bcNewCredential(key))};
  }
  bc.form.config=next;
}
function bcAddMissingClientCredentials(){
  bc.form.config??={};
  for(const inbound of bcInboundList().filter(item=>bcSelectedInboundTags().includes(item.tag))){
    const key=bcClientKey(inbound);
    if(!bcClientSupported(inbound)||bc.form.config[key])continue;
    bc.form.config[key]={name:bc.form.name,...bcNewCredential(key)};
    bcMark(['config',key]);
  }
}
function bcOutboundForm(type,current={}){
  const object={tag:current.tag||'',type};
  if(type==='direct'||type==='block')return object;
  object.server=current.server||'';object.server_port=current.server_port||(['socks','http'].includes(type)?1080:443);
  if(type==='socks'){object.version='5';object.username='';object.password='';object.network='';object.udp_over_tcp='off'}
  else if(type==='http'){object.username='';object.password=''}
  else if(type==='vless'){object.uuid='';object.tls={enabled:true,server_name:''}}
  else if(type==='shadowsocks'){object.method='aes-256-gcm';object.password=''}
  else{object.password='';object.tls={enabled:true,server_name:''}}
  object.detour='';
  return object;
}
function bcPrepareNewObject(tab,form){
  const object=structuredClone(form);
  if(tab==='clients'){
    if(!String(object.name||'').trim())throw Error('请填写用户名称');
    const perServer=bc.clientTagsByServer&&Object.keys(bc.clientTagsByServer).length;
    if(perServer?!Object.values(bc.clientTagsByServer).some(tags=>tags.length):!Array.isArray(object.inbounds)||!object.inbounds.length)throw Error('请至少选择一个可用入站');
    if(!Object.keys(object.config||{}).length)throw Error('所选入站没有可创建的协议凭据');
    if(!Number.isInteger(object.volume)||object.volume<0)throw Error('流量上限无效');
    if(!Number.isInteger(object.expiry)||object.expiry<0)throw Error('到期时间无效');
    if(object.autoReset&&(!Number.isInteger(object.resetDays)||object.resetDays<1))throw Error('自动重置需要填写周期天数');
    if(!object.autoReset)delete object.resetDays;
    for(const [key,credential] of Object.entries(object.config)){
      credential.name=object.name;
      if(['vless','vmess','tuic'].includes(key)&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(credential.uuid||''))throw Error(`${key} UUID 格式无效`);
      if(!['vless','vmess'].includes(key)&&!String(credential.password||'').trim())throw Error(`${key} 缺少密码`);
    }
    object.remark=object.remark||object.name;
    object.inbounds=[];
    if(!object.desc)delete object.desc;
    if(!object.group)delete object.group;
    return object;
  }
  if(tab==='inbounds'){
    if(bc.inboundCopy&&!bc.sourceTag)throw Error('请选择要复制的入站');
    if(!bc.inboundCopy&&!bcInboundTypes.some(row=>row[0]===object.type))throw Error('请选择支持的入站类型');
    if(!String(object.tag||'').trim())throw Error('请填写入站 Tag');
    if(!String(object.listen||'').trim())throw Error('请填写监听地址');
    if(!Number.isInteger(object.listen_port)||object.listen_port<1||object.listen_port>65535)throw Error('监听端口无效');
    if(!bc.inboundCopy&&['trojan','hysteria2','tuic','anytls'].includes(object.type)&&bc.tlsName==='none')throw Error(`${object.type} 入站需要选择 TLS 证书`);
    return object;
  }
  if(tab!=='outbounds')return object;
  const type=object.type;
  if(!bcOutboundTypes.some(row=>row[0]===type))throw Error('请选择支持的出站类型');
  if(!String(object.tag||'').trim())throw Error('请填写出站 Tag');
  if(type==='direct'||type==='block')return {tag:object.tag,type};
  if(!String(object.server||'').trim())throw Error('请填写远端服务器');
  if(!Number.isInteger(object.server_port)||object.server_port<1||object.server_port>65535)throw Error('远端端口无效');
  if(type==='socks'){
    if(!['4','5'].includes(object.version))throw Error('SOCKS 版本只能为 4 或 5');
    if(!['','tcp','udp'].includes(object.network))throw Error('SOCKS 网络类型无效');
    if(!['off','1','2'].includes(object.udp_over_tcp))throw Error('UDP over TCP 版本无效');
    if(object.udp_over_tcp!=='off'){
      if(object.version!=='5')throw Error('UDP over TCP 仅支持 SOCKS5');
      if(object.network==='tcp')throw Error('UDP over TCP 需要启用 UDP 网络');
      object.udp_over_tcp={enabled:true,version:Number(object.udp_over_tcp)};
    }else delete object.udp_over_tcp;
    if(!object.network)delete object.network;
  }
  if(type==='vless'&&!String(object.uuid||'').trim())throw Error('请填写 VLESS UUID');
  if(['trojan','hysteria2','anytls','shadowsocks'].includes(type)&&!String(object.password||''))throw Error('请填写密码');
  if(!object.username)delete object.username;
  if(!object.password)delete object.password;
  if(!object.detour)delete object.detour;
  if(object.tls&&!object.tls.server_name)delete object.tls.server_name;
  return object;
}
function bcResetPreview(keepResult=false){bc.preview=null;$('batch-config-preview').classList.add('hidden');if(!keepResult)$('batch-config-result').classList.add('hidden')}
function bcSelected(){return [...state.selected]}
function bcServerList(){
  $('batch-config-servers').innerHTML=state.servers.map(s=>`<label class="batch-config-server"><input type="checkbox" data-bc-server="${s.id}" ${state.selected.has(s.id)?'checked':''}><span><b>${esc(s.name)}</b><small>${esc(s.region||'未分组')}</small></span></label>`).join('')||'<p class="muted">先添加 S-UI 面板。</p>';
}
async function bcLoad(options={}){
  const {keepResult=false,preserveNewDraft=false}=options;
  const draft=preserveNewDraft&&bc.mode==='new'&&bc.form?{
    tab:bc.tab,form:structuredClone(bc.form),tlsName:bc.tlsName,
    publicAddrs:structuredClone(bc.publicAddrs),inboundCopy:bc.inboundCopy,
    sourceTag:bc.sourceTag,copyOriginal:bc.copyOriginal?structuredClone(bc.copyOriginal):null,
    clientTagsByServer:structuredClone(bc.clientTagsByServer)
  }:null;
  bcResetPreview(keepResult);bc.version++;const version=bc.version,ids=bcSelected();bcServerList();
  if(!ids.length){bc.data=null;bc.source=null;$('batch-config-content').innerHTML='<div class="empty">先勾选目标服务器。</div>';return}
  const source=state.servers.find(s=>s.id===ids[0]);bc.source=source;$('batch-config-content').innerHTML=`<p class="muted">正在读取 ${esc(source?.name||'服务器')} 的配置…</p>`;
  try{
    const data=await api(`servers/${ids[0]}/configuration`);if(version!==bc.version)return;bc.data=data;bc.index=0;
    if(draft){
      bc.tab=draft.tab;bc.mode='new';bc.original=null;bc.ops.clear();bc.form=draft.form;bc.tlsName=draft.tlsName;
      bc.publicAddrs=draft.publicAddrs;bc.inboundCopy=draft.inboundCopy;bc.sourceTag=draft.sourceTag;bc.copyOriginal=draft.copyOriginal;
      bc.clientTagsByServer=draft.clientTagsByServer;bc.inboundOptions={};bc.inboundLoading=false;bcRender();
      if(bc.tab==='clients')bcLoadClientInboundOptions();
    }else{bc.mode='edit';bcSelect()}
  }catch(e){if(version===bc.version)$('batch-config-content').innerHTML=`<p class="error">读取失败：${esc(e.message)}</p>`}
}
function bcSyncPublicAddrsForSelection(){
  const selected=new Set(bcSelected().map(String));
  for(const id of Object.keys(bc.publicAddrs))if(!selected.has(id))delete bc.publicAddrs[id];
  for(const id of selected)if(!bc.publicAddrs[id])bc.publicAddrs[id]={server:'',port:bc.form?.listen_port||443};
}
async function bcSelectionChanged(){
  bcResetPreview();bcServerList();const ids=bcSelected();
  if(!ids.length){bc.data=null;bc.source=null;$('batch-config-content').innerHTML='<div class="empty">先勾选目标服务器。</div>';return}
  const sourceStillSelected=bc.data&&bc.source&&ids.includes(Number(bc.source.id));
  if(!sourceStillSelected){await bcLoad({preserveNewDraft:true});return}
  if(bc.mode==='new'&&bc.tab==='clients'){await bcLoadClientInboundOptions();return}
  if(bc.mode==='new'&&bc.tab==='inbounds')bcSyncPublicAddrsForSelection();
  bcRender();
}
function bcSelect(){
  bcResetPreview();bc.ops.clear();bc.inboundVersion++;bc.clientTagsByServer={};bc.inboundOptions={};bc.inboundLoading=false;const singleton=['config','settings'].includes(bc.tab),item=singleton?bc.data?.[bc.tab]:bcItems()[bc.index];bc.original=item==null?null:structuredClone(item);bc.form=item==null?null:structuredClone(item);
  bc.tlsName=bcTLSList().find(t=>t.id===bc.form?.tls_id)?.name||'none';bc.publicAddrs={};bc.inboundCopy=false;bc.sourceTag='';bc.copyOriginal=null;bcRender();
}
function bcNew(){
  if(['config','settings'].includes(bc.tab))return;
  bc.mode='new';bc.ops.clear();bcResetPreview();bc.original=null;bc.inboundVersion++;bc.clientTagsByServer={};bc.inboundOptions={};bc.inboundLoading=false;
  bc.form=bc.tab==='clients'?bcClientForm():bc.tab==='tls'?{name:'',server:{enabled:true},client:{enabled:true}}:bc.tab==='inbounds'?bcInboundForm('vless'):bc.tab==='outbounds'?bcOutboundForm('socks'):bc.tab==='endpoints'?{tag:'',type:'wireguard'}:{tag:'',type:'derp'};
  bc.tlsName='none';bc.inboundCopy=false;bc.sourceTag='';bc.copyOriginal=null;bc.publicAddrs=Object.fromEntries(bcSelected().map(id=>[id,{server:'',port:bc.form.listen_port||443}]));
  bcRender();if(bc.tab==='clients')bcLoadClientInboundOptions();
}
async function bcLoadClientInboundOptions(){
  const version=++bc.inboundVersion,ids=bcSelected(),previous=bc.clientTagsByServer;
  bc.clientTagsByServer=Object.fromEntries(ids.map(id=>[id,previous[id]||[]]));
  bc.inboundOptions=Object.fromEntries(ids.map(id=>[id,id===bc.source?.id?{items:bcInboundList()}:{loading:true}]));
  bc.inboundLoading=true;bcRender();
  const results=await Promise.all(ids.filter(id=>id!==bc.source?.id).map(async id=>{
    try{const data=await api(`servers/${id}/inbound-options`);return [id,{items:data.inbounds||[]}]}catch(error){return [id,{error:error.message}]}
  }));
  if(version!==bc.inboundVersion||bc.tab!=='clients'||bc.mode!=='new')return;
  for(const [id,result] of results)bc.inboundOptions[id]=result;
  for(const id of ids){const available=new Set((bc.inboundOptions[id]?.items||[]).map(item=>item.tag));bc.clientTagsByServer[id]=bc.clientTagsByServer[id].filter(tag=>available.has(tag))}
  bc.inboundLoading=false;bcSyncClientCredentials();bcRender();
}
function bcSelectedInboundTags(){
  if(bc.mode==='new')return bc.form.inbounds||[];
  return bcInboundList().filter(item=>(bc.form.inbounds||[]).includes(item.id)).map(item=>item.tag);
}
function bcInboundPicker(){
  const selected=bcSelectedInboundTags();
  return `<section class="batch-config-section"><h4>可用入站</h4><p class="hint">按 Tag 选择；预览时会逐台匹配对应入站，避免把第一台的 ID 复制到其他服务器。</p><div class="batch-config-picks">${bcInboundList().map(item=>`<label class="batch-config-pick"><input type="checkbox" data-bc-inbound-tag="${esc(item.tag)}" ${selected.includes(item.tag)?'checked':''} ${bc.mode==='new'&&!bcClientSupported(item)?'disabled':''}><span><strong>${esc(item.tag)}</strong><small>${esc(item.type)} · ${esc(item.listen_port||'—')}${bc.mode==='new'&&!bcClientSupported(item)?' · 此协议需在 S-UI 配置凭据':''}</small></span></label>`).join('')||'<p class="muted">当前面板没有入站。请先创建入站。</p>'}</div></section>`;
}
function bcClientNewInboundPicker(){
  return `<section class="batch-config-section"><h4>逐台选择可用入站</h4><p class="hint">每台机器的入站可以不同。为每台目标服务器选择至少一个；相同协议共用上方用户的一组凭据，预览会换算为各台的入站 ID。</p><div class="batch-config-client-servers">${bcSelected().map(id=>{const server=state.servers.find(item=>item.id===id),result=bc.inboundOptions[id],items=result?.items||[],selected=bc.clientTagsByServer[id]||[],supported=items.filter(bcClientSupported);return `<div class="batch-config-client-server"><div class="batch-config-client-server-head"><strong>${esc(server?.name||'#'+id)}</strong>${items.length?`<button type="button" class="secondary" data-bc-client-all="${id}">${selected.length===supported.length?'清空此台':'全选此台'}</button>`:''}</div>${result?.loading?'<p class="muted">正在读取入站…</p>':result?.error?`<p class="error">读取失败：${esc(result.error)}</p>`:items.length?`<div class="batch-config-picks">${items.map(item=>`<label class="batch-config-pick"><input type="checkbox" data-bc-client-server="${id}" data-bc-client-tag="${esc(item.tag)}" ${selected.includes(item.tag)?'checked':''} ${bcClientSupported(item)?'':'disabled'}><span><strong>${esc(item.tag)}</strong><small>${esc(item.type)} · ${esc(item.listen_port||'—')}${bcClientSupported(item)?'':' · 此协议不支持自动创建凭据'}</small></span></label>`).join('')}</div>`:'<p class="muted">此台没有可用入站。</p>'}</div>`}).join('')}</div>${bc.inboundLoading?'<p class="hint">正在读取其他服务器的入站，完成后即可选择并预览。</p>':''}</section>`;
}
function bcClientNewFields(){
  const fields=(...keys)=>keys.map(key=>bcField(key,bc.form[key],[key],0)).join('');
  const credentials=Object.entries(bc.form.config).map(([type,values])=>`<div class="batch-config-credential"><h5>${esc(type)} 凭据</h5>${Object.entries(values).filter(([key])=>key!=='name').map(([key,value])=>bcField(key,value,['config',type,key],2)).join('')}</div>`).join('');
  return `<div class="batch-config-guided"><section class="batch-config-section"><h4>用户信息</h4>${fields('name','remark','enable','desc','group')}</section>${bcClientNewInboundPicker()}<section class="batch-config-section"><h4>协议凭据</h4><p class="hint">按所选入站协议生成凭据；可直接修改 UUID 或密码。所有目标服务器使用同一组协议凭据。</p>${credentials||'<p class="muted">先选择上方的入站。</p>'}</section><section class="batch-config-section"><h4>流量与有效期</h4>${fields('volume','expiry','delayStart','autoReset')}${bc.form.autoReset?fields('resetDays'):''}</section></div>`;
}
function bcClientEditCredentials(){
  const entries=Object.entries(bc.form.config||{});
  return `<section class="batch-config-section"><h4>协议凭据</h4><p class="hint">选择新协议入站时会生成相应凭据。修改现有密码或 UUID 只影响勾选的字段；原密码不会显示。</p>${entries.map(([type,values])=>`<div class="batch-config-credential"><h5>${esc(type)} 凭据 ${bc.ops.has(bcKey(['config',type]))?'<small>新生成，随入站一起保存</small>':''}</h5>${values&&typeof values==='object'?Object.entries(values).filter(([key])=>key!=='name').map(([key,value])=>bcField(key,value,['config',type,key],2)).join(''):'<p class="muted">此协议凭据结构需在 S-UI 检查。</p>'}</div>`).join('')||'<p class="muted">此用户还没有协议凭据。</p>'}</section>`;
}
function bcInboundNewFields(){
  const sources=bcInboundList();
  const source=sources.find(item=>item.tag===bc.sourceTag);
  const fields=(...keys)=>keys.map(key=>bcField(key,bc.form[key],[key],0)).join('');
  const tlsOptions=`<option value="none" ${bc.tlsName==='none'?'selected':''}>不使用 TLS 证书</option>${bcTLSList().map(item=>`<option value="${esc(item.name)}" ${bc.tlsName===item.name?'selected':''}>${esc(item.name)}</option>`).join('')}`;
  const publicFields=bcSelected().map(id=>{const server=state.servers.find(item=>item.id===id),addr=bc.publicAddrs[id]||{server:'',port:bc.form.listen_port};return `<div class="batch-config-public-row"><strong>${esc(server?.name||'#'+id)}</strong><label>公开域名 / IP<input data-bc-public-server="${id}" value="${esc(addr.server||'')}" placeholder="留空则不发布到订阅"></label><label>公开端口<input data-bc-public-port="${id}" type="number" min="1" max="65535" value="${esc(addr.port||bc.form.listen_port)}"></label></div>`}).join('');
  const advanced=bc.inboundCopy?Object.keys(bc.form).filter(key=>!bcInboundManaged.has(key)):[];
  return `<div class="batch-config-guided"><section class="batch-config-section"><h4>创建方式</h4><label class="batch-config-choice"><input type="radio" name="bc-inbound-create" data-bc-inbound-copy="false" ${!bc.inboundCopy?'checked':''}> 按类型新建</label><label class="batch-config-choice"><input type="radio" name="bc-inbound-create" data-bc-inbound-copy="true" ${bc.inboundCopy?'checked':''} ${sources.length?'':'disabled'}> 复制各服务器的已有入站</label>${bc.inboundCopy?`<label>复制来源 Tag<select id="bc-inbound-source">${sources.map(item=>`<option value="${esc(item.tag)}" ${item.tag===bc.sourceTag?'selected':''}>${esc(item.tag)} · ${esc(item.type)}</option>`).join('')}</select></label><p class="hint">逐台复制相同 Tag 的入站，保留各台原有协议、TLS 和高级参数；请使用新的监听地址或端口。</p>`:''}</section><section class="batch-config-section"><h4>监听设置</h4>${fields('tag','type','listen','listen_port')}${!bc.inboundCopy&&bc.form.method!==undefined?fields('method'):''}${bc.inboundCopy?`<p class="hint">来源：${esc(source?.tag||'未选择')}；其余协议字段在每台服务器分别保留。</p>`:''}</section>${!bc.inboundCopy?`<section class="batch-config-section"><h4>TLS 证书</h4><label>证书名称<select id="bc-inbound-tls">${tlsOptions}</select></label><p class="hint">按名称在每台目标服务器匹配证书；若某台没有同名证书，预览会标出错误。</p></section>`:''}${advanced.length?`<section class="batch-config-section"><h4>协议与高级参数</h4><p class="hint">这些字段来自参考入站。只把你修改的值逐台覆盖，其他参数保留各服务器原值。</p>${advanced.map(key=>bcField(key,bc.form[key],[key],0)).join('')}</section>`:''}<section class="batch-config-section"><h4>订阅公开地址</h4><p class="hint">这是客户端连接各服务器的域名或 IP，与监听地址不同。留空则只创建监听入站，不发布订阅节点。</p><div class="batch-config-public-grid">${publicFields}</div></section></div>`;
}
function bcEditPublicFields(){
  const first=bc.form.addrs?.[0]||bc.form.out_json||{};
  return `<section class="batch-config-section"><h4>逐台修改订阅公开地址</h4><p class="hint">只修改勾选的服务器。填写的域名或 IP 会更新第一条公开地址，其余地址保留；留空并勾选会取消该服务器的全部订阅节点。</p><div class="batch-config-public-grid">${bcSelected().map(id=>{const enabled=Object.hasOwn(bc.publicAddrs,id),addr=bc.publicAddrs[id]||(id===bc.source?.id?{server:first.server||'',port:first.server_port||bc.form.listen_port}:{server:'',port:bc.form.listen_port});const server=state.servers.find(item=>item.id===id);return `<div class="batch-config-public-row"><label class="batch-config-choice"><input type="checkbox" data-bc-public-update="${id}" ${enabled?'checked':''}> ${esc(server?.name||'#'+id)}</label><label>第一条公开域名 / IP<input data-bc-public-server="${id}" value="${esc(addr.server||'')}" ${enabled?'':'disabled'} placeholder="留空为取消发布"></label><label>公开端口<input data-bc-public-port="${id}" type="number" min="1" max="65535" value="${esc(addr.port||bc.form.listen_port)}" ${enabled?'':'disabled'}></label></div>`}).join('')}</div></section>`;
}
function bcGuidedEditFields(){
  const sections=bc.tab==='clients'?[['用户信息',['name','remark','enable','desc','group']],['可用入站',['inbounds']],['流量与有效期',['volume','expiry','delayStart','autoReset','resetDays']]]:[['监听设置',['tag','type','listen','listen_port']],['TLS 证书',['tls_id']]];
  const shown=new Set(sections.flatMap(section=>section[1]));
  if(bc.tab==='clients')shown.add('config');
  if(bc.tab==='inbounds'){shown.add('addrs');shown.add('out_json')}
  const common=sections.map(([title,keys])=>{
    const fields=keys.filter(key=>Object.hasOwn(bc.form,key)).map(key=>bcField(key,bc.form[key],[key],0)).join('')||'<p class="muted">此对象没有对应字段。</p>';
    if(bc.tab==='clients'&&title==='可用入站')return fields+bcClientEditCredentials();
    return `<section class="batch-config-section"><h4>${title}</h4>${fields}</section>`;
  }).join('');
  const ignored=new Set(['id','up','down','totalUp','totalDown','createdAt','onlineAt','nextReset']);
  const other=Object.keys(bc.form).filter(key=>!shown.has(key)&&!ignored.has(key));
  return `<div class="batch-config-guided">${common}${bc.tab==='inbounds'?bcEditPublicFields():''}${other.length?`<details class="batch-config-extra"><summary>其他配置字段 · ${other.length} 项</summary><div class="batch-config-fields">${other.map(key=>bcField(key,bc.form[key],[key],0)).join('')}</div></details>`:''}${bc.tab==='clients'?'<p class="hint">用量和时间统计属于运行数据，不在批量配置中修改。</p>':''}</div>`;
}
function bcRender(){
  $('batch-config-tabs').innerHTML=fcTabs.map(([key,label])=>`<button data-bc-tab="${key}" class="${bc.tab===key?'active':''}" aria-selected="${bc.tab===key}">${label}</button>`).join('');
  const box=$('batch-config-content');if(!bc.data){box.innerHTML='<p class="muted">请选择服务器。</p>';return}
  if(bc.data.errors?.[bc.tab]){box.innerHTML=`<p class="error">${esc(bc.data.errors[bc.tab])}</p>`;return}
  const singleton=['config','settings'].includes(bc.tab),items=bcItems(),name=fcTabs.find(x=>x[0]===bc.tab)?.[1];
  const selector=singleton?'':`<div class="batch-config-object-bar"><label>配置对象<select id="batch-config-object">${items.map((item,i)=>`<option value="${i}" ${i===bc.index?'selected':''}>${esc(item.name||item.tag||'#'+item.id)} · ${esc(item.type||'')}</option>`).join('')}</select></label><button id="batch-config-new" class="secondary">＋ 新增${esc(name)}</button></div>`;
  const mode=singleton?'':`<div class="batch-config-mode"><button data-bc-mode="edit" class="${bc.mode==='edit'?'active':''}">修改字段</button><button data-bc-mode="new" class="${bc.mode==='new'?'active':''}">新增对象</button><button data-bc-mode="del" class="${bc.mode==='del'?'active':''}">删除对象</button></div>`;
  if(!bc.form&&bc.mode!=='new'){box.innerHTML=selector+mode+'<div class="empty">此类还没有对象。点击新增开始配置。</div>';return}
  const intro=bc.mode==='new'&&bc.tab==='inbounds'?'入站负责监听和订阅公开地址；用户密码或 UUID 在“用户”里设置。':bc.mode==='new'&&bc.tab==='clients'?'先选择可用入站，再填写对应协议凭据；预览会逐台匹配入站。':bc.mode==='new'?'将用下面的表单在每台服务器新建对象。':bc.mode==='del'?'将按名称或 Tag 在每台服务器定位对象并分别预览删除。':bc.tab==='settings'?'勾选要同步的设置值；未勾选的设置保持各服务器原值。':['inbounds','outbounds','endpoints','services'].includes(bc.tab)?'勾选要批量修改的字段；修改 Tag 时会逐台检查重名和配置引用。':'勾选要批量修改的字段；未勾选的字段保持各服务器原值。';
  const shortcut=bc.mode==='new'&&bc.tab==='inbounds'?'<button id="batch-config-client-shortcut" class="secondary" type="button">下一步：创建用户与凭据</button>':'';
  const fields=bc.mode==='del'?`<div class="batch-config-danger">将删除 ${esc(bc.original?.name||bc.original?.tag||'对象')}。预览会逐台检查。</div>`:bc.mode==='new'&&bc.tab==='clients'?bcClientNewFields():bc.mode==='new'&&bc.tab==='inbounds'?bcInboundNewFields():bc.mode==='edit'&&['clients','inbounds'].includes(bc.tab)?bcGuidedEditFields():bcFields(bc.form,[],0);
  box.innerHTML=`${selector}${mode}<p class="hint">参考 ${esc(bc.source?.name||'第一台服务器')} 的当前配置。${intro}</p>${shortcut}${fields}<div class="batch-config-actions"><span id="batch-config-count">${bc.mode==='new'?'新建对象':bc.ops.size+' 项字段变更'}</span><button id="batch-config-review" class="primary">生成逐台预览</button></div>`;
}
function bcFields(object,path,depth){
  if(depth>10)return '<p class="hint">嵌套较深，请在单机完整配置中编辑。</p>';
  const extra=bc.mode==='del'||bc.tab==='settings'||Array.isArray(object)?'':`<details class="batch-config-extra" data-bc-extra-path="${bcPath(path)}"><summary>${path.length?'添加嵌套字段（高级）':'高级参数（可选）'}</summary><p class="hint">仅在需要 sing-box 专用参数时填写其字段名；普通新增无需操作。</p><div class="batch-config-add" data-bc-container="${bcPath(path)}"><input data-bc-key placeholder="sing-box 字段名" aria-label="sing-box 字段名"><select data-bc-type aria-label="字段类型"><option value="text">文本</option><option value="number">数字</option><option value="boolean">开关</option><option value="object">对象</option><option value="list">列表</option></select><button data-bc-add class="secondary">＋ 添加</button></div></details>`;
  return `<div class="batch-config-fields">${Object.entries(object).map(([key,value])=>bcField(key,value,[...path,Array.isArray(object)?Number(key):key],depth)).join('')}${extra}</div>`;
}
function bcField(key,value,path,depth){
  const kind=fcKind(value),encoded=bcPath(path),label=bc.tab==='clients'&&path.length===1?({name:'用户名称 / 订阅 ID',volume:'流量上限（GB，0 为不限）',expiry:'到期日期'}[key]||fcNames[key]||key):bc.tab==='inbounds'&&path.length===1?({tag:'入站 Tag（节点名称）',type:'协议类型',listen:'监听地址（本机）',listen_port:'监听端口',tls_id:'TLS 证书'}[key]||fcNames[key]||key):path.length===1&&key==='tag'?'Tag 标签名称':fcNames[key]||key,locked=key==='id'||(bc.mode!=='new'&&path.length===1&&(key==='name'||bc.tab==='inbounds'&&key==='type'))||(bc.tab==='settings'&&fcManaged.has(key)),checked=bc.ops.has(bcKey(path)),freshCredential=bc.tab==='clients'&&bc.mode==='edit'&&bc.ops.has(bcKey(path.slice(0,-1)));
  if(bc.tab==='clients'&&bc.mode==='edit'&&path.length===1&&key==='inbounds')return `<div class="batch-config-group">${bcInboundPicker()}<label class="batch-config-sync"><input type="checkbox" data-bc-check="${encoded}" ${checked?'checked':''}> 将所选入站同步到各服务器</label></div>`;
  if(kind==='object'||kind==='array')return `<div class="batch-config-group"><div class="batch-config-group-head"><details ${depth<1?'open':''}><summary>${esc(label)} <small>${kind==='array'?'列表':'对象'} · ${Object.keys(value).length} 项</small></summary>${bcFields(value,path,depth+1)}</details>${bc.mode==='edit'&&!locked?`<label title="用参考服务器的整个分组覆盖目标分组"><input type="checkbox" data-bc-group="${encoded}" ${checked?'checked':''}> 同步整个分组</label>`:''}</div></div>`;
  const secret=fcSecret(key),id=`bc-${encoded}`,editable=!locked&&bc.mode!=='del';let input='';
  if(bc.mode==='new'&&bc.tab==='outbounds'&&path.length===1&&key==='type')input=`<select id="${id}" data-bc-value="${encoded}">${bcOutboundTypes.map(([type,name])=>`<option value="${type}" ${value===type?'selected':''}>${name}</option>`).join('')}</select>`;
  else if(bc.mode==='new'&&bc.tab==='inbounds'&&path.length===1&&key==='type')input=`<select id="${id}" data-bc-value="${encoded}" ${bc.inboundCopy?'disabled':''}>${bcInboundTypes.map(([type,name])=>`<option value="${type}" ${value===type?'selected':''}>${name}</option>`).join('')}</select>`;
  else if(bc.tab==='inbounds'&&bc.mode==='edit'&&path.length===1&&key==='tls_id')input=`<select id="${id}" data-bc-tls-name><option value="none" ${bc.tlsName==='none'?'selected':''}>不使用 TLS</option>${bcTLSList().map(item=>`<option value="${esc(item.name)}" ${bc.tlsName===item.name?'selected':''}>${esc(item.name)}</option>`).join('')}</select>`;
  else if(bc.mode==='new'&&bc.tab==='outbounds'&&path.length===1&&key==='version')input=`<select id="${id}" data-bc-value="${encoded}"><option value="5" ${value==='5'?'selected':''}>SOCKS5</option><option value="4" ${value==='4'?'selected':''}>SOCKS4</option></select>`;
  else if(bc.mode==='new'&&bc.tab==='outbounds'&&path.length===1&&key==='network')input=`<select id="${id}" data-bc-value="${encoded}"><option value="" ${value===''?'selected':''}>TCP + UDP（默认）</option><option value="tcp" ${value==='tcp'?'selected':''}>仅 TCP</option><option value="udp" ${value==='udp'?'selected':''}>仅 UDP</option></select>`;
  else if(bc.mode==='new'&&bc.tab==='outbounds'&&path.length===1&&key==='udp_over_tcp')input=`<select id="${id}" data-bc-value="${encoded}"><option value="off" ${value==='off'?'selected':''}>禁用</option><option value="2" ${value==='2'?'selected':''}>启用 · 版本 2</option><option value="1" ${value==='1'?'selected':''}>启用 · 版本 1</option></select>`;
  else if(kind==='boolean')input=`<select id="${id}" data-bc-value="${encoded}" ${editable?'':'disabled'}><option value="true" ${value?'selected':''}>启用</option><option value="false" ${!value?'selected':''}>关闭</option></select>`;
  else if(bc.tab==='clients'&&path.length===1&&key==='volume')input=`<input id="${id}" data-bc-volume type="number" min="0" step="0.01" value="${esc(Number((value/bcGiB).toFixed(3)))}" ${editable?'':'disabled'}>`;
  else if(bc.tab==='clients'&&path.length===1&&key==='expiry')input=`<input id="${id}" data-bc-expiry type="date" value="${value?new Date(value*1000).toISOString().slice(0,10):''}" ${editable?'':'disabled'}><small class="hint">留空表示永不过期</small>`;
  else if(kind==='number')input=`<input id="${id}" data-bc-value="${encoded}" type="number" step="any" value="${esc(value)}" ${editable?'':'disabled'}>`;
  else if(secret){const visibleValue=bc.mode==='new'||freshCredential;input=`<div class="batch-secret-wrap"><input id="${id}" data-bc-value="${encoded}" type="password" value="${visibleValue?esc(value):''}" placeholder="${visibleValue?'输入密码':value?'已设置；输入新值':'输入新值'}" autocomplete="new-password" ${editable?'':'disabled'}><button type="button" data-bc-secret-toggle class="secondary" aria-label="显示或隐藏${esc(label)}">显示</button></div>`}
  else if(kind==='string'&&(value.length>90||value.includes('\n')))input=`<textarea id="${id}" data-bc-value="${encoded}" rows="3" ${editable?'':'disabled'}>${esc(value)}</textarea>`;
  else input=`<input id="${id}" data-bc-value="${encoded}" value="${esc(value===null?'':value)}" ${editable?'':'disabled'}>`;
  return `<div class="batch-config-field"><div class="batch-config-field-label">${bc.mode==='edit'&&editable&&!freshCredential?`<input type="checkbox" data-bc-check="${encoded}" ${checked?'checked':''} aria-label="修改 ${esc(label)}">`:''}<label for="${id}">${esc(label)}${label!==key&&!['clients','inbounds'].includes(bc.tab)?` <code>${esc(key)}</code>`:''}</label></div>${input}${editable&&bc.mode==='edit'&&bc.tab!=='settings'&&key!=='tag'&&!['clients','inbounds'].includes(bc.tab)?`<button data-bc-remove="${encoded}" class="text-button" title="从各服务器删除此字段">✕</button>`:''}</div>`;
}
function bcError(message){const box=$('batch-config-content');let error=$('batch-config-error');if(!error){error=document.createElement('p');error.id='batch-config-error';error.className='error';box.prepend(error)}error.textContent=message;error.scrollIntoView({block:'nearest'})}
function bcMark(path,op='set'){
  if(op==='set')bc.ops.set(bcKey(path),{op:'set',path,value:structuredClone(bcRead(path))});else bc.ops.set(bcKey(path),{op:'remove',path});
  bcResetPreview();const count=$('batch-config-count');if(count)count.textContent=bc.ops.size+' 项字段变更';
}
function bcRequest(){
  const ids=bcSelected();if(!ids.length)throw Error('请先选择服务器');
  const singleton=['config','settings'].includes(bc.tab),mode=singleton?(bc.tab==='settings'?'set':'patch'):bc.mode==='edit'?'patch':bc.mode;
  const request={server_ids:ids,action:'config_save',config_target:bc.tab,config_mode:mode};
  if(!singleton&&bc.mode!=='new')request.config_identity=bcIdentity(bc.original);
  if(mode==='del')return request;
  if(mode==='new'){
    if(bc.tab==='clients'){
      if(bc.inboundLoading)throw Error('请等待各台服务器的入站读取完成');
      for(const id of ids){if(bc.inboundOptions[id]?.error)throw Error(`服务器 ${state.servers.find(item=>item.id===id)?.name||id} 的入站读取失败`);if(!bc.clientTagsByServer[id]?.length)throw Error(`请为服务器 ${state.servers.find(item=>item.id===id)?.name||id} 选择入站`)}
      request.config_inbounds_by_server=structuredClone(bc.clientTagsByServer);
    }
    if(bc.tab==='inbounds'){
      request.config_tls_name=bc.inboundCopy?'':bc.tlsName;
      request.config_public_addrs=structuredClone(bc.publicAddrs);
      if(bc.inboundCopy){request.config_source_tag=bc.sourceTag;request.config_patch=bcCopiedFieldPatch(bc.copyOriginal,bc.form)}
    }
    request.object=bcPrepareNewObject(bc.tab,bc.form);return request;
  }
  if(!bc.ops.size&&!(bc.tab==='inbounds'&&Object.keys(bc.publicAddrs).length))throw Error('请先勾选至少一个字段');
  if(bc.tab==='settings'){
    const patch={};for(const op of bc.ops.values()){if(op.op!=='set'||op.path.length!==1)throw Error('面板设置只能修改已有选项');if(typeof op.value!=='string')throw Error('面板设置的值须为文本');patch[op.path[0]]=op.value}request.object=patch;
  }else request.config_patch=[...bc.ops.values()];
  if(bc.tab==='clients'&&bc.ops.has(bcKey(['inbounds'])))request.config_inbound_tags=bcSelectedInboundTags();
  if(bc.tab==='inbounds'&&bc.ops.has(bcKey(['tls_id'])))request.config_tls_name=bc.tlsName;
  if(bc.tab==='inbounds'&&Object.keys(bc.publicAddrs).length)request.config_public_addrs=structuredClone(bc.publicAddrs);
  return request;
}
async function bcPreview(){
  let request;try{request=bcRequest()}catch(e){bcError(e.message);return}
  const button=$('batch-config-review');button.disabled=true;bcResetPreview();
  try{const preview=await api('operations/preview',{method:'POST',body:JSON.stringify(request)});bc.preview=preview;const box=$('batch-config-preview');box.classList.remove('hidden');const ready=preview.changes.filter(c=>!c.error).length;
    box.innerHTML=`<div class="batch-config-work-head"><h3>3. 逐台预览 · ${ready} / ${preview.changes.length} 可执行</h3><span class="hint">有效期至 ${esc(date(preview.expires))}</span></div><p class="hint">执行前会逐台核对配置版本并备份数据库。请检查每台服务器的实际变化。</p>${preview.changes.map(c=>{const before=c.before,after=c.after,rows=fcChanges(before,after);return `<div class="batch-config-preview-row"><div><strong>${esc(c.server_name||'#'+c.server_id)}</strong>${status(c.error?'不可执行':'可执行',c.error?'bad':'ok')}</div>${c.error?`<p class="error">${esc(c.error)}</p>`:`<div class="full-config-diff">${rows.join('')||'<p>新建或删除整个对象</p>'}</div>`}</div>`}).join('')}<div class="batch-config-actions"><button id="batch-config-execute" class="primary" ${ready?'':'disabled'}>执行 ${ready} 台可用项</button></div>`;box.scrollIntoView({block:'start'});
  }catch(e){bcError('预览失败：'+e.message)}finally{button.disabled=false}
}
async function bcExecute(){
  if(!bc.preview)return;const count=bc.preview.changes.filter(c=>!c.error).length;if(!confirm(`确认对 ${count} 台服务器写入配置？系统会逐台备份并检查版本。`))return;
  const button=$('batch-config-execute'),box=$('batch-config-result');button.disabled=true;box.classList.remove('hidden');box.scrollIntoView({block:'start'});
  try{
    const response=await executePreview(bc.preview.id,job=>{box.innerHTML=`<h3>执行中</h3><p class="hint">${esc(jobProgressText(job))}</p>`});
    bc.preview=null;
    const succeeded=response.results.filter(r=>r.ok).length,failed=response.results.length-succeeded;
    const resultHTML=`<div class="batch-config-work-head"><h3>执行完成 · 成功 ${succeeded} · 失败 ${failed}</h3><span class="hint">结果会保留在这里，直到下一次预览或操作</span></div>${response.results.map(r=>`<div class="batch-config-preview-row"><strong>${esc(r.name||'#'+r.server_id)}</strong>${status(r.ok?'成功':'需核对',r.ok?'ok':'bad')}<p class="${r.ok?'muted':'error'}">${esc(r.message)}</p>${r.backup?`<small>备份：<a href="/api/backups/${encodeURIComponent(r.backup)}">${esc(r.backup)}</a></small>`:''}</div>`).join('')}`;
    await refresh();await bcLoad({keepResult:true});box.innerHTML=resultHTML;box.classList.remove('hidden');box.scrollIntoView({block:'start'});
  }catch(e){bcError('执行失败：'+e.message);button.disabled=false}
}
document.addEventListener('click',event=>{
  if(event.target.closest('[data-tab="batch"]')){bcServerList();if(!bc.data)bcLoad()}
  const tab=event.target.closest('[data-bc-tab]');if(tab){bc.tab=tab.dataset.bcTab;bc.mode='edit';bc.index=0;bcSelect();return}
  if(event.target.closest('#batch-config-reload')){bcLoad();return}
  if(event.target.closest('#batch-config-new')){bcNew();return}
  if(event.target.closest('#batch-config-client-shortcut')){bc.tab='clients';bcNew();return}
  const mode=event.target.closest('[data-bc-mode]');if(mode){if(mode.dataset.bcMode==='new')bcNew();else{bc.mode=mode.dataset.bcMode;bcSelect();}return}
  if(event.target.closest('#batch-config-review')){bcPreview();return}
  if(event.target.closest('#batch-config-execute')){bcExecute();return}
  const clientAll=event.target.closest('[data-bc-client-all]');if(clientAll){const id=clientAll.dataset.bcClientAll,items=(bc.inboundOptions[id]?.items||[]).filter(bcClientSupported),selected=bc.clientTagsByServer[id]||[];bc.clientTagsByServer[id]=selected.length===items.length?[]:items.map(item=>item.tag);bcSyncClientCredentials();bcResetPreview();bcRender();return}
  const secretToggle=event.target.closest('[data-bc-secret-toggle]');if(secretToggle){const input=secretToggle.parentElement.querySelector('input');input.type=input.type==='password'?'text':'password';secretToggle.textContent=input.type==='password'?'显示':'隐藏';return}
  const remove=event.target.closest('[data-bc-remove]');if(remove){const path=JSON.parse(decodeURIComponent(remove.dataset.bcRemove));bcMark(path,'remove');remove.closest('.batch-config-field').classList.add('batch-config-removed');return}
  const add=event.target.closest('[data-bc-add]');if(add){const row=add.closest('[data-bc-container]'),path=JSON.parse(decodeURIComponent(row.dataset.bcContainer)),parent=path.length?bcRead(path):bc.form,type=row.querySelector('[data-bc-type]').value,key=row.querySelector('[data-bc-key]').value.trim();if(!parent||Array.isArray(parent)){bcError('请在对象中添加字段；列表请先在单机完整配置中调整');return}if(!key||['__proto__','prototype','constructor','id'].includes(key)||Object.hasOwn(parent,key)){bcError('请输入一个新的有效字段名');return}parent[key]=bcDefault(type);if(bc.mode==='edit')bcMark([...path,key]);bcRender();const extra=[...document.querySelectorAll('[data-bc-extra-path]')].find(item=>item.dataset.bcExtraPath===row.dataset.bcContainer);if(extra)extra.open=true;return}
});
document.addEventListener('change',event=>{
  if(event.target.matches('[data-bc-server]')){const id=Number(event.target.dataset.bcServer);event.target.checked?state.selected.add(id):state.selected.delete(id);bcSelectionChanged();return}
  if(event.target.matches('[data-pick]')){bcLoad();return}
  if(event.target.id==='batch-config-object'){bc.index=Number(event.target.value);bcSelect();return}
  if(event.target.matches('[data-bc-client-server]')){const id=event.target.dataset.bcClientServer,tag=event.target.dataset.bcClientTag,selected=new Set(bc.clientTagsByServer[id]||[]);event.target.checked?selected.add(tag):selected.delete(tag);bc.clientTagsByServer[id]=[...selected];bcSyncClientCredentials();bcResetPreview();bcRender();return}
  if(event.target.matches('[data-bc-inbound-copy]')){bc.inboundCopy=event.target.dataset.bcInboundCopy==='true';if(bc.inboundCopy){const first=bcInboundList()[0];bc.sourceTag=first?.tag||'';if(first){bc.form=bcCopyInboundForm(first,bc.form.tag);bc.copyOriginal=structuredClone(bc.form)}}else{bc.sourceTag='';bc.copyOriginal=null;bc.form=bcInboundForm('vless',bc.form)}bcResetPreview();bcRender();return}
  if(event.target.id==='bc-inbound-source'){bc.sourceTag=event.target.value;const source=bcInboundList().find(item=>item.tag===bc.sourceTag);if(source){bc.form=bcCopyInboundForm(source,bc.form.tag);bc.copyOriginal=structuredClone(bc.form)}bcResetPreview();bcRender();return}
  if(event.target.id==='bc-inbound-tls'){bc.tlsName=event.target.value;bcResetPreview();return}
  if(event.target.matches('[data-bc-tls-name]')){bc.tlsName=event.target.value;bc.form.tls_id=bcTLSList().find(item=>item.name===bc.tlsName)?.id||0;bcMark(['tls_id']);return}
  if(event.target.matches('[data-bc-inbound-tag]')){const tag=event.target.dataset.bcInboundTag,selected=new Set(bcSelectedInboundTags());event.target.checked?selected.add(tag):selected.delete(tag);bc.form.inbounds=bc.mode==='new'?[...selected]:bcInboundList().filter(item=>selected.has(item.tag)).map(item=>item.id);if(bc.mode==='new')bcSyncClientCredentials();else{bcMark(['inbounds']);bcAddMissingClientCredentials()}bcResetPreview();bcRender();return}
  if(event.target.matches('[data-bc-public-update]')){const id=event.target.dataset.bcPublicUpdate;if(event.target.checked){const first=bc.form.addrs?.[0]||bc.form.out_json||{};bc.publicAddrs[id]={server:id===String(bc.source?.id)?first.server||'':'',port:id===String(bc.source?.id)?first.server_port||bc.form.listen_port:bc.form.listen_port}}else delete bc.publicAddrs[id];bcResetPreview();bcRender();return}
  if(event.target.matches('[data-bc-public-server],[data-bc-public-port]')){const id=event.target.dataset.bcPublicServer||event.target.dataset.bcPublicPort;bc.publicAddrs[id]??={server:'',port:bc.form.listen_port};if(event.target.dataset.bcPublicServer)bc.publicAddrs[id].server=event.target.value.trim();else bc.publicAddrs[id].port=Number(event.target.value);bcResetPreview();return}
  if(event.target.matches('[data-bc-volume],[data-bc-expiry]')){const path=[event.target.matches('[data-bc-volume]')?'volume':'expiry'];if(path[0]==='volume'){const amount=Number(event.target.value);if(!Number.isFinite(amount)||amount<0){bcError('流量上限不能为负数');return}bc.form.volume=Math.round(amount*bcGiB)}else bc.form.expiry=event.target.value?Math.floor(Date.parse(event.target.value+'T23:59:59Z')/1000):0;if(bc.mode==='edit')bcMark(path);else bcResetPreview();return}
  const check=event.target.closest('[data-bc-check],[data-bc-group]');if(check){const path=JSON.parse(decodeURIComponent(check.dataset.bcCheck||check.dataset.bcGroup));if(check.checked)bcMark(path);else{bc.ops.delete(bcKey(path));bcResetPreview();$('batch-config-count').textContent=bc.ops.size+' 项字段变更'}return}
  if(event.target.matches('[data-bc-value]')){const path=JSON.parse(decodeURIComponent(event.target.dataset.bcValue)),old=bcRead(path);if(event.target.type==='number'&&event.target.value===''){bcError('数字字段不能留空');return}const value=typeof old==='number'?Number(event.target.value):typeof old==='boolean'?event.target.value==='true':event.target.value;if(bc.mode==='new'&&bc.tab==='outbounds'&&path.length===1&&path[0]==='type'){bc.form=bcOutboundForm(value,bc.form);bcResetPreview();bcRender();return}if(bc.mode==='new'&&bc.tab==='inbounds'&&path.length===1&&path[0]==='type'){bc.form=bcInboundForm(value,bc.form);bc.tlsName='none';bcResetPreview();bcRender();return}bcParent(path)[path.at(-1)]=value;if(bc.mode==='new'&&bc.tab==='clients'&&path[0]==='autoReset'){bcResetPreview();bcRender();return}if(bc.mode==='edit'){bcMark(path);const checkbox=event.target.closest('.batch-config-field')?.querySelector('[data-bc-check]');if(checkbox)checkbox.checked=true}return}
});
document.addEventListener('input',event=>{
  if(event.target.matches('[data-bc-public-server],[data-bc-public-port]')){const id=event.target.dataset.bcPublicServer||event.target.dataset.bcPublicPort;bc.publicAddrs[id]??={server:'',port:bc.form.listen_port};if(event.target.dataset.bcPublicServer)bc.publicAddrs[id].server=event.target.value.trim();else bc.publicAddrs[id].port=Number(event.target.value);bcResetPreview();return}
  if(event.target.matches('[data-bc-volume],[data-bc-expiry]')){const key=event.target.matches('[data-bc-volume]')?'volume':'expiry',value=key==='volume'?Math.round(Number(event.target.value)*bcGiB):event.target.value?Math.floor(Date.parse(event.target.value+'T23:59:59Z')/1000):0;if(!Number.isFinite(value))return;bc.form[key]=value;if(bc.mode==='edit')bcMark([key]);else bcResetPreview();return}
  if(!event.target.matches('[data-bc-value]')||event.target.tagName==='SELECT')return;const path=JSON.parse(decodeURIComponent(event.target.dataset.bcValue)),old=bcRead(path);if(event.target.type==='number'&&event.target.value==='')return;bcParent(path)[path.at(-1)]=typeof old==='number'?Number(event.target.value):event.target.value;if(bc.mode==='edit'){bcMark(path);const checkbox=event.target.closest('.batch-config-field')?.querySelector('[data-bc-check]');if(checkbox)checkbox.checked=true}
});
