import z from '@deepseek-ai/schemastery';
import { MODEL_MS, Reader, joinPath, parseAddress, parsePrometheus } from './metrics.js';
export { detectEngine, percentileBetween, readHistogram, Reader } from './metrics.js';
export const name = 'dsh-qwen-scope';
export const inject = ['webServer', 'connection'];
/** The credential plane and the launch environment, when this composition mounts them. */
const OPTIONAL = ['credentials', 'launchEnvironment'];
/** One local model server. The name is what the page shows; the address is what dsh reads. */
const Server = z.object({
    id: z.string(),
    name: z.string().default(''),
    url: z.string().default(''),
    apiKeyEnv: z.string().default('LOCAL_API_KEY')
});
export const Config = z.object({
    /** Servers written by hand. Those named by the model providers are added to these unless discovery is turned off. */
    servers: z.array(Server).default([]).volatile(),
    /** Which of them the pill under the composer reports. Empty means the first configured one. */
    active: z.string().default('').volatile(),
    /** Read the model providers' own config for the local servers they point at, so nothing has to be written twice. */
    discover: z.boolean().default(true).volatile()
});
/** The route the client half polls. The browser cannot read the engines itself: no CORS, and the keys live here. */
// 页面轮询的路由。浏览器读不到引擎指标（没有 CORS，也没有密钥），统一由运行 dsh 的宿主代读。
export const ROUTE = '/plugins/dsh-qwen-scope/state';
/** A vLLM metrics page is tens of kilobytes; anything far larger is not the engine. */
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 5000;
/** A reading newer than this counts as live; older means the host stopped reaching that engine. */
const FRESH_MS = 20_000;
/** Reading the profile costs a directory load, so the providers are asked for their servers this often at most. */
const DISCOVER_MS = 30_000;
/** The least time between two sweeps of the engines: the page reads every two seconds, and closer adds only load. */
const SWEEP_MS = 1500;
// Failures are answered 200 with an `error` field: the page polls every two seconds, and a failed status would put a
// console error on the page each time.
function send(res, body) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
}
/** The body as text, or null once it grows past MAX_BYTES. */
async function readLimited(response) {
    if (response.body === null) return '';
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_BYTES) return null;
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}
/**
 * The API key for one engine, resolved the way the model providers resolve theirs: a stored credential reference
 * first, then the launch environment (which carries the `.env` layers), then this process's own environment. Reading
 * `process.env` alone misses a key entered in the settings page, which is stored in the credential plane.
 */
// 按与模型提供方一致的顺序解析密钥：profile 存储的凭据 → 启动环境（.env）→ 进程环境。
async function keyFor(ctx, name) {
    const text = String(name ?? '').trim();
    if (text === '') return '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) return process.env[text] ?? '';
    try {
        const store = ctx.get('credentials');
        if (store !== undefined) {
            const hit = await store.resolve(text);
            if (typeof hit?.value === 'string' && hit.value !== '') return hit.value;
        }
    } catch {
        // A credential plane that refuses this name is not a reason to stop asking the environment for it.
    }
    try {
        const launch = ctx.get('launchEnvironment');
        const value = launch?.get(text)?.value;
        if (typeof value === 'string' && value !== '') return value;
    } catch {
        // Fall through to the inherited environment.
    }
    return process.env[text] ?? '';
}
/** The configured servers, each with an id: a row the page added without one gets one here. */
function listed(value) {
    const rows = Array.isArray(value) ? value : [];
    const seen = new Set();
    const out = [];
    for (const row of rows) {
        if (row === null || typeof row !== 'object') continue;
        const text = typeof row.url === 'string' ? row.url.trim() : '';
        if (text === '') continue;
        const given = typeof row.id === 'string' ? row.id.trim() : '';
        const id = given === '' || seen.has(given) ? `server-${out.length + 1}` : given;
        seen.add(id);
        out.push({
            id,
            name: typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : id,
            url: text,
            apiKeyEnv:
                typeof row.apiKeyEnv === 'string' && row.apiKeyEnv.trim() !== ''
                    ? row.apiKeyEnv.trim()
                    : 'LOCAL_API_KEY'
        });
    }
    return out;
}
/** What one server looks like to the page: whether it answers, and what it is serving. */
function brief(hub, server) {
    const fresh = hub.latestBeat !== null && Date.now() - hub.latestBeat.at <= FRESH_MS;
    return {
        id: server.id,
        name: server.name,
        url: server.url,
        from: server.from ?? 'manual',
        apiKeyEnv: server.apiKeyEnv,
        online: hub.failure === null && fresh && hub.latest !== null,
        error: hub.failure,
        modelName: hub.latest?.modelName ?? hub.declared ?? null,
        engine: hub.latest?.engine ?? null
    };
}
/** Hosts worth watching without being told: a loopback or private address, or a machine on the local network. */
const LOCAL_NAME = /^(localhost|[-a-z0-9]+\.local)$/i;
const LOCAL_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const LOCAL_IPV6 = /^\[(::1|f[cd][0-9a-f]*(?::[0-9a-f]*)*)\]$/i;
const isLocal = (host) => LOCAL_NAME.test(host) || LOCAL_IP.test(host) || LOCAL_IPV6.test(host);
/**
 * The model the composer is set to, as the page named it. The cell reports the engine running that model, so the page
 * says which model it is on and this side works out which engine that is.
 */
export function askedModel(request) {
    try {
        const query = new URL(String(request.url ?? ROUTE), 'http://localhost').searchParams;
        const model = query.get('model');
        return model === null ? '' : model.trim();
    } catch {
        return '';
    }
}
/** A provider address is `http://host:port/v1`; the metrics live at the root of the same server. */
// 提供方地址 http://host:8000/v1 → 引擎根地址 http://host:8000（指标在根路径上）。
export function engineUrl(value) {
    const text = String(value ?? '').trim();
    if (text === '' || /\s/.test(text)) return null;
    let url;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    } catch {
        return null;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLocal(url.hostname)) return null;
    // `url.pathname = ''` would put the `/` straight back, so the origin is joined by hand.
    const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
    return url.origin + path;
}
/** The model providers' own rows: every local OpenAI-compatible endpoint they name, keyed by its provider id. */
function discovered(ctx) {
    const editor = ctx.get('configEditor');
    if (editor === undefined) return [];
    const out = [];
    for (const row of editor.configuration()) {
        const providers = row.override?.providers ?? row.inherited?.providers;
        if (providers === null || typeof providers !== 'object') continue;
        const entryId = row.entry.options.id ?? 'llm';
        for (const [key, provider] of Object.entries(providers)) {
            if (provider === null || typeof provider !== 'object') continue;
            const url = engineUrl(provider.baseURL);
            if (url === null) continue;
            // A provider row may offer several models on one server; every id is a name this engine answers to.
            const models = Array.isArray(provider.models)
                ? provider.models
                      .map((model) => (typeof model?.id === 'string' ? model.id.trim() : ''))
                      .filter((id) => id !== '')
                : [];
            out.push({
                id: `${entryId}-${key}`,
                models,
                // A model id is what the user reads as the name of the thing; the provider's display name is the fallback.
                name: String(models[0] ?? provider.displayName ?? key),
                url,
                apiKeyEnv:
                    typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv !== ''
                        ? provider.apiKeyEnv
                        : 'LOCAL_API_KEY',
                from: `${entryId}/${key}`
            });
        }
    }
    return out;
}
export { keyFor };
// 插件入口：注册状态路由，并按页面的请求节奏对引擎做按需扫描。
export function apply(ctx, config) {
    for (const name of OPTIONAL) {
        try {
            ctx.inject?.(name, () => {
                /* only the presence matters; the keys are read on each poll */
            });
        } catch {
            // A composition without that service still reads the environment.
        }
    }

    /** The last read of the model providers' config, kept for DISCOVER_MS because reading it touches the disk. */
    let found = [];
    let foundAt = 0;
    /** Every server that has been configured at some point keeps its own reader and its last good reading. */
    const hubs = new Map();
    const hubFor = (id) => {
        let hub = hubs.get(id);
        if (hub === undefined) {
            hub = {
                reader: new Reader(),
                latest: null,
                latestBeat: null,
                failure: 'unreachable',
                declared: null,
                declaredAt: 0,
                busy: false
            };
            hubs.set(id, hub);
        }
        return hub;
    };
    const servers = () => {
        let written = [];
        try {
            written = listed(config.servers.get());
        } catch {
            written = [];
        }
        let wanted = true;
        try {
            wanted = config.discover.get() !== false;
        } catch {
            wanted = true;
        }
        if (wanted && Date.now() - foundAt > DISCOVER_MS) {
            foundAt = Date.now();
            try {
                found = discovered(ctx);
            } catch {
                // A profile this plugin cannot read is not a reason to stop reporting the ones already written down.
                found = [];
            }
        }
        // A hand-written row wins over a discovered one for the same engine: the id may differ, the address may not.
        const seen = new Set(written.map((row) => row.url.replace(/\/+$/, '')));
        return wanted
            ? [...written, ...found.filter((row) => !seen.has(row.url.replace(/\/+$/, '')) && !seen.has(row.id))]
            : written;
    };
    /** The row the pill reports: the one the page picked, else the first configured server. */
    const activeRow = () => {
        const rows = servers();
        if (rows.length === 0) return null;
        let wanted = '';
        try {
            wanted = String(config.active.get() ?? '');
        } catch {
            wanted = '';
        }
        return rows.find((row) => row.id === wanted) ?? rows[0];
    };
    /**
     * The row serving a model, as the composer's picker named it. A row's label is what discovery found in the model
     * settings, and an engine says its own id in its metric labels and on /v1/models; all three are the same string
     * for a server that serves one model, which is what a local engine is.
     */
    const rowServing = (model) => {
        const asked = String(model ?? '')
            .trim()
            .toLowerCase();
        if (asked === '') return null;
        const rows = servers();
        const said = (row) => {
            const hub = hubs.get(row.id);
            const names = [row.name, hub?.declared ?? '', hub?.latest?.modelName ?? ''];
            if (Array.isArray(row.models)) names.push(...row.models);
            // A row that names no model would otherwise match every model, because every string contains the empty one.
            return names.map((text) => String(text).trim().toLowerCase()).filter((text) => text !== '');
        };
        const exact = rows.find((row) => said(row).includes(asked));
        if (exact !== undefined) return exact;
        // The picker shows a display name, the provider an id: a row whose display name or served id contains the
        // asked-for text still serves that model, so a pick the ids do not spell out is not answered as hosted.
        return rows.find((row) => said(row).some((name) => asked.includes(name) || name.includes(asked))) ?? null;
    };
    // 读一台引擎：/metrics 每一拍都读，/v1/models 每 30 秒补一次模型 id。
    const read = async (hub, row) => {
        if (hub.busy) return;
        hub.busy = true;
        try {
            const base = parseAddress(row.url);
            if (base === null) return (hub.failure = 'invalid');
            const key = await keyFor(ctx, row.apiKeyEnv);
            const ask = (path, accept) =>
                fetch(joinPath(base, path), {
                    headers: {
                        ...(key === '' ? {} : { authorization: `Bearer ${key}` }),
                        ...(accept === undefined ? {} : { accept })
                    },
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                    cache: 'no-store'
                });
            const response = await ask('/metrics', 'text/plain').catch(() => null);
            if (response === null) return (hub.failure = 'unreachable');
            if (response.status === 401 || response.status === 403) return (hub.failure = 'apiKey');
            if (!response.ok) return (hub.failure = 'http');
            const text = await readLimited(response);
            if (text === null) return (hub.failure = 'large');
            const series = parsePrometheus(text);
            if (series.size === 0) return (hub.failure = 'notEngine');
            const beat = hub.reader.ingest(series);
            hub.latestBeat = beat;
            hub.latest = hub.reader.view(beat);
            hub.failure = null;
            // /v1/models carries the served id; the metric labels usually carry it too, but not every engine.
            if (Date.now() - hub.declaredAt > MODEL_MS) {
                hub.declaredAt = Date.now();
                const models = await ask('/v1/models').catch(() => null);
                if (models?.ok === true) {
                    const body = await models.json().catch(() => null);
                    const first = Array.isArray(body?.data) ? body.data[0] : null;
                    if (typeof first?.id === 'string') hub.declared = first.id;
                }
            }
        } catch {
            hub.failure = 'unreachable';
        } finally {
            hub.busy = false;
        }
    };
    /**
     * One sweep over every configured server. It is driven by the page's own reads rather than by a timer, so a closed
     * page costs the engines nothing: a background poll would keep asking a busy engine for its metrics while nobody
     * looks at them, and reading metrics is work the engine has to do between its own requests.
     */
    let sweeping = false;
    let sweptAt = 0;
    const poll = async () => {
        // The page reads every two seconds; a sweep closer than this adds nothing but load.
        if (sweeping || Date.now() - sweptAt < SWEEP_MS) return;
        sweeping = true;
        sweptAt = Date.now();
        try {
            const rows = servers();
            const kept = new Set(rows.map((row) => row.id));
            for (const id of hubs.keys()) {
                if (!kept.has(id)) hubs.delete(id);
            }
            // Every configured server is read, so switching to another one shows a reading at once and the page can say
            // which of them answer.
            await Promise.all(rows.map((row) => read(hubFor(row.id), row)));
        } finally {
            sweeping = false;
        }
    };
    // A page that opens between two reads gets one now; nothing else runs while no page is open.
    ctx.effect(() => {
        void poll();
    }, 'qwen-scope: first sweep');
    ctx.effect(
        () =>
            ctx.webServer.register({
                kind: 'exact',
                path: ROUTE,
                handler: async (req, res) => {
                    // The same Host/Origin checks and sign-in as dsh's own /api routes.
                    const rejection = ctx.connection.requestRejection(req);
                    if (rejection !== undefined || req.method !== 'GET') {
                        res.writeHead(rejection ?? 405, rejection === undefined ? { allow: 'GET' } : {});
                        res.end();
                        return;
                    }
                    // The read itself refreshes the engines, so the poller runs only while a page is looking. Awaiting it keeps
                    // the first read of a fresh page from answering with the empty state of a sweep that never ran.
                    await poll();
                    const rows = servers();
                    if (rows.length === 0) return send(res, JSON.stringify({ error: 'unset' }));
                    const configured = activeRow();
                    const listed = {
                        servers: rows.map((row) => brief(hubs.get(row.id), row)),
                        activeId: configured.id,
                        activeName: configured.name
                    };
                    // Which engine to report is the composer's choice, not this plugin's: the cell belongs to the model this
                    // session runs on. Without a named model — an old session, or a client that does not say — the page's own
                    // pick answers for it.
                    const asked = askedModel(req);
                    const active = asked === '' ? configured : rowServing(asked);
                    // A model none of these engines serves (a hosted one, usually): there is no prefill to show for it.
                    if (active === null) return send(res, JSON.stringify({ ...listed, error: 'notLocal' }));
                    const hub = hubFor(active.id);
                    // The picked server is named even when it is not answering: the pill says which one is silent.
                    const body = { ...listed, serverId: active.id, serverName: active.name, url: active.url };
                    if (hub.failure !== null) return send(res, JSON.stringify({ ...body, error: hub.failure }));
                    if (hub.latest === null) return send(res, JSON.stringify({ ...body, error: 'warming' }));
                    const view = { ...hub.latest, asked: asked || null };
                    view.modelName = view.modelName ?? hub.declared;
                    // The address the reading came from, so the page can tell which engine a number belongs to.
                    view.url = active.url;
                    view.serverId = active.id;
                    view.serverName = active.name;
                    send(res, JSON.stringify({ ...body, ...view }));
                }
            }),
        'qwen-scope: state route'
    );
}
