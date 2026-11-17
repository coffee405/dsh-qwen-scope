#!/usr/bin/env node
// Reads a live engine the way the plugin does and prints what the card would show, so the parsing can be checked
// without a running dsh. `--self-test` runs the same code against two crafted metric pages instead of the network.
// 中文说明：按插件的方式读一台真实引擎并打印单元格会显示的值；`--self-test` 不联网，跑内置用例。
import { readFileSync } from 'node:fs';
import { joinPath, parseAddress, parsePrometheus, percentileBetween, Reader, readHistogram } from '../lib/metrics.js';
import { engineUrl, keyFor } from '../lib/index.js';
/**
 * Loads the browser half outside a browser: it only registers itself with the module loader, so a stub loader hands
 * back the module and its parsing helpers can be checked here. Nothing in it runs React until `apply` is called.
 */
async function loadClient() {
    let registered = null;
    globalThis.window = { __ModuleLoader__: { load: (entry) => (registered = entry) } };
    await import('../lib/client.js');
    const react = {
        createElement: () => null,
        useCallback: () => {},
        useEffect: () => {},
        useId: () => '',
        useRef: () => ({}),
        useState: () => [undefined, () => {}]
    };
    const primitives = { IconDataOutlineRegular: () => null };
    return registered.factory((id) =>
        id === 'react' ? react : id === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : undefined
    );
}

const argument = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
};
const fixed = (value, digits = 1, unit = '') => (Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : '—');
const histogramText = (base, le, value, extra = '') => `${base}_bucket{le="${le}"${extra}} ${value}`;

async function selfTest() {
    const page = (generated, prompt, ttftShort, ttftLong, running) =>
        [
            '# HELP vllm:num_requests_running Number of requests currently running on GPU.',
            `vllm:num_requests_running{model_name="test-model",engine="0"} ${running}`,
            'vllm:num_requests_waiting{model_name="test-model",engine="0"} 1',
            'vllm:kv_cache_usage_perc{model_name="test-model",engine="0"} 0.25',
            'vllm:gpu_prefix_cache_hit_rate{model_name="test-model",engine="0"} 0.9',
            `vllm:generation_tokens_total{model_name="test-model",engine="0"} ${generated}`,
            `vllm:prompt_tokens_total{model_name="test-model",engine="0"} ${prompt}`,
            'vllm:request_success_total{model_name="test-model",engine="0,finished_reason="stop"} 4',
            histogramText('vllm:time_to_first_token_seconds', '0.1', ttftShort, ',model_name="test-model"'),
            histogramText('vllm:time_to_first_token_seconds', '1', ttftShort + ttftLong, ',model_name="test-model"'),
            histogramText('vllm:time_to_first_token_seconds', '+Inf', ttftShort + ttftLong, ',model_name="test-model"'),
            `vllm:time_to_first_token_seconds_count{model_name="test-model",engine="0"} ${ttftShort + ttftLong}`
        ].join('\n');
    const reader = new Reader(60_000);
    const first = reader.ingest(parsePrometheus(page(100, 500, 2, 6, 0)), 1_000);
    const second = reader.ingest(parsePrometheus(page(400, 1500, 2, 16, 3)), 3_000);
    const view = reader.view(second);
    const history = reader.history(second);
    const checks = [
        ['model id from labels', view.modelName, 'test-model'],
        ['engine from prefixes', view.engine, 'vLLM'],
        ['decode rate', view.decodeTokensPerSecond, 150],
        ['prefill rate', view.prefillTokensPerSecond, 500],
        ['running gauge', view.runningRequests, 3],
        ['waiting gauge', view.waitingRequests, 1],
        ['kv percent', view.kvCachePercent, 25],
        ['prefix cache percent', view.prefixCacheHitPercent, 90],
        // Ten new requests land in the (0.1, 1] bucket: p95 interpolates 0.1 + 0.9 * 9.5 / 10.
        ['p95 inside a bucket, interpolated', view.ttftP95Seconds, 0.955],
        ['percentile window covers the beats held', view.windowSeconds, 2],
        ['no tpot buckets means no reading', view.tpotP95Seconds, null],
        ['history point count', history.length, 1],
        ['history decode', history[0].decode, 150],
        [
            'histogram totals',
            readHistogram(parsePrometheus(page(1, 1, 2, 6, 0)), 'vllm:time_to_first_token_seconds').count,
            8
        ],
        [
            'a window with no requests reports nothing',
            percentileBetween(reader.beats[0].histograms.ttft, reader.beats[0].histograms.ttft, 0.95),
            null
        ],
        ['address without a scheme gets one', parseAddress('127.0.0.1:8000/').href, 'http://127.0.0.1:8000/'],
        ['empty address is refused', parseAddress('  '), null],
        [
            'a bare address joins to /metrics',
            joinPath(parseAddress('http://127.0.0.1:8000'), '/metrics').href,
            'http://127.0.0.1:8000/metrics'
        ],
        [
            'a proxy prefix is kept',
            joinPath(parseAddress('https://host.example/sglang/'), '/metrics').href,
            'https://host.example/sglang/metrics'
        ]
    ];
    // The two engines on this network, from their own /metrics. TensorFold writes nothing under a vLLM name; Radiance
    // mirrors vLLM and counts the prompt it actually computed apart from the prompt it was handed.
    const tensorfoldPage = (prompt, generated, running, kv, served) =>
        [
            `tensorfold:prompt_tokens_total ${prompt}`,
            `tensorfold:generation_tokens_total ${generated}`,
            `tensorfold:num_requests_running ${running}`,
            `tensorfold:num_requests_waiting 0`,
            `tensorfold:kv_cache_usage_perc{stream="0"} ${kv}`,
            `tensorfold:time_to_first_token_seconds_bucket{le="0.5"} ${served}`,
            `tensorfold:time_to_first_token_seconds_bucket{le="+Inf"} ${served}`,
            `tensorfold:time_to_first_token_seconds_sum ${served * 0.5}`,
            `tensorfold:time_to_first_token_seconds_count ${served}`
        ].join('\n');
    const tfReader = new Reader(60_000);
    tfReader.ingest(parsePrometheus(tensorfoldPage(100, 20, 1, 0.2, 0)), 1_000);
    const tf = tfReader.view(tfReader.ingest(parsePrometheus(tensorfoldPage(1100, 100, 2, 0.4, 4)), 3_000));
    const radiancePage = (computed, asked, generated, running) =>
        [
            `radiance:prefill_tokens_total{model_name="local-model",engine="0"} ${computed}`,
            `radiance:decode_tokens_total{model_name="local-model",engine="0"} ${generated}`,
            `vllm:prompt_tokens_total{model_name="local-model",engine="0"} ${asked}`,
            `vllm:generation_tokens_total{model_name="local-model",engine="0"} ${generated}`,
            `vllm:num_requests_running{model_name="local-model",engine="0"} ${running}`,
            'vllm:kv_cache_usage_perc{model_name="local-model"} 0.1'
        ].join('\n');
    const radReader = new Reader(60_000);
    radReader.ingest(parsePrometheus(radiancePage(1000, 9000, 100, 1)), 1_000);
    const rad = radReader.view(radReader.ingest(parsePrometheus(radiancePage(3000, 13000, 500, 0)), 3_000));
    checks.push(
        ['TensorFold is named from its own prefix', tf.engine, 'TensorFold'],
        ['its served model comes from /v1/models', tf.modelName, null],
        ['its prefill is read under its own name', tf.prefillTokensPerSecond, 500],
        ['its decode rate too', tf.decodeTokensPerSecond, 40],
        ['its queue gauge too', tf.runningRequests, 2],
        ['its cache watermarks too', `${tf.kvCachePercent}`, '40'],
        ['a prefix cache it does not count stays unreported', tf.reported.prefixCacheHitPercent, false],
        // Four requests land in the (0, 0.5] bucket: p95 interpolates 0.5 * 3.8 / 4 inside it.
        ['its p95 still comes from its own histogram', tf.ttftP95Seconds, 0.475],
        ['Radiance is named over the vLLM names it mirrors', rad.engine, 'Radiance'],
        ['its prefill is what it computed, not what it was asked', rad.prefillTokensPerSecond, 1000],
        ['the asked-for prompt is left out of that number', rad.totals.promptTokens, 13000],
        ['its decode rate comes from its own counter', rad.decodeTokensPerSecond, 200],
        ['the vLLM mirror still fills the cache gauge', rad.kvCachePercent, 10]
    );
    // SGLang keeps a prompt queue: the tokens still waiting to be prefilled, read once, is the live prefill rate. A
    // vLLM counter that moved by a handful of tokens between two beats is a request starting, not a prefill.
    const sglangPage = (queued) =>
        [
            'sglang:num_requests_running{model_name="local-model"} 1',
            `sglang:num_prefill_prompt_tokens_queued{model_name="local-model"} ${queued}`,
            'sglang:prompt_tokens_total{model_name="local-model"} 400'
        ].join('\n');
    const sgReader = new Reader(60_000);
    sgReader.ingest(parsePrometheus(sglangPage(0)), 1_000);
    const sg = sgReader.view(sgReader.ingest(parsePrometheus(sglangPage(800)), 3_000));
    const sgIdle = sgReader.view(sgReader.ingest(parsePrometheus(sglangPage(0)), 5_000));
    const vllmSmall = new Reader(60_000);
    vllmSmall.ingest(parsePrometheus('vllm:prompt_tokens_total{model_name="m"} 100'), 1_000);
    const vllmSmallView = vllmSmall.view(
        vllmSmall.ingest(parsePrometheus('vllm:prompt_tokens_total{model_name="m"} 106'), 3_000)
    );
    // A real page carries the request gauges too; without any, the reader's first beat has nothing to settle on.
    const vllmIdle = new Reader(60_000);
    const idlePage = (prompt) =>
        `vllm:num_requests_running{model_name="m"} 0\nvllm:prompt_tokens_total{model_name="m"} ${prompt}`;
    vllmIdle.ingest(parsePrometheus(idlePage(100)), 1_000);
    const vllmIdleView = vllmIdle.view(vllmIdle.ingest(parsePrometheus(idlePage(100)), 3_000));
    checks.push(
        ['SGLang is named from its own prefix', sg.engine, 'SGLang'],
        ['its prompt queue is the prefill rate', sg.prefillTokensPerSecond, 400],
        ['an empty queue is a true zero', sgIdle.prefillTokensPerSecond, 0],
        ['a counter that moved six tokens is no prefill', vllmSmallView.prefillTokensPerSecond, null],
        ['a counter that did not move is an idle engine', vllmIdleView.prefillTokensPerSecond, 0],
        // The exposition is read for both tails: Prometheus' own `value` and the `= value` some engines write.
        [
            'a plain tail is read',
            parsePrometheus('vllm:num_requests_running 2').get('vllm:num_requests_running')?.[0].value,
            2
        ],
        [
            'an equals tail is read too',
            parsePrometheus('vllm:num_requests_running{a="b"}= 3').get('vllm:num_requests_running')?.[0].value,
            3
        ],
        [
            'and its labels are kept',
            parsePrometheus('vllm:num_requests_running{a="b"}= 3').get('vllm:num_requests_running')?.[0].labels.a,
            'b'
        ],
        ['a comment line is not a series', parsePrometheus('# HELP vllm:num_requests_running 3').size, 0]
    );
    const tfPage = (prompt, generated, ttft, decode) =>
        [
            'tensorfold:num_requests_running{model_name="m"} 0',
            `tensorfold:prompt_tokens_total{model_name="m"} ${prompt}`,
            `tensorfold:generation_tokens_total{model_name="m"} ${generated}`,
            'tensorfold:time_to_first_token_seconds_bucket{le="+Inf",model_name="m"} 10',
            `tensorfold:time_to_first_token_seconds_sum{model_name="m"} ${ttft}`,
            'tensorfold:time_to_first_token_seconds_count{model_name="m"} 10',
            `tensorfold:request_decode_seconds_sum{model_name="m"} ${decode}`,
            'tensorfold:request_decode_seconds_count{model_name="m"} 10'
        ].join('\n');
    const tfLateReader = new Reader(60_000);
    tfLateReader.ingest(parsePrometheus(tfPage(10_000, 1_000, 10, 100)), 1_000);
    const tfTimed = tfLateReader.view(tfLateReader.ingest(parsePrometheus(tfPage(30_000, 1_300, 40, 102)), 3_000));
    const tfIdleReader = new Reader(60_000);
    tfIdleReader.ingest(parsePrometheus(tfPage(10_000, 1_000, 10, 100)), 1_000);
    const tfIdle = tfIdleReader.view(tfIdleReader.ingest(parsePrometheus(tfPage(10_000, 1_000, 10, 100)), 3_000));
    // An engine whose counters land when a request finishes: its own timing turns the batch into a rate, and an idle
    // one is a zero rather than a dash.
    // A long prompt finishing inside one poll is the shape that produced absurd numbers: the poll-to-poll difference of
    // an end-of-request counter is not a speed, so a late engine never reads it, whatever its size.
    const burstPage = (prompt, ttft) =>
        [
            'tensorfold:num_requests_running{model_name="m"} 0',
            `tensorfold:prompt_tokens_total{model_name="m"} ${prompt}`,
            'tensorfold:generation_tokens_total{model_name="m"} 0',
            'tensorfold:time_to_first_token_seconds_bucket{le="+Inf",model_name="m"} 10',
            `tensorfold:time_to_first_token_seconds_sum{model_name="m"} ${ttft}`,
            'tensorfold:time_to_first_token_seconds_count{model_name="m"} 10'
        ].join('\n');
    const burstReader = new Reader(60_000);
    burstReader.ingest(parsePrometheus(burstPage(1_000, 1)), 1_000);
    const burst = burstReader.view(burstReader.ingest(parsePrometheus(burstPage(201_000, 1)), 3_000));
    checks.push(
        ['a finished batch reads at its own rate', tfTimed.prefillTokensPerSecond, 666.6666666666666],
        ['and its decode rate too', tfTimed.decodeTokensPerSecond, 150],
        ['an idle late engine reads as zero', tfIdle.prefillTokensPerSecond, 0],
        // 200k prompt tokens landing inside one poll with no timing to divide them by must not read as a speed.
        ['a long prompt in one poll is not a rate', burst.prefillTokensPerSecond, 0]
    );
    const client = await loadClient();
    const hostView = {
        ok: true,
        engine: 'vLLM',
        modelName: 'local-model',
        updatedAt: new Date(2_000).toISOString(),
        serverId: 'local-model',
        serverName: 'local-model',
        activeId: 'local-model',
        activeName: 'local-model',
        servers: [
            {
                id: 'local-model',
                name: 'local-model',
                url: 'http://127.0.0.1:8000',
                online: true,
                error: null,
                modelName: 'local-model',
                engine: 'vLLM'
            },
            {
                id: 'second-model',
                name: 'second model',
                url: 'http://127.0.0.1:8001',
                online: false,
                error: 'unreachable',
                modelName: null,
                engine: null
            },
            'broken'
        ],
        decodeTokensPerSecond: 42.5,
        prefillTokensPerSecond: null,
        runningRequests: 1,
        waitingRequests: 0,
        kvCachePercent: 12.5,
        prefixCacheHitPercent: 90,
        ttftP95Seconds: 0.5,
        tpotP95Seconds: null,
        totals: { generatedTokens: 10, promptTokens: 20, completedRequests: 1 },
        reported: { kvCachePercent: true, ttftP95Seconds: true, tpotP95Seconds: false, promptTokens: true }
    };
    const card = client.parseState(hostView);
    const offline = client.parseReply({ error: 'apiKey', servers: hostView.servers, activeName: 'local-model' });
    checks.push(
        ['the page module registers an apply', typeof client.apply, 'function'],
        ['it needs the composer dock and settings slots', client.inject.join(','), 'slots,locale,configForms'],
        ['a reply with an error keeps the reason', offline.error, 'apiKey'],
        ['a failed reading still lists the servers', offline.state?.servers.length, 2],
        ['a reading survives the round trip', card.modelName, 'local-model'],
        ['the picked server is named', card.serverName, 'local-model'],
        [
            'prefill comes through',
            client.parseState({ ...hostView, prefillTokensPerSecond: 512 }).prefillTokensPerSecond,
            512
        ],
        ['a missing rate stays a dash', card.prefillTokensPerSecond, null],
        ['a rate formats compactly', client.rate(5120), '5.1k'],
        // The cell never turns red: a silent engine is a dash, and an engine without a prompt counter is a dash too.
        [
            'an idle engine shows its zero',
            client.cell({ prefillTokensPerSecond: 0, reported: { promptTokens: true } }, null),
            '0'
        ],
        [
            'a live reading shows as it is',
            client.cell({ prefillTokensPerSecond: 640.2, reported: { promptTokens: true } }, null),
            '640'
        ],
        [
            'an engine without a prompt counter shows a dash',
            client.cell({ prefillTokensPerSecond: null, reported: { promptTokens: false } }, null),
            '—'
        ],
        ['a silent engine shows a dash', client.cell({ prefillTokensPerSecond: 900 }, 'unreachable'), '—'],
        // What the cell shows when nothing is moving: an engine that answers is at zero, one that does not is a dash.
        ['an idle engine reads as zero', client.rate(client.reading({ prefillTokensPerSecond: null }, null)), '0'],
        [
            'a live rate is not rounded away',
            client.rate(client.reading({ prefillTokensPerSecond: 12.4 }, null)),
            '12.4'
        ],
        [
            'an engine that is not answering is a dash',
            client.rate(client.reading({ prefillTokensPerSecond: 900 }, 'unreachable')),
            '—'
        ],
        // The word stays technical in every language: prefill is the term, not a translation of it.
        ['the Chinese cell keeps the word', client.texts.zh.prefill, 'prefill'],
        ['and so does the English one', client.texts.en.prefill, 'prefill'],
        ['a silent server reads as a dash', client.rate(null), '—'],
        [
            'only reported metrics are claimed',
            `${card.reported.kvCachePercent}/${card.reported.tpotP95Seconds}`,
            'true/false'
        ],
        ['a server list drops unusable rows', card.servers.map((row) => row.id).join(','), 'local-model,second-model'],
        ['which server is offline stays visible', card.servers[1].online, false],
        ['a malformed body is unreachable', client.parseReply(null).error, 'unreachable'],
        // The addresses named by the model providers, read straight out of the profile.
        [
            'a provider /v1 address becomes the engine root',
            engineUrl('http://127.0.0.1:8000/v1'),
            'http://127.0.0.1:8000'
        ],
        ['a trailing slash is not doubled', engineUrl('http://localhost:8000/v1/'), 'http://localhost:8000'],
        [
            'a .local host is a machine worth asking',
            engineUrl('http://engine.local:8000/v1'),
            'http://engine.local:8000'
        ],
        ['a hosted provider is left alone', engineUrl('https://api.deepseek.com/v1'), null],
        ['a key in the address is not a host', engineUrl('sk-abc123'), null]
    );
    // The key is resolved the way the model providers resolve theirs: the credential plane first, then the launch
    // environment (the `.env` layers), then this process's own environment. Reading `process.env` alone misses it.
    const stored = await keyFor(
        {
            get: (name) =>
                name === 'credentials' ? { resolve: async (ref) => ({ value: `stored-${ref}` }) } : undefined
        },
        'LOCAL_API_KEY'
    );
    const fromEnv = await keyFor(
        { get: (name) => (name === 'launchEnvironment' ? { get: (ref) => ({ value: `launch-${ref}` }) } : undefined) },
        'LOCALDS_API_KEY'
    );
    const inherited = await keyFor({ get: () => undefined }, 'DSH_PROBE_MISSING_KEY');
    checks.push(
        ['the stored credential answers first', stored, 'stored-LOCAL_API_KEY'],
        ['the launch environment is the second answer', fromEnv, 'launch-LOCALDS_API_KEY'],
        ['an absent key reads as empty', inherited, '']
    );
    // The cell reads the model from its own session's projection: the picker's next choice first, then the last used.
    checks.push(
        [
            'a picked model is the one reported',
            client.modelOf({
                next: { provider: 'local', model: 'local-model' },
                lastUsed: { provider: 'local', model: 'other' }
            }),
            'local-model'
        ],
        [
            'without a pick the last used model answers',
            client.modelOf({ next: null, lastUsed: { provider: 'local', model: 'second-model' } }),
            'second-model'
        ],
        ['an empty projection names no model', client.modelOf(undefined), ''],
        // The cell is drawn whenever the host answers for a local engine; a `notLocal` answer is what takes it away.
        ['an unnamed session still draws the cell', client.cellShown(), true],
        // A fresh window runs nothing and spends nothing, and DSH's own statistics are hidden then: the cell follows the
        // same rule, so an empty composer shows nothing but the composer.
        ['a fresh session draws no cell', client.hasActivity(undefined, undefined), false],
        ['a stepped session draws it', client.hasActivity({ steps: 1 }, undefined), true],
        ['a session with usage draws it', client.hasActivity(undefined, { outputTokens: 3 }), true],
        [
            'a zeroed session stays hidden',
            client.hasActivity(
                { steps: 0 },
                { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
            ),
            false
        ]
    );
    let failed = 0;
    for (const [what, got, want] of checks) {
        const ok =
            Number.isFinite(got) && Number.isFinite(want)
                ? Math.abs(got - want) <= Math.abs(want) * 1e-9 + 1e-12
                : got === want;
        if (!ok) failed += 1;
        console.log(
            `${ok ? 'ok  ' : 'FAIL'} ${what}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
        );
    }
    console.log(
        failed === 0
            ? `\nself-test passed (${checks.length} checks)`
            : `\nself-test failed (${failed} of ${checks.length})`
    );
    process.exitCode = failed === 0 ? 0 : 1;
}
/** One stored credential reference from the profile's `.credentials.yaml`, or null. */
function readCredentialRef(name) {
    try {
        const text = readFileSync(`${process.env.HOME}/.dsh/.credentials.yaml`, 'utf8');
        const refs = text.split('\nrefs:')[1] ?? '';
        const line = refs.split('\n').find((row) => row.trimStart().startsWith(`${name}:`));
        return line === undefined
            ? null
            : line
                  .split(':')
                  .slice(1)
                  .join(':')
                  .trim()
                  .replace(/^['"]|['"]$/g, '');
    } catch {
        return null;
    }
}

async function probe() {
    const base = parseAddress(argument('url', 'http://127.0.0.1:8000'));
    if (base === null) throw new Error('bad --url');
    // A key entered in the settings page lives in the profile's credential file, not in this shell's environment.
    const key =
        process.env[argument('api-key-env', 'LOCAL_API_KEY')] ??
        readCredentialRef(argument('api-key-env', 'LOCAL_API_KEY')) ??
        '';
    const seconds = Number(argument('seconds', '6'));
    const reader = new Reader();
    const ask = async (path) =>
        (
            await fetch(joinPath(base, path), {
                headers: {
                    ...(key === '' ? {} : { authorization: `Bearer ${key}` }),
                    accept: path === '/metrics' ? 'text/plain' : '*/*'
                },
                signal: AbortSignal.timeout(5000)
            })
        ).text();
    const deadline = Date.now() + seconds * 1000;
    let last = null;
    while (Date.now() < deadline) {
        last = reader.ingest(parsePrometheus(await ask('/metrics')));
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const view = reader.view(last);
    const models = JSON.parse(await ask('/v1/models')).data ?? [];
    const served = models[0] ?? {};
    console.log(`${base.href}  engine ${view.engine}  model ${view.modelName ?? served.id ?? '—'}`);
    if (typeof served.root === 'string')
        console.log(
            `  served ${served.root} (max_model_len ${served.max_model_len ?? '—'}, owned_by ${served.owned_by ?? '—'})`
        );
    console.log(
        `  decode ${fixed(view.decodeTokensPerSecond)} tok/s   prefill ${fixed(view.prefillTokensPerSecond)} tok/s`
    );
    console.log(
        `  running ${fixed(view.runningRequests, 0)}  queued ${fixed(view.waitingRequests, 0)}  kv ${fixed(view.kvCachePercent, 1, '%')}  prefix cache ${fixed(view.prefixCacheHitPercent, 1, '%')}`
    );
    console.log(
        `  ttft p95 ${fixed(view.ttftP95Seconds, 3, 's')} over ${fixed(view.windowSeconds, 0, 's')}   tpot p95 ${fixed(view.tpotP95Seconds, 4, 's')}`
    );
    console.log(
        `  totals: prompt ${fixed(view.totals.promptTokens, 0)} generated ${fixed(view.totals.generatedTokens, 0)} completed ${fixed(view.totals.completedRequests, 0)}`
    );
    const history = reader.history(last);
    const peak = (key) => history.reduce((most, point) => Math.max(most, point[key] ?? 0), 0);
    console.log(
        `  sparkline: ${history.length} points, peak decode ${fixed(peak('decode'))} tok/s, peak prefill ${fixed(peak('prefill'))} tok/s`
    );
}
if (process.argv.includes('--self-test')) selfTest();
else await probe();
