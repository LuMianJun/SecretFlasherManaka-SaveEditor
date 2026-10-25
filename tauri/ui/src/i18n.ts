import messagesJson from './data/messages.json';
import gameJson from './data/game-locales.json';
import type {Metadata, Translator} from './semantics';

export const languages = [
  {id:'sc',name:'简体中文',html:'zh-Hans'},
  {id:'tc',name:'繁體中文',html:'zh-Hant'},
  {id:'en',name:'English',html:'en'},
  {id:'ja',name:'日本語',html:'ja'},
  {id:'ko',name:'한국어',html:'ko'},
] as const;
export type Locale = typeof languages[number]['id'];
const messages = messagesJson as Record<string,Record<Locale,string>>;
const game = gameJson as unknown as {locales:Record<Locale,{labels:Record<string,string>;catalog:Record<string,unknown>}>};
export const isLocale = (value:unknown):value is Locale => languages.some(item=>item.id===value);
const storageKey='secretflashermanaka-save-editor.locale';
let locale:Locale='sc';
try {
  const stored=localStorage.getItem(storageKey);
  if(isLocale(stored))locale=stored;
} catch { /* The editor remains usable when local storage is unavailable. */ }
export const getLocale=()=>locale;
export function setLocale(value:Locale) {
  locale=value;
  try{localStorage.setItem(storageKey,value);}catch{}
  document.documentElement.lang=languages.find(item=>item.id===value)!.html;
  document.title=`SecretFlasherManaka ${tr('存档编辑器')}`;
}
export const tr:Translator=(message,...values)=>
  (messages[message]?.[locale]??message).replace(/\{(\d+)\}/g,(_,index)=>String(values[Number(index)]??''));

/** Translate metadata only; never traverse a save document or user-provided text. */
export function localizeMetadata(source:Metadata):Metadata {
  const result=structuredClone(source);
  const text=(value:unknown):any=>typeof value==='string'?tr(value):Array.isArray(value)?value.map(text):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,child])=>[key,text(child)])):value;
  result.labels={...text(source.labels),...game.locales[locale].labels};
  result.categories=text(source.categories);
  result.options=text(source.options);
  result.catalog={...source.catalog,...game.locales[locale].catalog};
  if(source.saveScopes)result.saveScopes={...source.saveScopes,typeLabels:text(source.saveScopes.typeLabels),rules:source.saveScopes.rules.map(rule=>({...rule,description:tr(rule.description),...(rule.badge?{badge:tr(rule.badge)}:{})}))};
  return result;
}

const quoteRegex=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const patterns=Object.entries(messages).filter(([key])=>/\{(?:\w*)\}/.test(key)).map(([key,translations])=>{
  const names:string[]=[];
  const chunks=key.split(/(\{\w*\})/g);
  const regex=new RegExp('^'+chunks.map(chunk=>/^\{\w*\}$/.test(chunk)?(names.push(chunk),'([\\s\\S]*?)'):quoteRegex(chunk)).join('')+'$');
  return {regex,names,translations};
});
/** Legacy backend diagnostics remain Chinese internally; translate their exact
 * message templates without replacing arbitrary paths, save text or IDs. */
export function backendText(value:string,depth=0):string {
  if(depth>4)return value;
  if(messages[value])return messages[value][locale];
  for(const {regex,names,translations} of patterns){
    const match=regex.exec(value);
    if(!match)continue;
    let unnamed=0;
    return translations[locale].replace(/\{\w*\}/g,token=>{
      const index=token==='{}'?names.map((name,index)=>name==='{}'?index:-1).filter(index=>index>=0)[unnamed++]:names.indexOf(token);
      const replacement=match[index+1];
      return replacement===undefined?token:backendText(replacement,depth+1);
    });
  }
  return value;
}
