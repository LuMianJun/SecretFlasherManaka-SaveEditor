export type Key = string | number;
export type SavePath = Key[];
export interface SaveNode { path: SavePath; kind: 'object'|'array'|'number'|'bool'|'string'|'null'; raw: string; value?: string|boolean|null; children:Key[]; bareKeys:string[] }
export interface Change {path:SavePath;operation:string;before:string|null;after:string|null}
export interface Snapshot {source:string;sourceHash:string;nodes:SaveNode[];nodeCount:number;historyLength:number;dirty:boolean;changedEntries:Change[];identity:{kind:string;slotIndex:number|null;label:string};identityError:string|null}
export interface Rules {keyTables:Record<string,string>;valueTables:Record<string,string>;listTables:Record<string,string>;reinforcementTables:string[];lockTables:string[];stageDroneTables:string[]}
export interface Metadata {labels:Record<string,string>;categories:Record<string,string>;fieldCategories?:Record<string,string>;catalog:Record<string,any>;options:Record<string,Record<string,string>>;rules:Rules}
export const pathKey=(path:SavePath)=>JSON.stringify(path);
export const numeric = (node:SaveNode)=>node.kind==='number' ? node.raw.trim() : node.kind==='bool' ? (node.value?'true':'false') : String(node.value??'');
export interface Choice {raw:string;name:string}

export class Semantics {
  constructor(public meta:Metadata) {}
  table(name:string|undefined):Record<string,string> { return name ? (this.meta.catalog[name]??this.meta.options[name]??{}) : {}; }
  named(table:string,id:Key):string {
    if(table==='drop_items') {
      const n=Number(id);
      if(n>=10000&&n<10010) return `落地假阳具 ${n-9999}`;
      if(n>=10100&&n<10110) return `壁挂假阳具 ${n-10099}`;
    }
    if(table==='missions' && this.meta.catalog.custom_missions?.[String(id)]) return this.meta.catalog.custom_missions[String(id)];
    if(table==='missions' && this.meta.catalog.meta?.ambiguous_historical_custom_missions?.[String(id)]) return `历史自定义任务（编号 ${id}，名称有歧义）`;
    return this.table(table)[String(id)]??`未知条目（编号 ${id}）`;
  }
  name(path:SavePath):string {
    if(!path.length) return '完整存档';
    const field=path.at(-1)!, parent=String(path.at(-2)??''), grand=String(path.at(-3)??'');
    if(this.meta.rules.keyTables[parent]) return this.named(this.meta.rules.keyTables[parent],field);
    if(this.meta.rules.stageDroneTables.includes(grand)) return this.named('drone_missions',field);
    if(typeof field==='number') {
      if(this.meta.rules.reinforcementTables.includes(grand)) return `强化效果 ${field+1}`;
      if(this.meta.rules.lockTables.includes(grand)) return field<3?`锁定强化效果 ${field+1}`:'仅负面效果';
      if(['LoadoutDatas','LoadoutCustomizeDatas','CosplayMySetNames','CustomizeMySetNames'].includes(parent)) return `方案 ${field+1}`;
      if(['RankData','DifficultData','TotalPlayTimeData','ManualSaveTime','AutoSaveTime'].includes(parent)) return `存档槽位 ${field+1}`;
      return `第 ${field+1} 项`;
    }
    if(grand==='CosplayPartsOptionDataDict') {
      const info=this.meta.catalog.cosplay_part_options?.[parent]??{};
      if(info[field]) return typeof info[field]==='string'?info[field]:(this.meta.labels[field]??field);
      if(field==='materialIndex' && info.materialLabel) return info.materialLabel;
    }
    return this.meta.labels[field]??field;
  }
  booleanNames(path:SavePath):[string,string] {
    const f=String(path.at(-1)??''),parent=String(path.at(-2)??''),grand=String(path.at(-3)??'');
    if(['PlayerCosplayPartsDict','MAdultGoodsDict','PlayerCostumeDict'].includes(parent)) return ['已装备','未装备（已拥有）'];
    if(parent==='ClothesDict') return ['已拥有','未拥有'];
    if(f.startsWith('IsOpen') || f==='AnsweredFirstSexOption') return ['已看过','未看过'];
    if(f==='IsDaytime') return ['白天','夜晚'];
    const states:Record<string,[string,string]>={IsTrial:['试玩版存档','正式版存档'],IsDroneNeedCharge:['需要充电','无需充电'],IsDropped:['已掉落','未掉落'],IsReserve:['已预定生成','未预定生成'],IsExist:['存在','不存在'],invisible:['隐藏','显示'],PlayerIsAttachHandcuffs:['已佩戴','未佩戴'],PlayerIsAttachMapHandcuffs:['已固定','未固定']};
    if(states[f]) return states[f];
    if(f.endsWith('Disable')) return ['已禁用','未禁用'];
    if(this.meta.rules.lockTables.includes(grand) && Number(f)<3) return ['已锁定','未锁定'];
    return ['开启','关闭'];
  }
  choices(node:SaveNode,nodes?:Map<string,SaveNode>):Choice[] {
    if(node.kind==='bool') {const [yes,no]=this.booleanNames(node.path);return [{raw:'false',name:no},{raw:'true',name:yes}];}
    if(node.kind!=='number') return [];
    const field=String(node.path.at(-1)??''),parent=String(node.path.at(-2)??''),grand=String(node.path.at(-3)??'');
    let table=this.meta.rules.valueTables[field];
    if(this.meta.rules.reinforcementTables.includes(grand)) table='reinforce';
    if(this.meta.rules.listTables[parent]) table=this.meta.rules.listTables[parent];
    if(field.startsWith('RingShortcutModelIndex')) table='ring_actions';
    if(field==='CustomizeSkinColor') table='skin_colors';
    let opts:Record<string,string>={...(table?this.table(table):this.meta.options[field]??{})};
    if(field.startsWith('RingShortcutModelIndex')) opts['-1']='未设置';
    if(parent==='DifficultData') opts={...this.meta.options.DifficultType};
    if(parent==='RandomMissionClearNumIdDict') opts={'-1':'未通关','0':'已通关 10 个任务','1':'已通关 20 个任务','2':'已通关全部任务'};
    if(field==='Resolusion') {
      const wide=nodes?.get(pathKey(['OptionData','value','AspectRatioIndex']))?.raw.trim()==='1';
      const sizes=wide?['1920×800','2560×1080','3440×1440','5120×2160']:['1280×720','1920×1080','2560×1440','3840×2160'];
      opts=Object.fromEntries(sizes.map((v,i)=>[String(i),v]));
    }
    if(field==='materialIndex'&&grand==='CosplayPartsOptionDataDict') opts={...(this.meta.catalog.cosplay_part_options?.[parent]?.materialIndex??{})};
    if(table==='drop_items') for(const start of [10000,10100]) for(let n=start;n<start+10;n++) opts[String(n)]=this.named('drop_items',n);
    if(['PlayerCurrentHoldClothes','PlayerCurrentClothes','CurrentHair','ActiveDroneMissionId'].includes(field)) opts['-1']='无 / 未设置';
    if(!Object.keys(opts).length) return [];
    const raw=numeric(node);
    if(!(raw in opts)) opts[raw]=`未知选项（编号 ${raw}）`;
    const names=Object.values(opts);
    return Object.entries(opts).map(([raw,name])=>({raw,name:names.filter(v=>v===name).length>1?`${name}（编号 ${raw}）`:name}));
  }
  value(node:SaveNode,nodes?:Map<string,SaveNode>):string {
    const opts=this.choices(node,nodes);
    if(opts.length) return opts.find(v=>v.raw===numeric(node))!.name;
    const field=String(node.path.at(-1)??''),parent=String(node.path.at(-2)??''),grand=String(node.path.at(-3)??'');
    if(node.kind==='object'||node.kind==='array') {
      if(node.kind==='array'&&this.meta.rules.reinforcementTables.includes(parent)&&nodes) return node.children.map(k=>this.named('reinforce',nodes.get(pathKey([...node.path,k]))?.raw.trim()??'?')).join('；');
      return `${node.children.length} 个条目`;
    }
    if(node.kind==='string') return String(node.value??'');
    if(node.kind==='null') return '空值';
    const raw=node.raw.trim();
    if(node.kind==='number') {
      if(field==='MotionSpeedScaleIndex'||field==='WalkSpeedScaleIndex') { const index=Number(raw);const step=field==='WalkSpeedScaleIndex'?0.05:index<0?0.1:0.2;return `${Number((1+index*step).toFixed(8))} 倍`; }
      if(['StatistisTotalPlayTime','StatistisTotalExposeTime'].includes(field)) { const n=Number(raw);return `${Math.floor(n/3600)} 小时 ${Math.floor(n%3600/60)} 分 ${Math.floor(n%60)} 秒`; }
      if(field==='PlayerFear') return `恐惧等级 ${5-Math.trunc(Number(raw))}（进度 ${Number(((Number(raw)%1)*100).toFixed(1))}%）`;
      if(field==='StatistisMaxRpBoost') return `${raw} 倍`;
      if(parent==='MissionSatisfyDict') return `${Number((Number(raw)*100).toFixed(5))}%`;
      if(['PlayerLife','PlayerMaxLife','StatistisGameOverCount','StatistisEcstasyCount','StatistisMissionAchiveCount'].includes(field)) return `${raw} 次`;
      if(field==='StatistisMaxNudeMoveDistance') return `${raw} 米`;
      if(field.includes('RemainTime')||field==='PlayerHandcuffTimerSetTime') return `${raw} 秒`;
      if(!/^-?\d+$/.test(field)&&(field.startsWith('Sound')||field.endsWith('100'))) return `${raw}%`;
      if(parent==='MissionMaxRpBonus100Dict'||grand==='DroneMissionMaxRpBonus100PerStageDictDict') return `${Number(raw)/100} 倍`;
      if(parent==='ItemDict') return `${raw} 个`;
      if(['MissionAchieveCountDict','ContinueMissionAchieveCountDict','DroneMissionAchieveCountDict'].includes(parent)||grand==='DroneMissionAchieveCountPerStageDictDict') return `${raw} 次`;
      if(parent==='SkillLevel') return `${raw} 级`;
      if(field==='MaxFrameRate') return Number(raw)<0?'不限制':`${raw} FPS`;
      if(['CurrentRp','ExposeExp','CurrentEarnThisTimeRp','DroneMissionEarnRp','StatistisMaxEarnRp','StatistisTotalEarnRp','StatistisTotalLostRp','StatistisTotalLostExp','StatistisTotalUseRp','StatistisMaxEarnRpByOneDay'].includes(field)||parent==='MissionEarnRpDict') return `${raw} RP`;
    }
    return raw;
  }
  breadcrumbs(path:SavePath):string {return path.map((key,i)=>key==='value'?'':this.name(path.slice(0,i+1))).filter(Boolean).join(' › ')||'完整存档';}
  category(field:string):string {
    if(this.meta.fieldCategories?.[field]) return this.meta.fieldCategories[field];
    if(field.startsWith('Statistis')) return 'statistics';
    return 'other';
  }
}
