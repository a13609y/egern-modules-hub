---
name: egern-hub-maintenance
description: 在 a13609y/egern-modules-hub 仓库里加模块、改规则、跑门禁、排查同步问题时使用。仓库级维护手册：只写本仓库特有的硬规则（Egern 2.21.0+ 统一 rewrites 默认、生成物不可手改、一条 check_all.sh 验收），通用 Egern 写法见通用技能，不在此复制。
---

# egern-modules-hub 维护

本仓库是 Egern 模块 / 脚本 / 规则集合集，多个模块目录带 `sync.py`，被 `.github/workflows/sync-*.yml`
每天重新生成。**规范只有一份在 [`AGENTS.md`](../../../AGENTS.md)**；本技能只补「怎么动手 + 怎么验收」。
通用 Egern 模块/脚本/小组件写法与调试方法在全局技能 `egern-module-dev`，需要时读它，不要在这里复述。

## 硬规则（违反即打回）

1. **改写配置默认写统一 `rewrites`**，目标版本 **Egern 2.21.0+**。
2. **旧字段（`url_rewrites` / `header_rewrites` / `body_rewrites` / `map_locals`）只用于明确的旧版兼容**，
   与统一 `rewrites` 不混写同语义规则，旧分支单独隔离并注释适用范围。
3. **不猜字段**：写之前查目标版本 schema 页 + 至少一个官方 YAML 示例，逐项对条件/动作/阶段/顺序。
4. **证据写在文件里**：真的核过才加 `# egern-rewrites: verified <实际核对版本>`。
   没核过就说「未核实」，交迁移说明 + 待核对项，不给猜测的 YAML —— 也不要在 review/报告里
   声称某个字段「已验证」而没有对应文档与版本。
5. **不自动迁移**：既有旧字段模块照常运行，任务没点名就不动；`rules` / `widgets` / `schedule` 无关配置不碰。
6. **生成物不可手改**：`sync.py` 产物（如 `rules/coolapk/coolapk.js`、`rules/bilibili-redirect/*.bundle.js`
   和对应 YAML）每天被覆盖；要改行为改 `sync.py`，然后本地重跑它验证生成结果。

## 标准动作

```sh
git status --short                      # 先看清工作区还有什么别的改动，别覆盖它们
cat rules/<name>/README.md              # 用途 / 参数 / 已知限制
rg -n 'rewrites|scriptings|env_schema|compat_arguments' <rules|rulesets|widgets>/<name>/*.yaml
sh scripts/check_all.sh                 # 唯一验收命令，和 PR CI 完全一致
```

- 新模块：`<rules|rulesets|widgets>/<kebab-name>/` + 同名 YAML + README + 根 README「模块清单」一行 +「目录结构」真实存在。
- 改同步逻辑：只改 `<name>/sync.py`，再跑 `python3 <name>/sync.py`（或 `--check`）确认产物没被写坏；
  写盘类命令属于覆盖生成物，确认改动方向后再跑，别拿它当试验。
- **临时文件用 `mktemp -d`，不留工作区垃圾、不覆盖用户文件**。典型：coolapk 测试需要
  `coolapk.js` 以 `coolapk.mjs` 被 `import`，`check_all.sh` 是把 `test.mjs` 和 `coolapk.js→coolapk.mjs`
  拷进临时目录再跑，绝不在 `rules/coolapk/` 里生成 `coolapk.mjs`。
- 提交前自查清单见 AGENTS.md 第 3 节，不重复。

## 门禁与 CI 的关系

- `sh scripts/check_all.sh` = 静态校验（`scripts/check_repo.py`）+ 中国规则集校验 + BiliBili 行为测试
  + Coolapk 行为测试（临时目录）+ BiliBili 六组开关解析离线测试 + `git diff --check`。
- `.github/workflows/validate.yml` 跑同一条脚本，**唯一差别**：CI 多加一步 `git diff --check <base> HEAD`，
  查提交范围里的空白/冲突残留；本地那步查未提交的工作区。两者不能互相替代。
- 每日 `sync-*.yml` 用 `contents: write` 的 GITHUB_TOKEN 直接 `git push` 到 `main`，不经过这道门禁；
  改同步逻辑时要假设「产物会绕过本地检查直接进 main」，所以生成器自己内置校验、失败不写文件。

## 边界

- 只读调查（分支保护、远端设置、API 权限）：可以查，但不打印任何凭据，不做设置变更、不 `git push`、
  不新建/改 commit，除非任务明确要求且用户已批准。
- 不同分支的自动同步共用 `main`，改分支保护会影响全部同步流，需人工评估后再动。
- 任何输出（日志、粘贴的响应、issue）先脱敏：cookie、`Authorization`、token、订阅 URL、账号 ID。
