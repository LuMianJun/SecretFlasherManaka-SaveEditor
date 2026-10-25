export type Translator = (message: string, ...values: unknown[]) => string;
export const formatMessage: Translator = (message, ...values) => message.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ""));
export type Key = string | number;
export type SavePath = Key[];
export interface SaveNode {
    path: SavePath;
    kind: 'object' | 'array' | 'number' | 'bool' | 'string' | 'null';
    raw: string;
    value?: string | boolean | null;
    children: Key[];
    bareKeys: string[];
}
export interface Change {
    path: SavePath;
    operation: string;
    before: string | null;
    after: string | null;
}
export interface Snapshot {
    source: string;
    sourceHash: string;
    nodes: SaveNode[];
    nodeCount: number;
    historyLength: number;
    dirty: boolean;
    changedEntries: Change[];
    identity: {
        kind: string;
        slotIndex: number | null;
        label: string;
    };
    identityError: string | null;
    repairRequiresCopy?: boolean;
}
export interface Rules {
    keyTables: Record<string, string>;
    valueTables: Record<string, string>;
    listTables: Record<string, string>;
    reinforcementTables: string[];
    lockTables: string[];
    stageDroneTables: string[];
}
export type SaveType = 'manual' | 'system' | 'progress';
export interface ScopeRule {
    path: string[];
    types: SaveType[];
    description: string;
    badge?: string;
    state?: 'read' | 'metadata' | 'reset' | 'conditional';
}
export interface SaveScopes {
    typeLabels: Record<SaveType, string>;
    gameFields: string[];
    rules: ScopeRule[];
}
export interface FieldScope {
    range: string;
    description: string;
    badge: string;
    state: string;
}
export interface Metadata {
    labels: Record<string, string>;
    categories: Record<string, string>;
    fieldCategories?: Record<string, string>;
    catalog: Record<string, any>;
    options: Record<string, Record<string, string>>;
    rules: Rules;
    saveScopes?: SaveScopes;
    hiddenRootFields?: string[];
    hiddenFieldPaths?: string[][];
    foldedFieldPaths?: string[][];
    hideUnknownEntryTables?: string[];
    skillMaxLevels?: Record<string, number>;
    commonFields?: string[];
}
export const pathKey = (path: SavePath) => JSON.stringify(path);
export const numeric = (node: SaveNode) => node.kind === 'number' ? node.raw.trim() : node.kind === 'bool' ? (node.value ? 'true' : 'false') : String(node.value ?? '');
export interface Choice {
    raw: string;
    name: string;
}
export class Semantics {
    constructor(public meta: Metadata, private tr: Translator = formatMessage) { }
    private matchesPrefix(path: SavePath, prefix: SavePath): boolean { return prefix.length <= path.length && prefix.every((key, i) => String(path[i]) === String(key)); }
    isVisible(path: SavePath, nodes?: Map<string, SaveNode>): boolean {
        if (!path.length)
            return true;
        if (this.meta.hiddenRootFields?.includes(String(path[0])) || this.meta.hiddenFieldPaths?.some(prefix => this.matchesPrefix(path, prefix)))
            return false;
        if (path[0] === 'GameStateData' && path[1] === 'value' && path.length >= 4) {
            const table = this.meta.rules.keyTables[String(path[2])];
            if (table && this.meta.hideUnknownEntryTables?.includes(table) && !Object.hasOwn(this.table(table), String(path[3])))
                return false;
        }
        const partsIndex = path.indexOf('CosplayPartsOptionDataDict');
        const partsContext = path[0] === 'GameStateData' && path[1] === 'value' && (partsIndex === 2 || (path[2] === 'LoadoutDatas' && partsIndex === 4));
        if (partsContext && path.length > partsIndex + 2) {
            const info = this.meta.catalog.cosplay_part_options?.[String(path[partsIndex + 1])];
            if (info) {
                const field = String(path[partsIndex + 2]);
                if (['r', 'g', 'b', 'shadeColor'].includes(field) && info.canChangeColor === false)
                    return false;
                if (field === 'invisible' && info.canChangeInvisible === false)
                    return false;
                if (field === 'materialIndex' && !info.materialIndex)
                    return false;
                if (['boolOption1', 'boolOption2'].includes(field) && !info[field])
                    return false;
            }
        }
        // Presets keep their own switches; never filter a preset using the active appearance.
        const preset = path[0] === 'GameStateData' && path[1] === 'value' && path[2] === 'LoadoutCustomizeDatas' && path.length >= 5;
        const custom = path[0] === 'PlayerCustomData' && path[1] === 'value' && path.length >= 3;
        if (nodes && (custom || preset)) {
            const parent = custom ? ['PlayerCustomData', 'value'] : path.slice(0, 4);
            const field = String(path[parent.length]);
            const flag = (key: string) => { const node = nodes.get(pathKey([...parent, key])); return node?.kind === 'bool' ? node.value : undefined; };
            const free = flag(preset ? 'CustomizeIsSkinColorFree' : 'CustomIsSkinColorFree');
            if (['CustomizeSkinColorR', 'CustomizeSkinColorG', 'CustomizeSkinColorB'].includes(field) && free === false)
                return false;
            if (field === 'CustomizeSkinColor' && free === true)
                return false;
            if (field === 'CustomizeEyeLeftPattern' && flag('CustomizeOddEye') === false)
                return false;
            if (custom && field.startsWith('CustomizeFutanari')) {
                const mode = nodes.get(pathKey(['GameStateData', 'value', 'IsActiveFutanari']));
                if (mode?.kind === 'bool' && mode.value === false)
                    return false;
            }
        }
        return true;
    }
    isFolded(path: SavePath): boolean { return !!this.meta.foldedFieldPaths?.some(prefix => this.matchesPrefix(path, prefix)); }
    skillRange(path: SavePath): {
        min: number;
        max: number;
    } | null {
        if (path.length !== 4 || path[0] !== 'GameStateData' || path[1] !== 'value' || path[2] !== 'SkillLevel')
            return null;
        const max = this.meta.skillMaxLevels?.[String(path[3])];
        return typeof max === 'number' && Number.isInteger(max) && max >= 0 ? { min: 0, max } : null;
    }
    editError(path: SavePath, fragment: string, currentRaw: string): string | null {
        const range = this.skillRange(path);
        if (!range || fragment.trim() === currentRaw.trim())
            return null;
        let value: unknown;
        try {
            value = JSON.parse(fragment);
        }
        catch {
            return this.tr("技能等级必须是整数。");
        }
        return typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max ? null : this.tr("{0}只能设置为 {1}～{2} 级整数。", this.name(path), range.min, range.max);
    }
    table(name: string | undefined): Record<string, string> { return name ? (this.meta.catalog[name] ?? this.meta.options[name] ?? {}) : {}; }
    named(table: string, id: Key): string {
        if (table === 'drop_items') {
            const n = Number(id);
            if (n >= 10000 && n < 10010)
                return this.tr("落地假阳具 {0}", n - 9999);
            if (n >= 10100 && n < 10110)
                return this.tr("壁挂假阳具 {0}", n - 10099);
        }
        const name = this.table(table)[String(id)];
        if (name !== undefined) {
            // Original mission IDs encode MMissionArea.StageType * 10000 + record index.
            if (table === 'missions') {
                const stage = this.table('stages')[String(Math.floor(Number(id) / 10000))];
                if (stage !== undefined)
                    return `【${stage}】${name}`;
            }
            return name;
        }
        if (table === 'missions' || table === 'drone_missions')
            return this.tr("未知任务（编号 {0}，存档未记录名称）", id);
        return this.tr("未知条目（编号 {0}）", id);
    }
    name(path: SavePath): string {
        if (!path.length)
            return this.tr("完整存档");
        const field = path.at(-1)!, parent = String(path.at(-2) ?? ''), grand = String(path.at(-3) ?? '');
        if (this.meta.rules.keyTables[parent])
            return this.named(this.meta.rules.keyTables[parent], field);
        if (this.meta.rules.stageDroneTables.includes(grand)) {
            const name = this.named('drone_missions', field), stage = this.table('stages')[parent];
            return stage !== undefined ? `【${stage}】${name}` : name;
        }
        if (typeof field === 'number') {
            if (this.meta.rules.reinforcementTables.includes(grand))
                return this.tr("强化效果 {0}", field + 1);
            if (this.meta.rules.lockTables.includes(grand))
                return field < 3 ? this.tr("锁定强化效果 {0}", field + 1) : this.tr("仅负面效果");
            if (['LoadoutDatas', 'LoadoutCustomizeDatas', 'CosplayMySetNames', 'CustomizeMySetNames'].includes(parent))
                return this.tr("方案 {0}", field + 1);
            if (['RankData', 'DifficultData', 'TotalPlayTimeData', 'ManualSaveTime'].includes(parent))
                return this.tr("存档槽位 {0}", field + 1);
            return this.tr("第 {0} 项", field + 1);
        }
        if (grand === 'CosplayPartsOptionDataDict') {
            const info = this.meta.catalog.cosplay_part_options?.[parent] ?? {};
            if (info[field])
                return typeof info[field] === 'string' ? info[field] : (this.meta.labels[field] ?? field);
            if (field === 'materialIndex' && info.materialLabel)
                return info.materialLabel;
        }
        return this.meta.labels[field] ?? field;
    }
    booleanNames(path: SavePath): [
        string,
        string
    ] {
        const f = String(path.at(-1) ?? ''), parent = String(path.at(-2) ?? ''), grand = String(path.at(-3) ?? '');
        if (['PlayerCosplayPartsDict', 'MAdultGoodsDict', 'PlayerCostumeDict'].includes(parent))
            return [this.tr("已装备"), this.tr("未装备（已拥有）")];
        if (parent === 'ClothesDict')
            return [this.tr("已拥有"), this.tr("未拥有")];
        if (f.startsWith('IsOpen') || f === 'AnsweredFirstSexOption')
            return [this.tr("已看过"), this.tr("未看过")];
        if (f === 'IsDaytime')
            return [this.tr("白天"), this.tr("夜晚")];
        const states: Record<string, [
            string,
            string
        ]> = { IsTrial: [this.tr("试玩版存档"), this.tr("正式版存档")], IsDroneNeedCharge: [this.tr("需要充电"), this.tr("无需充电")], IsDropped: [this.tr("已掉落"), this.tr("未掉落")], IsReserve: [this.tr("已预定生成"), this.tr("未预定生成")], IsExist: [this.tr("存在"), this.tr("不存在")], invisible: [this.tr("隐藏"), this.tr("显示")], PlayerIsAttachHandcuffs: [this.tr("已佩戴"), this.tr("未佩戴")], PlayerIsAttachMapHandcuffs: [this.tr("已固定"), this.tr("未固定")] };
        if (states[f])
            return states[f];
        if (f.endsWith('Disable'))
            return [this.tr("已禁用"), this.tr("未禁用")];
        if (this.meta.rules.lockTables.includes(grand) && Number(f) < 3)
            return [this.tr("已锁定"), this.tr("未锁定")];
        return [this.tr("开启"), this.tr("关闭")];
    }
    choices(node: SaveNode, nodes?: Map<string, SaveNode>): Choice[] {
        if (node.kind === 'bool') {
            const [yes, no] = this.booleanNames(node.path);
            return [{ raw: 'false', name: no }, { raw: 'true', name: yes }];
        }
        if (node.kind !== 'number')
            return [];
        const range = this.skillRange(node.path);
        if (range)
            return Array.from({ length: range.max + 1 }, (_, level) => ({ raw: String(level), name: level === 0 ? this.tr("未学习（0 级）") : range.max === 1 ? this.tr("已学习（1 级）") : this.tr("{0} 级{1}", level, level === range.max ? this.tr("（满级）") : '') }));
        const field = String(node.path.at(-1) ?? ''), parent = String(node.path.at(-2) ?? ''), grand = String(node.path.at(-3) ?? '');
        let table = this.meta.rules.valueTables[field];
        if (this.meta.rules.reinforcementTables.includes(grand))
            table = 'reinforce';
        if (this.meta.rules.listTables[parent])
            table = this.meta.rules.listTables[parent];
        if (field.startsWith('RingShortcutModelIndex'))
            table = 'ring_actions';
        if (field === 'CustomizeSkinColor')
            table = 'skin_colors';
        let opts: Record<string, string> = { ...(table ? this.table(table) : this.meta.options[field] ?? {}) };
        if (field.startsWith('RingShortcutModelIndex'))
            opts['-1'] = this.tr("未设置");
        const difficulty = field === 'DifficultType' || parent === 'DifficultData' || (grand === 'DifficultData' && parent === 'value');
        if (difficulty)
            return ['1', '2'].map(raw => ({ raw, name: this.meta.options.DifficultType[raw] }));
        if (parent === 'RandomMissionClearNumIdDict')
            opts = { '-1': this.tr("未通关"), '0': this.tr("已通关 10 个任务"), '1': this.tr("已通关 20 个任务"), '2': this.tr("已通关全部任务") };
        if (field === 'Resolusion') {
            const wide = nodes?.get(pathKey(['OptionData', 'value', 'AspectRatioIndex']))?.raw.trim() === '1';
            const sizes = wide ? ['1920×800', '2560×1080', '3440×1440', '5120×2160'] : ['1280×720', '1920×1080', '2560×1440', '3840×2160'];
            opts = Object.fromEntries(sizes.map((v, i) => [String(i), v]));
        }
        if (field === 'materialIndex' && grand === 'CosplayPartsOptionDataDict')
            opts = { ...(this.meta.catalog.cosplay_part_options?.[parent]?.materialIndex ?? {}) };
        if (table === 'drop_items')
            for (const start of [10000, 10100])
                for (let n = start; n < start + 10; n++)
                    opts[String(n)] = this.named('drop_items', n);
        if (['PlayerCurrentHoldClothes', 'PlayerCurrentClothes', 'CurrentHair', 'ActiveDroneMissionId'].includes(field))
            opts['-1'] = this.tr("无 / 未设置");
        if (!Object.keys(opts).length)
            return [];
        const raw = numeric(node);
        if (!(raw in opts))
            opts[raw] = this.tr("未知选项（编号 {0}）", raw);
        const names = Object.values(opts);
        return Object.entries(opts).map(([raw, name]) => ({ raw, name: names.filter(v => v === name).length > 1 ? this.tr("{0}（编号 {1}）", name, raw) : name }));
    }
    value(node: SaveNode, nodes?: Map<string, SaveNode>): string {
        const opts = this.choices(node, nodes);
        if (opts.length)
            return opts.find(v => v.raw === numeric(node))?.name ?? (this.skillRange(node.path) ? this.tr("超出原版范围（原值 {0}）", numeric(node)) : (node.path.at(-1) === 'DifficultType' || node.path.at(-2) === 'DifficultData' || node.path.at(-3) === 'DifficultData') && numeric(node) === '0' ? this.tr("休闲（原版未开放）") : this.tr("未知选项（编号 {0}）", numeric(node)));
        const field = String(node.path.at(-1) ?? ''), parent = String(node.path.at(-2) ?? ''), grand = String(node.path.at(-3) ?? '');
        if (node.kind === 'object' || node.kind === 'array') {
            if (node.kind === 'array' && this.meta.rules.reinforcementTables.includes(parent) && nodes)
                return node.children.map(k => this.named('reinforce', nodes.get(pathKey([...node.path, k]))?.raw.trim() ?? '?')).join('；');
            return this.tr("{0} 个条目", node.children.filter(key => this.isVisible([...node.path, key], nodes)).length);
        }
        if (node.kind === 'string')
            return String(node.value ?? '');
        if (node.kind === 'null')
            return this.tr("空值");
        const raw = node.raw.trim();
        if (node.kind === 'number') {
            if (field === 'MotionSpeedScaleIndex' || field === 'WalkSpeedScaleIndex') {
                const index = Number(raw);
                const step = field === 'WalkSpeedScaleIndex' ? 0.05 : index < 0 ? 0.1 : 0.2;
                return this.tr("{0} 倍", Number((1 + index * step).toFixed(8)));
            }
            if (['StatistisTotalPlayTime', 'StatistisTotalExposeTime'].includes(field)) {
                const n = Number(raw);
                return this.tr("{0} 小时 {1} 分 {2} 秒", Math.floor(n / 3600), Math.floor(n % 3600 / 60), Math.floor(n % 60));
            }
            if (field === 'PlayerFear')
                return this.tr("恐惧等级 {0}（进度 {1}%）", 5 - Math.trunc(Number(raw)), Number(((Number(raw) % 1) * 100).toFixed(1)));
            if (field === 'StatistisMaxRpBoost')
                return this.tr("{0} 倍", raw);
            if (parent === 'MissionSatisfyDict')
                return `${Number((Number(raw) * 100).toFixed(5))}%`;
            if (['PlayerLife', 'PlayerMaxLife', 'StatistisGameOverCount', 'StatistisEcstasyCount', 'StatistisMissionAchiveCount'].includes(field))
                return this.tr("{0} 次", raw);
            if (field === 'StatistisMaxNudeMoveDistance')
                return this.tr("{0} 米", raw);
            if (field.includes('RemainTime') || field === 'PlayerHandcuffTimerSetTime')
                return this.tr("{0} 秒", raw);
            if (!/^-?\d+$/.test(field) && (field.startsWith('Sound') || field.endsWith('100')))
                return `${raw}%`;
            if (parent === 'MissionMaxRpBonus100Dict' || grand === 'DroneMissionMaxRpBonus100PerStageDictDict')
                return this.tr("{0} 倍", Number(raw) / 100);
            if (parent === 'ItemDict')
                return this.tr("{0} 个", raw);
            if (['MissionAchieveCountDict', 'ContinueMissionAchieveCountDict', 'DroneMissionAchieveCountDict'].includes(parent) || grand === 'DroneMissionAchieveCountPerStageDictDict')
                return this.tr("{0} 次", raw);
            if (parent === 'SkillLevel')
                return this.tr("{0} 级", raw);
            if (field === 'MaxFrameRate')
                return Number(raw) < 0 ? this.tr("不限制") : `${raw} FPS`;
            if (['CurrentRp', 'ExposeExp', 'CurrentEarnThisTimeRp', 'DroneMissionEarnRp', 'StatistisMaxEarnRp', 'StatistisTotalEarnRp', 'StatistisTotalLostRp', 'StatistisTotalLostExp', 'StatistisTotalUseRp', 'StatistisMaxEarnRpByOneDay'].includes(field) || parent === 'MissionEarnRpDict')
                return `${raw} RP`;
        }
        return raw;
    }
    breadcrumbs(path: SavePath): string { return path.map((key, i) => key === 'value' ? '' : this.name(path.slice(0, i + 1))).filter(Boolean).join(' › ') || this.tr("完整存档"); }
    saveType(snapshot: Pick<Snapshot, 'source' | 'identity'>): {
        type: SaveType;
        label: string;
    } {
        const filename = snapshot.source.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
        let type: SaveType = 'progress';
        // The parsed content is authoritative; a renamed system save is still system data.
        if (snapshot.identity.kind === 'system')
            type = 'system';
        else if (snapshot.identity.kind === 'progress') {
            if (/^(?:[0-9]|1[0-9])\.sd$/.test(filename))
                type = 'manual';
        }
        return { type, label: this.meta.saveScopes?.typeLabels[type] ?? (type === 'system' ? this.tr("系统存档") : this.tr("进度存档")) };
    }
    scope(path: SavePath, snapshot: Pick<Snapshot, 'source' | 'identity'>): FieldScope | null {
        if (!path.length || !this.meta.saveScopes)
            return null;
        const data = this.meta.saveScopes, current = this.saveType(snapshot);
        const unknown = (): FieldScope => ({ range: this.tr("尚未核实"), description: this.tr("尚未确认原版是否读取此字段。保留编辑能力，不据字段存在推断修改会生效。"), badge: this.tr("作用待核实"), state: 'unknown' });
        if (path[0] === 'GameStateData' && path[1] === 'value' && path.length > 2 && !data.gameFields.includes(String(path[2])))
            return unknown();
        let rule: ScopeRule | undefined;
        for (const candidate of data.rules)
            if (candidate.path.length <= path.length && candidate.path.every((key, i) => String(path[i]) === key) && (!rule || candidate.path.length > rule.path.length))
                rule = candidate;
        if (!rule)
            return unknown();
        const range = rule.types.length === 1 && rule.types[0] === 'manual' ? this.tr("进度存档") : rule.types.map(t => data.typeLabels[t]).join('、');
        const applicable = rule.types.includes(current.type) || (current.type === 'progress' && rule.types.some(t => t !== 'system'));
        if (!applicable)
            return { range, description: this.tr("{0}写在当前文件中，原版不会从这里使用它。{1}", rule.types.includes('system') ? this.tr("此项只从系统存档 s.sd 读取。") : this.tr("此项只从进度存档读取。"), rule.description), badge: this.tr("此档不读取"), state: 'ignored' };
        // Ordinary applicability is implicit. Show only specific editing consequences.
        const specific = rule.state && rule.state !== 'read';
        const useful = ['CurrentRp', 'ExposeExp'].includes(String(rule.path.at(-1)));
        const appearance = rule.path[0] === 'PlayerCustomData' && path.length <= 2;
        if (!specific && !useful && !appearance)
            return null;
        return { range, description: rule.description, badge: rule.badge ?? '', state: rule.state ?? 'read' };
    }
    category(field: string): string {
        if (this.meta.fieldCategories?.[field])
            return this.meta.fieldCategories[field];
        if (field.startsWith('Statistis'))
            return 'statistics';
        return 'other';
    }
}
