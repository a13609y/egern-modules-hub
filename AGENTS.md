# AGENTS.md · 贡献与发布约定

面向在本仓库提交改动的人（以及自动代理）。只写「必须遵守」的部分，细节在各模块 `README.md`。

## 1. Egern 版本与 rewrites 约定

目标客户端：**Egern 2.21.0 及以上**。低于该版本不保证兼容，新增能力不为旧版做降级分支。

改写类配置的写法优先级：

1. **默认写原生字段**：`url_rewrites` / `header_rewrites` / `body_rewrites` / `map_locals`。
   响应正文过滤一律优先 `body_rewrites` + `response_jq`（自带 jq 过滤，不需要脚本）。
2. **统一 `rewrites`（2.21.0+）是受限分支**：只有两种情况可以用——
   用户/需求明确要求统一写法，或原生字段确实表达不了既有语义。
   用它时必须同时满足：
   - 每个条件、动作、顺序都能在**目标版本 schema + 官方 YAML 示例**里逐项对上；
   - 文件头第一屏加标记：`# egern-rewrites: verified 2.21.0`（版本号写实际核对过的版本）；
   - 不与同语义的旧字段**混写**；确需兼容旧客户端时，把兼容分支单独隔离并加注释说明。
3. 任一字段未核实就**不要输出猜测的 YAML**：改成提交迁移说明 + 待核对项。
4. 既有 `url_rewrites` / `header_rewrites` / `body_rewrites` / `map_locals` 照常运行，**不因为写了 AGENTS.md 就自动迁移**；改到哪个模块才动哪个模块，`rules`、`widgets`、`schedule` 等无关配置不碰。
5. 能用声明式字段表达的，不要为了它引入脚本；脚本只留给需要分支/状态/跨请求的逻辑。脚本统一 `export default async (ctx) => {...}`，用 `ctx.http` / `ctx.storage` / `ctx.notify`，不引入中转运行时。

检查器会拦：顶层出现 `rewrites` 但缺 `# egern-rewrites: verified <版本>` 标记 → 判失败；
统一 `rewrites` 与原生字段混写 → 告警（需人工确认兼容分支）。

## 2. 模块目录与元数据

```
<rules|rulesets|widgets>/<kebab-case-name>/
├── <name>.yaml          模块文件，文件名与目录同名（多档可 <name>-extra.yaml）
├── <name>.js | *.js     原始脚本（有脚本的模块）
├── README.md            必填：用途 / 安装 / 参数 / 已知限制
└── sync.py, test.mjs    自动同步与测试（按需）
```

- 目录名 `kebab-case`；一个目录只放一个模块族，不跨模块共用文件。
- YAML 元数据：模块必须有 `name`、`description`；建议带 `author`（吸收上游时写**内容原作者**，本仓库是整合方）、`homepage`、`icon`。
- 需要用户配置的项走 `env_schema`（会生成 UI）；模块参数默认值走 `compat_arguments`，正文用 `{{{ARG}}}`
  占位（字符串字段加引号，数字/布尔字段裸写）。
- 纯规则集（`rulesets/*`、`rules/china`）只允许 Egern 官方 rule_set 字段，`no_resolve` 只在顶层写一次。
- 由 `sync.py` 生成的 YAML 顶部必须有「自动生成，请勿手改」注释；手改会被次日同步覆盖。
- `mitm.hostnames` 只列规则真正需要拦截的主机；模块默认不写 `rules` / `dns`（不干扰用户分流）。
- 订阅地址固定指向 `main` 的 raw 路径，路径必须真实存在。

## 3. 发布前检查（本地一条命令跑完）

```sh
python3 -m pip install --quiet pyyaml==6.0.2   # 唯一第三方依赖（CI 同样只装这个）
python3 scripts/check_repo.py                  # 全仓静态校验
python3 rules/china/verify.py                  # 中国规则集专项校验
node rules/bilibili-redirect/test.mjs          # BiliBili Redirect 行为测试
git diff --check                               # 空白 / 冲突残留
```

`scripts/check_repo.py` 覆盖：YAML 可解析（先按 Egern 运行时替换 `{{{ARG}}}` 占位）、
顶层字段白名单、模块元数据与目录约定（README + 同名 YAML）、Markdown 相对链接、
根 README「目录结构」条目存在性、指向本仓库的 raw/blob/tree 链接路径存在性、
统一 `rewrites` 守卫。

PR 会跑 `.github/workflows/validate.yml`（同一套命令）；每日 `sync-*.yml` 同步流不受影响。
提交前自查要点：

- [ ] 新模块有 README，且根 README 的「模块清单」表格加了一行（说明 + 订阅地址）
- [ ] 根 README「目录结构」里提到的目录真实存在（不存在就不要写）
- [ ] YAML 能被 `scripts/check_repo.py` 解析，元数据齐全
- [ ] 订阅的 raw 地址在 `main` 上能取到（`scripts/check_repo.py` 会校验自引用路径）
- [ ] 需要 MITM 的模块在 README 里写清主机与证书步骤
- [ ] 生成物（`sync.py` 产物）没有被手改过的痕迹，或说明为何手改
