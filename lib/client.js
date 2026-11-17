window.__ModuleLoader__.load({
    id: 'dsh-qwen-scope',
    factory: (load) => {
        'use strict';
        const module = { exports: {} };
        const exports = module.exports;
        const react = load('react');
        // The cell's own mark: a prompt flowing into the engine, drawn here rather than borrowed so it reads as prefill and
        // cannot disappear with one missing glyph in an assembly that ships fewer icons.
        function Mark({ className }) {
            return h(
                'svg',
                { viewBox: '0 0 16 16', width: 14, height: 14, className, 'aria-hidden': true },
                h('path', {
                    d: 'M1.8 5.1h4.6M1.8 8h3.2M1.8 10.9h4.6',
                    stroke: 'currentColor',
                    'stroke-width': 1.5,
                    'stroke-linecap': 'round'
                }),
                h('rect', {
                    x: 8.6,
                    y: 3.1,
                    width: 5.4,
                    height: 9.8,
                    rx: 1.6,
                    stroke: 'currentColor',
                    'stroke-width': 1.5
                }),
                h('path', {
                    d: 'M10.2 6.3v3.4',
                    stroke: 'currentColor',
                    'stroke-width': 1.5,
                    'stroke-linecap': 'round'
                })
            );
        }
        const { createElement: h, useEffect, useId, useState } = react;
        /** Locale namespace, and the settings namespace (the entry id in cordis.patch.yml). */
        const NS = 'qwen-scope';
        const ROUTE = '/plugins/dsh-qwen-scope/state';
        const POLL_MS = 2000;
        /** A reading older than this means the host stopped reaching the engine. */
        const STALE_MS = 20000;
        const en = {
            nav: 'local model scope',
            noModel: 'no model',
            offline: 'offline',
            apiKey: 'needs an API key',
            invalid: 'bad address',
            unset: 'no server configured',
            warming: 'reading…',
            unreachable: 'unreachable',
            http: 'server error',
            notEngine: 'not an engine',
            large: 'too large',
            prefill: 'prefill',
            helpPrefill: 'Prompt tokens computed per second by the selected local model server, over the last poll.',
            helpOffline: 'The selected server has not answered in the last twenty seconds.',
            settingTitle: 'Local model servers',
            settingDescription:
                'The local model servers the pill may report. Those named by your model providers are found on their own; add a row only for an engine dsh is not configured to talk to. dsh reads the addresses, not your browser, so they have to work from this computer.',
            settingFromModel: 'from the model settings',
            settingActive: 'Show',
            settingActiveHelp: 'The server the pill under the composer reports. Only one is shown at a time.',
            settingName: 'Name',
            settingUrl: 'Address',
            settingKey: 'API key variable',
            settingAdd: 'Add a server',
            settingRemove: 'Remove',
            settingOnline: 'answering',
            settingOffline: 'not answering',
            settingModel: 'serving',
            settingReadOnly: 'This page cannot write the settings; set them in the profile instead.',
            settingFailed: 'Could not save.'
        };
        const zh = {
            nav: '本地模型面板',
            noModel: '无模型',
            offline: '离线',
            apiKey: '需要 API key',
            invalid: '地址无效',
            unset: '未配置服务',
            warming: '读取中…',
            unreachable: '无法连接',
            http: '服务报错',
            notEngine: '不是推理引擎',
            large: '响应过大',
            prefill: 'prefill',
            helpPrefill: '所选本地模型服务在最近一次采样内实际计算的 prompt token 速率。',
            helpOffline: '所选服务已二十秒没有响应。',
            settingTitle: '本地模型服务',
            settingDescription:
                '底栏可以上报的本地模型服务。模型配置里已有的服务会自动出现；只有 dsh 没有连接地址的引擎才需要手动添加。地址由 dsh 读取而非浏览器，需要在本机能访问。',
            settingFromModel: '来自模型配置',
            settingActive: '显示',
            settingActiveHelp: '底栏上报哪一个服务，一次只显示一个。',
            settingName: '名称',
            settingUrl: '地址',
            settingKey: 'API key 环境变量',
            settingAdd: '添加服务',
            settingRemove: '移除',
            settingOnline: '在线',
            settingOffline: '离线',
            settingModel: '当前模型',
            settingReadOnly: '该页面不能写入设置，请在 profile 里配置。',
            settingFailed: '保存失败。'
        };
        const REASONS = {
            unreachable: 'unreachable',
            invalid: 'invalid',
            apiKey: 'apiKey',
            unset: 'unset',
            warming: 'warming',
            http: 'http',
            notEngine: 'notEngine',
            large: 'large'
        };
        const finite = (value) => typeof value === 'number' && Number.isFinite(value);
        const num = (value) => (finite(value) ? value : null);
        const str = (value) => (typeof value === 'string' ? value : null);
        const record = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null);
        /** Numbers the pill can show; a missing or broken field reads as “no reading”. */
        // 把宿主回包规整成页面可用的形状；缺失字段一律按「没有读数」处理。
        function parseState(value) {
            const raw = record(value);
            if (raw === null) return null;
            const reported = record(raw.reported) ?? {};
            const servers = Array.isArray(raw.servers) ? raw.servers : [];
            return {
                ok: raw.ok === true,
                engine: str(raw.engine),
                modelName: str(raw.modelName),
                updatedAt: str(raw.updatedAt),
                url: str(raw.url),
                error: str(raw.error),
                serverId: str(raw.serverId),
                serverName: str(raw.serverName),
                activeId: str(raw.activeId),
                activeName: str(raw.activeName),
                prefillTokensPerSecond: num(raw.prefillTokensPerSecond),
                reported: Object.fromEntries(Object.keys(reported).map((key) => [key, reported[key] === true])),
                servers: servers
                    .map((row) => {
                        const item = record(row) ?? {};
                        return {
                            id: str(item.id) ?? '',
                            name: str(item.name) ?? '',
                            url: str(item.url) ?? '',
                            apiKeyEnv: str(item.apiKeyEnv),
                            from: str(item.from),
                            online: item.online === true,
                            error: str(item.error),
                            modelName: str(item.modelName),
                            engine: str(item.engine)
                        };
                    })
                    .filter((row) => row.id !== '')
            };
        }
        /** The response is either a reading or `{ error }`; the host always answers 200 so the console stays quiet. */
        function parseReply(body) {
            const raw = record(body);
            if (raw === null) return { state: null, error: 'unreachable' };
            const state = parseState(raw);
            if (typeof raw.error === 'string') return { state, error: raw.error };
            return state === null ? { state: null, error: 'unreachable' } : { state, error: null };
        }
        /**
         * What the cell shows. An engine that is answering is at zero when it is computing nothing — that is the truth, and a
         * dash would read as a gap in the instrument. A dash belongs to an engine that is not answering at all.
         */
        function reading(state, reason) {
            if (reason !== null) return null;
            if (finite(state?.prefillTokensPerSecond)) return state.prefillTokensPerSecond;
            // No number yet: an engine that keeps no prompt counter has nothing to read. A quiet engine is a zero, not a gap.
            return state?.reported?.promptTokens === false ? null : 0;
        }
        /** A number, or a dash when the engine keeps no such counter. */
        const cell = (state, reason) =>
            reason === null && finite(state?.prefillTokensPerSecond) ? rate(state.prefillTokensPerSecond) : '—';
        const rate = (value) =>
            !finite(value)
                ? '—'
                : value === 0
                  ? '0'
                  : value >= 1000
                    ? `${(value / 1000).toFixed(1)}k`
                    : value.toFixed(value >= 100 ? 0 : 1);
        /**
         * One poll for the whole page, shared by the pill under the composer and the settings page: the engines are read once
         * every two seconds no matter how many widgets are open. The poll stops when the last one unmounts.
         */
        const listeners = new Set();
        let shared = { state: null, error: null, at: Date.now() };
        let readers = 0;
        let stopPolling = null;
        /** The live poller's read-on-demand, so a model change shows at once. */
        let pollNow = null;
        /** The model the composer is on, kept here because the poll is shared: the host reports that model's engine. */
        let watched = '';
        function publish(next) {
            shared = next;
            for (const notify of listeners) notify(next);
        }
        function startPolling() {
            const abort = new AbortController();
            let busy = false;
            const tick = async () => {
                if (document.hidden || busy) return;
                busy = true;
                let state = null;
                let error = null;
                try {
                    const url = watched === '' ? ROUTE : `${ROUTE}?model=${encodeURIComponent(watched)}`;
                    const response = await fetch(url, {
                        cache: 'no-store',
                        headers: { accept: 'application/json' },
                        signal: abort.signal
                    });
                    const reply = parseReply(response.ok ? await response.json() : null);
                    state = reply.state;
                    error = reply.error;
                } catch {
                    error = 'unreachable';
                } finally {
                    busy = false;
                }
                if (abort.signal.aborted) return;
                publish({ state, error, at: Date.now() });
            };
            void tick();
            pollNow = () => {
                if (!abort.signal.aborted) void tick();
            };
            // Read again at the beat after the first one, so a page that opened between two beats never waits twice as long.
            const follow = () => {
                if (!abort.signal.aborted) void tick();
            };
            const prime = setTimeout(follow, POLL_MS);
            const timer = setInterval(follow, POLL_MS);
            const shown = () => {
                if (!document.hidden) void tick();
            };
            document.addEventListener('visibilitychange', shown);
            stopPolling = () => {
                pollNow = null;
                abort.abort();
                clearTimeout(prime);
                clearInterval(timer);
                document.removeEventListener('visibilitychange', shown);
            };
        }
        /** Called when the composer changes model: the next read names the new engine at once, not in two seconds. */
        function watchModel(model) {
            const next = String(model ?? '');
            if (next === watched) return;
            watched = next;
            if (pollNow !== null) pollNow();
        }
        /**
         * The model this session is on. A slot entry belongs to one session, so the model comes from that session's own
         * selection projection (`useProjection('modelSelection')`), never from one page-wide value. The picker's next choice
         * wins over the last used one: the engine changes when a model is picked, not when its first request starts.
         */
        function modelOf(view) {
            const picked = view?.next ?? view?.pending ?? view?.lastUsed ?? null;
            return typeof picked?.model === 'string' ? picked.model : '';
        }
        // 整个页面共享一个轮询：无论打开几个组件，引擎都只按同一节奏被读，最后一个组件卸载时停止。
        function usePoll() {
            const [poll, setPoll] = useState(shared);
            const [live] = useState(() => Date.now());
            useEffect(() => {
                readers += 1;
                if (stopPolling === null) startPolling();
                listeners.add(setPoll);
                setPoll(shared);
                return () => {
                    listeners.delete(setPoll);
                    readers -= 1;
                    if (readers === 0) {
                        stopPolling?.();
                        stopPolling = null;
                    }
                };
            }, []);
            return { ...poll, at: Math.max(poll.at, live) };
        }
        /**
         * Whether the cell is drawn at all. It is drawn whenever the host answers for a local engine: a session that never named
         * its model is answered by the engine picked in Settings, which is what that pick is for. A hosted model is answered
         * `notLocal` and the cell stays away, which the caller handles.
         */
        function cellShown() {
            return true;
        }
        /**
         * The cell under the composer: which local server is being reported, and what it is prefilling right now. A server
         * that is configured but silent shows a dash rather than a zero, so an idle engine and a dead one stay distinguishable.
         */
        /** The cell: the mark, its name, the reading, and the unit. */
        function StatCell({ label, value, title, t }) {
            return h(
                'span',
                { className: 'dqs-cell', 'data-composer-stat': `qwen-scope-${label}` },
                h(
                    'span',
                    { className: 'dqs-pill', title },
                    h(Mark, { className: 'dqs-mark' }),
                    h('span', { className: 'dqs-label' }, t(label)),
                    h('span', { className: 'dqs-value' }, value),
                    h('span', { className: 'dqs-unit' }, 'tok/s')
                )
            );
        }
        /** What the cell reads: the session's model (so the host answers for its engine) and the shared poll. */
        function useCell(sessionId, useProjection) {
            const view = useProjection('modelSelection');
            const model = modelOf(view);
            useEffect(() => {
                if (model !== '') watchModel(model);
            }, [model]);
            const { state, error, at } = usePoll();
            const updated = Date.parse(state?.updatedAt ?? '');
            const reason = error ?? (finite(updated) && at - updated > STALE_MS ? 'unreachable' : null);
            return { state, reason };
        }
        /**
         * Whether the session has run anything yet. A fresh window has no steps and no usage, and DSH's own statistics pills
         * are hidden until there are: this cell is drawn by the same rule, so an empty composer shows only the composer.
         */
        // 会话是否已经跑过东西：与 DSH 自带统计格同一判据，空会话时这一格不渲染。
        function hasActivity(stats, usage) {
            const steps = Number(stats?.steps ?? stats?.turns ?? 0);
            const billed = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].reduce(
                (sum, key) => sum + (Number(usage?.[key]) || 0),
                0
            );
            return steps > 0 || billed > 0;
        }
        /**
         * The prefill cell: prompt tokens the engine is computing now. An engine that is answering at rest is a zero; only one
         * that keeps no prompt counter, or one that is not answering, reads a dash.
         */
        // 底栏的 prefill 单元格：显示当前会话所选本地引擎此刻的 prefill 速率。
        function PrefillPill({ t, useProjection }) {
            const stats = useProjection('sessionStats');
            const usage = useProjection('tokenUsage');
            const { state, reason } = useCell(undefined, useProjection);
            if (!hasActivity(stats, usage)) return null;
            if (state === null && reason === null) return null;
            if (reason === null && state?.error === 'notLocal') return null;
            const note =
                reason === null
                    ? t('helpPrefill')
                    : `${state?.serverName === undefined || state.serverName === '' ? '' : `${state.serverName} · `}${t(REASONS[reason] ?? 'unreachable')}`;
            return h(StatCell, { label: 'prefill', value: cell(state, reason), title: note, t });
        }
        /** One row of the settings page: what to call it, where it is, and whether the pill should report it. */
        function ServerRow({ row, active, writable, online, error, modelName, t, id, onChange, onRemove, onActivate }) {
            const picked = h(
                'label',
                { className: 'dqs-pick', title: t('settingActiveHelp') },
                h('input', {
                    type: 'radio',
                    name: `${id}active`,
                    checked: active,
                    disabled: writable !== 'writable',
                    onChange: onActivate
                }),
                h('span', { className: 'dqs-hidden' }, t('settingActive'))
            );
            const state = h(
                'span',
                { className: `dqs-state ${online === true ? 'dqs-live' : 'dqs-dead'}` },
                online === true
                    ? `${t('settingOnline')}${modelName !== null && modelName !== '' ? ` · ${t('settingModel')} ${modelName}` : ''}`
                    : t(REASONS[error ?? ''] ?? 'offline')
            );
            // A server the model providers already name is not edited here; it is edited where the model itself is configured.
            if (row.from !== undefined && row.from !== 'manual') {
                return h(
                    'div',
                    { className: 'dqs-server dqs-found' },
                    picked,
                    h('span', { className: 'dqs-static' }, row.name),
                    h('span', { className: 'dqs-static' }, row.url),
                    h('span', { className: 'dqs-static' }, t('settingFromModel')),
                    state
                );
            }
            const field = (key, placeholder, label) =>
                h('input', {
                    className: 'dqs-input',
                    spellCheck: false,
                    autoComplete: 'off',
                    placeholder,
                    'aria-label': t(label),
                    disabled: writable !== 'writable',
                    value: row[key] ?? '',
                    onChange: (event) => onChange(key, event.target.value)
                });
            return h(
                'div',
                { className: 'dqs-server' },
                picked,
                field('name', 'local-model', 'settingName'),
                field('url', 'http://127.0.0.1:8000', 'settingUrl'),
                field('apiKeyEnv', 'LOCAL_API_KEY', 'settingKey'),
                state,
                h(
                    'button',
                    { className: 'dqs-remove', type: 'button', disabled: writable !== 'writable', onClick: onRemove },
                    t('settingRemove')
                )
            );
        }
        /** The plugin's page in Settings: the local servers dsh already knows about, and which one the pill reports. */
        // 设置页的「本地模型面板」：列出自动发现与手工登记的服务，并选择底栏上报哪一台。
        function ScopeSection({ t, useSettings, write }) {
            const servers = useSettings((s) => s.value?.servers ?? []) ?? [];
            const active = useSettings((s) => s.value?.active ?? '') ?? '';
            const writable = useSettings((s) =>
                s.status === 'loading' ? 'loading' : s.status === 'ready' && s.writable ? 'writable' : 'readOnly'
            );
            const { state } = usePoll();
            const live = new Map((state?.servers ?? []).map((row) => [row.id, row]));
            const id = useId();
            const [problem, setProblem] = useState();
            const rows = Array.isArray(servers) ? servers : [];
            // The engines found in the model providers' own config, minus any the user has already written down by hand.
            const written = new Set(rows.map((row) => String(row.url ?? '').replace(/\/+$/, '')));
            const found = (state?.servers ?? []).filter(
                (row) =>
                    row.from !== undefined &&
                    row.from !== 'manual' &&
                    !written.has(row.url.replace(/\/+$/, '')) &&
                    !rows.some((own) => own.id === row.id)
            );
            const shown = [
                ...rows.map((row) => ({ row, index: rows.indexOf(row), found: false })),
                ...found.map((row) => ({ row, index: -1, found: true }))
            ];
            const picked = active === '' ? shown[0]?.row.id : active;
            const save = (next, choice) => {
                setProblem(undefined);
                write(next, choice ?? active).then(
                    (saved) => {
                        if (!saved) setProblem('settingFailed');
                    },
                    () => setProblem('settingFailed')
                );
            };
            const edit = (index, key, value) =>
                save(rows.map((row, at) => (at === index ? { ...row, [key]: value } : row)));
            const remove = (index) => save(rows.filter((_, at) => at !== index));
            const add = () => {
                const idOf = (n) => (rows.some((row) => row.id === `server-${n}`) ? idOf(n + 1) : `server-${n}`);
                save([...rows, { id: idOf(rows.length + 1), name: '', url: '', apiKeyEnv: 'LOCAL_API_KEY' }]);
            };
            /** Picking a discovered server writes it down as a row of its own, so the pick survives a provider edit. */
            const pick = (entry) =>
                save(
                    entry.found
                        ? [
                              ...rows,
                              {
                                  id: entry.row.id,
                                  name: entry.row.name,
                                  url: entry.row.url,
                                  apiKeyEnv: entry.row.apiKeyEnv ?? 'LOCAL_API_KEY'
                              }
                          ]
                        : rows,
                    entry.row.id
                );
            return h(
                'div',
                { className: 'dqs-page' },
                h('div', { className: 'dqs-page-title' }, t('settingTitle')),
                h('div', { className: 'dqs-page-desc' }, t('settingDescription')),
                h('div', { className: 'dqs-page-desc' }, t('settingActiveHelp')),
                h(
                    'div',
                    { className: 'dqs-list' },
                    shown.map((entry) => {
                        const seen = live.get(entry.row.id);
                        return h(ServerRow, {
                            key: entry.row.id,
                            row: entry.row,
                            id,
                            t,
                            active: picked === entry.row.id,
                            writable,
                            online: seen === undefined ? null : seen.online,
                            modelName: seen?.modelName ?? null,
                            error: seen?.error ?? null,
                            onChange: (key, value) => edit(entry.index, key, value),
                            onRemove: () => remove(entry.index),
                            onActivate: () => pick(entry)
                        });
                    })
                ),
                h(
                    'button',
                    { className: 'dqs-add', type: 'button', disabled: writable !== 'writable', onClick: add },
                    t('settingAdd')
                ),
                writable === 'readOnly' && h('div', { className: 'dqs-page-desc' }, t('settingReadOnly')),
                problem !== undefined && h('div', { role: 'alert', className: 'dqs-bad' }, t(problem))
            );
        }
        const css = `
.dqs-cell{min-width:0;font-family:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));letter-spacing:inherit;display:inline-flex}
.dqs-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.dqs-pill svg{flex:none;width:14px;height:14px}
.dqs-label{overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:14ch}
.dqs-value,.dqs-unit{font:inherit;font-weight:inherit;font-variant-numeric:tabular-nums}
.dqs-mark{color:var(--dsw-alias-label-tertiary)}
.dqs-live{color:light-dark(#059669,#34d399)}
.dqs-dead{color:light-dark(#dc2626,#f87171)}
.dqs-page{display:flex;flex-direction:column;gap:8px;padding:16px 0}
.dqs-page,.dqs-page *{box-sizing:border-box}
.dqs-page-title{font-family:inherit;font-size:14px;line-height:22px;letter-spacing:0;color:var(--dsw-alias-label-primary)}
.dqs-page-desc{font-family:inherit;font-size:12px;line-height:18px;letter-spacing:0;color:var(--dsw-alias-label-tertiary)}
.dqs-list{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.dqs-server{display:grid;grid-template-columns:24px minmax(9ch,1fr) minmax(18ch,3fr) minmax(12ch,2fr) auto auto;align-items:center;gap:8px}
.dqs-pick{display:flex;align-items:center;justify-content:center}
.dqs-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.dqs-found{grid-template-columns:24px minmax(9ch,1fr) minmax(18ch,3fr) auto auto}
.dqs-static{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:inherit;font-size:13px;line-height:20px;letter-spacing:0;color:var(--dsw-alias-label-secondary)}
.dqs-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);font-family:inherit;font-size:13px;line-height:20px;letter-spacing:0;color:var(--dsw-alias-label-primary)}
.dqs-input:disabled{opacity:.6}
.dqs-state{font-family:inherit;font-size:12px;line-height:18px;letter-spacing:0;white-space:nowrap}
.dqs-remove,.dqs-add{height:28px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);font-family:inherit;font-size:12px;line-height:20px;letter-spacing:0;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dqs-remove:hover,.dqs-add:hover{color:var(--dsw-alias-label-primary)}
.dqs-remove:disabled,.dqs-add:disabled{opacity:.5;cursor:default}
.dqs-add{align-self:flex-start;margin-top:4px}
.dqs-bad{font-family:inherit;font-size:12px;line-height:18px;letter-spacing:0;color:var(--dsw-alias-state-error-primary,#dc2626)}
`;
        exports.inject = ['slots', 'locale', 'configForms'];
        // 页面侧入口：注入样式与文案，注册底栏单元格和设置页。
        function apply(ctx) {
            ctx.effect(() => {
                const style = Object.assign(document.createElement('style'), {
                    id: 'dsh-qwen-scope',
                    textContent: css
                });
                document.head.append(style);
                return () => {
                    style.remove();
                };
            }, 'qwen-scope: styles');
            ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'qwen-scope: en/zh strings');
            const form = ctx.configForms.get(NS);
            /**
             * Writes the whole list and the picked row in one namespace mutation, and keeps the pick pointing at a row that
             * still exists: the last row removed falls back to the first, which is what the host answers with anyway.
             */
            const write = async (next, picked) => {
                const rows = Array.isArray(next) ? next : [];
                const wanted = typeof picked === 'string' ? picked : '';
                const active = rows.some((row) => row.id === wanted) ? wanted : (rows[0]?.id ?? '');
                try {
                    return await form.mutate([
                        { op: 'set', path: ['servers'], value: rows },
                        { op: 'set', path: ['active'], value: active }
                    ]);
                } catch {
                    return false;
                }
            };
            // Order 20 puts the cell after the shipped activity and usage pills rather than between them.
            ctx.slots.inject('conversation.composer.dock', () =>
                ctx.slots.register(
                    {
                        name: 'conversation.composer.dock',
                        id: 'qwen-scope.prefill',
                        order: 20,
                        label: () => ctx.locale.bind(NS)('prefill'),
                        locale: NS
                    },
                    PrefillPill
                )
            );
            ctx.slots.inject('settings.section', () =>
                ctx.slots.register(
                    {
                        name: 'settings.section',
                        id: 'qwen-scope',
                        order: 51,
                        label: () => ctx.locale.bind(NS)('nav'),
                        locale: NS,
                        inject: () => ({ hooks: { settings: form }, write })
                    },
                    ScopeSection
                )
            );
        }
        exports.apply = apply;
        exports.parseReply = parseReply;
        exports.parseState = parseState;
        exports.reading = reading;
        exports.rate = rate;
        exports.cell = cell;
        exports.texts = { en, zh };
        exports.modelOf = modelOf;
        exports.hasActivity = hasActivity;
        exports.cellShown = cellShown;
        return module.exports;
    }
});
