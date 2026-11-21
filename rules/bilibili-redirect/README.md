# BiliBili Redirect（Egern，开关版）

哔哩哔哩 CDN 重定向，源自 [Biliverse/Redirect](https://github.com/Biliverse/Redirect) 原生 Egern 模块（Apache-2.0，见 `LICENSE` / `NOTICE`），在其上提供六组参数开关。

- 订阅：`https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/bilibili-redirect/bilibili-redirect.yaml`
- 上游版本：`v0.2.25`，每日 04:17 UTC 由 GitHub Actions 重新生成并在内容变化时提交

## 开关怎么用

每组（Host.OverseaVideo 港澳台 / Host.BStar 国际版 / Host.PCDN 大陆 PCDN / Host.MCDN / Storage / LogLevel）的每个上游候选值是一个独立 Toggle，标签形如「港澳台：阿里云 CDN」。
**某组恰好一个为开**→使用该值；**全关或多开**→回到 `compat_arguments` 的默认值。脚本不会写坏请求：任何异常都退回运行时原生 `$argument`。

## 实现与 v96611db 的区别（超时修复）

v96611db 的开关版在脚本里替换了 `globalThis.$done`，并 `await Promise.race([自有 Promise, setTimeout])`。上游 `request.bundle.js` 在 Egern 分支结束时会调用 `$done(...)`；一旦这个原生完成回调被顶掉，引擎就等不到结束信号，真机上表现为
`📺 BiliBili.Redirect.CDN.upgcxcode.m4s` **执行超时**，而原版（直接用上游脚本 + 静态 `url_rewrites`）不会。

现在：

1. **不覆盖 `$done`**、不包 Promise、不设定时器、不重写 `$request`/`$persistentStore`，上游 bundle 逐字执行并调用原生 `$done`，结束路径与原版一致；
2. 唯一新增动作：把 Toggle 解析成 `$argument` 字符串后交给上游（全程 try/catch，失败即用原生 `$argument`）；
3. 没有把静态 `url_rewrites` 搬进脚本；主机改写由上游 bundle 自己的逻辑完成。

## 验证限度

- 已做：YAML 解析与字段检查、生成器自校验、`node test.mjs`（Node 模拟 `$request`/`$done`/`$persistentStore`/`Egern` 全局）确认六组开关生效、`$done` 按时调用、失败路径不挂起。
- **未做**：真机 Egern 运行验证。若真机仍报超时，把订阅换成上游原版（无开关）即可立即恢复：
  `https://github.com/Biliverse/Redirect/releases/latest/download/BiliBili.Redirect.yaml`

## 影响

模块包含上游 `mitm.hostnames`，启用后会对列出的哔哩哔哩主机做 HTTPS 解密，请确认已安装并信任证书。
