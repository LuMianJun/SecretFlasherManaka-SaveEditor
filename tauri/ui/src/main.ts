import {tr, backendText, getLocale, setLocale, isLocale, languages, localizeMetadata, type Locale} from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Semantics, pathKey, numeric, type Metadata, type Snapshot, type SaveNode, type SavePath, type Key } from './semantics';
import './style.css';
const icons: Record<string, string> = { folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>', save: '<path d="M5 3h12l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>', chevron: '<path d="m9 5 7 7-7 7"/>', undo: '<path d="M3 10h10a7 7 0 1 1 0 14M3 10l5-5M3 10l5 5"/>', sliders: '<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>', spark: '<path d="m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3 3-6Z"/>', check: '<path d="m5 12 4 4 10-10"/>', plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', person: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>', map: '<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5ZM9 3v16M15 5v16"/>', book: '<path d="M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3V4ZM12 6v15"/>', box: '<path d="m3 7 9-4 9 4v10l-9 4-9-4V7ZM3 7l9 4 9-4M12 11v10"/>', chart: '<path d="M4 3v18h17M9 17v-4M14 17V8M19 17V4"/>' };
const svg = (name: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? icons.grid}</svg>`;
const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const app = document.querySelector<HTMLDivElement>('#app')!;
let baseMetadata: Metadata;
let metadata: Metadata, sem: Semantics, snapshot: Snapshot | null = null, nodes = new Map<string, SaveNode>();
let active = 'common', query = '', selected: string | null = null, expanded = new Set<string>(), showRaw = false, busy = false, draft = '', draftInitial = '', lastSaved = false, persisting = false;
const rawOpenPaths = new Set<string>();
const openFoldedCategories = new Set<string>();
const categoryIcons: Record<string, string> = { common: 'spark', basic: 'grid', player: 'person', tasks: 'book', inventory: 'box', growth: 'spark', world: 'map', statistics: 'chart', character: 'person', settings: 'sliders', other: 'folder' };
function mountShell() {
app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><div class="brand-icon">${svg('sliders')}</div><div class="brand-name">SecretFlasherManaka<span>${escape(tr("存档编辑器"))}</span></div></div><div class="nav-label">${escape(tr("存档内容"))}</div><nav id="categories"></nav><div class="nav-label advanced-label">${escape(tr("高级"))}</div><button class="nav-item raw-nav" data-category="raw">${svg('book')}<span>${escape(tr("完整原始结构"))}</span></button><label class="locale-control"><span>${escape(tr("编辑器语言"))}</span><select id="ui-language" aria-label="${escape(tr("编辑器语言"))}">${languages.map(language=>`<option value="${language.id}" ${language.id===getLocale()?"selected":""}>${language.name}</option>`).join("")}</select></label><div class="sidebar-bottom"><span class="status-dot"></span>${escape(tr("本地运行 · 存档编辑"))}<small>${escape(tr("存档数据不会上传"))}</small></div></aside><main class="workspace"><header class="topbar"><div><span class="eyebrow">SAVE EDITOR</span><h1>${escape(tr("存档管理与编辑"))}</h1><p>${escape(tr("读取完整存档，按原版名称编辑。"))}</p></div><div class="header-actions"><button class="button secondary" id="repair">${svg('sliders')}${escape(tr("修复存档"))}</button><button class="button secondary" id="open">${svg('folder')}${escape(tr("打开存档"))}</button><button class="button secondary" id="save-as">${svg('folder')}${escape(tr("另存为"))}</button><button class="button primary" id="save">${svg('save')}${escape(tr("保存"))}</button></div></header><section id="source" class="source-card"></section><div id="notice" class="notice" role="status" hidden></div><section class="content-card"><div class="content-toolbar"><div><h2 id="category-title"></h2><span id="category-summary"></span></div><div class="table-actions"><label class="search">${svg('search')}<input id="search" placeholder="${escape(tr("搜索字段、物品或当前值"))}" spellcheck="false"><button id="clear-search" title="${escape(tr("清除搜索"))}" hidden>×</button></label><button id="undo" class="icon-button" title="${escape(tr("撤销上一步"))}">${svg('undo')}</button><button id="changes" class="button subtle">${escape(tr("改动"))} <span id="change-count">0</span></button></div></div><div class="editor-layout"><section class="data-pane"><div class="table-heading"><span>${escape(tr("存档内容"))}</span><span>${escape(tr("当前值"))}</span></div><div id="data-list" class="data-list"></div><div class="table-footer"><label><input type="checkbox" id="show-raw">${escape(tr("显示原始字段与编号"))}</label><button id="reset" class="text-button">${escape(tr("还原全部修改"))}</button></div></section><aside id="details" class="details-pane"></aside></div></section><footer class="page-footer"><span id="footer-state"></span><span>${escape(tr("原版数据结构 · 加密后自动校验"))}</span></footer></main></div><div id="modal-root"></div>`;
    el<HTMLInputElement>('search').value=query;
    el<HTMLInputElement>('show-raw').checked=showRaw;
    el('clear-search').hidden=!query;
    bindShellEvents();
    el<HTMLSelectElement>('ui-language').onchange=async event=>{
        const value=(event.target as HTMLSelectElement).value;
        if(isLocale(value))await changeLanguage(value);
    };
}
async function changeLanguage(locale:Locale) {
    if(busy||persisting||el('modal-root').children.length)return;
    busy=true;updateButtons();
    try {
        await invoke('set_ui_locale',{locale});
        setLocale(locale);
        metadata=localizeMetadata(baseMetadata);
        sem=new Semantics(metadata,tr);
        mountShell();render();
    }catch(error){el<HTMLSelectElement>('ui-language').value=getLocale();notice(backendText(String(error)),true);}
    finally{busy=false;updateButtons();}
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function notice(text: string, error = false) { const target = el('notice'); target.hidden = !text; target.classList.toggle('error', error); target.textContent = backendText(text); }
function updateSnapshot(next: Snapshot) {
    snapshot = next;
    nodes = new Map(next.nodes.map(n => [pathKey(n.path), n]));
    if (selected && (!nodes.has(selected) || !sem.isVisible(nodes.get(selected)!.path, nodes)))
        selected = null;
    if (!selected) {
        const first = next.nodes.find(n => pathKey(n.path) === pathKey(['GameStateData', 'value', 'CurrentRp']));
        if (first)
            selected = pathKey(first.path);
    }
    if (selected) {
        const n = nodes.get(selected)!;
        draft = n.kind === 'string' ? String(n.value ?? '') : n.raw;
        draftInitial = draft;
    }
    lastSaved = false;
    render();
}
async function action<T>(work: () => Promise<T>, apply = true): Promise<T | undefined> {
    if (busy)
        return;
    busy = true;
    updateButtons();
    notice('');
    try {
        const result = await work();
        if (apply && result && typeof result === 'object' && 'nodes' in result)
            updateSnapshot(result as unknown as Snapshot);
        return result;
    }
    catch (error) {
        notice(String(error), true);
        return undefined;
    }
    finally {
        busy = false;
        updateButtons();
    }
}
function updateButtons() { for (const id of ['open', 'save', 'save-as', 'undo', 'reset', 'repair']) {
    const b = el<HTMLButtonElement>(id);
    b.disabled = busy || persisting || (id !== 'open' && !snapshot) || (id === 'undo' && !snapshot?.historyLength) || (id === 'repair' && snapshot?.identity.kind === 'system');
} ; el<HTMLButtonElement>('save').classList.toggle('working', busy);
    el<HTMLSelectElement>('ui-language').disabled=busy||persisting||el('modal-root').children.length>0; }
function rootFields(): {
    path: SavePath;
    category: string;
    title?: string;
}[] {
    if (!snapshot)
        return [];
    const result: {
        path: SavePath;
        category: string;
        title?: string;
    }[] = [];
    const game = nodes.get(pathKey(['GameStateData', 'value']));
    if (game)
        for (const key of game.children) {
            const path = [...game.path, key];
            if (sem.isVisible(path, nodes))
                result.push({ path, category: sem.category(String(key)) });
        }
    const root = nodes.get(pathKey([]));
    for (const key of root?.children ?? []) {
        if (!sem.isVisible([key], nodes))
            continue;
        if (key === 'GameStateData' && game)
            continue;
        const rawPath = [key];
        const wrapped = [key, 'value'];
        const path = nodes.has(pathKey(wrapped)) ? wrapped : rawPath;
        result.push({ path, category: key === 'PlayerCustomData' ? 'character' : ['OptionData', 'TutorialData'].includes(String(key)) ? 'settings' : 'other', title: metadata.labels[String(key)] ?? String(key) });
    }
    const priority: Record<string, number> = { CurrentRp: 0, ExposeExp: 1, CurrentEarnThisTimeRp: 2, DifficultType: 3 };
    return result.sort((a, b) => (priority[String(a.path.at(-1))] ?? 99) - (priority[String(b.path.at(-1))] ?? 99));
}
function categoryFields(id: string, fields = rootFields()): ReturnType<typeof rootFields> {
    if (id !== 'common')
        return fields.filter(field => field.category === id);
    return (metadata.commonFields ?? []).flatMap(name => fields.filter(field => field.path.length === 3 && field.path[0] === 'GameStateData' && field.path[1] === 'value' && field.path[2] === name));
}
function matching(path: SavePath, memo: Map<string, boolean>): boolean {
    if (!sem.isVisible(path, nodes))
        return false;
    const id = pathKey(path);
    if (memo.has(id))
        return memo.get(id)!;
    const n = nodes.get(id);
    if (!n)
        return false;
    const direct = [sem.name(path), sem.value(n, nodes), showRaw ? String(path.at(-1)) : ''].join(' ').toLowerCase().includes(query.toLowerCase());
    const result = direct || n.children.some(k => matching([...path, k], memo));
    memo.set(id, result);
    return result;
}
function render() {
    const fields = rootFields();
    const categories = Object.entries(metadata.categories).filter(([id]) => !snapshot || categoryFields(id, fields).length > 0);
    if (snapshot && active !== 'raw' && !categories.some(([id]) => id === active))
        active = categories[0]?.[0] ?? 'other';
    const saveType = snapshot ? sem.saveType(snapshot) : null;
    el('categories').innerHTML = categories.map(([id, title]) => `<button class="nav-item ${active === id && !query ? 'active' : ''}" data-category="${id}">${svg(categoryIcons[id])}<span>${escape(title)}</span>${snapshot ? `<small>${categoryFields(id, fields).length}</small>` : ''}</button>`).join('');
    document.querySelector('.raw-nav')!.classList.toggle('active', active === 'raw' && !query);
    el('source').innerHTML = snapshot ? `<div class="source-icon">${svg('folder')}</div><div class="source-info"><div><strong>${escape(snapshot.source.split(/[\\/]/).at(-1))}</strong><span class="pill ${snapshot.identityError ? 'edited' : ''}" title="${escape(snapshot.identityError ? backendText(snapshot.identityError) : tr("存档 ID 校验通过"))}">${escape(backendText(snapshot.identity.label))}${snapshot.identityError ? tr(" · 校验未通过") : ''}</span>${snapshot.dirty ? `<span class="pill edited">${escape(tr("有暂存修改"))}</span>` : ''}</div><p title="${escape(snapshot.source)}">${escape(snapshot.source)}</p></div><div class="source-meta"><strong>${snapshot.nodeCount.toLocaleString()}</strong><span>${escape(tr("完整数据节点"))}</span></div><div class="source-meta"><strong>${snapshot.changedEntries.length}</strong><span>${escape(tr("暂存改动"))}</span></div>` : `<div class="source-icon">${svg('folder')}</div><div class="source-info"><strong>${escape(tr("从一个存档开始"))}</strong><p>${escape(tr("打开 .sd 存档，编辑后保存；也可以另存到其他位置。"))}</p></div><span class="pill neutral">${escape(tr("等待打开"))}</span>`;
    el('category-title').textContent = query ? tr("搜索结果") : active === 'raw' ? tr("完整原始结构") : metadata.categories[active];
    if (saveType) {
        const tag = document.createElement('span');
        tag.className = 'pill neutral';
        tag.textContent = saveType.label;
        tag.title = tr("按存档内容和文件名识别");
        el('source').querySelector('.source-info>div')?.append(tag);
    }
    el('category-summary').textContent = query ? tr("搜索全部分类中的名称与当前值") : active === 'raw' ? tr("包含类型信息、未知字段与其他插件数据") : tr("选择条目，查看并编辑完整内容");
    const rows: string[] = [], memo = new Map<string, boolean>();
    function row(path: SavePath, depth: number, title?: string) {
        if (!sem.isVisible(path, nodes))
            return;
        const n = nodes.get(pathKey(path));
        if (!n)
            return;
        if (query && !matching(path, memo))
            return;
        const id = pathKey(path), container = n.kind === 'object' || n.kind === 'array', opened = expanded.has(id) || !!query;
        const scope = snapshot ? sem.scope(path, snapshot) : null;
        rows.push(`<button class="data-row ${id === selected ? 'selected' : ''}" data-path="${escape(id)}" style="--depth:${depth}"><span class="row-name">${container ? `<span class="expander ${opened ? 'expanded' : ''}" data-expand="${escape(id)}">${svg('chevron')}</span>` : '<span class="leaf-dot"></span>'}<span>${escape(title ?? sem.name(path))}${scope?.badge ? `<span class="scope-badge ${escape(scope.state)}" title="${escape(scope.description)}">${escape(scope.badge)}</span>` : ''}${showRaw && path.length ? `<small>${escape(path.at(-1))}</small>` : ''}</span></span><span class="row-value ${container ? 'container-value' : ''}" title="${escape(sem.value(n, nodes))}">${escape(sem.value(n, nodes))}</span></button>`);
        if (container && opened)
            for (const key of n.children)
                row([...path, key], depth + 1);
    }
    if (snapshot) {
        if (active === 'raw' && !query)
            row([], 0);
        else {
            const current = query ? fields : categoryFields(active, fields);
            for (const field of current)
                if (query || !sem.isFolded(field.path))
                    row(field.path, 0, field.title);
            if (!query) {
                const folded = current.filter(field => sem.isFolded(field.path));
                if (folded.length) {
                    const start = rows.length;
                    for (const field of folded)
                        row(field.path, 0, field.title);
                    const contents = rows.splice(start).join('');
                    rows.push(`<details class="folded-fields" data-folded-category="${escape(active)}" ${openFoldedCategories.has(active) ? 'open' : ''}><summary>${svg('chevron')}<span>${active === 'tasks' ? tr("分地图详细记录") : active === 'settings' ? tr("设置与教程记录") : tr("游戏内可调整的内容")}</span><small>${folded.length} ${escape(tr("项"))}</small></summary>${contents}</details>`);
                }
            }
        }
    }
    el('data-list').innerHTML = rows.join('') || `<div class="empty-state">${svg(query ? 'search' : 'book')}<h3>${query ? tr("没有找到匹配内容") : snapshot ? tr("这个分类暂无内容") : tr("尚未打开存档")}</h3><p>${query ? tr("试试原版物品名、任务关键词或当前值。") : snapshot ? tr("其他分类与完整原始结构仍可查看。") : tr("点击右上角“打开存档”开始编辑。")}</p></div>`;
    el('data-list').querySelectorAll<HTMLDetailsElement>('[data-folded-category]').forEach(group => { group.ontoggle = () => { const category = group.dataset.foldedCategory!; group.open ? openFoldedCategories.add(category) : openFoldedCategories.delete(category); }; });
    el('change-count').textContent = String(snapshot?.changedEntries.length ?? 0);
    el('footer-state').innerHTML = snapshot ? `${svg('check')} ${lastSaved ? tr("已保存，加密校验通过") : snapshot.dirty ? tr("修改已暂存，尚未保存") : tr("完整读取，尚无改动")}` : tr("{0} 就绪", svg('check'));
    renderDetails();
    updateButtons();
}
function renderDetails() {
    const node = selected && sem.isVisible(nodes.get(selected)?.path ?? [], nodes) ? nodes.get(selected) : null;
    if (!node) {
        el('details').innerHTML = `<div class="detail-empty">${svg('sliders')}<h3>${escape(tr("选择一个条目"))}</h3><p>${escape(tr("字段解释、当前值与编辑选项"))}<br>${escape(tr("会显示在这里。"))}</p></div>`;
        return;
    }
    const choices = sem.choices(node, nodes), container = node.kind === 'array' || node.kind === 'object', skillRange = sem.skillRange(node.path);
    const typeNames = { object: tr("数据表"), array: tr("列表"), number: tr("数值"), bool: tr("开关"), string: tr("文本"), null: tr("空值") };
    let control = '';
    if (choices.length)
        control = `<label class="field-label" for="value-choice">${node.kind === 'bool' ? tr("状态") : tr("选择内容")}</label><select id="value-choice">${!choices.some(c => c.raw === draft.trim()) ? `<option value="" selected disabled>${skillRange ? tr("当前值超出范围，请选择合法等级") : tr("使用下方原始输入")}</option>` : ''}${choices.map(c => `<option value="${escape(c.raw)}" ${c.raw === draft.trim() ? 'selected' : ''}>${escape(c.name)}</option>`).join('')}</select><p class="input-help">${skillRange ? tr("原版范围：{0}～{1} 级；0 级表示未学习。", skillRange.min, skillRange.max) : tr("按名称选择，保存时沿用原版数据格式。")}</p>`;
    else if (!container)
        control = `<label class="field-label" for="value-input">${node.kind === 'string' ? tr("文本内容") : tr("修改当前值")}</label>${node.kind === 'string' ? `<textarea id="value-input" class="text-input" spellcheck="false">${escape(draft)}</textarea>` : `<input id="value-input" class="text-input" spellcheck="false" value="${escape(draft)}">`}<p class="input-help">${node.kind === 'string' ? tr("直接填写文字，无需添加引号。") : tr("填写数值；保留原始小数精度。")}</p>`;
    else
        control = `<div class="container-note">${svg('book')}<p>${escape(tr("展开左侧列表逐项修改。"))}<br>${escape(tr("也可以新增条目，或在下方编辑完整片段。"))}</p></div>`;
    el('details').innerHTML = `<div class="detail-header"><span class="eyebrow">${typeNames[node.kind]}</span><h3>${escape(sem.name(node.path))}</h3><p class="breadcrumb">${escape(sem.breadcrumbs(node.path))}</p></div><div class="current-value"><span>${escape(tr("当前值"))}</span><strong>${escape(sem.value(node, nodes))}</strong></div><div class="edit-control">${control}</div>${choices.length || container ? `<details class="raw-editor"><summary>${escape(tr("编辑原始"))}${container ? tr("片段") : tr("数值")}</summary><textarea id="raw-input" spellcheck="false">${escape(draft)}</textarea><p class="input-help">${container ? tr("保留原版对象、列表结构和数字字典键。") : tr("名称对应的原版编号；未知值仍可手动修改。")}</p></details>` : ''}<button class="button primary apply-button" id="apply">${svg('check')}${escape(tr("暂存修改"))}</button><div class="detail-secondary">${container ? `<button id="add" class="button secondary">${svg('plus')}${escape(tr("新增条目"))}</button>` : ''}${node.path.length ? `<button id="delete" class="text-button danger">${escape(tr("删除选中项"))}</button>` : ''}</div><div class="detail-tip">${svg('save')}<p>${escape(tr("修改保留在工具中。"))}<br>${escape(tr("完成后点击“保存”或“另存为”。"))}</p></div>${showRaw ? `<div class="raw-path">${escape('$' + node.path.map(k => `[${JSON.stringify(k)}]`).join(''))}</div>` : ''}`;
    const input = el<HTMLInputElement | HTMLTextAreaElement>('value-input'), raw = el<HTMLTextAreaElement>('raw-input'), choice = el<HTMLSelectElement>('value-choice');
    const rawDetails = el('details').querySelector<HTMLDetailsElement>('.raw-editor');
    const scope = snapshot ? sem.scope(node.path, snapshot) : null;
    if (scope) {
        const info = document.createElement('section');
        info.className = `field-scope ${scope.state}`;
        info.dataset.scopeState = scope.state;
        info.innerHTML = `<p>${escape(scope.description)}</p>`;
        el('details').querySelector('.detail-header')?.after(info);
    }
    if (rawDetails) {
        rawDetails.open = rawOpenPaths.has(pathKey(node.path));
        rawDetails.ontoggle = () => { rawDetails.open ? rawOpenPaths.add(pathKey(node.path)) : rawOpenPaths.delete(pathKey(node.path)); };
    }
    if (input)
        input.oninput = () => { draft = input.value; updateButtons(); };
    if (raw)
        raw.oninput = () => { draft = raw.value; updateButtons(); };
    if (choice)
        choice.onchange = () => { draft = choice.value; if (raw)
            raw.value = draft; updateButtons(); };
    el('apply').onclick = () => applySelected();
    if (el('add'))
        el('add').onclick = async () => { if (await allowDraftChange()) {
            selectPath(node.path);
            addDialog(node);
        } };
    if (el('delete'))
        el('delete').onclick = () => deleteSelected();
}
interface RepairChange {
    path: SavePath;
    operation: string;
    reason: string;
    before: string | null;
    after: string | null;
}
interface RepairPreview {
    profile: string;
    contentHash: string;
    changes: RepairChange[];
}
async function repairDialog() {
    if (!snapshot || busy || persisting)
        return;
    if (draft !== draftInitial) {
        notice(tr("请先暂存或撤销当前输入，再扫描修复。"), true);
        return;
    }
    const preview = await action(() => invoke<RepairPreview>('preview_repair'), false);
    if (!preview)
        return;
    const rows = preview.changes.map(change => `<article><span class="change-operation">${escape(backendText(change.operation))}</span><h3>${escape(sem.breadcrumbs(change.path))}</h3><p>${escape(backendText(change.reason))}</p><div><span>${escape(tr("原值"))}</span><code>${escape(change.before ?? tr("缺失"))}</code></div><div><span>${escape(tr("修复后"))}</span><code>${escape(change.after ?? tr("移除"))}</code></div></article>`).join('');
    showModal(`<h2>${escape(tr("清理扩展数据＋补全原版数据"))}</h2><p class="modal-description">${escape(tr("按工具内置的原版规则扫描。所有扩展任务、物品、服饰等记录都将被移除；缺失数据补默认值，无法找回丢失的真实进度。应用后可撤销，保存时必须另存副本。"))}</p><p>${escape(backendText(preview.profile))} · ${preview.changes.length} ${escape(tr("项修复"))}</p><div class="changes-list">${rows || `<p>${escape(tr("没有发现需要修复的内容。"))}</p>`}</div><div class="modal-actions"><button class="button secondary" id="repair-cancel">${escape(tr("取消"))}</button><button class="button primary" id="repair-apply" ${preview.changes.length ? '' : 'disabled'}>${escape(tr("应用修复"))}</button></div>`, true);
    el('modal-root').querySelector('.modal')!.classList.add('repair-modal');
    el('repair-cancel').onclick = closeModal;
    el('repair-apply').onclick = async () => {
        const next = await action(() => invoke<Snapshot>('apply_repair', { contentHash: preview.contentHash }));
        if (next) {
            closeModal();
            notice(tr("已应用 {0} 项修复，尚未写入文件。点击“保存”将另存副本；可撤销本批修复。", preview.changes.length));
        }
    };
}
async function confirmDialog(title: string, text: string, confirm = tr("继续")): Promise<boolean> { return new Promise(resolve => { showModal(`<h2>${escape(title)}</h2><p class="modal-description">${escape(text)}</p><div class="modal-actions"><button class="button secondary" id="modal-cancel">${escape(tr("取消"))}</button><button class="button primary" id="modal-confirm">${escape(confirm)}</button></div>`); el('modal-cancel').onclick = () => { closeModal(); resolve(false); }; el('modal-confirm').onclick = () => { closeModal(); resolve(true); }; }); }
function showModal(content: string, wide = false) { el('modal-root').innerHTML = `<div class="modal-backdrop"><section role="dialog" aria-modal="true" class="modal ${wide ? 'wide' : ''}">${content}</section></div>`; updateButtons(); }
function closeModal() { el('modal-root').innerHTML = ''; updateButtons(); }
async function allowDraftChange() { return draft === draftInitial || await confirmDialog(tr("有尚未暂存的输入"), tr("切换条目会丢弃当前输入。先暂存修改，或继续切换。"), tr("继续切换")); }
function selectPath(path: SavePath) { selected = pathKey(path); const node = nodes.get(selected)!; draft = node.kind === 'string' ? String(node.value ?? '') : node.raw; draftInitial = draft; }
async function applySelected() { if (!selected)
    return; const node = nodes.get(selected)!; const fragment = node.kind === 'string' ? JSON.stringify(draft) : draft; const error = sem.editError(node.path, fragment, node.raw); if (error) {
    notice(error, true);
    return;
} await action(() => invoke<Snapshot>('replace_value', { path: node.path, fragment })); }
async function deleteSelected() { if (!selected)
    return; const node = nodes.get(selected)!; if (!await confirmDialog(tr("删除这个条目？"), sem.breadcrumbs(node.path), tr("暂存删除")))
    return; await action(() => invoke<Snapshot>('delete_entry', { path: node.path })); }
function addDialog(node: SaveNode) {
    const keyTable = metadata.rules.keyTables[String(node.path.at(-1))], known = sem.table(keyTable);
    showModal(`<h2>${escape(tr("新增"))}${node.kind === 'array' ? tr("列表项") : tr("表项")}</h2><p class="modal-description">${escape(sem.breadcrumbs(node.path))}</p>${node.kind === 'object' ? `${Object.keys(known).length ? `<label class="field-label">${escape(tr("选择原版条目"))}</label><select id="add-known"><option value="">${escape(tr("手动填写条目键"))}</option>${Object.entries(known).filter(([k]) => !node.children.includes(k)).map(([k]) => `<option value="${escape(k)}">${escape(sem.named(keyTable, k))}</option>`).join('')}</select>` : ''}<label class="field-label">${escape(tr("条目键"))}</label><input id="add-key" class="text-input" placeholder="${escape(tr("填写原版编号或字段名"))}"><label class="check-label"><input id="add-bare" type="checkbox" ${node.bareKeys.length ? 'checked' : ''}>${escape(tr("使用原版数字字典键格式"))}</label>` : ''}<label class="field-label">${escape(tr("条目内容"))}</label><textarea id="add-fragment" class="text-input code" spellcheck="false">0</textarea><p class="input-help">${escape(tr("填写有效的数值、开关、对象或列表；文本需要双引号。"))}</p><div class="modal-actions"><button class="button secondary" id="modal-cancel">${escape(tr("取消"))}</button><button class="button primary" id="modal-add">${escape(tr("暂存新增"))}</button></div>`);
    el('modal-cancel').onclick = closeModal;
    const example = nodes.get(pathKey([...node.path, node.children[0]]));
    if (example)
        el<HTMLTextAreaElement>('add-fragment').value = ({ bool: 'false', array: '[]', object: '{}', string: '""', null: 'null', number: '0' }[example.kind]);
    if (el('add-known'))
        el<HTMLSelectElement>('add-known').onchange = () => { el<HTMLInputElement>('add-key').value = el<HTMLSelectElement>('add-known').value; el<HTMLInputElement>('add-bare').checked = true; };
    el('modal-add').onclick = async () => { const key = node.kind === 'object' ? el<HTMLInputElement>('add-key').value : null, fragment = el<HTMLTextAreaElement>('add-fragment').value, bare = node.kind === 'object' && el<HTMLInputElement>('add-bare').checked; const next = await action(() => invoke<Snapshot>('add_entry', { path: node.path, key, fragment, bare })); if (next) {
        expanded.add(pathKey(node.path));
        closeModal();
        render();
    } };
}
function changesDialog() {
    const changes = snapshot?.changedEntries ?? [];
    const renderValue = (path: SavePath, raw: string | null) => { if (raw === null)
        return tr("无"); const node = nodes.get(pathKey(path)); if (!node)
        return raw; try {
        return sem.value({ ...node, raw, value: node.kind === 'bool' ? raw === 'true' : node.kind === 'string' ? JSON.parse(raw) : raw }, nodes);
    }
    catch {
        return raw;
    } };
    showModal(`<div class="modal-title"><h2>${escape(tr("全部改动"))} <span class="pill">${changes.length}</span></h2><button class="icon-button" id="modal-close">${svg('close')}</button></div><p class="modal-description">${escape(tr("仅这些内容会变化，其余数据保留原文。"))}</p><div class="changes-list">${changes.length ? changes.map(c => `<article><span class="change-operation">${escape(backendText(c.operation))}</span><h3>${escape(sem.breadcrumbs(c.path))}</h3><div><span>${escape(tr("原值"))}</span><code>${escape(renderValue(c.path, c.before))}</code></div><div><span>${escape(tr("新值"))}</span><code>${escape(renderValue(c.path, c.after))}</code></div></article>`).join('') : `<div class="empty-state"><h3>${escape(tr("尚无修改"))}</h3><p>${escape(tr("暂存修改后，可以在这里核对。"))}</p></div>`}</div>`, true);
    el('modal-close').onclick = closeModal;
}
document.addEventListener('click', async (event) => {
    const target = event.target as HTMLElement;
    const category = target.closest<HTMLButtonElement>('[data-category]');
    if (category) {
        if (!await allowDraftChange())
            return;
        active = category.dataset.category!;
        query = '';
        el<HTMLInputElement>('search').value = '';
        el('clear-search').hidden = true;
        const first = active === 'raw' ? nodes.get(pathKey([])) : categoryFields(active).find(f => (!sem.isFolded(f.path) || openFoldedCategories.has(active)));
        if (first)
            selectPath(first.path);
        else
            selected = null;
        render();
        return;
    }
    const expand = target.closest<HTMLElement>('[data-expand]');
    if (expand) {
        const id = expand.dataset.expand!;
        expanded.has(id) ? expanded.delete(id) : expanded.add(id);
        render();
        return;
    }
    const row = target.closest<HTMLButtonElement>('[data-path]');
    if (row) {
        if (!await allowDraftChange())
            return;
        selected = row.dataset.path!;
        const node = nodes.get(selected)!;
        draft = node.kind === 'string' ? String(node.value ?? '') : node.raw;
        draftInitial = draft;
        render();
    }
});
function bindShellEvents() {
el('open').onclick = async () => { if (((snapshot?.dirty) || draft !== draftInitial) && !await confirmDialog(tr("打开其他存档？"), tr("尚未保存的修改或输入会被丢弃。"), tr("打开其他存档")))
    return; const next = await action(() => invoke<Snapshot | null>('open_document')); if (next) {
    active = 'common';
    expanded.clear();
    rawOpenPaths.clear();
    openFoldedCategories.clear();
    selected = null;
    updateSnapshot(next);
} };
interface SavePlan {
    token: string;
    destination: string;
    exists: boolean;
    identity: {
        label: string;
    };
    changedCount: number;
    systemSummary: {
        path: string;
        slotIndex: number;
    } | null;
}
async function persist(asNew: boolean) {
    if (persisting || busy || !snapshot)
        return;
    asNew = asNew || !!snapshot.repairRequiresCopy;
    persisting = true;
    updateButtons();
    try {
        if (draft !== draftInitial) {
            await applySelected();
            if (draft !== draftInitial)
                return;
        }
        const plan = await action(() => invoke<SavePlan | null>(asNew ? 'prepare_save_as' : 'prepare_save', asNew ? { destination: null } : {}), false);
        if (!plan)
            return;
        const summary = plan.systemSummary ? tr("\n同时更新 {0} 的第 {1} 个槽位：等级、保存时间、难度和游玩时间。", plan.systemSummary.path, plan.systemSummary.slotIndex + 1) : '';
        if ((!asNew || plan.systemSummary) && !await confirmDialog(asNew ? tr("保存并同步存档列表？") : tr("保存并覆盖当前存档？"), tr("{0}\n{1}，{2} 项修改。{3}", plan.destination, backendText(plan.identity.label), plan.changedCount, summary), asNew ? tr("保存并同步") : tr("保存并覆盖"))) {
            await invoke('cancel_save');
            return;
        }
        const saved = await action(() => invoke<Snapshot>('commit_save', { token: plan.token }));
        if (saved) {
            lastSaved = true;
            render();
            notice(tr("已保存，加密校验通过。{0}{1}", saved.source, plan.systemSummary ? tr("；已同步同目录 s.sd 的槽位摘要。") : ''));
        }
    }
    finally {
        persisting = false;
        updateButtons();
    }
}
el('repair').onclick = () => repairDialog();
el('save').onclick = () => persist(false);
el('save-as').onclick = () => persist(true);
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!el('modal-root').children.length)
        void persist(event.shiftKey);
} });
el('undo').onclick = async () => { if (await allowDraftChange())
    await action(() => invoke<Snapshot>('undo_document')); };
el('reset').onclick = async () => { if (!snapshot?.dirty && draft === draftInitial)
    return; if (await confirmDialog(tr("还原全部修改？"), tr("工具中的暂存修改会全部恢复为打开文件时的内容。"), tr("还原全部")))
    await action(() => invoke<Snapshot>('reset_document')); };
el('changes').onclick = changesDialog;
el<HTMLInputElement>('search').oninput = event => { query = (event.target as HTMLInputElement).value.trim(); el('clear-search').hidden = !query; render(); };
el('clear-search').onclick = () => { query = ''; el<HTMLInputElement>('search').value = ''; el('clear-search').hidden = true; render(); };
el<HTMLInputElement>('show-raw').onchange = event => { showRaw = (event.target as HTMLInputElement).checked; render(); };
}
async function startup() { try {
    baseMetadata = await invoke<Metadata>('get_metadata');
    setLocale(getLocale());
    await invoke('set_ui_locale',{locale:getLocale()});
    metadata=localizeMetadata(baseMetadata);
    sem = new Semantics(metadata,tr);
    const doc = await invoke<Snapshot | null>('get_document');
    if (doc)
        updateSnapshot(doc);
    else
        render();
    const launch = await invoke<{
        startupError?: string;
    }>('get_launch_options');
    if (launch.startupError)
        notice(launch.startupError, true);
    await listen('request-close', async () => { if ((snapshot?.dirty) || draft !== draftInitial) {
        if (!await confirmDialog(tr("关闭存档编辑器？"), tr("还有尚未保存的修改，关闭后会丢弃。"), tr("关闭工具")))
            return;
    } await invoke('close_app'); });
    (window as any).__saveEditor = { ready: true, get metadata(){return metadata;}, get locale(){return getLocale();}, get snapshot() { return snapshot; }, select: (path: SavePath) => { selected = pathKey(path); const n = nodes.get(selected)!; draft = n.kind === 'string' ? String(n.value) : n.raw; draftInitial = draft; render(); }, setCategory: (value: string) => { active = value; render(); } };
    window.dispatchEvent(new Event('save-editor-ready'));
}
catch (error) {
    notice(tr("启动失败：") + String(error), true);
} }
setLocale(getLocale());
mountShell();
startup();
