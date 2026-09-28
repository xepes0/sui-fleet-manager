const fc = {id:null, server:null, data:null, errors:{}, tab:'inbounds', index:0, mode:'edit', form:null, original:null, preview:null, request:null, version:0};
const fcTabs = [['clients','用户'],['inbounds','入站'],['outbounds','出站'],['endpoints','端点'],['services','服务'],['tls','TLS'],['config','核心'],['settings','面板设置']];
const fcTypes = [['string','文本'],['number','数字'],['boolean','开关'],['object','对象'],['array','列表'],['null','空值']];
const fcNames = {name:'名称',tag:'Tag',type:'类型',username:'用户名',password:'密码',uuid:'UUID',version:'协议版本',network:'网络类型',udp_over_tcp:'UDP over TCP',detour:'经由出站 Tag（可选）',server_name:'TLS 服务器名 SNI（可选）',method:'加密方式',enable:'启用',remark:'显示名称',desc:'备注',group:'分组',config:'协议凭据 / 配置',inbounds:'可用入站',links:'额外链接',volume:'流量上限（字节）',expiry:'到期时间（Unix 秒）',delayStart:'首次使用时开始计时',autoReset:'自动重置',resetDays:'重置周期（天）',listen:'监听地址',listen_port:'监听端口',server:'服务器 / TLS 服务端',server_port:'服务器端口',tls_id:'TLS 证书 ID',addrs:'公开地址列表',out_json:'订阅出站模板',client:'TLS 客户端',route:'路由',dns:'DNS',log:'日志',experimental:'实验功能',webListen:'面板监听地址',webPort:'面板端口',webPath:'面板路径',webDomain:'面板域名限制',webCertFile:'面板证书文件',webKeyFile:'面板私钥文件',webURI:'面板公开地址',sessionMaxAge:'会话时长（分钟）',subListen:'订阅监听地址',subPort:'订阅端口',subPath:'订阅路径',subDomain:'订阅域名限制',subCertFile:'订阅证书文件',subKeyFile:'订阅私钥文件',subURI:'订阅公开地址',subUpdates:'订阅更新间隔（小时）',subEncode:'纯链接 Base64 编码',subShowInfo:'节点名称显示流量与天数',subJsonExt:'JSON 订阅模板',subClashExt:'Clash 订阅模板',subClashNoDefGrp:'不添加默认分组',subClashSprtAll:'展开 all 为所有节点',subClashUdp:'Clash 节点支持 UDP',trafficAge:'统计保留天数',statsBucketSeconds:'统计桶秒数',globalReset:'全局重置计划',timeLocation:'时区'};
const fcSettingGroups = [['面板访问',['webListen','webPort','webPath','webDomain','webCertFile','webKeyFile','webURI','sessionMaxAge']],['订阅服务',['subListen','subPort','subPath','subDomain','subCertFile','subKeyFile','subURI','subUpdates','subEncode','subShowInfo']],['订阅模板',['subJsonExt','subClashExt','subClashNoDefGrp','subClashSprtAll','subClashUdp']],['流量与统计',['trafficAge','statsBucketSeconds','globalReset']],['其他',['timeLocation','secret','config','version','globalResetLast','maintenance']]];
const fcManaged = new Set(['config','version','globalResetLast','maintenance']);
const fcSettingBools = new Set(['subEncode','subShowInfo','subClashNoDefGrp','subClashSprtAll','subClashUdp']);
const fcSecret = key => /password|secret|private.?key(?!_path)|token|psk|userkey|(^|_)key$/i.test(key);
const fcPath = path => esc(encodeURIComponent(JSON.stringify(path)));
const fcParsePath = node => JSON.parse(decodeURIComponent(node.dataset.fcPath));
const fcKind = value => value===null?'null':Array.isArray(value)?'array':typeof value;
const fcItems = () => Array.isArray(fc.data?.[fc.tab])?fc.data[fc.tab]:[];
const fcItemLabel = item => item?.tag||item?.name||`#${item?.id||'?'}`;
function fcReset(){fc.version++;fc.preview=null;fc.request=null;$('full-config-preview')?.remove()}
async function openFullConfig(serverID, tab='inbounds'){
  const server=state.servers.find(x=>x.id===+serverID);if(!server)return;
  if($('single-editor-dialog').open)$('single-editor-dialog').close();
  if($('detail-dialog').open)$('detail-dialog').close();
  fc.id=server.id;fc.server=server;fc.tab=fcTabs.some(x=>x[0]===tab)?tab:'inbounds';fc.index=0;fc.mode='edit';fc.data=null;fcReset();
  $('full-config-title').textContent=server.name;$('full-config-workspace').innerHTML='<p class="muted">正在读取 S-UI 的八类配置…</p>';
  if(!$('full-config-dialog').open)$('full-config-dialog').showModal();
  try{const result=await api(`servers/${server.id}/configuration`);if(fc.id!==server.id||!$('full-config-dialog').open)return;fc.data=result;fc.errors=result.errors||{};fcSelectTab(fc.tab)}catch(e){$('full-config-workspace').innerHTML=`<p class="error">读取配置失败：${esc(e.message)}</p>`}
}
function fcSelectTab(tab){fc.tab=tab;fc.index=0;fc.mode='edit';fcSelectObject()}
function fcSelectObject(){
  fcReset();const singleton=fc.tab==='config'||fc.tab==='settings',source=singleton?fc.data?.[fc.tab]:fcItems()[fc.index];
  fc.original=source==null?null:structuredClone(source);fc.form=source==null?null:structuredClone(source);
  fcRender();
}
function fcNew(){
  fcReset();fc.mode='new';fc.original=null;
  fc.form=fc.tab==='clients'?{enable:true,name:'',remark:'',config:{},inbounds:[],volume:0,expiry:0}:fc.tab==='tls'?{name:'',server:{enabled:true},client:{enabled:true}}:fc.tab==='inbounds'?{type:'vless',tag:'',listen:'::',listen_port:443,tls_id:0,addrs:[],out_json:{}}:fc.tab==='outbounds'?{type:'socks',tag:'',server:'',server_port:1080}:fc.tab==='endpoints'?{type:'wireguard',tag:''}:{type:'derp',tag:'',tls_id:0};
  fcRender();
}
function fcRender(){
  $('full-config-tabs').innerHTML=fcTabs.map(([key,label])=>`<button data-fc-tab="${key}" class="${fc.tab===key?'active':''}" aria-selected="${key===fc.tab}">${label}<span>${Array.isArray(fc.data?.[key])?fc.data[key].length:''}</span></button>`).join('');
  const singleton=fc.tab==='config'||fc.tab==='settings';
  $('full-config-list-title').textContent=fcTabs.find(x=>x[0]===fc.tab)?.[1]||'';
  $('full-config-new').classList.toggle('hidden',singleton);
  $('full-config-list').innerHTML=singleton?`<p class="full-config-side-note">${fc.tab==='config'?'日志、DNS、路由、实验功能等 sing-box 核心选项。':'面板访问、订阅服务、模板与统计设置。'}</p>`:fcItems().map((item,index)=>`<button data-fc-index="${index}" class="full-config-item ${fc.mode==='edit'&&index===fc.index?'active':''}"><b>${esc(fcItemLabel(item))}</b><small>${esc(item.type||item.remark||'#'+item.id)}</small></button>`).join('')||'<p class="full-config-side-note">暂无对象。可点击新增。</p>';
  fcRenderWorkspace();
}
function fcRenderWorkspace(){
  const box=$('full-config-workspace'),scroll=box.scrollTop;
  if(fc.errors[fc.tab]){box.innerHTML=`<p class="error">S-UI ${esc(fc.tab)} 读取失败：${esc(fc.errors[fc.tab])}</p>`;return}
  if(!fc.form){box.innerHTML='<p class="muted">暂无可编辑配置。点击左侧新增。</p>';return}
  const singleton=fc.tab==='config'||fc.tab==='settings',title=fc.mode==='new'?'新增'+(fcTabs.find(x=>x[0]===fc.tab)?.[1]||'对象'):singleton?(fc.tab==='config'?'核心配置':'面板设置'):fcItemLabel(fc.form);
  box.innerHTML=`<div class="full-config-work-head"><div><div class="eyebrow">${esc(fc.tab.toUpperCase())} · ${fc.mode==='new'?'新增':'编辑'}</div><h3>${esc(title)}</h3><p>点击字段可修改；对象和列表可展开、添加或删除子项。</p></div>${!singleton&&fc.mode==='edit'?'<button id="full-config-delete" class="danger">删除对象</button>':''}</div>${fc.tab==='settings'?'<p class="full-config-warning">更改面板端口、路径、域名或证书后，控制台可能需要更新面板关联地址。更改统计保留天数为 0 会清除历史统计。</p>':''}<div id="full-config-tree">${fc.tab==='settings'?fcRenderSettings():fcChildren(fc.form,[],0)}</div><div class="full-config-submit"><button id="full-config-review" class="primary">生成变更预览</button></div>`;
  box.scrollTop=scroll;fcReset();
}
function fcRenderSettings(){
  const used=new Set(),groups=fcSettingGroups.map(([name,keys])=>{const fields=keys.filter(key=>key in fc.form);fields.forEach(key=>used.add(key));return fields.length?`<section class="full-config-group"><h4>${esc(name)}</h4>${fields.map(key=>fcNode(key,fc.form[key],[key],0)).join('')}</section>`:''}).join('');
  const remaining=Object.keys(fc.form).filter(key=>!used.has(key));
  return groups+(remaining.length?`<section class="full-config-group"><h4>其他设置</h4>${remaining.map(key=>fcNode(key,fc.form[key],[key],0)).join('')}</section>`:'');
}
function fcChildren(value,path,depth){
  if(depth>12)return '<p class="hint">嵌套超过 12 层，暂不展开。</p>';
  const items=Array.isArray(value)?value.map((entry,index)=>fcNode(String(index),entry,[...path,index],depth)):Object.entries(value).map(([key,entry])=>fcNode(key,entry,[...path,key],depth));
  return `${items.join('')}<div class="full-config-add" data-fc-add-row data-fc-path="${fcPath(path)}">${Array.isArray(value)?'<span>添加列表项</span>':'<input data-fc-new-key placeholder="新字段名" aria-label="新字段名">'}<select data-fc-new-type aria-label="新字段类型">${fcTypes.map(([key,label])=>`<option value="${key}">${label}</option>`).join('')}</select><button data-fc-add class="secondary">＋ 添加</button></div>`;
}
function fcNode(key,value,path,depth){
  const kind=fcKind(value),encoded=fcPath(path),root=path.length===1,managed=fc.tab==='settings'&&root&&fcManaged.has(key),locked=key==='id',label=fcNames[key]||key;
  const meta=`<div class="full-config-field-head"><div><strong>${esc(label)}</strong>${label!==key?`<code>${esc(key)}</code>`:''}</div><div class="full-config-field-actions">${locked||managed?'<span class="full-config-locked">只读</span>':fc.tab==='settings'?'':`<select data-fc-type data-fc-path="${encoded}" aria-label="${esc(key)} 类型">${fcTypes.map(([name,text])=>`<option value="${name}" ${kind===name?'selected':''}>${text}</option>`).join('')}</select><button data-fc-remove data-fc-path="${encoded}" class="text-button" aria-label="删除 ${esc(key)}">✕</button>`}${typeof path[path.length-1]==='number'?`<button data-fc-move="-1" data-fc-path="${encoded}" class="text-button" aria-label="上移">↑</button><button data-fc-move="1" data-fc-path="${encoded}" class="text-button" aria-label="下移">↓</button>`:''}</div></div>`;
  let editor='';
  if(managed||locked)editor=`<div class="full-config-readonly">${esc(fcDisplay(value,key))}</div>`;
  else if(kind==='object'||kind==='array')editor=`<details class="full-config-nested" ${depth<1?'open':''}><summary>${kind==='array'?'列表':'对象'} · ${Object.keys(value).length} 项</summary><div>${fcChildren(value,path,depth+1)}</div></details>`;
  else if(fc.tab==='settings'&&root&&fcSettingBools.has(key))editor=`<select data-fc-value data-fc-path="${encoded}" aria-label="${esc(label)}"><option value="true" ${value==='true'?'selected':''}>启用</option><option value="false" ${value==='false'?'selected':''}>关闭</option></select>`;
  else if(kind==='string'){
    if(fcSecret(key)){const previous=path.reduce((item,segment)=>item?.[segment],fc.original);editor=`<input data-fc-value data-fc-path="${encoded}" type="password" value="" placeholder="${value?'已设置，留空保留原值':'输入新值'}" autocomplete="new-password" aria-label="${esc(label)}">${previous!==undefined&&previous!==value?'<small class="full-config-secret-changed">已填写新值</small>':''}`;}
    else if(value.length>120||value.includes('\n')||key.endsWith('Ext'))editor=`<textarea data-fc-value data-fc-path="${encoded}" rows="5" aria-label="${esc(label)}">${esc(value)}</textarea>`;
    else editor=`<input data-fc-value data-fc-path="${encoded}" value="${esc(value)}" aria-label="${esc(label)}">`;
  }else if(kind==='number')editor=`<input data-fc-value data-fc-path="${encoded}" type="number" step="any" value="${esc(value)}" aria-label="${esc(label)}">`;
  else if(kind==='boolean')editor=`<label class="full-config-toggle"><input data-fc-value data-fc-path="${encoded}" type="checkbox" ${value?'checked':''}> ${value?'启用':'关闭'}</label>`;
  else editor='<p class="muted">空值。可从右侧选择新类型。</p>';
  return `<div class="full-config-field" data-fc-node="${encoded}">${meta}<div class="full-config-field-body">${editor}</div></div>`;
}
function fcDisplay(value,key){if(fcSecret(key))return '••••••';if(value===null)return 'null';if(typeof value==='object')return Array.isArray(value)?`列表（${value.length} 项）`:`对象（${Object.keys(value).length} 项）`;return String(value)}
function fcRead(path){return path.reduce((value,key)=>value[key],fc.form)}
function fcWrite(path,value){const parent=path.slice(0,-1).reduce((item,key)=>item[key],fc.form);parent[path.at(-1)]=value}
function fcRemove(path){const parent=path.slice(0,-1).reduce((item,key)=>item[key],fc.form);if(Array.isArray(parent))parent.splice(path.at(-1),1);else delete parent[path.at(-1)]}
function fcDefault(type){return type==='string'?'':type==='number'?0:type==='boolean'?false:type==='object'?{}:type==='array'?[]:null}
function fcMessage(message,bad=false){let box=$('full-config-message');if(!box){box=document.createElement('p');box.id='full-config-message';$('full-config-workspace').prepend(box)}box.className='full-config-message '+(bad?'error':'success');box.textContent=message;box.scrollIntoView({block:'nearest'})}
function fcRequest(mode=fc.mode){
  if([...document.querySelectorAll('#full-config-workspace [data-fc-value][type="number"]')].some(input=>input.value===''))throw Error('数字字段不能留空；可删除字段或改为空值类型');
  const request={server_ids:[fc.id],action:'config_save',config_target:fc.tab,config_mode:fc.tab==='config'||fc.tab==='settings'?'set':mode};
  if(mode==='edit'||mode==='del')request.config_identity=String(fc.original?.id??'');
  if(mode==='del')return request;
  if(fc.tab==='settings'){
    const patch={};for(const [key,value] of Object.entries(fc.form)){if(value!==fc.original[key])patch[key]=value}
    if(!Object.keys(patch).length)throw Error('没有发现设置变化');request.object=patch;
  }else request.object=fc.form;
  return request;
}
function fcRedact(value,key=''){if(fcSecret(key))return '••••••';if(Array.isArray(value))return value.map(x=>fcRedact(x));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,fcRedact(v,k)]));return value}
function fcChanges(before,after,path=[],rows=[]){
  if(rows.length>=80||JSON.stringify(before)===JSON.stringify(after))return rows;
  if(before&&after&&typeof before==='object'&&typeof after==='object'&&Array.isArray(before)===Array.isArray(after)){
    const keys=new Set([...Object.keys(before),...Object.keys(after)]);for(const key of keys)fcChanges(before[key],after[key],[...path,key],rows);return rows;
  }
  const key=String(path.at(-1)||''),format=value=>value===undefined?'—':esc(typeof value==='object'?JSON.stringify(fcRedact(value,key)):String(fcRedact(value,key)));
  rows.push(`<div class="full-config-diff-row"><code>${esc(path.join(' / ')||'整个对象')}</code><span>${format(before)}</span><b>→</b><span>${format(after)}</span></div>`);return rows;
}
async function fcPreviewRequest(request){
  fcReset();const version=fc.version,id=fc.id,button=$('full-config-review');if(button)button.disabled=true;
  try{const preview=await api('operations/preview',{method:'POST',body:JSON.stringify(request)});if(version!==fc.version||id!==fc.id||!$('full-config-dialog').open)return;fc.preview=preview;fc.request=request;const change=preview.changes?.[0];if(!change)throw Error('服务器没有返回预览结果');const before=typeof change.before==='string'?JSON.parse(change.before):change.before,after=typeof change.after==='string'?JSON.parse(change.after):change.after;const box=document.createElement('div');box.id='full-config-preview';box.className='full-config-preview';const rows=fcChanges(before,after);box.innerHTML=`<div class="full-config-preview-head"><strong>变更预览 · ${esc(fc.tab)}</strong>${status(change.error?'不可执行':'可执行',change.error?'bad':'ok')}</div>${change.error?`<p class="error">${esc(change.error)}</p>`:`<p class="hint">写入前会备份 S-UI 数据库，并检查预览时的对象版本。有效期至 ${esc(date(preview.expires))}。</p><div class="full-config-diff">${rows.join('')||'<p>对象状态变化</p>'}</div><button id="full-config-execute" class="primary">确认执行</button>`}`;$('full-config-workspace').appendChild(box);box.scrollIntoView({block:'nearest'});
  }catch(e){if(version===fc.version&&id===fc.id)fcMessage('预览失败：'+e.message,true)}finally{if(button)button.disabled=false}
}
async function fcExecute(){
  if(!fc.preview)return;const button=$('full-config-execute');button.disabled=true;
  try{const response=await api('operations/execute',{method:'POST',body:JSON.stringify({preview_id:fc.preview.id})}),result=response.results?.[0];if(!result?.ok)throw Error(result?.message||'执行失败');const selected=fc.form?.tag||fc.form?.name;fc.data=await api(`servers/${fc.id}/configuration`);fc.errors=fc.data.errors||{};fc.mode='edit';const items=fcItems();fc.index=Math.max(0,items.findIndex(x=>(x.tag||x.name)===selected));fcSelectObject();fcMessage(`已保存并重新读取 S-UI。${result.backup?'备份：'+result.backup:''}`);await refresh();
  }catch(e){fcMessage('执行结果需要核对：'+e.message,true);button.disabled=false}
}
$('open-full-config').onclick=()=>openFullConfig(cfg.id,cfg.tab==='routes'?'config':cfg.tab==='maintenance'?'settings':cfg.tab);
$('close-full-config').onclick=()=>$('full-config-dialog').close();
$('full-config-dialog').addEventListener('close',()=>{fc.id=null;fcReset()});
$('full-config-dialog').addEventListener('click',event=>{
  const tab=event.target.closest('[data-fc-tab]');if(tab){fcSelectTab(tab.dataset.fcTab);return}
  const item=event.target.closest('[data-fc-index]');if(item){fc.index=Number(item.dataset.fcIndex);fc.mode='edit';fcSelectObject();return}
  if(event.target.closest('#full-config-new')){fcNew();return}
  if(event.target.closest('#full-config-review')){try{fcPreviewRequest(fcRequest())}catch(e){fcMessage(e.message,true)}return}
  if(event.target.closest('#full-config-delete')){if(confirm(`预览删除 ${fcItemLabel(fc.form)}？`)){fcPreviewRequest(fcRequest('del'))}return}
  if(event.target.closest('#full-config-execute')){fcExecute();return}
  const add=event.target.closest('[data-fc-add]');if(add){const row=add.closest('[data-fc-add-row]'),path=fcParsePath(row),parent=path.length?fcRead(path):fc.form,type=row.querySelector('[data-fc-new-type]').value;if(Array.isArray(parent))parent.push(fcDefault(type));else{const key=row.querySelector('[data-fc-new-key]').value.trim();if(!key||['__proto__','prototype','constructor'].includes(key)){fcMessage('请输入有效的字段名',true);return}if(Object.hasOwn(parent,key)){fcMessage('这个字段已存在',true);return}parent[key]=fcDefault(type)}fcRenderWorkspace();return}
  const remove=event.target.closest('[data-fc-remove]');if(remove){fcRemove(fcParsePath(remove));fcRenderWorkspace();return}
  const move=event.target.closest('[data-fc-move]');if(move){const path=fcParsePath(move),index=path.at(-1),parent=path.slice(0,-1).reduce((v,key)=>v[key],fc.form),other=index+Number(move.dataset.fcMove);if(other>=0&&other<parent.length){[parent[index],parent[other]]=[parent[other],parent[index]];fcRenderWorkspace()}return}
});
$('full-config-dialog').addEventListener('change',event=>{
  if(event.target.matches('[data-fc-type]')){fcWrite(fcParsePath(event.target),fcDefault(event.target.value));fcRenderWorkspace();return}
  if(event.target.matches('[data-fc-value]')){const path=fcParsePath(event.target),old=fcRead(path);fcWrite(path,typeof old==='boolean'?event.target.checked:typeof old==='number'?Number(event.target.value):event.target.value);fcReset()}
});
$('full-config-dialog').addEventListener('input',event=>{if(event.target.matches('[data-fc-value]')){const path=fcParsePath(event.target),old=fcRead(path);if(event.target.type==='password'&&!event.target.value){const original=path.reduce((value,key)=>value?.[key],fc.original);fcWrite(path,original??'');fcReset();return}if(event.target.type==='number'&&!event.target.value){fcReset();return}fcWrite(path,typeof old==='number'?Number(event.target.value):event.target.value);fcReset()}});
