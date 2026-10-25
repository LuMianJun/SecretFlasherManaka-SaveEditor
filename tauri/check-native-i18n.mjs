// Native five-language checks. Only disposable copies in a new output directory are written.
// node check-native-i18n.mjs <exe> <progress-save> <cosplay-fault-save> <new-output-directory>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';
const [exe,progress,fault,output]=process.argv.slice(2);
assert.ok(exe&&progress&&fault&&output);
fs.mkdirSync(output);
const source=path.join(output,'progress-copy.sd'),faultCopy=path.join(output,'cosplay-fault-copy.sd');
fs.copyFileSync(progress,source);fs.copyFileSync(fault,faultCopy);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalHashes=[progress,fault,source,faultCopy].map(hash);
const child=spawn(exe,['--source',source],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_USER_DATA_FOLDER:path.join(output,'webview-profile'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9580 --remote-debugging-address=127.0.0.1'}});
let socket;
const checks=[];
try{
 let page;
 for(let attempt=0;attempt<100;attempt++){
  try{page=(await(await fetch('http://127.0.0.1:9580/json/list')).json()).find(item=>item.type==='page');}catch{}
  if(page)break;await new Promise(resolve=>setTimeout(resolve,200));
 }
 assert.ok(page,'Native WebView target available');
 socket=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
 let sequence=0;const pending=new Map();
 socket.on('message',data=>{const message=JSON.parse(data),entry=pending.get(message.id);if(!entry)return;pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(Error(JSON.stringify(message.error))):entry.resolve(message.result);});
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Timeout: '+method));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
 const js=async(fn,...args)=>{const result=await rpc('Runtime.evaluate',{expression:`(${fn})(${args.map(arg=>JSON.stringify(arg)).join(',')})`,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result?.value;};
 const until=async(fn,...args)=>{for(let attempt=0;attempt<100;attempt++){if(await js(fn,...args))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('UI condition not met');};
 const ready=()=>until(()=>!!window.__saveEditor?.ready);
 const invoke=(command,args={})=>js((command,args)=>window.__TAURI_INTERNALS__.invoke(command,args),command,args);
 const reload=async()=>{await rpc('Page.reload');await new Promise(resolve=>setTimeout(resolve,150));await ready();};
 const language=async locale=>{await js(locale=>{if(!document.querySelector('[data-language-dialog]'))document.querySelector('#language-button').click();document.querySelector(`[data-locale="${locale}"]`).click();},locale);await until(locale=>window.__saveEditor.locale===locale&&!document.querySelector('[data-language-dialog]')&&!document.querySelector('#language-button').disabled,locale);};
 const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
 await ready();
 const before=await invoke('get_document');
 await check('First launch prompts with native language names and does not silently save the Chinese default',async()=>{
  assert.equal(await js(()=>document.documentElement.lang),'zh-Hans');
  assert.equal(await js(()=>localStorage.getItem('secretflashermanaka-save-editor.locale')),null);
  assert.equal(await js(()=>document.querySelector('[data-language-dialog]').dataset.languageDialog),'first');
  assert.deepEqual(await js(()=>Array.from(document.querySelectorAll('.language-choice strong'),item=>item.textContent)),['简体中文','繁體中文','English','日本語','한국어']);
  await rpc('Page.enable');fs.writeFileSync(path.join(output,'first-language-choice.png'),Buffer.from((await rpc('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await language('sc');assert.equal(await js(()=>localStorage.getItem('secretflashermanaka-save-editor.locale')),'sc');
  await reload();assert.equal(await js(()=>!!document.querySelector('[data-language-dialog]')),false);
 });

 await check('All five languages appear and switching preserves unapplied input and loaded save nodes',async()=>{
  await js(()=>document.querySelector('#language-button').click());
  assert.deepEqual(await js(()=>Array.from(document.querySelectorAll('[data-locale]'),button=>button.dataset.locale)),['sc','tc','en','ja','ko']);
  await js(()=>document.querySelector('#language-cancel').click());
  await js(()=>{window.__saveEditor.select(['GameStateData','value','CurrentRp']);const input=document.querySelector('#value-input');input.value='123456789.123456789';input.dispatchEvent(new Event('input',{bubbles:true}));});
  for(const locale of ['en','ja','ko','tc','sc']){
   await language(locale);assert.equal(await js(()=>document.querySelector('#value-input').value),'123456789.123456789');
   assert.deepEqual((await invoke('get_document')).nodes,before.nodes);assert.equal((await invoke('get_document')).dirty,false);
  }
 });
 await reload();
 await check('Localized scene search and mission details use original names in every language',async()=>{
  for(const locale of ['sc','tc','en','ja','ko']){
   await language(locale);
   const scene=await js(()=>window.__saveEditor.metadata.catalog.stages['6']);
   const result=await js(scene=>{
    window.__saveEditor.setCategory('tasks');
    const input=document.querySelector('#search');input.value=scene;input.dispatchEvent(new Event('input',{bubbles:true}));
    const rows=Array.from(document.querySelectorAll('#data-list [data-path]')).filter(row=>JSON.parse(row.dataset.path)[2]==='MissionAchieveCountDict'&&JSON.parse(row.dataset.path).length===4);
    window.__saveEditor.select(['GameStateData','value','MissionAchieveCountDict','60000']);
    return {rows:rows.map(row=>({path:JSON.parse(row.dataset.path),name:row.querySelector('.row-name').textContent})),title:document.querySelector('#details h3').textContent,expected:window.__saveEditor.metadata.catalog.missions['60000']};
   },scene);
   assert.ok(result.rows.length>0);assert.ok(result.rows.every(row=>row.name.startsWith(`【${scene}】`)&&Math.floor(Number(row.path[3])/10000)===6));
   assert.equal(result.title,`【${scene}】${result.expected}`);
   await rpc('Page.enable');fs.writeFileSync(path.join(output,'missions-'+locale+'.png'),Buffer.from((await rpc('Page.captureScreenshot',{format:'png'})).data,'base64'));
  }
 });
 await check('Language persists after reload without changing the game save or options',async()=>{
  await language('ja');await reload();assert.equal(await js(()=>window.__saveEditor.locale),'ja');assert.equal(await js(()=>document.documentElement.lang),'ja');assert.deepEqual((await invoke('get_document')).nodes,before.nodes);
 });
 await check('Window fits the minimum supported size with English labels',async()=>{
  await language('en');await rpc('Emulation.setDeviceMetricsOverride',{width:1000,height:680,deviceScaleFactor:1,mobile:false});
  const layout=await js(()=>({body:document.body.scrollWidth,width:innerWidth,buttons:Array.from(document.querySelectorAll('.header-actions button'),button=>{const r=button.getBoundingClientRect();return {right:r.right,left:r.left};})}));
  assert.ok(layout.body<=layout.width);assert.ok(layout.buttons.every(button=>button.left>=0&&button.right<=layout.width));
  await rpc('Emulation.clearDeviceMetricsOverride');
 });
 for(const locale of ['sc','tc','en','ja','ko'])await check(`Repair preview, cancellation, copy protection and save roundtrip in ${locale}`,async()=>{
  await invoke('load_document',{path:faultCopy});await reload();await language(locale);
  const original=await invoke('get_document');
  await js(()=>document.querySelector('#repair').click());await until(()=>!!document.querySelector('#repair-apply'));
  assert.equal(await js(()=>document.querySelector('#language-button').disabled),true);
  const prose=await js(()=>Array.from(document.querySelectorAll('.repair-modal article p'),item=>item.textContent));
  if(['en','ko'].includes(locale))assert.ok(prose.every(text=>!/[\u4e00-\u9fff]/.test(text)));
  await js(()=>document.querySelector('#repair-cancel').click());assert.deepEqual((await invoke('get_document')).nodes,original.nodes);
  const plan=await invoke('preview_repair');const repaired=await invoke('apply_repair',{contentHash:plan.contentHash});assert.equal(repaired.repairRequiresCopy,true);
  assert.ok(!repaired.nodes.some(node=>node.path.slice(2).includes('10033')));
  await assert.rejects(()=>invoke('prepare_save'));
  const destination=path.join(output,'repaired-'+locale+'.sd');const save=await invoke('prepare_save_as',{destination});await invoke('commit_save',{token:save.token});
  await invoke('load_document',{path:destination});assert.equal((await invoke('preview_repair')).changes.length,0);
 });
 assert.deepEqual([progress,fault,source,faultCopy].map(hash),originalHashes);
 fs.writeFileSync(path.join(output,'native-i18n-check.json'),JSON.stringify({passed:checks.length,checks,sourceFilesUnchanged:true,actualGameLoadOfRepairPreviouslyConfirmedByUser:true},null,2));
 await invoke('close_app').catch(()=>{});
}finally{socket?.close();if(child.exitCode===null)child.kill();}
