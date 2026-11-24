# YouTube 增强（Egern 原生版）

YouTube 去广告（播放器 ad_break / 广告计费 / 推广位）、后台播放与画中画、最高画质、
Shorts / 小游戏 / 竖屏直播 / 商店入口隐藏、Jump Ahead、实验性原生下载、字幕翻译。

订阅地址（固定 `main`）：

```
https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/youtube/youtube.yaml
```

Egern → 工具 → 模块 → `+` → 粘贴上面的地址。模块需要 MITM：安装并信任 Egern 的 CA 证书
（模块已声明 `mitm.hostnames`：`*.googlevideo.com`、`www.youtube.com`、`m.youtube.com`、
`s.youtube.com`、`youtubei.googleapis.com`，排除 `redirector*.googlevideo.com`）。

## 参数（8 个原生开关）

全部由 YAML 的 `env_schema` 生成模块设置页的 Toggle，**默认全部关闭**（装好后模块只做去广告 / 后台播放等无开关的基础功能；8 个增强开关需在模块设置页手动打开才生效）：

| 开关（env 键） | 名称 | 关闭后的效果 |
| --- | --- | --- |
| `blockUpload` | 隐藏「上传」入口 | 恢复导航栏上传入口 |
| `blockShorts` | 隐藏「Shorts」入口 | 恢复 Shorts 入口 |
| `autoHd` | 自动最高画质 | 不锁定最高画质、不阻止降画质 |
| `blockGames` | 隐藏小游戏推荐 | 恢复 Playables 推荐 |
| `blockVerticalLive` | 隐藏竖屏直播推荐 | 恢复竖屏直播推荐 |
| `jumpAhead` | 启用 Jump Ahead | 不启用跳转按钮、保留推广提示 |
| `blockStore` | 隐藏商店和购物板块 | 恢复创作者商店 / 购物板块 |
| `nativeDownload` | 原生下载（实验性） | 关闭原生下载改写（脚本仍会加载，行为回到上游默认） |

取值规则：只有合法真值 `true` / `1` / `on` / `yes`（大小写不敏感）会把开关打开；未设置、空值、`false` / `0` / `off` / `no` 以及任何非法值一律按**关闭**处理 —— 默认全关，不会因为上游配置残留或手误输入而误开。

- 官方文档依据（2026-11-23 抓取）：`/zh-CN/docs/configuration/modules` 的 `env_schema` 条目写明
  `options: ["true", "false"]` 会生成 **Toggle**、键名即环境变量名，且「用户未主动设置时不会写入 `env`」
  （即用户设置后会写入脚本 `env`）；`/zh-CN/docs/configuration/scriptings` 写明脚本里的 `env`
  **可通过 `ctx.env` 访问**。开关桥读 `ctx.env[<键名>]` 因此是文档化路径，不是猜测。
  未验证项：真机上「模块设置页改动 → 写入 env」的生效时机（无设备可测）。

### 默认值与实现路径（为什么默认关得住）

- `env_schema` 的 `options: ["true", "false"]` 保留不动（这是 Egern 渲染 Toggle 的必要条件，
  `sync.py` 的 `verify()` 现在把它当门禁校验）。
- 三个 `scriptings` 的 `env` 由 `sync.py` 按 `TOGGLES` 生成，8 个键一律写成 `'false'`，
  这是文档化的默认值载体（`env` 是脚本可见的初始环境）。
- 脚本前缀（开关桥）再做一次兜底：`ctx.env[键]` 缺失 / 空 / 非真值 → `false`，
  只有 `true|1|on|yes` → `true`；因此即使 Egern 版本差异导致 `env` 未下发，行为仍是全关。
- **未采用 `env_schema` 的 `default_value: 'false'`**：本仓库抓取的官方 `env_schema` 文档片段
  只覆盖 `name` / `description` / `options`，未核到 `default_value` 字段；按 AGENTS.md
  「核过 schema 才可写」，不写入未核实字段，默认值改由上面两个已文档化的位置保证。
  若日后官方文档出现 `default_value`，在 `sync.py` 的 `env_schema` 生成处加一行即可。
- 回归测试：`node rules/youtube/test-toggles.mjs`（读生成物，校验 YAML 的 `env_schema` /
  `scriptings.env`，并真实执行开关桥验证「缺失 / false / true / 非法值」四种输入）。

### 与原版参数的差异

- 上游 IBL3ND 的 `compat_arguments` / `compat_arguments_schema` / `env._compat.$argument`
  已全部去掉，改成上面的原生 `env_schema`；脚本内由生成的前缀把 `ctx.env` 组装成上游读取的
  `$argument` JSON，上游 JavaScript 逐字节保留（逐文件 sha256 见 `SOURCE.lock`）。
- 上游的 `屏蔽选段按钮`（`屏蔽选段按钮: 'true'`）是**死开关**：它没有传给任何脚本，
  `youtube-request.js` / `youtube-response.js` 里也搜不到 `blockSelection`/选段相关读取
  （证据：`rg 'blockSelection|选段' youtube-request.js youtube-response.js` 无输出）。
  因此本模块不发布这个开关，避免给用户一个按了没反应的 UI。
- 上游的 `dns: {}` 空字段不再输出（本仓库约定模块不写 `dns` / 路由规则）。
  上游的两条 `rules`（`googlevideo.com` / `youtubei.googleapis.com` 的 UDP REJECT）
  是功能的一部分（禁 QUIC 回落），**保留**。
- 上游统一 `rewrites`（9 条，redirect / respond）逐条转成官方文档化的 `url_rewrites`：
  `respond` 200 空体 → `http://reject-200/`，302 + `Location` → `location` + `status_code: 302`，
  `redirect` → `location` + `status_code`。语义等价、字段全部见于
  <https://egernapp.com/zh-CN/docs/configuration/url_rewrites>。
  之所以保留 `url_rewrites`、没有改写成统一 `rewrites`（这是本模块唯一一处偏离「新改动默认用统一
  `rewrites`」的地方，证据如下，不猜）：2026-11-23 复抓官方文档站，`env_schema` / `scriptings` /
  `url_rewrites` 页面均存在且可逐字段核对，但统一 `rewrites` 的 schema 页
  `https://egernapp.com/zh-CN/docs/configuration/rewrites`（以及 `/rewrite`）返回 **404**，
  没有可读 schema、也没有官方 YAML 示例。按本仓库 AGENTS.md 的「核过 schema + 官方示例才可写」，
  这里落到**已可核实**的 `url_rewrites`。若官方日后发布统一 `rewrites` 的 schema 页与示例，
  只需把 `sync.py` 的 `convert_rewrites()` 改成一对一映射（9 条上游改写已在该函数里逐条校验）。

## 自动跟随上游（不需要手改任何 SHA）

每日 GitHub Actions（`sync-youtube`，cron `47 5 * * *` UTC）执行 `rules/youtube/sync.py`：

1. 无认证 REST 读取 `IBL3ND/module` 与 `IBL3ND/js` 的 `commits/main`，解析各自 **main 的最新提交**；
   `GITHUB_TOKEN` 只用于提升 API 速率上限，不落盘、不打印。
2. **同一个 run 每个仓库只锁定一个提交**，四个文件都从
   `https://raw.githubusercontent.com/<repo>/<resolved_sha>/<path>` 读取，
   因此不会出现「YAML 来自 A 提交、脚本来自 B 提交」的版本混合。
3. 逐文件算 sha256，写入 `rules/youtube/SOURCE.lock`（repo / commit / path / sha256 / bytes，
   外加生成物自身的 sha256 与派生计数）。上游一变，锁文件与生成物在同一提交里一起变，
   `git log -p rules/youtube/SOURCE.lock` 就是完整的升级审计记录。
4. 全部门禁（API / 下载 / YAML 结构 / schema / 静态扫描 / 自检断言）通过才写盘；
   任一失败即非零退出、**不覆盖**上一版生成物。下载回来的上游 JS 只做哈希与文本拼装，**从不执行**。
5. 上游 `main` 没有新提交时，生成物与 `SOURCE.lock` 都不变，工作流不提交。有新提交时锁**一定会变**
   （`SOURCE.lock` 记录最新 commit 与 `committed_at`），所以即使该提交**没有改动这四个目标文件**，
   也会触发一次审计提交；此时四个目标文件的 sha256 均不变，`sync.py` 的转换结果与模块配置
   （开关 / 规则 / 改写 / 脚本正文）**完全不变**，唯一差异是生成物注释里记录的 commit 短 SHA 跟着刷新。
   判断「上游行为是否真的变了」看 `SOURCE.lock` 的 `files[].sha256`，不要看 commit 号。

需要复现某一次同步（离线排障）时可显式锁 SHA：
`python3 rules/youtube/sync.py --rev IBL3ND/module=<40位sha> --rev IBL3ND/js=<40位sha>`
—— 这是唯一的手工入口，日常与 CI 都不需要它。

## 来源证据（区分直接上游与原始来源）

| 层 | 仓库 | 证据 |
| --- | --- | --- |
| 直接上游 | `IBL3ND/module` · `Egern-YouTube.yaml` | 本模块的结构、规则、改写、脚本清单、MITM 均出自此文件；仓库无 LICENSE 文件。每次同步解析其 `main` 最新提交，**当前 commit 与 sha256 见 `SOURCE.lock`** |
| 脚本上游 | `IBL3ND/js` · `youtube-request.js` / `youtube-response.js` / `YT-CC-ASR-Auto.js` | 上游 YAML 的 `script_url` 指向该仓库 `main`；本模块每次同步解析 `IBL3ND/js` 的 `main` 最新提交，与 YAML 在**同一个 run 内锁定同两个 commit**，逐文件哈希见 `SOURCE.lock` |
| 原始来源（声明的） | `gholts/surge` `modules/youtube-enhance.sgmodule` | 该文件头写明 `#!desc=... Based on Maasea's code (Apache-2.0).`；脚本路径 `scripts/youtube/{request,response,ump,key}.js`。IBL3ND 的脚本名/URL 匹配/`$argument` 键名（`blockUpload`、`blockShorts`、`blockGames`…）与 gholts 版同名同构，属同一血脉的重打包+扩展（未逐行 diff，脚本体量 12.9K vs 5.9K、130K vs 77K） |
| 原始来源（许可） | `Maasea/sgmodule`（`LICENSE` = Apache-2.0） | gholts 自述基于 Maasea 代码；Maasea 仓库根 `LICENSE` 为 Apache License 2.0 原文 |

结论（只写可从现有证据核实的事实）：

- `IBL3ND/module` 的 `Egern-YouTube.yaml` **不是**独立原创：它与 gholts/Surge 版 YouTube Enhance
  同名同构（脚本名、URL 匹配、`$argument` 键名一致），属同一血脉上的重打包 + 扩展（未逐行 diff）。
- `Maasea/sgmodule` 仓库根有 Apache-2.0 `LICENSE` 原文；`gholts/surge` 该模块文件头自述
  `Based on Maasea's code (Apache-2.0)`；`IBL3ND/module` 与 `IBL3ND/js` **两仓均无 LICENSE 文件**。

不可从上述证据推出的结论：IBL3ND 对其增量 / 重打包代码是否取得 Apache-2.0 授权、或另行选择了其它条款，
**本仓库无法独立确认**（照抄上游 LICENSE 文本 ≠ 上游已授权该再分发）。因此**本模块的整体再分发许可
状态待权利人确认**，本目录不整体声明为 Apache-2.0：

- 同目录 `LICENSE` 保留为链条上可核实的 **Maasea Apache-2.0 原文**，作为原始许可文本与署名依据，
  不代表本目录整体已获 Apache-2.0 授权；
- 同目录 `NOTICE` 保留分层署名、来源 repo / commit / 逐文件 sha256（见 `SOURCE.lock`）与改动说明，
  供审计与权利人核对；
- 风险：若 IBL3ND 的增量部分未获 Apache-2.0 授权或另附条件，本目录的再分发可能超出上游许可范围。
  IBL3ND / gholts / Maasea 任一权利人提出异议，删除 `rules/youtube/` 即可，不影响仓库其他模块
  （已发布的文件不擅自删除，等权利人表态或逐案处理）。

## 安全核查

- 三个脚本的静态扫描（`sync.py` 每次生成都跑）：无 `eval` / `new Function` /
  `XMLHttpRequest`；唯一出站主机是 `translate.googleapis.com`（字幕翻译功能本身），
  没有新增外联、没有上传凭据的代码路径。这里的「去广告 / 隐藏入口」是用户本机的个人过滤，
  不属于攻击或漏洞利用，可以迁移。
- 同步工作流**不执行**下载回来的上游 JS：只做哈希校验 + 文本拼装 + 静态扫描（纯 Python），
  生成物才进入仓库；任何校验失败即非零退出、不写文件，上一版保留。

## 已知限制

- 依赖 YouTube 内部 protobuf 接口（`youtubei/v1/*`），YouTube 改协议后上游需跟进；
  本仓库只做「解析 main → 按锁定的 SHA 拉取 → 原生化」，上游不更新则生成物不变（幂等）。
- `nativeDownload` 仍是实验性的：未设置画质时按 720p，服务器端限制可能仍生效。
- 字幕翻译会把字幕文本发给 `translate.googleapis.com`（上游行为，未改动）。
- 静态校验通过 ≠ 真机可用；本模块未在 iPhone 上跑 Egern 真机回归（无设备）。
- `youtube.single.response` 的 `match` 在生成期裁掉了 `youtubei/v1/next`（见 `sync.py` 的 `DROP_MATCH_ALTS`）。
  副作用：`next` 响应不再进入本模块脚本，基于 `next` 响应的去广告/UI 处理（如部分推荐流清理）不再生效；
  `player`、`browse`、`guide`、`log_event` 等其他路径照旧拦截。裁剪只改 YAML 的 `match`，上游脚本正文逐字节未改。

## 复跑与验收

```sh
python3 rules/youtube/sync.py --check   # 只校验不写盘：上游哈希、转换、静态扫描
python3 rules/youtube/sync.py           # 重新生成 youtube.yaml + 3 个 bundle（无变化则不写）
sh scripts/check_all.sh                 # 全仓门禁（含 YAML/字段/链接校验）
node rules/youtube/test-toggles.mjs     # 开关默认关 + 开关桥行为（离线，无网络）
```

`--check` 输出示例（本文件生成时的真实输出）：

```
{"upstream": {"IBL3ND/js": "aa76cd9b", "IBL3ND/module": "6cb7c889"},
 "upstream_full": {"IBL3ND/js": "aa76cd9b4a323b55efa51b8cfe94d92a3dd20126",
                   "IBL3ND/module": "6cb7c889ed43e83adea8e33310ebf3c13f9d7c46"},
 "toggles": 8, "url_rewrites": 9, "scriptings": 9,
 "bundles": ["youtube-dual-subs.js", "youtube-request.js", "youtube-response.js"],
 "changed": [], "check": true}
```

上游升级：**不需要手改任何 SHA** —— 每日 cron 解析两条 `main` 的最新提交，`SOURCE.lock` 与生成物
在同一提交里一起更新。若 `--check` 报 `changed` 非空而你没改 `sync.py`，说明上游确实动了：
看 `git diff rules/youtube/SOURCE.lock` 里的 commit 从 X 到 Y 即可；不要手改生成物。
