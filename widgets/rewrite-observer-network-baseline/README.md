# Rewrite Observer Network Baseline

> **状态：网络基线，不是 unified `rewrites` 验证。** 本目录**不包含**任何未经官方 schema 或样例核实的顶层 `rewrites` 语法，也不声称请求已经穿过 Egern 的 rewrite 阶段。只有取得目标版本的真实 schema/最小样例并在设备上观察到断言后，才可以进行端到端验证。

面向 Egern 2.21.0 (786) 的小组件网络基线：generic 脚本使用 `ctx.http.get()` 请求一个可配置 HTTPS 地址，并显示 HTTP 状态、耗时、主机名和 widget family。它用于确认脚本与网络请求的基本链路，而非证明 URL/头/Body 或未来 unified rewrites 的执行。

## 订阅地址

```text
https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/widgets/rewrite-observer-network-baseline/rewrite-observer-network-baseline.yaml
```

## 文件

- `rewrite-observer-network-baseline.yaml`：模块清单，仅声明 `rewrite-observer` 小组件；没有猜测的 rewrite 规则。
- `rewrite-observer-network-baseline.js`：导入为名称严格为 `egern-rewrite-observer` 的 **generic** 脚本。

## 导入与使用

1. 在 Egern 的**工具 → 脚本 → +**中新建 **generic** 脚本，名称设为 `egern-rewrite-observer`，粘贴 `rewrite-observer-network-baseline.js` 内容并保存。
2. 在 Egern 的**工具 → 模块 → +**粘贴上方订阅地址并保存。
3. 在**分析 → 小组件画廊**添加 `rewrite-observer`；再在 iOS 主屏幕添加 Egern 小组件并选择它。
4. 可在模块环境变量中将 `PROBE_URL` 改为自己的 HTTPS 测试端点；默认值为 Apple 的 success 页面。

## 观测边界（重要）

- 小组件单次 GET 显示的 HTTP 状态、耗时和主机名只是**网络基线**。
- 公开文档没有说明 generic 脚本的 `ctx.http.get()` 是否经过 URL/头/Body/未来 unified rewrites；本脚本和显示均**不作该断言**。
- 点击小组件会由 Safari 打开同一 URL；Safari 流量是否经过 Egern 还取决于设备网络/VPN 状态，不能由本模块证明。
- 本模块尚未在 Egern 2.21.0 (786) 真机完成小组件运行验证；没有以浏览器结果或静态检查冒充设备验证。

## 统一重写端到端验证所需的官方依据

在添加任何 `rewrites` 字段之前，至少需要该目标版本的官方：(1) 顶层或模块字段定义；(2) 一条 request/response 最小 YAML；(3) URL 匹配、执行顺序和 MITM 要求；(4) 可观察断言，例如响应头 `X-Rewrite-Probe: 1` 或固定响应体。之后必须在真机上同时观察断言与小组件状态，才可标记为设备端到端验证。

## 公开文档

- https://egernapp.com/zh-CN/docs/configuration/modules
- https://egernapp.com/zh-CN/docs/configuration/example
- https://egernapp.com/zh-CN/docs/configuration/widgets
- https://egernapp.com/zh-CN/docs/javascript-api
