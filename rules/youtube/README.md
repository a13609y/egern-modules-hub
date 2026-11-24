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

全部由 YAML 的 `env_schema` 生成模块设置页的 Toggle，默认全开：

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

值接受 `true/false`（也接受 `1/0/on/off/yes/no`），非法值按默认 `true`。

### 与原版参数的差异

- 上游 IBL3ND 的 `compat_arguments` / `compat_arguments_schema` / `env._compat.$argument`
  已全部去掉，改成上面的原生 `env_schema`；脚本内由生成的前缀把 `ctx.env` 组装成上游读取的
  `$argument` JSON，上游 JavaScript 逐字节保留（哈希见 `NOTICE`）。
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
  之所以不用统一 `rewrites`：官方文档站当前（2026-11-24 抓取）的模块页
  <https://egernapp.com/zh-CN/docs/configuration/modules> 只列
  `url_rewrites`/`header_rewrites`/`body_rewrites`/`map_locals`，没有统一 `rewrites` 的
  schema 页；本仓库 AGENTS.md 要求「核过 schema + 官方示例才可写」，
  所以这里走可核实的原生字段（详见 NOTICE 的「字段核对」段）。

## 来源证据（区分直接上游与原始来源）

| 层 | 仓库 | 证据 |
| --- | --- | --- |
| 直接上游 | `IBL3ND/module` @ `a185a5f38f0c3acaa107ce1f05304fd3204edc2a`（`Egern-YouTube.yaml`，sha256 `8faa25c7…fa2d1`） | 本模块的结构、规则、改写、脚本清单、MITM 均出自此文件；提交史 `e03e268f`(2026-10-01 建立) → `a185a5f3`(2026-11-03) 共 8 次，作者 iBL3ND，仓库无 LICENSE 文件 |
| 脚本上游 | `IBL3ND/js`：`youtube-request.js`@`9d93c69a`、`youtube-response.js`@`23866dcb`、`YT-CC-ASR-Auto.js`@`ab98a875` | 上游 YAML 的 `script_url` 指向该仓库 `main` 分支；本模块改为按上述 commit SHA 取快照（不可变） |
| 原始来源（声明的） | `gholts/surge` `modules/youtube-enhance.sgmodule` | 该文件头写明 `#!desc=... Based on Maasea's code (Apache-2.0).`；脚本路径 `scripts/youtube/{request,response,ump,key}.js`。IBL3ND 的脚本名/URL 匹配/`$argument` 键名（`blockUpload`、`blockShorts`、`blockGames`…）与 gholts 版同名同构，属同一血脉的重打包+扩展（未逐行 diff，脚本体量 12.9K vs 5.9K、130K vs 77K） |
| 原始来源（许可） | `Maasea/sgmodule`（`LICENSE` = Apache-2.0） | gholts 自述基于 Maasea 代码；Maasea 仓库根 `LICENSE` 为 Apache License 2.0 原文 |

结论：`IBL3ND/module` 的 `Egern-YouTube.yaml` **不是**独立原创，它是 gholts/Surge 版
YouTube Enhance 的 Egern 重打包，而 gholts 版自述基于 Maasea（Apache-2.0）。
`IBL3ND/*` 两个仓库都没有 LICENSE；Apache-2.0 链条上的再分发必须保留署名与许可，
故本模块带 `LICENSE`（Apache-2.0 原文）+ `NOTICE`（分层署名、SHA、哈希、改动说明）。
若原作者要求下架，删除本目录即可，不影响仓库其他模块。

## 安全核查

- 三个脚本的静态扫描（`sync.py` 每次生成都跑）：无 `eval` / `new Function` /
  `XMLHttpRequest`；唯一出站主机是 `translate.googleapis.com`（字幕翻译功能本身），
  没有新增外联、没有上传凭据的代码路径。这里的「去广告 / 隐藏入口」是用户本机的个人过滤，
  不属于攻击或漏洞利用，可以迁移。
- 同步工作流**不执行**下载回来的上游 JS：只做哈希校验 + 文本拼装 + 静态扫描（纯 Python），
  生成物才进入仓库；任何校验失败即非零退出、不写文件，上一版保留。

## 已知限制

- 依赖 YouTube 内部 protobuf 接口（`youtubei/v1/*`），YouTube 改协议后上游需跟进；
  本仓库只做「按 SHA 拉取 + 原生化」，上游不更新就不会有变化。
- `nativeDownload` 仍是实验性的：未设置画质时按 720p，服务器端限制可能仍生效。
- 字幕翻译会把字幕文本发给 `translate.googleapis.com`（上游行为，未改动）。
- 静态校验通过 ≠ 真机可用；本模块未在 iPhone 上跑 Egern 真机回归（无设备）。

## 复跑与验收

```sh
python3 rules/youtube/sync.py --check   # 只校验不写盘：上游哈希、转换、静态扫描
python3 rules/youtube/sync.py           # 重新生成 youtube.yaml + 3 个 bundle（无变化则不写）
sh scripts/check_all.sh                 # 全仓门禁（含 YAML/字段/链接校验）
```

`--check` 输出示例：

```
{"upstream": {"module": "a185a5f3", "request": "9d93c69a", "response": "23866dcb",
 "dual_subs": "ab98a875"}, "toggles": 8, "url_rewrites": 9, "scriptings": 9,
 "bundles": ["youtube-dual-subs.js", "youtube-request.js", "youtube-response.js"],
 "changed": [], "check": true}
```

上游升级方式：改 `sync.py` 顶部 `PIN` 的 commit + sha256（四处），跑 `--check` 通过后提交，
CI 次日会按新 SHA 重新生成。
