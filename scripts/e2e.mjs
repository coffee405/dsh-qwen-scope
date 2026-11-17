#!/usr/bin/env node
// Runs the host half against a real engine with a stand-in dsh context: one effect runner, one route registry, one
// HTTP server. Nothing here ships to users; it answers "does the poller and its route actually work" in one command.
// 中文说明：用替身 dsh 上下文跑宿主半边（轮询器 + 路由），验证成功与各种失败路径。
import http from 'node:http';
import { ROUTE, apply } from '../lib/index.js';

const settings = {
    servers: [
        {
            id: 'local-model',
            name: 'local-model',
            url: process.env.QWEN_SCOPE_URL ?? 'http://127.0.0.1:8000',
            apiKeyEnv: process.env.QWEN_SCOPE_KEY_ENV ?? 'LOCAL_API_KEY'
        },
        { id: 'second-model', name: 'second model', url: 'http://127.0.0.1:1', apiKeyEnv: 'LOCAL_API_KEY' }
    ],
    active: 'local-model',
    discover: true
};
/** The profile as the model provider plugin sees it: one local engine, one hosted one, and a machine on the LAN. */
const profileRows = [
    {
        entry: { options: { id: 'llm-pi-ai' } },
        inherited: {},
        override: {
            providers: {
                local: {
                    displayName: 'local',
                    apiKeyEnv: 'LOCAL_API_KEY',
                    baseURL: `${process.env.QWEN_SCOPE_URL ?? 'http://127.0.0.1:8000'}/v1`,
                    models: [{ id: 'local-model-from-profile' }, { id: 'local-model-second' }]
                },
                'second-model': {
                    displayName: 'second-model',
                    apiKeyEnv: 'LOCALDS_API_KEY',
                    baseURL: 'http://127.0.0.1:1/v1',
                    models: [{ id: 'second-model-from-profile' }]
                },
                hosted: {
                    displayName: 'Hosted',
                    apiKeyEnv: 'HOSTED_KEY',
                    baseURL: 'https://api.deepseek.com/v1',
                    models: [{ id: 'deepseek' }]
                }
            }
        }
    }
];
const config = {
    servers: { get: () => settings.servers },
    active: { get: () => settings.active },
    discover: { get: () => settings.discover }
};
const routes = new Map();
const cleanups = [];
const ctx = {
    effect: (run) => {
        const cleanup = run();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    webServer: {
        register: (entry) => {
            routes.set(entry.path, entry.handler);
            return () => routes.delete(entry.path);
        }
    },
    connection: { requestRejection: () => undefined },
    inject: () => {},
    // The credential plane a user-entered key lives in, and the launch environment its `.env` layers reach. A key held
    // in either answers here, which is what the real composition does; `process.env` alone is not enough.
    get: (name) => {
        if (name === 'configEditor') return { configuration: () => profileRows };
        if (name === 'credentials') return { resolve: async (ref) => ({ value: process.env[`${ref}_STORED`] ?? '' }) };
        if (name === 'launchEnvironment') return { get: (ref) => ({ value: process.env[`${ref}_LAUNCH`] }) };
        return undefined;
    }
};
apply(ctx, config);
const server = http.createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://local').pathname);
    if (handler === undefined) return void res.writeHead(404).end();
    void handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const ask = async (path, init) => {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : JSON.parse(text) };
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const check = (what, got, want) => checks.push([what, got, want]);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const rowOf = (body, id) => (Array.isArray(body?.servers) ? body.servers.find((row) => row.id === id) : undefined);
await wait(7000);
const full = await ask(ROUTE);
check('the route answers 200', full.status, 200);
check('the reading is ok', full.body?.ok, true);
check('the served model is named', typeof full.body?.modelName, 'string');
check('the engine is recognised', full.body?.engine, process.env.QWEN_SCOPE_ENGINE ?? 'Radiance');
check('the picked server is named', full.body?.serverName, 'local-model');
check('the address comes back', typeof full.body?.url, 'string');
check('a good reading carries no error', full.body?.error, null);
check('both servers are listed', Array.isArray(full.body?.servers) && full.body.servers.length, 2);
check('the live one says so', rowOf(full.body, 'local-model')?.online, true);
check('the dead one says so too', rowOf(full.body, 'second-model')?.online, false);
check('and why it is dead', rowOf(full.body, 'second-model')?.error, 'unreachable');
const post = await fetch(`${base}${ROUTE}`, { method: 'POST' });
check('only GET is served', post.status, 405);
// Nothing written by hand: the engine named by the model provider is found on its own, and the hosted one is left out.
settings.servers = [];
await wait(5000);
const found = await ask(ROUTE);
check('a provider server is answering', found.body?.error, null);
check('and named after the model it serves', found.body?.serverName, 'local-model-from-profile');
check(
    'the hosted provider is not watched',
    found.body?.servers?.some((row) => row.url.includes('deepseek.com')),
    false
);
check('and the discovered row says where it came from', rowOf(found.body, 'llm-pi-ai-local')?.from, 'llm-pi-ai/local');
// Switching the pick over costs a poll, not a restart: the row is volatile configuration.
settings.active = 'llm-pi-ai-local';
await wait(1000);
check('the discovered server can be picked', (await ask(ROUTE)).body?.serverName, 'local-model-from-profile');
// The composer's choice outranks this page's pick: the cell belongs to the model the session is running on.
settings.active = 'llm-pi-ai-second-model';
await wait(1000);
const following = await ask(`${ROUTE}?model=${encodeURIComponent('local-model-from-profile')}`);
check('the session\u2019s model is the one reported', following.body?.serverName, 'local-model-from-profile');
check('and its engine answers for the cell', following.body?.error, null);
check(
    'the page\u2019s own pick is still reported to the settings page',
    following.body?.activeName,
    'second-model-from-profile'
);
const dead = await ask(`${ROUTE}?model=${encodeURIComponent('second-model-from-profile')}`);
check('a model whose engine is silent says which one it is', dead.body?.serverName, 'second-model-from-profile');
check('and says it is unreachable', dead.body?.error, 'unreachable');
// Any of the models a provider row offers is served by that same engine, not only the first one in its list.
const second = await ask(`${ROUTE}?model=${encodeURIComponent('local-model-second')}`);
check('a second model on the same engine is found', second.body?.serverName, 'local-model-from-profile');
const hosted = await ask(`${ROUTE}?model=${encodeURIComponent('deepseek')}`);
check('a model no local engine serves says so', hosted.body?.error, 'notLocal');
check(
    'but still lists the engines it has',
    Array.isArray(hosted.body?.servers) && hosted.body.servers.length > 0,
    true
);
settings.active = 'llm-pi-ai-local';
// Turning discovery off leaves a plugin with nothing to read, which is an answer rather than a hang.
settings.discover = false;
await wait(1000);
check('discovery can be turned off', (await ask(ROUTE)).body?.error, 'unset');
settings.discover = true;
settings.servers = [
    {
        id: 'local-model',
        name: 'local-model',
        url: process.env.QWEN_SCOPE_URL ?? 'http://127.0.0.1:8000',
        apiKeyEnv: 'LOCAL_API_KEY'
    },
    { id: 'second-model', name: 'second model', url: 'http://127.0.0.1:1', apiKeyEnv: 'LOCAL_API_KEY' }
];
settings.active = 'local-model';
await wait(5000);
const again = await ask(ROUTE);
check(
    'a written row is not listed twice',
    (again.body?.servers ?? []).filter((row) => row.id === 'llm-pi-ai-local').length +
        (again.body?.servers ?? []).filter((row) => row.url === settings.servers[0].url).length,
    1
);
// The page pointing the pill at the other server: the same route now answers for that one, and says it is unreachable.
settings.active = 'second-model';
await wait(1000);
const picked = await ask(ROUTE);
check('a switch is answered at once', picked.body?.activeName, 'second model');
check('the picked server is reported by id', picked.body?.activeId, 'second-model');
check('a dead server is an error, not a zero', picked.body?.error, 'unreachable');
settings.active = 'local-model';
settings.discover = false;
settings.servers = [{ id: 'local-model', name: 'local-model', url: '', apiKeyEnv: 'LOCAL_API_KEY' }];
await wait(3000);
check('an empty address says so', (await ask(ROUTE)).body?.error, 'unset');
settings.servers = [{ id: 'local-model', name: 'local-model', url: 'not a url @', apiKeyEnv: 'LOCAL_API_KEY' }];
await wait(3000);
check('an unusable address says so', (await ask(ROUTE)).body?.error, 'invalid');
settings.servers = [{ id: 'local-model', name: 'local-model', url: 'http://127.0.0.1:1', apiKeyEnv: 'LOCAL_API_KEY' }];
await wait(3000);
check('an unreachable engine says so', (await ask(ROUTE)).body?.error, 'unreachable');
// A server that wants a key, and no key to give it: the address of a guarded engine, or the real one without its key.
settings.servers = [
    {
        id: 'local-model',
        name: 'local-model',
        url: process.env.QWEN_SCOPE_KEYED_URL ?? process.env.QWEN_SCOPE_URL ?? 'http://127.0.0.1:8000',
        apiKeyEnv: 'QWEN_SCOPE_A_KEY_THAT_DOES_NOT_EXIST'
    }
];
await wait(3000);
const noKey = await ask(ROUTE);
check('a missing key is reported as such', noKey.body?.error, 'apiKey');
for (const cleanup of cleanups) cleanup();
server.close();
let failed = 0;
for (const [what, got, want] of checks) {
    const ok = got === want;
    if (!ok) failed += 1;
    console.log(
        `${ok ? 'ok  ' : 'FAIL'} ${what}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
    );
}
if (full.body?.ok === true) {
    console.log(
        `\nlive reading: ${full.body.serverName} ${full.body.engine} ${full.body.modelName}  ` +
            `prefill ${finite(full.body.prefillTokensPerSecond) ? full.body.prefillTokensPerSecond.toFixed(1) : '—'} tok/s  ` +
            `decode ${finite(full.body.decodeTokensPerSecond) ? full.body.decodeTokensPerSecond.toFixed(1) : '—'} tok/s  ` +
            `kv ${finite(full.body.kvCachePercent) ? full.body.kvCachePercent.toFixed(1) : '—'}%  running ${full.body.runningRequests}`
    );
}
console.log(failed === 0 ? `\ne2e passed (${checks.length} checks)` : `\ne2e failed (${failed} of ${checks.length})`);
process.exitCode = failed === 0 ? 0 : 1;
