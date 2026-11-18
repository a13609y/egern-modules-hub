# 中国规则集

**这是规则集，不是模块。** 只放「中国大陆」的东西：大陆域名 + 大陆 IPv4 / IPv6 段，
配套使用：命中 → `DIRECT`。不含任何策略、不含脚本、不需要 MITM。

## 地址

```yaml
# Egern rule_set
https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/china/china.yaml

# 通用文本（Surge / Clash / Loon 的 RULE-SET 行格式）
https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/china/china.txt
```

## 怎么用（Egern）

在你的主配置 `rules:` 里加一条，**放在最前面**：

```yaml
rules:
  # 1. 中国大陆域名 + IP 段 → 直连
  - rule_set:
      match: "https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/china/china.yaml"
      policy: DIRECT
      update_interval: 86400

  # 2. 国外域名 → 代理（可选，配合 rulesets/foreign-domains 用）
  - rule_set:
      match: "https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rulesets/foreign-domains/foreign-domains.yaml"
      policy: Proxy          # ← 改成你的策略组名
      update_interval: 86400

  # 3. 其余兜底
  - default:
      policy: Proxy
```

规则按顺序匹配、命中即停，所以这条要在国外规则集**之前**：两套集里有 151 条重叠
（`bilibili.tv`、`alibabacloud.com.xx`、`aboutmcdonalds.com` 这类「中国公司海外站 / CDN」），
放前面才能让它们走直连。只用本规则集 + `default: Proxy` 也能跑。

## 里面有什么

| 字段 | 条数 | 含义 |
|---|---|---|
| `domain_suffix_set` | 8,339 | 后缀匹配（`qq.com` 同时覆盖其全部子域） |
| `domain_set` | 79 | 精确匹配（只匹配域名本身，如 `ads3-normal-hl.zijieapi.com`） |
| `domain_regex_set` | 3 | 正则匹配（`awsdns-cn-xx` 这类机器生成的域名） |
| `ip_cidr_set` | 6,221 | IPv4 段，覆盖 344,334,845 个地址（IPv4 空间的 8.02%） |
| `ip_cidr6_set` | 3,444 | IPv6 段（占 IPv6 空间的 0.002%，以 `240e::/…`、`2408::/…` 为主） |
| `no_resolve` | `true` | IP 规则只用「已知目的 IP」判断，不为了匹配而额外做 DNS 解析 |

合计 **8,421 条域名 + 9,665 段 IP**，YAML 约 328 KB，文本版约 554 KB。

### `no_resolve` 为什么写在顶层

Egern 官方文档 [规则](https://egernapp.com/zh-CN/docs/configuration/rules/) 的「规则集合」小节：

- 规则集字段表里，IPv4 用 **`ip_cidr_set`**、IPv6 用 **`ip_cidr6_set`**（是两张表，不是把 v6 塞进 v4）；
- `no_resolve:` 是**整个规则集的一个开关**（"(可选) 是否跳过 DNS 解析，影响所有 IP 相关规则"），
  官方示例就是 `no_resolve: true` 和 `domain_suffix_set:` 平级；
- 单条规则的 `no_resolve` 只存在于 `rules:` 里的 IP 类规则（`geoip` / `ip_cidr` / `ip_cidr6` / `asn`），
  **规则集内部的元素只能是字符串**，写成 `- {value: 1.2.3.0/24, no_resolve: true}` 会被静默忽略。

所以本集把 `no_resolve: true` 放在顶层一次，就覆盖了全部 9,665 段 IP（`verify.py` 会断言这一点）；
文本版没有顶层字段，于是逐行写成 `IP-CIDR,1.0.0.0/24,no-resolve` / `IP-CIDR6,240e::/20,no-resolve`。

`no_resolve: true` 的实际含义：请求只有域名、IP 还没解析出来时，**不为了匹配 IP 规则而多做一次 DNS 解析**。
它只对「App 直接连 IP」或「已经解析过」的流量生效，不会拖慢域名请求，也不会泄漏 DNS。

## 数据从哪来（都是 MIT 许可）

| 上游 | 许可 | 取什么 |
|---|---|---|
| [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community) | MIT | `data/cn` = `include:tld-cn` + `include:geolocation-cn`，本地递归展开几百个 include 后的域名表 |
| [gaoyifan/china-operator-ip](https://github.com/gaoyifan/china-operator-ip) | MIT | `ip-lists` 分支 `china.txt`（IPv4）/ `china6.txt`（IPv6），按 BGP/ASN 归到中国运营商的段，每天自动重建 |

**没有用什么、为什么：**

- `Loyalsoldier/clash-rules`（`direct.txt`，10 万+ 条）是 **GPL-3.0**：数据是自由软件，
  混进本仓库会让整份产物背上 copyleft；本仓库其余文件也没有 LICENSE 声明，不引入更省事。
- `17mon/china_ip_list`：仓库**没有 licence 字段**，等于未授权，只用 IPv4，弃用。
- 不硬编码任何域名或 IP：全部由 `sync.py` 从上面两个上游现算，上游变了产物就变。

## 自动更新（每天一次，有变化才提交）

`.github/workflows/sync-china.yml`，每天 04:47 UTC（北京时间 12:47），与仓库其他同步任务错开；
`workflow_dispatch` 可手动触发。设计上刻意「稳」：

- 只 GET `codeload.github.com`（1 次 tar 包，346 KB 含全仓 1,557 个 data 文件）+ 2 次
  `raw.githubusercontent.com`（CDN），**完全不调用 `api.github.com`**，**不带任何 PAT**；
- 每天约 3 个请求，每个请求最多重试 3 次（退避 2s / 5s），job `timeout-minutes: 10`、生成步骤 5 分钟；
- `permissions:` 只有 `contents: write`（默认 GITHUB_TOKEN，不新增 secret）；
- `concurrency: sync-china` + `cancel-in-progress: false` → 串行排队，不会两个任务互相踩；
- **先校验后落盘**：`sync.py` 抓取 → 解析 → 校验全部通过才写文件，任何一步失败进程非零退出，
  工作流随即中止，仓库里保留上一版产物，订阅端继续用旧数据（不会出现「上游挂了 → 空规则集」）；
- 生成结果是确定的（排序、无时间戳），内容没变 → `git status` 干净 → **不提交**，不产生空 commit；
- 提交前再跑一次独立验收 `verify.py`；提交信息带 `[skip ci]`，不会自触发形成连环 run。

校验拦得住什么（都是硬失败，不是告警）：

| 风险 | 拦截 |
|---|---|
| 上游残缺 / 改版 | 条数下限：域名 ≥1500、IPv4 ≥1000、IPv6 ≥200 |
| 误展开成「全世界」 | 条数上限（域名 ≤40000、IPv4 ≤20000）+ IPv4 覆盖 ≤35% / IPv6 ≤5% |
| 裸 TLD 让规则集失效 | 只允许 `cn`，出现 `com`/`net`/`org` 等直接失败 |
| 国外大站被收进来 | `google.com`、`youtube.com`、`github.com`、`openai.com` 等命中即失败 |
| 过宽 IP 段（`0.0.0.0/0` 之类） | IPv4 前缀 < /8、IPv6 < /16 直接丢弃；跨族条目（v6 混进 v4 表）丢弃并告警 |
| 覆盖度掉到 0 | 必须有 `qq.com` / `baidu.com` / `bilibili.com` / `taobao.com` / `alipay.com` / `cn` 锚点 |

## 本地运行 / 复跑验收

```sh
git clone https://github.com/a13609y/egern-modules-hub && cd egern-modules-hub

python3 rules/china/sync.py        # 拉上游 → 生成 china.yaml + china.txt（无变化不写）
python3 rules/china/verify.py      # 独立静态验收：schema / 样本 / 每个 IP no_resolve / 格式 / 幂等
sh rules/china/accept.sh           # 全量验收：幂等、上游 404、上游格式错乱、过宽段、手改产物
```

`accept.sh` 是刻意「反着测」的：注入 404、注入 HTML 假数据、注入 `0.0.0.0/0`、
手工删掉 `no_resolve`、手工删掉一行的 `no-resolve`——每一种都必须被抓到。

依赖只有 Python 3 + PyYAML（`apk add py3-yaml` / `pip install pyyaml`）。

## 手工改吗

不要改 `china.yaml` / `china.txt`——生成物，下次同步直接覆盖。要增删条目请改 `sync.py` 的
`FOREIGN_MUST_NOT` / `BARE_TLD_*` / `LIMITS` 等护栏，或者直接提 issue。
