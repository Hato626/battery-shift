export const SCHEMA_VERSION = 1;
export const STATUS = {ready:'充满待用',in_use:'使用中',empty:'待充电',charging:'充电中',retired:'已退役'};
export const FORMATS = ['AA','AAA','18650','9V','其他'];
export const CHEMISTRIES = ['NiMH','Li-ion','LiFePO4','其他'];
const fail = (s) => { throw new Error(s); };
const uid = () => globalThis.crypto.randomUUID();
const text = (v, name, max=200, empty=false) => {
  if(typeof v !== 'string' || (!empty && !v.trim()) || v.length>max) fail(`${name}格式不正确`);
  if(name.endsWith('编号') && !/^[a-zA-Z0-9_-]+$/.test(v)) fail(`${name}只能使用字母、数字、下划线与连字符`);
};
function validateCore(s) {
  if(!Array.isArray(s.groups) || !Array.isArray(s.devices) || s.groups.length>2000 || s.devices.length>2000) fail('电池组或设备列表无效');
  const ids = new Set(), cells = new Set(), installed = new Set(), slots = new Set();
  for(const g of s.groups){
    text(g.id,'组编号',100); if(ids.has(g.id)) fail('电池组编号重复'); ids.add(g.id);
    text(g.name,'组名称',80); text(g.location,'存放位置',120,true); text(g.notes,'备注',1000,true);
    if(!FORMATS.includes(g.format)||!CHEMISTRIES.includes(g.chemistry)||!Object.hasOwn(STATUS,g.status)) fail('电池组类型或状态无效');
    if(!Array.isArray(g.cells)||g.cells.length<1||g.cells.length>24) fail('每组需要 1 至 24 节电池');
    for(const c of g.cells){text(c.id,'单体编号',100);text(c.label,'电池标签',80);if(cells.has(c.id)) fail('同一电池不能属于多个组');cells.add(c.id);}
    for(const k of ['chargeCount','useCount']) if(!Number.isSafeInteger(g[k])||g[k]<0) fail('轮换次数无效');
    for(const k of ['lastUsedAt','lastChargedAt']) if(g[k]!==null && (typeof g[k]!=='string'||!Number.isFinite(Date.parse(g[k])))) fail('电池日期无效');
  }
  const deviceIds = new Set();
  for(const d of s.devices){
    text(d.id,'设备编号',100);if(deviceIds.has(d.id)) fail('设备编号重复');deviceIds.add(d.id);
    text(d.name,'设备名称',80);text(d.location,'设备位置',120,true);
    if(!Array.isArray(d.slots)||d.slots.length<1||d.slots.length>20) fail('每个设备需要 1 至 20 个槽位');
    for(const slot of d.slots){
      text(slot.id,'槽位编号',100);if(slots.has(slot.id))fail('槽位编号重复');slots.add(slot.id);
      text(slot.name,'槽位名称',80);
      if(!Number.isInteger(slot.count)||slot.count<1||slot.count>24||!FORMATS.includes(slot.format)||!['不限',...CHEMISTRIES].includes(slot.chemistry)) fail('槽位规格无效');
      if(slot.groupId!==null){
        const g=s.groups.find(g=>g.id===slot.groupId);
        if(!g)fail('设备引用了不存在的电池组');
        if(installed.has(g.id))fail('一组电池不能同时安装到多个槽位');installed.add(g.id);
        if(g.status!=='in_use'||!compatible(g,slot))fail('已安装电池组的状态或规格不一致');
      }
    }
  }
  for(const g of s.groups) if((g.status==='in_use')!==installed.has(g.id))fail('使用中状态必须对应一个设备槽位');
}
export function validateState(s){
  if(!s || typeof s!=='object'||s.schemaVersion!==SCHEMA_VERSION)fail('不支持此备份版本；需要 schemaVersion = 1');
  if(!Number.isSafeInteger(s.revision)||s.revision<0) fail('修订号无效');
  for(const key of ['createdAt','updatedAt']) if(typeof s[key]!=='string'||!Number.isFinite(Date.parse(s[key]))) fail('台账日期无效');
  validateCore(s);
  if(!Array.isArray(s.history)||s.history.length>500||!Array.isArray(s.undo)||s.undo.length>10)fail('历史记录格式无效');
  for(const h of s.history){text(h.id,'记录编号',100);text(h.type,'记录类型',80);text(h.summary,'记录内容',1000);if(typeof h.at!=='string'||!Number.isFinite(Date.parse(h.at)))fail('记录时间无效');}
  for(const u of s.undo){text(u.summary,'撤销说明',1000);validateCore(u);}
  return true;
}
export function emptyState(now=new Date().toISOString()){
  return {schemaVersion:1,revision:0,createdAt:now,updatedAt:now,groups:[],devices:[],history:[],undo:[]};
}
export function compatible(g,slot){return g.format===slot.format && g.cells.length===slot.count && (slot.chemistry==='不限'||g.chemistry===slot.chemistry);}
export function recommended(s,slot){return s.groups.filter(g=>g.status==='ready'&&compatible(g,slot)).sort((a,b)=>(a.lastUsedAt||'').localeCompare(b.lastUsedAt||'') || a.useCount-b.useCount || a.name.localeCompare(b.name));}
export function installedAt(s,id){for(const d of s.devices)for(const slot of d.slots)if(slot.groupId===id)return {device:d,slot};return null;}
export function transition(original,a,now=new Date().toISOString()){
  validateState(original); const s=structuredClone(original); let summary='';
  const group=()=>s.groups.find(g=>g.id===a.id)||fail('找不到电池组');
  const snapshot={groups:structuredClone(s.groups),devices:structuredClone(s.devices)};
  if(a.type==='addGroup'){
    const p=a.group;
    s.groups.push({id:uid(),name:p.name.trim(),format:p.format,chemistry:p.chemistry,cells:p.labels.map(label=>({id:uid(),label:label.trim()})),location:p.location.trim(),notes:(p.notes||'').trim(),status:p.status||'ready',chargeCount:0,useCount:0,lastUsedAt:null,lastChargedAt:null});
    if(!['ready','empty','charging'].includes(p.status||'ready'))fail('新建组状态无效');
    summary=`新建电池组「${p.name.trim()}」`;
  }else if(a.type==='editGroup'){
    const g=group(),p=a.group;
    if(g.status==='in_use' && (p.format!==g.format||p.chemistry!==g.chemistry||p.labels.length!==g.cells.length))fail('请先取出电池组再更改规格或数量');
    if(g.status==='charging' && p.labels.length!==g.cells.length)fail('充电过程中不能更改组成员数量');
    Object.assign(g,{name:p.name.trim(),format:p.format,chemistry:p.chemistry,location:p.location.trim(),notes:(p.notes||'').trim(),cells:p.labels.map((label,i)=>({id:g.cells[i]?.id||uid(),label:label.trim()}))});summary=`修正电池组「${g.name}」资料`;
  }else if(a.type==='status'){
    const g=group(),next=a.status;
    if(g.status==='in_use')fail('请通过设备换班先取出电池组');
    const allowed={ready:['charging','empty','retired'],empty:['charging','ready','retired'],charging:['ready','empty','retired'],retired:['empty']};
    if(!allowed[g.status]?.includes(next))fail('不允许的状态变更');
    const old=g.status; g.status=next;
    if(old==='charging'&&next==='ready'){g.chargeCount++;g.lastChargedAt=now;}
    summary=`「${g.name}」：${STATUS[old]} → ${STATUS[next]}`;
  }else if(a.type==='addDevice'||a.type==='editDevice'){
    const p=a.device; const existing=s.devices.find(d=>d.id===a.id);
    if(a.type==='editDevice'&&!existing)fail('找不到设备');
    const next={id:existing?.id||uid(),name:p.name.trim(),location:p.location.trim(),slots:p.slots.map((v,i)=>({id:existing?.slots[i]?.id||uid(),name:v.name.trim(),format:v.format,chemistry:v.chemistry,count:Number(v.count),groupId:existing?.slots[i]?.groupId||null}))};
    if(existing?.slots.slice(next.slots.length).some(x=>x.groupId))fail('移除槽位前请先取出电池');
    if(existing)s.devices[s.devices.indexOf(existing)]=next;else s.devices.push(next);
    summary=`${existing?'修正':'新建'}设备「${next.name}」`;
  }else if(a.type==='deleteDevice'){
    const d=s.devices.find(d=>d.id===a.id)||fail('找不到设备');
    if(d.slots.some(v=>v.groupId))fail('删除设备前请先取出所有电池组');
    s.devices=s.devices.filter(v=>v.id!==d.id);summary=`删除空设备「${d.name}」`;
  }else if(a.type==='exchange'){
    const d=s.devices.find(d=>d.id===a.deviceId)||fail('找不到设备');const slot=d.slots.find(v=>v.id===a.slotId)||fail('找不到槽位');
    const incoming=a.incomingGroupId?s.groups.find(g=>g.id===a.incomingGroupId):null;
    if(a.incomingGroupId&&!incoming)fail('找不到新电池组');
    if(!slot.groupId&&!incoming)fail('空槽位没有需要取出的电池');
    if(incoming && (incoming.status!=='ready'||!compatible(incoming,slot)))fail('新组必须充满待用且规格、数量匹配');
    if(!['ready','empty'].includes(a.outgoingStatus))fail('旧组状态无效');
    const outgoing=s.groups.find(g=>g.id===slot.groupId);
    if(outgoing)outgoing.status=a.outgoingStatus;
    if(incoming){incoming.status='in_use';incoming.useCount++;incoming.lastUsedAt=now;}
    slot.groupId=incoming?.id||null;
    summary=`${d.name} / ${slot.name}：${outgoing?`取出「${outgoing.name}」（${STATUS[a.outgoingStatus]}）`:'空槽'}；${incoming?`装入「${incoming.name}」`:'保持空槽'}`;
  }else if(a.type==='undo'){
    const prior=s.undo.pop(); if(!prior)fail('没有可撤销的操作');s.groups=prior.groups;s.devices=prior.devices;summary=`撤销：${prior.summary}`;
  }else if(a.type==='import'){
    validateState(a.state);s.groups=structuredClone(a.state.groups);s.devices=structuredClone(a.state.devices);s.history=structuredClone(a.state.history);s.undo=[];summary=`恢复备份（${s.groups.length} 组电池，${s.devices.length} 个设备）`;
  }else fail('未知操作');
  if(!['undo','import'].includes(a.type)){s.undo.push({...snapshot,summary});s.undo=s.undo.slice(-10);}
  if(a.type==='import')s.undo=[{...snapshot,summary:'恢复备份'}];
  s.updatedAt=now;s.revision++;s.history.unshift({id:uid(),type:a.type,summary,at:now});s.history=s.history.slice(0,500);validateState(s);return s;
}
export function parseBackup(input){
  if(typeof input!=='string'||input.length>8*1024*1024)fail('备份过大或内容无效');
  let result;try{result=JSON.parse(input);}catch{fail('不是有效的 JSON 备份');} validateState(result);return result;
}
export function demoState(now=new Date().toISOString()){
  let s=emptyState(now);
  for(const [name,status] of [['蓝组','ready'],['绿组','empty'],['橙组','ready']])s=transition(s,{type:'addGroup',group:{name,format:'AA',chemistry:'NiMH',labels:[name+'-1',name+'-2'],location:'书桌抽屉',notes:'示例：给实物贴上同名标签',status}},now);
  s=transition(s,{type:'addDevice',device:{name:'无线鼠标',location:'书桌',slots:[{name:'主槽',format:'AA',chemistry:'NiMH',count:2}]}},now);
  s=transition(s,{type:'exchange',deviceId:s.devices[0].id,slotId:s.devices[0].slots[0].id,incomingGroupId:s.groups[0].id,outgoingStatus:'empty'},now);
  return s;
}
