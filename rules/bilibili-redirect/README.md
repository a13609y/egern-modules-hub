# BiliBili Redirect（可同步参数开关版）

把 [Biliverse/Redirect](https://github.com/Biliverse/Redirect) 的 Egern 原生模块包成一份**带开关的生成版**：上游六组参数（`Host.OverseaVideo` / `Host.BStar` / `Host.PCDN` / `Host.MCDN` / `Storage` / `LogLevel`）的**每个候选值都是独立 Toggle**，在 egern 模块设置页直接点选，每天跟随上游 Releases 重新生成。

- 订阅（路径与旧版一致）：`https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/bilibili-redirect/bilibili-redirect.yaml`
- 上游：`Biliverse/Redirect` `v0.2.25`（由 GitHub Actions 每日查询 Releases latest）
- 上游原始文件：[BiliBili.Redirect.yaml](https://github.com/Biliverse/Redirect/releases/download/v0.2.25/BiliBili.Redirect.yaml)、[request.bundle.js](https://github.com/Biliverse/Redirect/releases/download/v0.2.25/request.bundle.js)
- 许可：上游 Apache-2.0；本目录含上游原文的衍生文件，见 [NOTICE](NOTICE) 与 [LICENSE](LICENSE)

## 开关规则

| 组 | 开关数 | 生效条件 | 全关 / 多开时 |
|---|---|---|---|
| `Host.OverseaVideo` | 15 | 组内恰好 1 个为开 → 用该主机名 | 回 `compat_arguments` 默认 `upos-sz-mirrorali.bilivideo.com` |
| `Host.BStar` | 15 | 同上 | 同上 |
| `Host.PCDN` | 15 | 同上 | 同上 |
| `Host.MCDN` | 1 | 打开 → `proxy-tf-all-ws.bilivideo.com` | 同上 |
| `Storage` | 3 | 同上（`Argument` / `PersistentStore` / `database`） | 默认 `Argument` |
| `LogLevel` | 6 | 同上（`OFF`…`ALL`） | 默认 `WARN` |

- 开关名为候选值本身（如 `upos-sz-mirrorcos.bilivideo.com`、`PersistentStore`、`DEBUG`），env 键形如 `Bili_OverseaVideo__upos_sz_mirrorcos_bilivideo_com`。
- **多开不会被"平分"**：同组 ≥2 个为开即视为歧义，整组回上游默认（`false` 不计入"开"）。
- 每组独立判断，`Host.OverseaVideo` 选 A 不影响 `Host.BStar` 选 B。
- `compat_arguments` 仍照上游保留：模块引用里写的 `compat_arguments` 覆盖值在**全关**时仍然生效（与上游行为一致），但**单选开关优先级高于** `compat_arguments`。这一点与上游"参数只能整个值覆盖"的语义不同，是本模块唯一的有意偏离，用户需求已指定"全关/多开回上游默认"。

## 实现方式（为什么不只是加 env_schema）

Egern 文档（`/configuration/modules`）对 `env_schema` 只承诺两件事：在模块设置页生成控件（`options: ["true","false"]` → Toggle），以及键值以环境变量形式存在。文档**没有**说 `env_schema` 会参与 `compat_arguments` / `{{{占位符}}}` 替换。所以本模块不依赖这种替换：

1. **脚本**：`scriptings` 全部指向本仓库生成的 `bilibili-redirect.bundle.js`。这个文件 = 一个 Egern wrapper（`export default async (ctx) => …`）+ 上游 `request.bundle.js` **原文逐字拼接**。wrapper 做四件事：
   - 读 `ctx.env`，按"每组恰好一个为开"算出六组有效值，未定义时回落到烘焙进 bundle 的 `compat_arguments` 默认值；
   - 把结果写成 `globalThis.$argument` 的查询串（上游自己 `a.parse(globalThis.$argument)` 取值，行为不变）；
   - 用 `ctx.request` 拼出 `globalThis.$request`（上游直接读这个全局），并用 `ctx.storage` 兜底 `globalThis.$persistentStore`；
   - 执行上游原文，拿到上游 `$done(...)` 的结果后按"原 `url_rewrites` 的主机替换"再算一遍 URL，最后以文档返回值形式交给 Egern。
2. **静态 `url_rewrites`**：Egern 的 YAML 没有"按 env 分支"的语法，静态规则无法随开关变化。因此本模块**不再声明 `url_rewrites`**，改为在同一个 `http_request` 脚本里按上游 12 条规则的语义做**主机类 → 目标主机**的前缀替换：保持 scheme、path、query 与端口语义完全不变（见下），并同步 `Host` / `:authority` 头。
3. **MITM**：与上游 `mitm.hostnames` 完全一致，未扩大。脚本 `match` 逐条照抄上游，未扩大拦截面。

### 与原 `url_rewrites` 的等价性

上游 12 条规则（6 个主机类 × http/https）只把 `host[:80|443|4483]` 换成 `{{{Host.*}}}`，路径固定 `/upgcxcode/`，其余原样。脚本里的等价实现：

| 上游 | 本模块 |
|---|---|
| `^http:\/\/upos-sz-mirror[a-z0-9-]*ov\.bilivideo\.com(?::80)?\/upgcxcode\/` | scheme `http:`、端口 `80`/空、hostname 匹配该正则、path 以 `/upgcxcode/` 开头 → hostname 换成目标、端口清空 |
| `^https:…(?::(?:443|4483))?\/upgcxcode\/` | 同上（`443`/`4483`/空端口） |
| `cn-hk-eq-*`、`upos-*-mirrorakam.akamaized.net`、`upos-sz-mirror*bstar1*` | 逐条对应，顺序同上（先 OverseaVideo 四条，再 BStar 两条，与上游 `url_rewrites` 顺序一致） |
| path / query / scheme | 不做任何改动（`URL` 对象只改 `hostname`、`port`） |

两点与上游的差异需明说：

- **端口**：上游 header 模式下 `location` 里写了 `http://host/upgcxcode/`，落到目标主机的端口由 Egern 依 scheme 决定；本实现把端口清空（http→80、https→443），不显式写 `:4483`。上游脚本自身在改名时也是 `a.port=""`，行为一致。
- **已经重写过的 URL**：若请求 hostname 已经等于某组当前选中的目标值，则不再改写（避免二次跳转打环）。上游静态规则按正则匹配，理论上对目标主机不匹配（`upos-sz-mirrorcos.bilivideo.com` 不匹配 `…ov\.bilivideo\.com` / `…bstar1…`），所以这一条只是防御性等价。

命中的脚本按上游 `scriptings.match` 执行：`.bilivideo.com/upgcxcode/`、`mcdn.bilivideo.cn:8000|8082/v1/resource/`、`mcdn…:4483|9102/upgcxcode/`、`*:4480/upgcxcode/`、两个 akamaized 主机。与上游相比**没有新增任何拦截主机**。

### 已知限制

1. **`Host.PCDN` / `Host.MCDN` 的开关只影响请求脚本路径，不影响静态 URL 重写**——因为上游 `url_rewrites` 里根本没有这两组（PCDN 走 `:4480` 脚本分支、MCDN 走 `:4483|9102` 脚本分支），所以这两个开关确实"只能由脚本实现"，而上游行为本就如此。
2. **脚本未收到 env 的场景**：如果 Egern 版本不向模块脚本注入 `ctx.env`，所有开关等于全关，模块回上游默认值（不会崩、不会写出 `{{{…}}}` 之类的坏主机名——wrapper 会丢弃未替换的占位符）。
3. **Egern 未在设备上实测**（本仓库在 Linux 上以 Node 模拟 `ctx` 跑测试）。`ctx.respond()` 未使用，只用文档化的"返回值修改请求"约定；`$done` 由 wrapper 拦截后转成返回值。若某个 Egern 版本既不给 `ctx.env` 也不认返回值，模块会退化为"上游默认行为"，不会静默改错 CDN。
4. 上游若新增候选值、主机类或参数组，每日生成会因漂移校验失败而**保留上一版**产物（不会自动发布半成品），此时需要人更新 `sync.py` 里的 `REWRITE_RULES` / 组定义。

## 文件

| 文件 | 作用 |
|---|---|
| `bilibili-redirect.yaml` | 订阅模块（自动生成，勿手改） |
| `bilibili-redirect.bundle.js` | 生成版脚本：wrapper + 上游 `request.bundle.js` 原文（自动生成，勿手改） |
| `sync.py` | 生成器：拉取上游 release → 解析候选值 → 生成 YAML + bundle → 漂移校验 |
| `test.mjs` | 行为测试：Node 里模拟 `ctx` 跑 39 项断言（单选 / 全关 / 多开 / Storage / LogLevel / 路径与查询保留 / 不扩大改写范围 / 旧 `$argument` 兼容） |
| `NOTICE` / `LICENSE` | Apache-2.0 归属与许可全文 |

```bash
# 生成（需要网络）
python3 rules/bilibili-redirect/sync.py
# 校验现有产物与上游一致（不一致 exit 1，CI 用来决定是否提交）
python3 rules/bilibili-redirect/sync.py --check
# 离线复现某一版
python3 rules/bilibili-redirect/sync.py --tag v0.2.25 --upstream-yaml up.yaml --upstream-js request.bundle.js
# 行为测试
node rules/bilibili-redirect/test.mjs      # → 39 passed, 0 failed
```

## 使用与影响

Egern → 工具 → 模块 → `+`，粘贴订阅地址；在模块设置里按开关选 CDN。模块包含上游的 `mitm.hostnames`，启用后会对列出的哔哩哔哩主机做 HTTPS 解密，请理解并接受该影响后启用，并按 Egern 要求安装/信任证书。

注意：**升级到本版后，原先在模块引用里写 `compat_arguments` 的用法仍可用，但一旦打开某组开关，开关值优先**。如果希望完全恢复旧语义，把该组开关全部关掉即可。

## 同步与防覆盖

`.github/workflows/sync-bilibili-redirect.yml` 每天 04:17 UTC 查询上游 Releases latest，下载 YAML + bundle，运行 `sync.py` 重新生成，跑 `test.mjs`，只有全部通过才提交；否则保留上一版并让工作流失败（不会把手改内容或半成品写进订阅地址）。生成文件头带"自动生成，勿手改"标记。
