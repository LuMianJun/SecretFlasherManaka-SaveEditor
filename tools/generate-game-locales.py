"""Export only names used by the editor from the supplied original TSV/assets.

Usage: python generate-game-locales.py --dictionary dictionary.txt --assets Assets/MonoBehaviour --repo . --output out
Requires PyYAML when regenerating; the application uses the checked-in JSON only.
The output directory must exist. game-text.json and pending.json are audit aids;
only game-locales.json is consumed by the application.
"""
import argparse,collections,csv,hashlib,json,re
from pathlib import Path
import yaml

p=argparse.ArgumentParser();p.add_argument('--dictionary',type=Path,required=True);p.add_argument('--assets',type=Path,required=True);p.add_argument('--repo',type=Path,required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args()
locales=['sc','tc','en','ja','ko']
rows=list(csv.DictReader(args.dictionary.open(encoding='utf-8-sig'),delimiter='\t'))
dictionary={row['key']:row for row in rows}
reverse=collections.defaultdict(list)
for row in rows:
 if row['sc']:reverse[row['sc']].append(row)
metadata=json.loads((args.repo/'tauri/metadata.json').read_text(encoding='utf-8'))
fields=json.loads((args.repo/'tauri/ui/src/data/field_labels.json').read_text(encoding='utf-8'))
guid_files={}
for file in args.assets.glob('*.asset.meta'):
 match=re.search(r'^guid: (\w+)',file.read_text(encoding='utf-8'),re.M)
 if match:guid_files[match[1]]=file.with_suffix('')
cache={}
def asset(file):
 file=Path(file)
 if file not in cache:
  text=file.read_text(encoding='utf-8');text='\n'.join(line for line in text.splitlines() if not line.startswith(('%','---')))
  cache[file]=yaml.safe_load(text)['MonoBehaviour']
 return cache[file]
def deref(value):return asset(guid_files[value['guid']])
def trans(key,locale,*values):
 text=dictionary.get(key,{}).get(locale) or key
 for i,value in enumerate(values):text=text.replace('{'+str(i)+'}',str(value))
 return text
provenance={};unresolved=set()
patterns=[]
for row in rows:
 text=row['sc']
 if not text or not re.search(r'\{\d+\}',text):continue
 parts=re.split(r'(\{\d+\})',text);groups=[];pattern=''
 for part in parts:
  if re.fullmatch(r'\{\d+\}',part):groups.append(int(part[1:-1]));pattern+='(.+?)'
  else:pattern+=re.escape(part)
 patterns.append((re.compile('^'+pattern+'$'),row,groups))
def match_text(text,context=''):
 candidates=reverse.get(text,[])
 if candidates:
  priority={'reinforce':'ui_reinforce_','skills':'ui_skill_','missions':'m_mission_','drone_missions':'m_drone_','items':'m_item_','cosplay_parts':'m_cosplay_','stages':'m_stage_'}.get(context,'')
  candidates=sorted(candidates,key=lambda row:(not bool(priority and row['key'].startswith(priority)),len(row['key']),row['key']))
  return candidates[0],[]
 for pattern,row,groups in patterns:
  match=pattern.fullmatch(text)
  if match:
   values=['']*(max(groups)+1)
   for index,value in zip(groups,match.groups()):values[index]=value
   return row,values
 return None,None
def localized(text,locale,context,path):
 if not isinstance(text,str):return text
 row,values=match_text(text,context)
 if row:
  provenance[path]={'key':row['key'],'args':values};return trans(row['key'],locale,*values)
 if not re.search('[\u3400-\u9fff]',text):return text
 unresolved.add(text);return text
def walk(value,locale,context,path):
 if isinstance(value,dict):return {key:walk(child,locale,context,path+'/'+key) for key,child in value.items()}
 return localized(value,locale,context,path)
catalogs={locale:{table:walk(values,locale,table,'catalog/'+table) for table,values in metadata['catalog'].items() if table!='meta'} for locale in locales}
def set_name(table,id,key,args_for=lambda locale:[]):
 for locale in locales:catalogs[locale][table][str(id)]=trans(key,locale,*args_for(locale))
 provenance['catalog/'+table+'/'+str(id)]={'key':key,'argsByLocale':{locale:args_for(locale) for locale in locales}}
def property(record,key):return record.get(key,record.get('<'+key+'>k__BackingField'))
# Prefer master-owned NameKey fields to reverse matching: identical Chinese names
# can refer to different English/Korean terms (e.g. Eye Mask versus Blindfold).
for table,master,field,id_field in [
 ('items','MItem','records','Type'),('goods','MAdultGoods','records','Type'),
 ('skills','MSkill','skills','Type'),('costumes','MCostume','records','Type'),
 ('clothes','MClothes','clothes','ClothesType'),('body_paint','MBodyPaint','records','Type'),
 ('stages','MStage','stages','StageType'),('drone_missions','MDroneMission','records',None),
 ('fast_travel','MFastTravel','records',None)]:
 for index,ref in enumerate(asset(args.assets/(master+'.asset'))[field]):
  record=deref(ref);id=str(index if id_field is None else property(record,id_field))
  if id not in metadata['catalog'][table]:continue
  key=record.get('StageNameKey') if table=='stages' else property(record,'NameKey')
  if key:set_name(table,id,key)
for ref in asset(args.assets/'MCosplay.asset')['records']:
 record=deref(ref);type=record['Type'];set_name('cosplay',type,record['SeriesNameKey'])
 for index,ref in enumerate(record.get('PartsRecords') or []):
  part=deref(ref);id=str(type*10000+index)
  if id in metadata['catalog']['cosplay_parts']:set_name('cosplay_parts',id,property(part,'NameKey'))

# Mirror MMissionOverrideRecord.GetMissionName's original numeric/area argument.
areas={1:'ui_mission_area_crossing',2:'ui_mission_area_entrance',4:'ui_mission_area_regi',5:'ui_mission_area_park_central',6:'ui_mission_area_park_maze',7:'ui_mission_area_bridge'}
for file in args.assets.glob('MMissionArea*.asset'):
 area=asset(file);stage=area.get('<StageType>k__BackingField')
 if stage is None:continue
 for index,ref in enumerate(area.get('records',[])):
  id=str(stage*10000+index)
  if id not in metadata['catalog']['missions']:continue
  override=deref(ref);original=deref(override['OriginalRecord']);key=original['NameKey']
  if original.get('CategoryType')==4:
   area_key=areas.get(override.get('AreaType'))
   set_name('missions',id,key,lambda locale,k=area_key:[trans(k,locale) if k else ''])
  else:set_name('missions',id,key,lambda locale,n=int(override.get('FloatParam',0)):[str(n)])
for index,ref in enumerate(asset(args.assets/'MReinforceEffect.asset')['records'],1):
 record=deref(ref);key=record['NameKey'];amount=record['EffectAmount100'];suffix=f' {amount:+d}%'
 for locale in locales:catalogs[locale]['reinforce'][str(index)]=trans(key,locale)+suffix
 provenance['catalog/reinforce/'+str(index)]={'key':key,'suffix':suffix}
# Names baked as Japanese literals in old records have no localized dictionary entry.
# Preserve that original literal rather than inventing a different in-game name.
literal_overrides=metadata['catalog']['meta'].get('literal_translation_overrides',{})
for table in ['items','costumes','clothes','stages']:
 for id,text in metadata['catalog'][table].items():
  for literal,old in literal_overrides.items():
   if text==old and 'catalog/'+table+'/'+id not in provenance:
    for locale in locales:catalogs[locale][table][id]=trans(literal,locale)
    provenance['catalog/'+table+'/'+id]={'literal':literal}
for locale in locales:
 for id,text in catalogs[locale]['skin_colors'].items():catalogs[locale]['skin_colors'][id]=trans('ui_Closet_body_SkinColor',locale)+' '+text.split()[-1]
for index,ref in enumerate(asset(args.assets/'MAchievement.asset')['records']):
 if str(index) not in metadata['catalog']['achievements']:continue
 record=deref(ref);key=record['NameKey'];kind=record['AchievementConditionType']
 if kind==1:set_name('achievements',index,key,lambda locale,n=record['ConditionHighScore']:[str(n)])
 elif kind==2:set_name('achievements',index,key,lambda locale,stage=record['ConditionStageType'],n=record['ConditionPercent100']:[catalogs[locale]['stages'][str(stage)],str(n)])
 else:set_name('achievements',index,key)
game_text={}
message_keys=list(json.loads((args.repo/'tauri/ui/src/data/messages.json').read_text(encoding='utf-8')))
for text in message_keys:
 row,values=match_text(text)
 if row:game_text[text]={locale:trans(row['key'],locale,*values) for locale in locales}
overlays={locale:{'catalog':catalogs[locale],'labels':{}} for locale in locales}
for field,key in fields['originalUiKeys'].items():
 if key not in dictionary:continue
 for locale in locales:overlays[locale]['labels'][field]=trans(key,locale)
 provenance['labels/'+field]={'key':key}
 game_text[metadata['labels'][field]]={locale:trans(key,locale) for locale in locales}
# Retain every original dictionary key selected by any renderer for independently
# checking exact source wording without shipping unrelated game dialogue.
used_keys={entry['key'] for entry in provenance.values() if 'key' in entry}
for text in game_text:
 row,_=match_text(text)
 if row:used_keys.add(row['key'])
output={'source':{'dictionarySha256':hashlib.sha256(args.dictionary.read_bytes()).hexdigest(),'locales':locales,'terms':'Original dictionary columns; mission parameters follow MMissionOverrideRecord.GetMissionName'},'locales':overlays,'provenance':provenance,'dictionary':{key:{locale:trans(key,locale) for locale in locales} for key in sorted(used_keys)}}
(args.output/'game-locales.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(args.output/'game-text.json').write_text(json.dumps(game_text,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
pending=[text for text in message_keys if text not in game_text]
(args.output/'pending.json').write_text(json.dumps(pending,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'officialUiMessages':len(game_text),'editorMessagesPending':len(pending),'provenance':len(provenance),'literalNameKeys':sorted({entry.get('literal',entry.get('key')) for entry in provenance.values() if entry.get('literal') or (entry.get('key') and entry['key'] not in dictionary)})},ensure_ascii=False))
