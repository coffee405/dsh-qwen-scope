// A stand-in vLLM server for scripts/e2e.mjs: /metrics counters that grow and a /v1/models id, no key needed.
// 中文说明：计数器随时间增长的替身引擎，e2e 没有硬件也能跑。
const start = Date.now();
const text = () => {
    const seconds = (Date.now() - start) / 1000;
    const generated = Math.round(seconds * 40);
    const prompt = Math.round(seconds * 500);
    return [
        'vllm:num_requests_running{model_name="fake-model",engine="0"} 1',
        'vllm:num_requests_waiting{model_name="fake-model",engine="0"} 0',
        'vllm:kv_cache_usage_perc{model_name="fake-model",engine="0"} 0.2',
        'vllm:gpu_prefix_cache_hit_rate{model_name="fake-model",engine="0"} 0.8',
        `vllm:generation_tokens_total{model_name="fake-model",engine="0"} ${generated}`,
        `vllm:prompt_tokens_total{model_name="fake-model",engine="0"} ${prompt}`,
        'vllm:request_success_total{model_name="fake-model",engine="0",finished_reason="stop"} 4',
        `vllm:time_to_first_token_seconds_bucket{le="1",model_name="fake-model"} 4`,
        `vllm:time_to_first_token_seconds_bucket{le="+Inf",model_name="fake-model"} 4`,
        'vllm:time_to_first_token_seconds_count{model_name="fake-model",engine="0"} 4'
    ].join('\n');
};
const server = await import('node:http').then(({ default: http }) =>
    http.createServer((req, res) => {
        // The guarded path stands in for a server that does want a key, so the failure paths can be checked too.
        if (req.url?.startsWith('/guarded')) {
            res.writeHead(req.headers.authorization === undefined ? 401 : 200, { 'content-type': 'text/plain' });
            res.end(req.headers.authorization === undefined ? '' : text());
            return;
        }
        if (req.url?.startsWith('/metrics')) {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end(text());
            return;
        }
        if (req.url?.startsWith('/v1/models')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
            return;
        }
        res.writeHead(404).end();
    })
);
await new Promise((resolve) => server.listen(Number(process.env.PORT ?? 8099), '127.0.0.1', resolve));
console.log(`fake engine on http://127.0.0.1:${server.address().port}`);
