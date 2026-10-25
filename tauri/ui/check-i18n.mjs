import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
const read=file=>fs.readFileSync(new URL(file,import.meta.url),'utf8');
const json=file=>JSON.parse(read(file));
const metadata=json('../metadata.json'),names=json('./src/data/game-locales.json'),messages=json('./src/data/messages.json');
globalThis.document={documentElement:{lang:''},title:''};
globalThis.localStorage={value:null,getItem(){return this.value;},setItem(key,value){this.value=value;}};
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const moduleFor=source=>'data:text/javascript;base64,'+Buffer.from(compile(source)).toString('base64');
const {Semantics}=await import(moduleFor(read('./src/semantics.ts')));
let source=read('./src/i18n.ts').replace(/import messagesJson[^;]+;/,'const messagesJson='+JSON.stringify(messages)+';').replace(/import gameJson[^;]+;/,'const gameJson='+JSON.stringify(names)+';');
const {tr,setLocale,getLocale,hasSavedLocale,localizeMetadata,backendText,languages}=await import(moduleFor(source));
let count=0;
const test=(name,fn)=>{fn();count++;console.log('PASS '+name);};
const locales=languages.map(item=>item.id);
test('An unset preference uses Chinese without silently saving it',()=>{assert.equal(getLocale(),'sc');assert.equal(hasSavedLocale(),false);setLocale('sc',false);assert.equal(localStorage.value,null);assert.equal(hasSavedLocale(),false);});
test('Five editor languages match the original dictionary columns',()=>assert.deepEqual(locales,['sc','tc','en','ja','ko']));
test('All user-facing source messages have complete translations with identical placeholders',()=>{
 const keys=text=>[...text.matchAll(/\{\w*\}/g)].map(item=>item[0]).sort();
 for(const [key,translations] of Object.entries(messages))for(const locale of locales){assert.equal(typeof translations[locale],'string',`${key}/${locale}`);assert.deepEqual(keys(translations[locale]),keys(key),`${key}/${locale}`);}
 for(const file of ['./src/main.ts','./src/semantics.ts']){
  const tree=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true);
  const visit=node=>{if(ts.isCallExpression(node)&&((ts.isIdentifier(node.expression)&&node.expression.text==='tr')||(ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='tr'))&&ts.isStringLiteral(node.arguments[0]))assert.ok(Object.hasOwn(messages,node.arguments[0].text),node.arguments[0].text);ts.forEachChild(node,visit);};visit(tree);
 }
});
test('Every master-backed name equals the original localized key and parameters',()=>{
 for(const [path,entry] of Object.entries(names.provenance)){
  if(!entry.key)continue;
  for(const locale of locales){
   let expected=names.dictionary[entry.key][locale];
   const args=entry.argsByLocale?.[locale]??entry.args??[];
   expected=expected.replace(/\{(\d+)\}/g,(token,index)=>args[Number(index)]??token)+(entry.suffix??'');
   const actual=path.split('/').reduce((value,key)=>value[key],names.locales[locale]);
   assert.equal(actual,expected,`${locale}/${path}`);
  }
 }
});
test('Mission locations, parameters and ambiguous costume names follow their own master keys',()=>{
 setLocale('en');const meta=localizeMetadata(metadata),sem=new Semantics(meta,tr);
 assert.equal(meta.catalog.cosplay['14'],'Jumpsuit');assert.equal(meta.catalog.cosplay_parts['40003'],'Leotard');
 assert.equal(meta.catalog.goods['2'],'Eye Mask');assert.equal(meta.catalog.cosplay_parts['7'],'Blindfold');
 assert.equal(meta.catalog.missions['60004'],'Be in Checkout Counter while flashing');
 assert.equal(sem.name(['GameStateData','value','MissionAchieveCountDict','60004']),'【Convenience Store】Be in Checkout Counter while flashing');
 assert.equal(meta.catalog.achievements['0'],'Achieved a high score of 1000 RP or more');
 assert.ok(!/\{\d+\}/.test(meta.catalog.achievements['3']));
});
test('Language changes preserve every ID, rule, range and raw input value',()=>{
 const before=JSON.stringify(metadata);
 for(const locale of locales){setLocale(locale);const localized=localizeMetadata(metadata);assert.deepEqual(localized.rules,metadata.rules);assert.deepEqual(localized.skillMaxLevels,metadata.skillMaxLevels);for(const table of Object.keys(metadata.catalog))if(table!=='meta')assert.deepEqual(Object.keys(localized.catalog[table]).sort(),Object.keys(metadata.catalog[table]).sort());const sem=new Semantics(localized,tr),node={path:['GameStateData','value','PlayerVibrationModeType'],kind:'number',raw:'2',children:[],bareKeys:[]};assert.deepEqual(sem.choices(node).map(option=>option.raw),['0','1','2','3']);assert.equal(node.raw,'2');}
 assert.equal(JSON.stringify(metadata),before);
});
test('Changing language stores only editor preference and translates backend diagnostics',()=>{
 setLocale('ko');assert.equal(getLocale(),'ko');assert.equal(document.documentElement.lang,'ko');assert.equal(localStorage.value,'ko');assert.match(backendText('进度存档 · 槽位 4'),/4/);assert.ok(!/[\u4e00-\u9fff]/.test(backendText('进度存档 · 槽位 4')));assert.ok(!/[\u4e00-\u9fff]/.test(backendText('修复后的存档必须另存到其他文件，原文件保留不覆盖')));assert.equal(backendText('C:/unchanged/打开存档.sd'),'C:/unchanged/打开存档.sd');
});
console.log(JSON.stringify({passed:count,locales,sourceLinkedNames:Object.keys(names.provenance).length,messages:Object.keys(messages).length}));
