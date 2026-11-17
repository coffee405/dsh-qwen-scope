# dsh-qwen-scope

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在输入框（composer）下方、会话自带的统计旁新增一格，显示**当前会话所选本地模型服务正在 prefill 的速率**。

它会跟随 composer 的模型选择器：在模型列表里换一个本地模型，下一拍读数就来自那台引擎。引擎地址直接读取模型提供方（`dsh-llm-pi-ai` 等）的配置，不需要再抄一份服务列表；设置页会列出发现的服务、哪些在线、以及会话不在本地模型上时底栏默认上报哪一台。

它参考了 [dsh-spark-scope](https://github.com/juliankang4/dsh-spark-scope) 的形态（宿主提供轮询路由，页面只读），区别是数据来源：Spark Scope 读一个自带拓扑的仪表盘，本插件跳过中间层，直接读推理引擎的 `/metrics`。

## 上报哪台引擎

这一格属于会话当前运行的模型，数据取自该会话自己的 `modelSelection` 投影，而不是页面级的某个值：在 composer 里换模型，下一次轮询就会切到对应引擎。页面每次轮询都把模型名传给宿主（`GET /plugins/dsh-qwen-scope/state?model=...`），宿主按以下顺序找服务它的引擎：模型提供方里声明的模型 id、引擎指标标签里的 `model_name`、引擎 `/v1/models` 返回的 id。都不是本地引擎（例如官方托管的模型）时返回 `notLocal`，这一格不渲染。

引擎在线但没有计算任务时显示 **0**，这是真实读数；只有引擎没有响应、或引擎不提供相应计数器时才显示 `—`。

空会话（新建窗口、还没有任何轮次和用量）不渲染这一格，与 DSH 自带统计格的行为一致。

## 读取的指标

宿主每两秒从 **运行 dsh 的这台机器**（而不是浏览器，浏览器既没有 CORS 也没有密钥）对本机/局域网可达的每台引擎读一次 `GET <address>/metrics`（Prometheus 文本），支持 `name value` 与 `name{labels}= value` 两种行尾。`GET <address>/v1/models` 每 30 秒读一次，用于补全模型 id；指标标签通常已经带了。

速率的口径是 **token 数 ÷ 这些 token 实际花的时间**：

- 引擎自己发布实时速率（如 Radiance 的 `radiance:prefill_tokens_per_second`）时直接采用，这是引擎此刻正在算的速度；
- 否则用引擎自己的计时直方图：prompt token 数 ÷ 首 token 时间（`time_to_first_token_seconds`）；
- 最后才退回到两次采样之间的计数器差值，且只对「推理过程中就累加计数」的引擎使用；对请求结束才结算计数的引擎（如 TensorFold）不用差值，避免把一次长上下文请求的整段 prompt 除以两秒、得到十万级的假读数。

读数统一有 20,000 tok/s 的上限，超过只可能是采样窗口或浮点事故，显示为空而不是错误速度。

引擎由指标前缀识别，随后全部按该引擎自己的指标名读取，所以不镜像 vLLM 命名的引擎也能读；引擎没有的指标显示为 `—`。

| 单元格 | vLLM | SGLang | Radiance | TensorFold |
| --- | --- | --- | --- | --- |
| prefill | `vllm:prompt_tokens_total` | `sglang:prompt_tokens_total`（外加 `sglang:num_prefill_prompt_tokens_queued`） | `radiance:prefill_tokens_total` | `tensorfold:prompt_tokens_total` |
| decode | `vllm:generation_tokens_total` | `sglang:generation_tokens_total` | `radiance:decode_tokens_total` | `tensorfold:generation_tokens_total` |
| 运行 / 排队 | `vllm:num_requests_{running,waiting}` | `sglang:num_requests_{running,waiting}` | 镜像在 `vllm:` 下 | `tensorfold:num_requests_{running,waiting}` |
| KV cache | `vllm:kv_cache_usage_perc` | `sglang:token_usage` | 镜像在 `vllm:` 下 | `tensorfold:kv_cache_usage_perc` |
| 前缀缓存 | `vllm:gpu_prefix_cache_hit_rate` | `sglang:cache_hit_rate` | 镜像在 `vllm:` 下 | 不统计，显示 `—` |
| TTFT / TPOT p95 | `vllm:time_to_first_token_seconds` / `…time_per_output_token_seconds` | `sglang:time_to_first_token_seconds` / `sglang:inter_token_latency_seconds` | 镜像在 `vllm:` 下 | `tensorfold:time_to_first_token_seconds` / `…request_time_per_output_token_seconds` |

prefill 的含义是**引擎实际计算过的 prompt token**。带前缀缓存的引擎（如 Radiance）命中的部分不计入，因此读它自己的计数器而不是它同时镜像的 vLLM 名字；TensorFold 在请求结束时才结算 prompt token，所以用它自己的计时直方图折算成速率（这一格在推理过程中为 0、请求结束时跳到真实速率，是引擎计数方式决定的）。

设置里填写的密钥只进 profile 的凭据文件，不会写进本插件的配置，也不会发到页面；插件读取时按模型提供方同样的顺序解析：profile 存储的凭据 → 启动环境（`.env` 层）→ 进程环境。

## 安装

插件以 bundle 形式安装。在 **插件** → **添加插件** 里选择本目录，或在 profile 中手工声明：

```json
"dependencies": { "dsh-qwen-scope": "link:/path/to/dsh-qwen-scope" },
"dsh": { "profile": { "bundles": ["…", "dsh-qwen-scope"] } }
```

然后在 profile 的 `cordis.patch.yml` 加一行配置并重启 dsh：

```yaml
- id: qwen-scope
  name: dsh-qwen-scope
  config:
    active: local-model
    servers:
      - id: local-model
        name: local-model
        url: http://127.0.0.1:8000
        apiKeyEnv: LOCAL_API_KEY
      - id: second-model
        name: second-model
        url: http://127.0.0.1:8001
        apiKeyEnv: SECOND_API_KEY
```

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `servers` | `[]` | 手工登记的服务；留空则从模型提供方配置自动发现。 |
| `servers[].id` | — | 行的稳定标识，`active` 用它指定上报哪台。 |
| `servers[].name` | 同 id | 单元格和设置页显示的名字，保持简短。 |
| `servers[].url` | — | 模型服务地址（`http` / `https`，保留反向代理路径前缀）。 |
| `servers[].apiKeyEnv` | `LOCAL_API_KEY` | 引擎所需凭据的变量名，按凭据文件 → 启动环境 → 进程环境的顺序解析。 |
| `active` | 第一行 | 会话不在上述本地模型上时，底栏默认上报哪台。 |
| `discover` | `true` | 是否从模型提供方配置自动发现服务。 |

`servers` 与 `active` 都是 volatile 配置，增删服务、切换上报对象在下一拍轮询就生效，不需要重启。

## 开发

需要 Node.js 24。插件的脚本会 `import '@deepseek-ai/schemastery'`，仓库里带了开发占位包 `dev/schemastery`，克隆后把它放到位即可：

```sh
mkdir -p node_modules/@deepseek-ai
cp -r dev/schemastery node_modules/@deepseek-ai/schemastery
```

dsh 运行时会提供真实的包，占位包只用于本地脚本。

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 语法检查 + 离线自检：Prometheus 解析、速率计算、地址处理、页面侧对宿主回包的解析。 |
| `npm run probe` | 按插件同样的方式读一台真实引擎并打印它会在单元格里显示什么：`--url`、`--api-key-env`、`--seconds`。 |
| `npm run e2e` | 用替身 dsh 上下文跑宿主半边（轮询器 + 路由），包含两台服务和切换上报对象；也覆盖空地址、非法地址、不可达、缺密钥等失败路径。`QWEN_SCOPE_URL` 指定引擎地址。 |
| `node scripts/fake-engine.mjs` | 一个计数器持续增长的替身引擎，没有硬件也能跑 `e2e`。 |

`probe` 的密钥解析顺序与插件一致：环境变量 → profile 凭据文件；不要把它写进任何提交。

## 许可

MIT
