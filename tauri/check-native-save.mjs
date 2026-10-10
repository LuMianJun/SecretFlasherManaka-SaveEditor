// Native WebView2 test. The supplied directory must contain disposable copies.
import WebSocket from 'ws';
import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const [port,pid,out]=process.argv.slice(2),hash=b=>createHash('sha256').update(b).digest('hex');
assert.match(pid,/^\d+$/);
const pages=await(await fetch(`http://127.0.0.1:${port}/json`)).json();
const page=pages.find(p=>p.type==='page');
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.once('open',r));
let sequence=0;const pending=new Map();
ws.on('message',d=>{const m=JSON.parse(d);if(pending.has(m.id)){const {resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);}});
const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
async function js(expression){const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function until(expression){for(let i=0;i<100;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+expression);}
const invoke=(name,args={})=>js(`window.__TAURI__.core.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
const snapshot=()=>invoke('get_document');
const field=(s,p)=>s.nodes.find(n=>JSON.stringify(n.path)===JSON.stringify(p));
const rp=['GameStateData','value','CurrentRp'];
const select=p=>js(`window.__saveEditor.select(${JSON.stringify(p)})`);
const input=value=>js(`document.querySelector('#value-input').value=${JSON.stringify(value)};document.querySelector('#value-input').dispatchEvent(new Event('input'))`);
const reload=async()=>{await rpc('Page.reload');await until('Boolean(window.__saveEditor?.ready)');};
const expectRejected=async command=>{const error=await js(`(async()=>{try{await ${command};return null}catch(e){return String(e)}})()`);assert.ok(error);return error;};
await until('Boolean(window.__saveEditor?.ready)');
const original=await snapshot(),source=original.source,sourceCipher=await readFile(source),originalRp=BigInt(field(original,rp).raw);
assert.equal(original.identity.slotIndex,0);assert.equal(original.identityError,null);
assert.equal(await js('document.title'),'SecretFlasherManaka 存档编辑器');
assert.ok(await js("document.querySelector('.brand-name').textContent.includes('SecretFlasherManaka')"));
assert.equal(await js("Boolean(document.querySelector('#save')&&document.querySelector('#save-as')&&!document.querySelector('#export'))"),true);
const launch=await invoke('get_launch_options');assert.match(launch.defaultDirectory.replaceAll('\\','/'),/LocalLow\/SheableSoft\/SecretFlasherManaka\/SaveData$/);
// Save automatically stages current input. Cancel must leave the file untouched.
await select(rp);await input(String(originalRp+1n));await js("document.querySelector('#save').click()");
await until("Boolean(document.querySelector('#modal-confirm'))");
assert.equal(hash(await readFile(source)),hash(sourceCipher));
await js("document.querySelector('#modal-cancel').click()");await until("!document.querySelector('#save').disabled");
assert.equal(hash(await readFile(source)),hash(sourceCipher));assert.equal((await snapshot()).dirty,true);
async function saveCurrent(){await js("document.querySelector('#save').click()");await until("Boolean(document.querySelector('#modal-confirm'))");await js("document.querySelector('#modal-confirm').click()");await until("!window.__saveEditor.snapshot.dirty&&window.__saveEditor.snapshot.historyLength===0");}
await saveCurrent();let current=await snapshot();assert.equal(field(current,rp).raw,String(originalRp+1n));assert.equal(current.changedEntries.length,0);assert.notEqual(current.sourceHash,original.sourceHash);
await input(String(originalRp+2n));await saveCurrent();current=await snapshot();assert.equal(field(current,rp).raw,String(originalRp+2n));
const secondCipher=await readFile(source);
// Save As validates the target and makes it the next Save destination.
const firstAs=out+'/as/0.sd';let plan=await invoke('prepare_save_as',{destination:firstAs});assert.equal(plan.exists,false);
await invoke('commit_save',{token:plan.token});await reload();assert.equal((await snapshot()).source.replaceAll('\\','/'),firstAs.replaceAll('\\','/'));
await select(rp);await input(String(originalRp+3n));await saveCurrent();assert.equal(hash(await readFile(source)),hash(secondCipher));
const existing=out+'/existing/0.sd';plan=await invoke('prepare_save_as',{destination:existing});assert.equal(plan.exists,true);
await invoke('commit_save',{token:plan.token});await reload();assert.equal(field(await snapshot(),rp).raw,String(originalRp+3n));
const rejected=[];
for(const target of [out+'/1.sd',out+'/s.sd',out+'/other-id.sd',out+'/a3.sd']) rejected.push(await expectRejected(`window.__TAURI__.core.invoke('prepare_save_as',{destination:${JSON.stringify(target)}})`));
// Invalid edited IDs cannot reach disk; restoring them clears the error.
const slot=['SaveDataSlotIndex','value'];await select(slot);await input('20');const targetBefore=hash(await readFile(existing));
await js("document.querySelector('#save').click()");await until("Boolean(window.__saveEditor.snapshot.identityError)&&document.querySelector('#notice').classList.contains('error')");
assert.equal(hash(await readFile(existing)),targetBefore);assert.equal(await js("Boolean(document.querySelector('#modal-confirm'))"),false);
await js("document.querySelector('#undo').click()");await until('!window.__saveEditor.snapshot.dirty');
// Native OS close still protects an unapplied draft.
await select(rp);await input('777');
execFileSync('powershell.exe',['-NoProfile','-Command',`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class TestCloseWindow{[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint msg,IntPtr wp,IntPtr lp);}'; [TestCloseWindow]::PostMessage((Get-Process -Id ${pid}).MainWindowHandle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)`]);
await until("Boolean(document.querySelector('#modal-cancel'))");await js("document.querySelector('#modal-cancel').click()");
const system=out+'/work/s.sd';await invoke('load_document',{path:system});await reload();current=await snapshot();assert.equal(current.nodeCount,238);assert.equal(current.identity.kind,'system');assert.equal(current.identity.slotIndex,null);
const language=['OptionData','value','Language'],oldLanguage=field(current,language).raw,nextLanguage=oldLanguage==='2'?'1':'2';
await js("window.__saveEditor.setCategory('settings')");await select(language);
await js(`document.querySelector('#value-choice').value=${JSON.stringify(nextLanguage)};document.querySelector('#value-choice').dispatchEvent(new Event('change'))`);
await saveCurrent();assert.equal(field(await snapshot(),language).raw,nextLanguage);
rejected.push(await expectRejected(`window.__TAURI__.core.invoke('prepare_save_as',{destination:${JSON.stringify(out+'/system-as/0.sd')}})`));
await invoke('load_document',{path:existing});await reload();await select(rp);
const screen=await rpc('Page.captureScreenshot',{format:'png'});await writeFile(out+'/editor.png',Buffer.from(screen.data,'base64'));
const result={formalName:true,defaultGameDirectory:launch.defaultDirectory,cancelPreservesFile:true,saveStagesInput:true,repeatedSave:true,baselineResets:true,saveAsAdoptsFile:true,saveAsOverwritesMatchingId:true,idChecks:rejected,invalidIdBlocksWrite:true,nativeCloseProtectsDraft:true,systemSave:true,originalRp:String(originalRp),workRp:String(originalRp+2n),savedAsRp:String(originalRp+3n),systemLanguage:nextLanguage};
await writeFile(out+'/native-check.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
await invoke('close_app');ws.close();
