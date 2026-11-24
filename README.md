# 模块 · 脚本 · 分流规则合集

Egern 模块 / 脚本 / 分流规则合集。每个模块自带原始 JS、模块清单（YAML）和说明文档，直接订阅 YAML 即可。


作者：[a13609y](https://github.com/a13609y)

## 目录结构

```
widgets/            小组件类模块（generic 脚本 + widgets 声明）
├── oil-price/      全国实时油价（小/中/大号三套布局）
├── holiday-countdown/ 节日倒数（春节/中秋/国庆…，内置农历表）
├── sticky-note/     便签（文字自定义 + 9 种纸张样式）
├── ...
rules/              规则 / URL 重写 / MITM / http_response 类模块
├── general-enhanced/ 通用增强（合一版：绕过隧道 + 真实 IP + MITM 排除，跟随上游）
├── lan-bypass/     已合并进 general-enhanced（保留兼容）
├── real-ip-domains/ 已合并进 general-enhanced（保留兼容）
├── coolapk/        酷安去广告（自动跟随上游 zirawell/R-Store）
├── pinterest/      Pinterest 去广告（信息流 / 搜索 / 相关推荐推广 Pin）
├── bilibili-redirect/ BiliBili CDN 重定向（生成版：上游六组参数拆成开关，跟随 Releases）
├── youtube/        YouTube 增强（去广告/后台播放/画中画/原生下载，8 个原生开关；每日自动跟随上游 main、按锁定 SHA 生成）
├── fanqie-adblock/ 番茄小说去广告（穿山甲 / 广告计费 / 章末视频，跟随上游）
├── pingme/         PingMe 签到 + 看视频奖励（拆成两条独立定时任务，可单独开关）
├── china/          中国规则集（大陆域名 8,400+ / IPv4 6,200+ / IPv6 3,400+ 段，no_resolve: true，每天跟随上游）
rulesets/           纯规则集（不含模块，直接给 rule_set 引用）
├── foreign-domains/ 国外域名规则集（26,000+ 条，每天更新）
scripts/            仓库自检脚本（check_all.sh 一条命令跑完，CI 跑同一个脚本）
agents/skills/      仓库维护技能（egern-hub-maintenance：加模块 / 跑门禁 / 排查同步）
.github/workflows/  上游同步（每天拉一次上游，有变化才提交）+ validate.yml 贡献门禁
```

命名约定：目录用 `kebab-case`，每个模块目录内文件名与目录同名，附一份 `README.md`。

提交前自检（本地一条命令，与 PR CI 同一套检查）：

```sh
sh scripts/check_all.sh
```

它依次跑全仓静态校验（YAML / 元数据 / 链接 / 目录树 / 自引用 / 统一 `rewrites` 守卫）、中国规则集专项校验、
BiliBili Redirect 行为测试、Coolapk 行为测试（拷到临时目录跑，不在工作区生成文件）、
BiliBili 六组开关解析的离线测试（合成样本，无网络无凭据）、`git diff --check`。
CI（`.github/workflows/validate.yml`）跑同一个脚本，只多一步 `git diff --check <base> HEAD`：
检查的是提交范围内的差异，本地那步查的是尚未提交的工作区改动。

贡献约定（模块目录、Egern 2.21.0+ 版本与统一 `rewrites` 写法、发布前检查清单）见 [AGENTS.md](AGENTS.md)；
仓库维护手册（加模块、跑门禁、同步排查）见 `agents/skills/egern-hub-maintenance/SKILL.md`。

## 模块清单

| 模块 | 说明 | 订阅地址 |
| --- | --- | --- |
| [全国实时油价](widgets/oil-price/README.md) | 92/95/98/柴油实时油价，小/中/大号三套布局（居中四油品 2×2 田字格 / 四油品+走势折线 / 完整信息+加满金额）；走势只用真实抓取记录（站点无逐轮历史价格，不画推测曲线），下轮窗口按 10 个工作日推算 | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/widgets/oil-price/oil-price.yaml` |
| [节日倒数](widgets/holiday-countdown/README.md) | 距离下个节日还有几天，内置 2024–2050 农历与节气表，按画布自动排版 | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/widgets/holiday-countdown/holiday-countdown.yaml` |
| [便签](widgets/sticky-note/README.md) | 桌面便签，文字自己填（标题 + 8 行 + 页脚），9 种纸张样式、颜色/装饰/横线/字体/对齐可调 | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/widgets/sticky-note/sticky-note.yaml` |
| [通用增强（合一版）](rules/general-enhanced/README.md) | 三合一：私有网段/组播不走隧道 + 门户检测/STUN/联机/NTP/推送/NAS 等用真实 IP（每天跟随上游聚合）+ MITM 排除 | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/general-enhanced/general-enhanced.yaml` |
| [酷安去广告](rules/coolapk/README.md) | 去酷安开屏 / 首页信息流 / 评论 / 商品推广广告，规则与脚本自动跟随上游 | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/coolapk/coolapk.yaml` |
| [Pinterest 去广告](rules/pinterest/README.md) | 去 Pinterest 信息流、搜索、相关推荐里的推广 Pin，拦广告与点击追踪域名 | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/pinterest/pinterest.yaml` |
| [BiliBili Redirect](rules/bilibili-redirect/README.md) | 哔哩哔哩 CDN 重定向；基于 Biliverse/Redirect 生成，把 `Host.OverseaVideo/BStar/PCDN/MCDN`、`Storage`、`LogLevel` 的每个上游候选值拆成独立开关（每组恰好一个为开才生效，全关/多开回上游默认），每天跟随 Releases 重新生成 | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/bilibili-redirect/bilibili-redirect.yaml` |
| [YouTube 增强](rules/youtube/README.md) | 去 YouTube 广告（播放器 ad_break／计费／推广位）、后台播放与 PiP、最高画质、Shorts／小游戏／竖屏直播／商店入口隐藏、Jump Ahead、实验性原生下载；基于 IBL3ND/module（源自 Maasea Apache-2.0 → gholts）每日自动跟随上游 main、按锁定 SHA 生成，8 个原生 env_schema 开关（取代上游 compat_arguments）；整体再分发许可状态待权利人确认，见该目录 NOTICE | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/youtube/youtube.yaml` |
| [番茄小说去广告](rules/fanqie-adblock/README.md) | 穿山甲 / 广告计费 / 广告素材 / 章末视频，域名表每天跟随上游聚合 | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/fanqie-adblock/fanqie-adblock.yaml` |
| [PingMe 签到 + 看视频奖励](rules/pingme/README.md) | 签到（滚动签到小时 + 当天追赶制）与看视频得奖励拆成两条独立定时任务，各自 cron / 超时 / 开关，支持多账号 | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/pingme/pingme.yaml` |
| [中国规则集](rules/china/README.md) | 大陆域名 8,421 条（后缀 8,339 / 精确 79 / 正则 3）+ IPv4 6,221 段 + IPv6 3,444 段，顶层 `no_resolve: true`（IP 规则不触发额外 DNS 解析）；纯规则集，命中走 `DIRECT` | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/china/china.yaml` |
| [国外域名规则集](rulesets/foreign-domains/README.md) | 26,000+ 条国外域名（v2fly geolocation-!cn + Loyalsoldier proxy），已剔除中国域名；纯规则集，给 `rule_set` 引用 | `https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rulesets/foreign-domains/foreign-domains.yaml` |

> 规则集摆放顺序：`rules/china`（中国直连）在前，`rulesets/foreign-domains`（国外代理）在后，两者有 151 条重叠（`bilibili.tv`、`alibabacloud.com.xx` 这类中国公司海外站），先匹配直连才不会误走代理。

> 注：`lan-bypass`、`real-ip-domains`、`real-ip-domains-extra` 已合并为 **通用增强（合一版）**，旧订阅仍可用但不再更新。

## 安装方式

1. 复制上表里的模块地址。
2. Egern → 工具 → 模块 → `+` → 粘贴地址 → 保存。
3. 模块需要配置的项会出现在模块的「参数 / 环境变量」里（由 YAML 的 `env_schema` 生成界面）。
4. 小组件类模块：主屏幕长按 → `+` → Egern → 选尺寸 → 长按组件 → 编辑小组件 → 选择对应组件名。

## 说明

- 模块地址固定指向 `main` 分支，更新即生效，Egern 默认 24 小时检查一次模块更新。
- 本仓库模块默认不写路由规则（`rules` / `dns` 置空），避免影响你的分流策略；需要的直连规则在各自 README 里单独说明。
- 数据来自公开网页或公开接口，站点改版可能导致失效，脚本内均有缓存与错误兜底。
- 需要 MITM 的模块（如酷安去广告）会显式声明 `mitm.hostnames`，并在各自 README 里注明。
- 依赖第三方上游的模块由 GitHub Actions 定时同步，转换脚本与测试都在模块目录内，可自行复跑。
