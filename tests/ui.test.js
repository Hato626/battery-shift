import {chromium} from 'playwright';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,copyFile,cp} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const work=path.join(root,'work');await mkdir(work,{recursive:true});
const run=await mkdtemp(path.join(work,'验收 带空格-'));
await cp(path.join(root,'app'),path.join(run,'app'),{recursive:true});
await copyFile(path.join(root,'server.ps1'),path.join(run,'server.ps1'));
await copyFile(path.join(root,'start.cmd'),path.join(run,'start.cmd'));
const data=path.join(run,'data'),artifacts=path.join(work,'artifacts');await mkdir(artifacts,{recursive:true});
const port=Number(process.env.TEST_PORT||8977),url=`http://127.0.0.1:${port}`;
let server,browser,log='';
async function start(){server=spawn('cmd.exe',['/d','/c','start.cmd','-Port',String(port),'-DataDir',data,'-NoBrowser'],{cwd:run,windowsHide:true});server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);for(let i=0;i<80;i++){try{const r=await fetch(url+'/api/state');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,150));}throw Error('Server failed: '+log);}
async function stop(){if(server&&server.exitCode===null){await new Promise(resolve=>{const killer=spawn('taskkill.exe',['/PID',String(server.pid),'/T','/F'],{windowsHide:true});killer.once('exit',resolve);});}}
const readState=async()=>(await fetch(url+'/api/state')).json();
let checks=0;
function check(value,message){assert.ok(value,message);checks++;console.log('PASS '+message);}
try{
  await start();
  const launch={headless:true};if(process.env.BROWSER_CHANNEL!=='chromium')launch.channel=process.env.BROWSER_CHANNEL||'msedge';
  browser=await chromium.launch(launch);const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.getByRole('button',{name:'体验示例台账'}).waitFor();
  check((await readState()).groups.length===0,'clean first launch');
  await page.getByRole('button',{name:'体验示例台账'}).click();await page.getByRole('heading',{name:'无线鼠标'}).waitFor();
  let state=await readState();check(state.groups.length===3&&state.devices[0].slots[0].groupId===state.groups[0].id,'demo contains real linked records');
  await page.getByRole('button',{name:'换班 / 取出',exact:true}).click();await page.locator('select[name="incoming"]').selectOption(state.groups[2].id);await page.getByRole('button',{name:'确认换班',exact:true}).click();await page.locator('#editor').waitFor({state:'hidden'});
  state=await readState();check(state.groups[0].status==='empty'&&state.groups[2].status==='in_use','UI atomic exchange updates both groups');
  const blue=page.locator('.group-card').filter({has:page.getByRole('heading',{name:'蓝组',exact:true})});await blue.getByRole('button',{name:'开始充电',exact:true}).click();await blue.getByRole('button',{name:'充电完成',exact:true}).waitFor();await blue.getByRole('button',{name:'充电完成',exact:true}).click();
  await page.getByText('已保存 · 「蓝组」：充电中 → 充满待用',{exact:true}).waitFor();await page.getByRole('button',{name:'电池档案',exact:true}).click();await page.locator('#search').fill('蓝组-1');await page.waitForFunction(()=>document.querySelectorAll('.group-card').length===1);check(await page.locator('.group-card').count()===1,'search finds single battery label');
  state=await readState();check(state.groups[0].chargeCount===1&&state.groups[0].status==='ready','UI charging completion recorded once');
  await page.locator('#search').fill('');await page.locator('.group-card').filter({has:page.getByRole('heading',{name:'蓝组',exact:true})}).getByRole('button',{name:'退役',exact:true}).click();await page.getByRole('button',{name:'确认退役',exact:true}).click();await page.locator('#editor').waitFor({state:'hidden'});check((await readState()).groups[0].status==='retired','retirement persists');
  await page.getByRole('button',{name:'撤销上一步',exact:true}).click();await page.getByText('已保存 · 撤销：',{exact:false}).waitFor();check((await readState()).groups[0].status==='ready','undo restores retirement');
  const snapshot=await readState();await page.reload();await page.getByRole('heading',{name:'无线鼠标'}).waitFor();check(JSON.stringify(await readState())===JSON.stringify(snapshot),'browser refresh persistence');
  const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'导出备份',exact:false}).click();const download=await downloadEvent;const backupPath=path.join(run,'backup.json');await download.saveAs(backupPath);const backup=JSON.parse(await readFile(backupPath,'utf8'));check(backup.revision===snapshot.revision,'export downloads complete backup');
  const bad=path.join(run,'bad.json');await writeFile(bad,JSON.stringify({...backup,schemaVersion:999}));await page.locator('#import-file').setInputFiles(bad);await page.getByText('恢复失败：',{exact:false}).waitFor();check(JSON.stringify(await readState())===JSON.stringify(snapshot),'bad import does not overwrite data');
  await page.getByRole('button',{name:'＋ 电池组',exact:true}).click();await page.locator('[name="name"]').fill('测试新组');await page.locator('[name="labels"]').fill('测试01\n测试02');await page.locator('[name="location"]').fill('书架');await page.getByRole('button',{name:'保存',exact:true}).click();await page.locator('#editor').waitFor({state:'hidden'});check((await readState()).groups.length===4,'create new group through full form');
  await page.locator('#import-file').setInputFiles(backupPath);await page.getByRole('button',{name:'确认恢复',exact:true}).click();await page.locator('#editor').waitFor({state:'hidden'});check((await readState()).groups.length===3,'backup restore returns expected ledger');
  await page.getByRole('button',{name:'＋ 设备',exact:true}).click();await page.locator('[name="name"]').fill('双槽测试');await page.getByRole('button',{name:'＋ 添加槽位',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click();await page.locator('#editor').waitFor({state:'hidden'});check((await readState()).devices[1].slots.length===2,'multiple device slots created');
  const beforeRestart=await readState();await stop();await start();check(JSON.stringify(await readState())===JSON.stringify(beforeRestart),'PowerShell process restart preserves data');await page.reload();await page.getByRole('heading',{name:'双槽测试',exact:true}).waitFor();
  const token=(await(await fetch(url+'/api/session')).json()).token;
  const put=(body,headers={})=>fetch(url+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json','X-Battery-Token':token,...headers},body:JSON.stringify(body)});
  let response=await put({expectedRevision:0,state:{...beforeRestart,revision:beforeRestart.revision+1}});check(response.status===409,'server blocks stale-tab revision overwrite');
  response=await put({expectedRevision:beforeRestart.revision,state:{...beforeRestart,revision:beforeRestart.revision+1}},{Origin:'https://hostile.example'});check(response.status===403,'server rejects cross-origin write');
  response=await put({expectedRevision:beforeRestart.revision,state:{...beforeRestart,revision:beforeRestart.revision+1}},{'X-Battery-Token':'bad'});check(response.status===403,'server rejects missing/wrong session token');
  const hostStatus=await new Promise((resolve,reject)=>{const req=http.get(url+'/api/state',{headers:{Host:'hostile.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});check(hostStatus===403,'server rejects untrusted host');
  response=await fetch(url+'/data/state.json');check(response.status===404,'data is not exposed as a static file');
  const conflict=structuredClone(beforeRestart);conflict.revision++;conflict.devices[1].slots[0].groupId=conflict.groups[2].id;response=await put({expectedRevision:beforeRestart.revision,state:conflict});check(response.status===400,'server rejects a group assigned twice');
  check(JSON.stringify(await readState())===JSON.stringify(beforeRestart),'all failed writes leave original state intact');
  await page.screenshot({path:path.join(artifacts,'dashboard-desktop.png'),fullPage:true});await page.getByRole('button',{name:'电池档案',exact:true}).click();await page.screenshot({path:path.join(artifacts,'groups-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'换班工作台',exact:true}).click();await page.screenshot({path:path.join(artifacts,'dashboard-mobile.png'),fullPage:true});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile viewport has no horizontal overflow');check(errors.length===0,'no browser JavaScript errors: '+errors.join('; '));
  await writeFile(path.join(artifacts,'ui-results.json'),JSON.stringify({passed:checks,browser:'Chromium / '+(launch.channel||'bundled'),server:'Windows PowerShell 5.1',runDirectory:run,errors},null,2));console.log(`UI acceptance complete: ${checks} checks passed. Artifacts: ${artifacts}`);
}finally{if(browser)await browser.close();await stop();}
