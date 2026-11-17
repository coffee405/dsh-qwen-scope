/**
 * Reading a vLLM-compatible /metrics endpoint (vLLM, SGLang, and the Radiance engine all serve this shape) and
 * turning the stream of polls into rates and windowed percentiles. No dsh imports here: the same file can run in a
 * test, in a probe script, and inside the host plugin.
 */
/** The engine is polled on this beat; the card only reads what the last beat produced. */
// 采样节奏（毫秒）：宿主每 2 秒读一次引擎指标，页面只消费最新一拍。
export const POLL_MS = 2000;
export const MODEL_MS = 30_000;
/** Latency percentiles are computed over this window, the five-minute p95 the card shows. */
export const WINDOW_MS = 5 * 60_000;
/**
 * The names a vLLM-shaped server writes its numbers under. Every other engine is read through `ENGINES` below, which
 * says only where that engine's names differ; a number it does not count is left out rather than read as a zero.
 */
export const COUNTERS = {
    generatedTokens: 'vllm:generation_tokens_total',
    promptTokens: 'vllm:prompt_tokens_total',
    /**
     * Prompt tokens the engine actually computed. It shares vLLM's name because vLLM computes what it is asked to
     * compute; an engine that serves a prompt from its prefix cache and counts the difference separately overrides it.
     */
    prefillTokens: 'vllm:prompt_tokens_total',
    completedRequests: 'vllm:request_success_total'
};
/** An engine with a prompt queue of its own: SGLang counts the tokens waiting to be prefilled right now. */
export const PREFILL = {
    queuedPromptTokens: 'num_prefill_prompt_tokens_queued'
};
/** The same gauge under the prefixes engines write it with. */
export const PREFILL_ALIASES = ['vllm:num_prefill_prompt_tokens_queued', 'sglang:num_prefill_prompt_tokens_queued'];
export const GAUGES = {
    runningRequests: 'vllm:num_requests_running',
    waitingRequests: 'vllm:num_requests_waiting'
};
/**
 * The rates an engine computes itself. A rate read off a counter difference is a lump when a prefill finishes inside one
 * poll; an engine that publishes its own live rate is read from that instead, which is the number it is computing now.
 */
export const RATES = {
    prefillRate: null,
    decodeRate: null
};
export const HISTOGRAMS = {
    ttft: 'vllm:time_to_first_token_seconds',
    tpot: 'vllm:time_per_output_token_seconds',
    /** The wall time a finished request spent decoding, which turns its token counts into the rate a user reads. */
    decodeSeconds: 'vllm:request_decode_time_seconds'
};
/** The cache watermarks and the prefix hit rate, best name first: some engines name the GPU pool, some the stream. */
export const CACHE = ['vllm:kv_cache_usage_perc', 'vllm:gpu_cache_usage_perc'];
export const HIT = ['vllm:gpu_prefix_cache_hit_rate', 'vllm:prefix_cache_hit_rate'];
/** Per engine, the names that are not the ones above. */
export const ENGINES = {
    // SGLang writes its own prefix over vLLM's names, so only the prefix is different; the prompt queue is in PREFILL.
    SGLang: {
        counters: {
            generatedTokens: 'sglang:generation_tokens_total',
            promptTokens: 'sglang:prompt_tokens_total',
            prefillTokens: 'sglang:prompt_tokens_total',
            completedRequests: 'sglang:num_requests_total'
        },
        gauges: { runningRequests: 'sglang:num_requests_running', waitingRequests: 'sglang:num_requests_waiting' },
        histograms: { ttft: 'sglang:time_to_first_token_seconds', tpot: 'sglang:inter_token_latency_seconds' },
        cache: ['sglang:token_usage', 'sglang:cache_hit_rate']
    },
    TensorFold: {
        counters: {
            generatedTokens: 'tensorfold:generation_tokens_total',
            // A finished request's prompt tokens, counted when the reply leaves: the rate lags a running prefill.
            promptTokens: 'tensorfold:prompt_tokens_total',
            prefillTokens: 'tensorfold:prompt_tokens_total'
        },
        gauges: {
            runningRequests: 'tensorfold:num_requests_running',
            waitingRequests: 'tensorfold:num_requests_waiting'
        },
        histograms: {
            ttft: 'tensorfold:time_to_first_token_seconds',
            tpot: 'tensorfold:request_time_per_output_token_seconds',
            // The wall time this engine spent decoding, which turns its finished-request token counts into rates.
            decodeSeconds: 'tensorfold:request_decode_seconds'
        },
        /**
         * Its counters land when a request finishes, so a poll-to-poll difference is the batch's whole prompt divided by
         * two seconds — a lump, not what the engine is doing now. Its own time histograms say how long that batch took,
         * which is the same rate the session's statistics report.
         */
        late: true,
        cache: ['tensorfold:kv_cache_usage_perc', 'tensorfold:kv_cache_usage_ratio']
    },
    Radiance: {
        counters: {
            generatedTokens: 'radiance:decode_tokens_total',
            // What this engine computed, as against the whole prompt its vLLM mirror reports.
            prefillTokens: 'radiance:prefill_tokens_total'
        },
        rates: {
            prefillRate: 'radiance:prefill_tokens_per_second',
            decodeRate: 'radiance:decode_tokens_per_second'
        },
        // The live hit rate it publishes next to the vLLM mirror it also serves.
        hit: ['radiance:linear_prefix_cache_hit_rate', ...HIT]
    }
};
/** The metric names to read for one engine: the vLLM table with that engine's differences applied. */
export function namesFor(engine) {
    const over = (engine === null ? undefined : ENGINES[engine]) ?? {};
    return {
        counters: { ...COUNTERS, ...(over.counters ?? {}) },
        gauges: { ...GAUGES, ...(over.gauges ?? {}) },
        histograms: { ...HISTOGRAMS, ...(over.histograms ?? {}) },
        cache: over.cache ?? CACHE,
        hit: over.hit ?? HIT,
        prefill: { ...PREFILL, ...(over.prefill ?? {}) },
        rates: { ...RATES, ...(over.rates ?? {}) },
        late: over.late === true
    };
}
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
/**
 * Prometheus text exposition → `name → [{labels, value}]`. Comment lines and anything without a numeric tail are
 * skipped; labels are kept as a plain object because only `le` and `model_name` are ever read.
 */
// 把 Prometheus 文本解析为「指标名 → [{labels, value}]」，`name value` 与 `name{labels}= value` 两种行尾都支持。
export function parsePrometheus(text) {
    const series = new Map();
    for (const line of String(text).split('\n')) {
        if (line === '' || line[0] === '#') continue;
        // Some engines write `name{labels} value`, others `name{labels}= value`: the tail is the same after the equals.
        const cut = line.lastIndexOf('}');
        let space = line.indexOf(' ', cut + 1);
        if (space < 0) space = line.indexOf('= ', cut + 1);
        const head = space < 0 ? '' : line.slice(0, space);
        if (head === '') continue;
        const rest = line.slice(space);
        const value = Number(
            rest
                .slice(rest.indexOf('=') < 0 ? 0 : rest.indexOf('=') + 1)
                .trim()
                .split(' ')[0]
        );
        if (!Number.isFinite(value)) continue;
        const open = head.indexOf('{');
        const name = open < 0 ? head : head.slice(0, open);
        if (name === '') continue;
        const labels = {};
        if (open >= 0) {
            const body = head.slice(open + 1, cut);
            for (const match of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="(.*?)"/g)) labels[match[1]] = match[2];
        }
        const found = series.get(name);
        if (found === undefined) series.set(name, [{ labels, value }]);
        else found.push({ labels, value });
    }
    return series;
}
/**
 * Which engine wrote these metrics: a prefix check over the metric names. An engine that mirrors vLLM's names is
 * asked about first, so Radiance is read as Radiance and gets the numbers only it counts.
 */
export function detectEngine(series) {
    let engine = null;
    for (const name of series.keys()) {
        if (name.startsWith('radiance:')) return 'Radiance';
        if (name.startsWith('tensorfold:')) return 'TensorFold';
        if (name.startsWith('sglang:')) engine = 'SGLang';
        else if (name.startsWith('llamacpp:')) engine = 'llama.cpp';
        else if (name.startsWith('vllm:')) engine = 'vLLM';
    }
    return engine;
}
const totalOf = (series, name) => {
    const found = series.get(name);
    if (found === undefined) return null;
    let total = 0;
    for (const point of found) total += point.value;
    return total;
};
/** The largest of a per-engine gauge: a cache watermark across engines means the fullest one. */
const worstOf = (series, name) => {
    const found = series.get(name);
    if (found === undefined) return null;
    let top = null;
    for (const point of found) top = top === null ? point.value : Math.max(top, point.value);
    return top;
};
/** Cumulative histogram buckets over every engine, ordered by `le`. */
export function readHistogram(series, base) {
    const rows = series.get(`${base}_bucket`);
    if (rows === undefined) return null;
    const byLe = new Map();
    for (const point of rows) {
        const raw = point.labels.le;
        if (raw === undefined) continue;
        const le = raw === '+Inf' ? Number.POSITIVE_INFINITY : Number(raw);
        if (!Number.isFinite(le) && le !== Number.POSITIVE_INFINITY) continue;
        byLe.set(le, (byLe.get(le) ?? 0) + point.value);
    }
    if (byLe.size === 0) return null;
    return {
        buckets: [...byLe.entries()].sort((a, b) => a[0] - b[0]),
        sum: totalOf(series, `${base}_sum`),
        count: totalOf(series, `${base}_count`)
    };
}
/** Percentile `q` of the requests that arrived between two cumulative histograms. */
// 用两个累计直方图的差集求 q 分位：只统计这两个采样点之间新完成的请求。
export function percentileBetween(before, after, q) {
    if (before === null || after === null) return null;
    const seen = new Map(before.buckets);
    const points = [];
    let total = 0;
    for (const [le, value] of after.buckets) {
        total = Math.max(0, value - (seen.get(le) ?? 0));
        points.push([le, total]);
    }
    // A window with no completed requests has no percentile to show; a dash is truer than a zero.
    if (points.length === 0 || total <= 0) return null;
    const target = total * q;
    let lowerLe = 0;
    let lowerCount = 0;
    for (const [le, count] of points) {
        if (count >= target) {
            if (!Number.isFinite(le)) return lowerLe;
            const span = count - lowerCount;
            return span <= 0 ? le : lowerLe + ((le - lowerLe) * (target - lowerCount)) / span;
        }
        lowerLe = le;
        lowerCount = count;
    }
    return null;
}
/** The first name a series was written under that this engine actually publishes. */
const firstOf = (series, names) => {
    for (const name of names) {
        const value = worstOf(series, name);
        if (value !== null) return value;
    }
    return null;
};
/** One engine reading, reduced to the numbers the card shows. */
function readBeat(series, at) {
    // The engine is named first because every number is read under that engine's own names.
    const engine = detectEngine(series);
    const names = namesFor(engine);
    let modelName = null;
    for (const point of series.get(names.gauges.runningRequests) ?? []) {
        if (typeof point.labels.model_name === 'string') modelName = point.labels.model_name;
    }
    const cache = firstOf(series, names.cache);
    const hit = firstOf(series, names.hit);
    // Engines carry the queue under their own prefix (SGLang writes sglang:…), so it is found by its name alone.
    const queued = firstOf(series, [names.prefill.queuedPromptTokens, ...PREFILL_ALIASES]);
    return {
        at,
        modelName,
        engine,
        queuedPromptTokens: queued,
        // The engine's own name for the prompt it computed, so a reading the engine keeps can be told apart from a rate.
        prefillMetric: names.counters.prefillTokens,
        ownPrefillRate: names.rates.prefillRate === null ? null : worstOf(series, names.rates.prefillRate),
        late: names.late,
        ownDecodeRate: names.rates.decodeRate === null ? null : worstOf(series, names.rates.decodeRate),
        ownPrefill:
            names.counters.prefillTokens === COUNTERS.prefillTokens
                ? null
                : totalOf(series, names.counters.prefillTokens),
        counters: Object.fromEntries(
            Object.entries(names.counters).map(([key, metric]) => [key, totalOf(series, metric)])
        ),
        gauges: Object.fromEntries(Object.entries(names.gauges).map(([key, metric]) => [key, worstOf(series, metric)])),
        kvCachePercent: cache === null ? null : 100 * cache,
        prefixCacheHitPercent: hit === null ? null : 100 * hit,
        histograms: Object.fromEntries(
            Object.entries(names.histograms).map(([key, metric]) => [key, readHistogram(series, metric)])
        )
    };
}
const perSecond = (before, now, seconds) =>
    finite(before) && finite(now) && now >= before && seconds > 0 ? (now - before) / seconds : null;
/** Below this many tokens per second a counter difference is noise from one request starting, not a prefill. */
const PREFILL_FLOOR = 20;
/**
 * Above this many tokens per second a reading is a measurement accident, not a speed: a poll window that caught the whole
 * prompt of a long request, or a timing histogram whose sum moved by a millisecond. No local engine in this plugin's
 * reach prefills or decodes faster than this, so a larger number is dropped rather than shown.
 */
const MAX_RATE = 20_000;
/**
 * Keeps the last few minutes of beats. Counters are differenced against the previous beat for the live rates, and
 * against the oldest beat still inside the window for the p95 latencies.
 */
// 维护最近几分钟的采样：计数器差值换算成实时速率，累计直方图换算成窗口内的 p95。
export class Reader {
    #smoothed = { generatedTokens: null, promptTokens: null, prefillTokens: null };
    #maxBeats;
    constructor(windowMs = WINDOW_MS) {
        this.windowMs = windowMs;
        this.beats = [];
        this.#maxBeats = Math.ceil(windowMs / POLL_MS) + 8;
    }
    get length() {
        return this.beats.length;
    }
    /** Whether the newest beat's engine counts at the end of a request rather than while it runs. */
    get late() {
        return this.beats.length > 0 && this.beats[this.beats.length - 1].late === true;
    }
    ingest(series, at = Date.now()) {
        const beat = readBeat(series, at);
        this.beats.push(beat);
        if (this.beats.length > this.#maxBeats) this.beats.splice(0, this.beats.length - this.#maxBeats);
        return beat;
    }
    #index(beat) {
        return this.beats.indexOf(beat);
    }
    /** What the card shows for one beat; pass the newest beat from `ingest`. */
    // 把一拍读数整理成卡片显示的字段：速率优先取引擎自报值，其次是计时直方图，最后才是计数器差值。
    view(beat) {
        const index = this.#index(beat);
        if (index < 0) return null;
        const seconds = index === 0 ? 0 : (beat.at - this.beats[index - 1].at) / 1000;
        // The rate a user reads is tokens over the time those tokens took, from the engine's own histograms: a poll to
        // poll difference would divide one finished batch by the poll window, which is not a speed. An engine that
        // counts while a request runs has a difference worth reading; one that counts at the end does not.
        const running = beat.gauges.runningRequests;
        const decode =
            this.#timedRate('generatedTokens', 'decodeSeconds', index) ??
            this.#rate('generatedTokens', index, seconds) ??
            (finite(running) && running > 0 && finite(beat.ownDecodeRate) ? beat.ownDecodeRate : null) ??
            0;
        const prefill = this.#prefillRate(index, seconds);
        const baseline = this.#baseline(beat);
        const percentiles = {};
        for (const key of Object.keys(HISTOGRAMS))
            percentiles[key] = percentileBetween(baseline?.histograms[key] ?? null, beat.histograms[key], 0.95);
        const reported = {};
        for (const key of Object.keys(COUNTERS)) reported[key] = beat.counters[key] !== null;
        for (const key of Object.keys(GAUGES)) reported[key] = beat.gauges[key] !== null;
        // The pill asks whether a prefill can be shown at all; either of the two counters answers for it.
        reported.promptTokens = beat.counters.prefillTokens !== null || beat.counters.promptTokens !== null;
        reported.kvCachePercent = beat.kvCachePercent !== null;
        reported.prefixCacheHitPercent = beat.prefixCacheHitPercent !== null;
        reported.ttftP95Seconds = percentiles.ttft !== null;
        reported.tpotP95Seconds = percentiles.tpot !== null;
        return {
            ok: true,
            engine: beat.engine,
            modelName: beat.modelName,
            error: null,
            updatedAt: new Date(beat.at).toISOString(),
            decodeTokensPerSecond: decode,
            prefillTokensPerSecond: prefill.rate,
            prefillQueuedTokens: prefill.queued,
            runningRequests: beat.gauges.runningRequests,
            waitingRequests: beat.gauges.waitingRequests,
            kvCachePercent: beat.kvCachePercent,
            prefixCacheHitPercent: beat.prefixCacheHitPercent,
            ttftP95Seconds: percentiles.ttft,
            tpotP95Seconds: percentiles.tpot,
            windowSeconds: baseline === null ? 0 : (beat.at - baseline.at) / 1000,
            totals: { ...beat.counters },
            reported
        };
    }
    /** Sparkline points for the window this reader covers, newest last. */
    history(beat) {
        const index = this.#index(beat);
        if (index < 0) return [];
        const from = beat.at - this.windowMs;
        const points = [];
        for (let i = 1; i <= index; i += 1) {
            const before = this.beats[i - 1];
            const now = this.beats[i];
            if (now.at < from) continue;
            const seconds = (now.at - before.at) / 1000;
            points.push({
                at: now.at,
                decode: perSecond(before.counters.generatedTokens, now.counters.generatedTokens, seconds),
                prefill: perSecond(before.counters.promptTokens, now.counters.promptTokens, seconds),
                kv: now.kvCachePercent
            });
        }
        return points;
    }
    /**
     * What the engine is prefilling. A prefill lasts a fraction of one poll, so a counter difference between two beats
     * is usually 0 or a lump; engines that say how much prompt is still waiting to be prefilled are read from that,
     * which is the live number. Otherwise the counter rate answers, and only when it is large enough to be a prefill
     * rather than a single request starting — a small number there is a gap in the instrument, not a reading.
     */
    // prefill 速率的选取顺序：引擎实时速率 → 实际计算的 prompt token ÷ TTFT → 队列长度 → 计数器差值。
    #prefillRate(index, seconds) {
        const beat = this.beats[index];
        const queued = beat.queuedPromptTokens;
        const usable = (value) => (value !== null && finite(value) && value <= MAX_RATE ? value : null);
        // A prefill on an engine that publishes its own live rate: that is the speed the engine is computing right now,
        // before the batch has finished and its timing histogram has moved. The running gauge is not consulted: Radiance
        // reports it as zero while it prefills, so requiring it would send this reading down to the counter fallback,
        // where a prompt served from the prefix cache reads as the whole prompt per second.
        if (finite(beat.ownPrefillRate) && beat.ownPrefillRate > 0 && beat.ownPrefillRate <= MAX_RATE)
            return { rate: beat.ownPrefillRate, queued: finite(queued) ? queued : null };
        // A finished batch's own prompt tokens over the first-token time it took: the prefill speed of that batch. The
        // prompt the engine computed is used, not the prompt it was handed: on an engine with a prefix cache the two
        // differ by however much came from the cache, which would otherwise divide into a rate it never ran.
        const timed = usable(this.#timedRate('prefillTokens', 'ttft', index));
        if (timed !== null) return { rate: timed, queued: finite(queued) ? queued : null };
        // A prompt queue says how much is still coming, which is live while a prefill runs.
        if (finite(queued) && queued > 0 && seconds > 0) {
            const queuedRate = usable(queued / seconds);
            if (queuedRate !== null) return { rate: queuedRate, queued };
        }
        // Only an engine that counts while it prefills has a difference worth reading: one that counts at the end of a
        // request would divide that whole request's prompt by the poll window, which is where absurd numbers come from.
        if (!this.late) {
            const counted = usable(
                (beat.counters.prefillTokens !== null ? this.#rate('prefillTokens', index, seconds) : null) ??
                    this.#rate('promptTokens', index, seconds)
            );
            if (counted !== null && counted >= PREFILL_FLOOR)
                return { rate: counted, queued: finite(queued) ? queued : null };
            if (counted !== null && counted === 0) return { rate: 0, queued: finite(queued) ? queued : null };
            if (counted !== null && counted > 0) return { rate: null, queued: finite(queued) ? queued : null };
        }
        // Nothing measured and nothing queued: an engine that keeps a prompt counter is idle, one without it has no reading.
        const hasCounter = beat.counters.prefillTokens !== null || beat.counters.promptTokens !== null;
        return { rate: hasCounter ? 0 : null, queued: finite(queued) ? queued : null };
    }
    /**
     * Tokens between two beats divided by the wall time those tokens took, from the engine's own histogram. This is the
     * rate a finished-request counter really carries, so it does not swing with how much landed inside one poll.
     */
    // 两次采样之间新增的 token ÷ 这段时间新增的引擎计时，得到这批请求的真实速率。
    #timedRate(key, secondsKey, index) {
        if (index === 0) return null;
        const beat = this.beats[index];
        const before = this.beats[index - 1];
        const tokens = beat.counters[key];
        const earlier = before.counters[key];
        const spent = beat.histograms[secondsKey]?.sum;
        const spentBefore = before.histograms[secondsKey]?.sum;
        if (!finite(tokens) || !finite(earlier) || !finite(spent) || !finite(spentBefore)) return null;
        const moved = tokens - earlier;
        const time = spent - spentBefore;
        if (moved <= 0 || time <= 0) return null;
        return moved / time;
    }
    /** A rate with a little smoothing; a beat where nothing moved is a true zero, not a slow decay. */
    #rate(key, index, seconds) {
        if (index === 0 || seconds <= 0 || seconds > 60) return null;
        const now = this.beats[index].counters[key];
        const before = this.beats[index - 1].counters[key];
        if (now === null || before === null || now < before) return null;
        const raw = (now - before) / seconds;
        if (raw < 0.5) return 0;
        const held = this.#smoothed[key];
        const value = held === null || held === 0 ? raw : held * 0.55 + raw * 0.45;
        this.#smoothed[key] = value;
        return value;
    }
    /** The oldest beat still inside the percentile window: the baseline the buckets are differenced against. */
    #baseline(beat) {
        const edge = beat.at - this.windowMs;
        let found = null;
        for (const other of this.beats) {
            if (other.at >= beat.at) break;
            if (other.at <= edge) found = other;
        }
        return found ?? (this.beats.length > 1 ? this.beats[0] : null);
    }
}
/** Normalises the configured address, adding the scheme the user left out. */
export function parseAddress(value) {
    const text = String(value ?? '').trim();
    // A space inside what should be a host is a half-typed address, not a host: say so instead of failing to connect.
    if (text === '' || /\s/.test(text)) return null;
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
}
/**
 * `<address>/metrics` for an address that may sit behind a reverse-proxy prefix. `new URL(path, base)` cannot do it:
 * a base whose path is empty still reports `/`, so a join would read as protocol-relative and replace the host.
 */
export function joinPath(base, path) {
    const prefix = base.pathname === '/' ? '' : base.pathname;
    return new URL(`${prefix}${path}`, base);
}
