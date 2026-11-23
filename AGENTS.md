# AGENTS.md · 贡献与发布约定

面向在本仓库提交改动的人（以及自动代理）。只写「必须遵守」的部分；模块细节看各模块 `README.md`，
仓库维护流程的完整操作手册在 [`agents/skills/egern-hub-maintenance/SKILL.md`](agents/skills/egern-hub-maintenance/SKILL.md)。

## 1. Egern 版本与 rewrites 约定

目标客户端：**Egern 2.21.0 及以上**。新写的改写配置以该版本为基线；更低版本不保证兼容，
只有用户明确要求旧版兼容时才写旧分支。

改写类配置的写法：

1. **新改写默认写统一的 `rewrites`**（2.21.0+ 引入的统一写法：一条规则里同时表达条件与动作，
   请求/响应阶段与顺序都在条目内）。URL 重写、请求/响应头改写、响应正文过滤都往这一处写，
   不再新开 `url_rewrites` / `header_rewrites` / `body_rewrites` / `map_locals` 分支。
2. **旧字段只为明确的旧版兼容保留**：只有「用户要在 <2.21.0 客户端上跑」这种被明确要求的情况下，
   才另写旧字段版本，并放在单独的文件/单独段落里加注释说明适用范围；旧分支与统一 `rewrites`
   不得在同一模块里混写同语义规则，也不得声称运行时会自动互相转换。
3. **不猜字段、不猜语义**。写统一 `rewrites` 之前必须查两样东西并说明查的是什么：
   - 目标版本的 **schema**（Egern 官方 profile/module 文档里 `rewrites` 那一页，写清版本）；
   - 至少一个**官方 YAML 示例**（`example` 页或模块文档里的完整片段）。
   每个条件、动作、阶段、顺序都要能在上面两者中逐项对上。
4. **没有证据就不要说验证过**。文件头第一屏加标记：

   ```yaml
   # egern-rewrites: verified 2.21.0   # 版本号写实际核对过的那一版
   ```

   只在真的读过该版本 schema + 官方示例并逐项对过之后才写这一行。任一项没核实 → 不输出 YAML，
   改为提交「迁移说明 + 待核对项」，写清缺哪份文档、哪个字段、需要在哪个版本上验。
5. **不自动迁移现有模块**。既有 `url_rewrites` / `header_rewrites` / `body_rewrites` / `map_locals`
   照常运行、照常被每日同步覆盖；只有任务点名改到某个模块时才动那个模块，`rules`、`widgets`、
   `schedule` 等无关配置一律不碰。
6. **声明式优先**。能用字段表达的不要引入脚本；脚本只留给需要分支/状态/跨请求的逻辑，
   统一 `export default async (ctx) => {...}`，用 `ctx.http` / `ctx.storage` / `ctx.notify`，
   不引入中转运行时。

`scripts/check_repo.py` 的守卫：顶层出现 `rewrites` 但缺 `# egern-rewrites: verified <版本>` → 判失败
（等于「声称验证过却没留证据」）；统一 `rewrites` 与旧字段混写 → 告警，需人工确认兼容分支是否隔离。

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
sh scripts/check_all.sh     # 与 PR CI 完全同一套检查
```

它依次跑：`scripts/check_repo.py`（全仓静态校验）→ `rules/china/verify.py` → `rules/bilibili-redirect/test.mjs`
→ `rules/coolapk/test.mjs`（拷到临时目录跑，不在工作区生成 `coolapk.mjs`）→
`scripts/tests/test_bilibili_toggles.py`（BiliBili 六组开关解析的离线合成样本测试）→ `git diff --check`。
唯一第三方依赖是 `pyyaml==6.0.2`，缺失时脚本自己装。

`scripts/check_repo.py` 覆盖：YAML 可解析（先按 Egern 运行时替换 `{{{ARG}}}` 占位）、
顶层字段白名单、模块元数据与目录约定（README + 同名 YAML）、Markdown 相对链接、
根 README「目录结构」条目存在性、指向本仓库的 raw/blob/tree 链接路径存在性、
统一 `rewrites` 守卫。

PR / push 会跑 `.github/workflows/validate.yml`（同一个 `check_all.sh`）。它与本地只有一处差别：
CI 另跑一步 `git diff --check <base> HEAD`，检查的是**这段提交范围内**的空白/冲突残留；
本地那步 `git diff --check` 查的是**尚未提交**的工作区改动。CI 检出是干净的，两者不能互相替代。
每日 `sync-*.yml` 同步流不受这道门禁影响。

提交前自查要点：

- [ ] `sh scripts/check_all.sh` 通过
- [ ] 新模块有 README，且根 README 的「模块清单」表格加了一行（说明 + 订阅地址）
- [ ] 根 README「目录结构」里提到的目录真实存在（不存在就不要写）
- [ ] 新增/改写的 `rewrites` 有 `# egern-rewrites: verified <版本>` 标记，且版本号是实际核对过的那一版
- [ ] 订阅的 raw 地址在 `main` 上能取到（`scripts/check_repo.py` 会校验自引用路径）
- [ ] 需要 MITM 的模块在 README 里写清主机与证书步骤
- [ ] 生成物（`sync.py` 产物）没有被手改过的痕迹，或说明为何手改
