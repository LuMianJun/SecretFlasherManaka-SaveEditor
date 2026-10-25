// Native WebView2 checks against disposable, generated save fixtures only.
// Usage: node check-native-repair.mjs <exe> <fixture-directory> <new-output-directory>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import WebSocket from 'ws';

const [executable,fixtures,output,baseline]=process.argv.slice(2);
assert.ok(executable&&fixtures&&output,'Supply executable, generated fixtures and a new output directory');
fs.mkdirSync(output);
const source=path.join(output,'cosplay-and-missing-data.sd');
fs.copyFileSync(path.join(fixtures,'cosplay-and-missing-data.sd'),source);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHash=hash(source);
const child=spawn(executable,['--source',source],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9572 --remote-debugging-address=127.0.0.1'}});
let socket;
const checks=[];
try {
  let page;
  for(let i=0;i<100;i++){
    try{page=(await(await fetch('http://127.0.0.1:9572/json/list')).json()).find(p=>p.type==='page');}catch{}
    if(page)break;await new Promise(r=>setTimeout(r,200));
  }
  assert.ok(page,'Native debug target available');
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  let sequence=0;
  const pending=new Map();
  socket.on('message',data=>{const m=JSON.parse(data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('Timeout: '+method));},20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const js=async(fn,...args)=>{const r=await rpc('Runtime.evaluate',{expression:`(${fn})(${args.map(a=>JSON.stringify(a)).join(',')})`,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
  const until=async fn=>{for(let i=0;i<100;i++){if(await js(fn))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout waiting for UI');};
  const reload=async()=>{await rpc('Page.reload');await new Promise(r=>setTimeout(r,200));await until(()=>!!window.__saveEditor?.ready);};
  const invoke=(command,args={})=>js((command,args)=>window.__TAURI_INTERNALS__.invoke(command,args),command,args);
  const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
  const scan=async()=>{await js(()=>document.querySelector('#repair').click());await until(()=>!!document.querySelector('#repair-apply'));};
  const apply=async()=>{await js(()=>document.querySelector('#repair-apply').click());await until(()=>!document.querySelector('#repair-apply')&&window.__saveEditor.snapshot.dirty);};
  const field=(snapshot,parts)=>snapshot.nodes.find(node=>JSON.stringify(node.path)===JSON.stringify(parts));
  const game=['GameStateData','value'];
  await until(()=>!!window.__saveEditor?.ready);
  const before=await invoke('get_document');
  await check('Generated fault sample contains equipped MOD ID, preset residue and missing original records',async()=>{
    assert.equal(field(before,[...game,'PlayerCosplayPartsDict','10033']).raw,'true');
    assert.equal(field(before,[...game,'SkillLevel']),undefined);
    assert.equal(field(before,[...game,'CosplayPartsReinforceEffectDict','20011']),undefined);
    assert.ok(field(before,['ExampleModData']));
  });
  await check('Repair preview and cancellation do not mutate the document or source file',async()=>{
    await scan();
    const labels=await js(()=>Array.from(document.querySelectorAll('.changes-list h3'),n=>n.textContent));
    assert.ok(labels.some(label=>label.includes('10033')));
    assert.ok(labels.some(label=>label.includes('技能')));
    const buttonBounds=await js(()=>{const r=document.querySelector('#repair-apply').getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight};});
    assert.ok(buttonBounds.top>=0&&buttonBounds.bottom<=buttonBounds.height,'Repair action remains visible without scrolling the entire change list');
    assert.deepEqual((await invoke('get_document')).nodes,before.nodes);
    await rpc('Page.enable');fs.writeFileSync(path.join(output,'repair-preview.png'),Buffer.from((await rpc('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await js(()=>document.querySelector('#repair-cancel').click());
    assert.deepEqual((await invoke('get_document')).nodes,before.nodes);assert.equal(hash(source),sourceHash);
  });
  await check('Applying repair clears all MOD references and restores original records without changing RP',async()=>{
    await scan();await apply();
    const after=await invoke('get_document');
    for(const name of ['PlayerCosplayPartsDict','CosplayPartsOptionDataDict','CosplayPartsReinforceEffectDict','CosplayReinforceLockState'])assert.equal(field(after,[...game,name,'10033']),undefined,name);
    for(const node of after.nodes)if(node.path[2]==='LoadoutDatas'&&node.kind==='number')assert.notEqual(node.raw,'10033');
    assert.equal(field(after,['ExampleModData']),undefined);
    assert.equal(field(after,[...game,'MissionAchieveCountDict','79100']),undefined);
    assert.equal(field(after,[...game,'CosplayPartsReinforceEffectDict','20011']).children.length,3);
    assert.equal(field(after,[...game,'CosplayReinforceLockState','20011']).children.length,4);
    assert.equal(field(after,[...game,'CosplayReinforceLockState','20011',0]).raw,'true');
    assert.ok(field(after,[...game,'SkillLevel','-1']));
    assert.equal(field(after,[...game,'CurrentRp']).raw,field(before,[...game,'CurrentRp']).raw);
    assert.equal(after.repairRequiresCopy,true);assert.equal(hash(source),sourceHash);
  });
  await check('Repaired data cannot overwrite the fault sample and one undo restores the full fault state',async()=>{
    const error=await js(async()=>{try{await window.__TAURI_INTERNALS__.invoke('prepare_save');return null;}catch(e){return String(e);}});
    assert.match(error,/另存/);
    await js(()=>document.querySelector('#undo').click());
    await until(()=>!window.__saveEditor.snapshot.dirty);
    assert.deepEqual((await invoke('get_document')).nodes,before.nodes);assert.equal(hash(source),sourceHash);
    assert.equal((await invoke('get_document')).repairRequiresCopy,false);
  });
  await check('Saving the repaired copy passes encryption, reopening and an idempotent second scan',async()=>{
    await scan();await apply();
    const destination=path.join(output,'native-repaired.sd');
    const plan=await invoke('prepare_save_as',{destination});
    await invoke('commit_save',{token:plan.token});
    await invoke('load_document',{path:destination});
    assert.equal((await invoke('preview_repair')).changes.length,0);
    assert.equal(hash(source),sourceHash);await reload();
  });
  await check('The original generated save is already valid under the repair contract',async()=>{
    const original=path.join(fixtures,'original.sd'),originalHash=hash(original);
    await invoke('load_document',{path:original});assert.equal((await invoke('preview_repair')).changes.length,0);
    assert.equal(hash(original),originalHash);await reload();
  });
  if(baseline)await check('An existing full progress save retains its original progression and equipment',async()=>{
    const originalHash=hash(baseline),copy=path.join(output,'existing-progress-copy.sd');fs.copyFileSync(baseline,copy);
    await invoke('load_document',{path:copy});const original=await invoke('get_document');
    const preview=await invoke('preview_repair');fs.writeFileSync(path.join(output,'existing-progress-plan.json'),JSON.stringify(preview,null,2));
    await invoke('apply_repair',{contentHash:preview.contentHash});const repaired=await invoke('get_document');
    for(const name of ['CurrentRp','ExposeExp','StatistisTotalEarnRp','StatistisTotalPlayTime'])assert.equal(field(repaired,[...game,name]).raw,field(original,[...game,name]).raw,name);
    const profile=JSON.parse(fs.readFileSync(new URL('./repair_profile.json',import.meta.url),'utf8'));
    const ids=profile.definitions.GameStateData.fields.PlayerCosplayPartsDict.ids;
    for(const node of original.nodes)if(node.path.length===4&&node.path[2]==='PlayerCosplayPartsDict'&&ids.includes(node.path[3]))assert.equal(field(repaired,node.path).raw,node.raw);
    assert.equal((await invoke('preview_repair')).changes.length,0);
    assert.equal(hash(baseline),originalHash);assert.equal(hash(copy),originalHash);
    await invoke('load_document',{path:copy});await reload();
  });
  const report={passed:checks.length,checks,sourceUnchanged:true,fixtureType:'synthetic reconstruction of observed Cosplay Loader 2.2.1 writes; not an actual gameplay save',actualGameLoadVerified:false};
  fs.writeFileSync(path.join(output,'native-repair-check.json'),JSON.stringify(report,null,2));
  await invoke('close_app').catch(()=>{});
} finally {
  socket?.close();if(child.exitCode===null)child.kill();
}
