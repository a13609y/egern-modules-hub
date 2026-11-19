# sb.sb 每日签到 Egern 模块

一键导入（Egern 订阅本 YAML）：

```
https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/sb-checkin/sb-checkin.yaml
```

默认 **只做只读预检**（`GET /checkin/`），不产生签到副作用；是否真正提交由 `ALLOW_POST` 控制。

## 接口证据（只读探测，未提交签到）

| 项 | 值 | 证据 |
|---|---|---|
| 签到页 | `GET https://sb.sb/checkin/` → `200 text/html` | 页面标题「每日签到 - 烧饼论坛」 |
| 签到提交 | `POST https://sb.sb/checkin/`，`application/x-www-form-urlencoded`，`data-no-ajax="1"` 纯表单 | 页面内 `<form method="post" action="/checkin/" class="signin-form">` |
| 必需字段 | `_csrf`（hidden，值随会话变化，需从 GET 页面实时解析） | `<input type="hidden" name="_csrf" value="…">` |
| 可选字段 | `message`（文字，`maxlength=100`） | `<input class="signin-message" name="message" maxlength="100">` |
| 条件字段 | `cap-token`（hidden，由前端在 Cap.js 验证通过后注入） | app.js 中 `input[name="cap-token"]` 注入逻辑 + `[data-signin-cap]` 弹层 |
| 认证 | 仅登录 Cookie（无 Bearer/API Key）；站点非 Flarum JSON API，`/api/*` 全部返回 404 | `GET /api/checkin` → 404 |
| 已签判定 | 页面 `.signin-form` 存在=今日未签到；缺失则视为已签到/结构变化，脚本不提交 | 签到页 HTML |

## 关键行为

1. **Cookie 采集只匹配签到页**：`http_request` 的 `match` 限定为 `^https://sb\.sb/checkin`，脚本内再校验一次 pathname，非 `/checkin` 请求一律原样放行、不采集。
   → 所以需要你用**已登录**的浏览器打开一次 `https://sb.sb/checkin/`（Egern MITM 开启且证书已信任）。
2. **不修改流量**：脚本只读 `Cookie` 请求头，不读 body、不改请求/响应，不加规则、不改路由。
3. **不打印凭证**：脚本从不打印/通知 Cookie 值；storage 内只存 Cookie 串与时间戳，失败分支不清理已有 Cookie（避免误伤）。
4. **幂等**：只有「确认成功」才会写入本地日期 `sb_checkin.last_done`，同日不再提交。
5. **定时**：`cron: "0 8 * * *"`（每天 08:00，iOS 后台调度尽力而为，可能延后或跳过）。

## 判定原则：重定向不等于成功

- POST 使用 `redirect: "manual"`，**不跟随重定向**。
- 只有 `200` 且响应正文出现明确成功文案（`签到成功` / `签到已完成` / `已签到` / `明天再来`）才记为成功并写入 `last_done`。
- `301/302/303/307/308` 或其他状态一律**不记成功**，通知「结果待网页确认」，请自行打开 `https://sb.sb/checkin/` 核对。
- GET 预检阶段若看不到 `.signin-form`（通常意味今日已签或用已签视图），直接不提交，同样只提示网页确认。

## Cap.js 人机验证阻塞（不做绕过）

签到页存在明确的人机验证标记（`cap-token` / `data-signin-cap` / `Cap.js` / `人机验证`）：

- `ALLOW_POST=false`（默认）：只读预检照常通过后，**检测到标记即停止**，通知「需人工签到（Cap.js 人机验证）」。
- `ALLOW_POST=true`：同样检测到标记即停止，**不会发起 POST**，通知里附带手工签到地址。
- POST 响应中若出现上述标记（被拦截），立即停止并提示人工签到。
- 本站 `cap-token` 由前端 Cap.js 验证通过后注入，无头请求无法通过；模块**不实现任何绕过**，遇到即让人工签到。

## 如何启用提交（需自行确认站点没有强制人机验证）

1. Egern → 模块 → 添加/订阅上面的 YAML。
2. 开启 MITM 并信任证书 → 用已登录浏览器打开 `https://sb.sb/checkin/` 采集 Cookie。
   （也可在模块设置里手动填 `COOKIE`，优先级高于采集值；**不要**把 Cookie 写进文件、聊天或仓库。）
3. 先保持 `ALLOW_POST=false`，手动跑一次定时任务或等 08:00，确认通知里没有「缺少 Cookie / 未登录」。
4. 若想尝试自动提交：把 `ALLOW_POST` 改成 `true`。此时脚本仍会先检查人机验证标记；只有页面**没有**明确 Cap.js 标记时才会真正 POST，且结果按上面的判定原则保守处理。
5. 只要通知是「需人工签到」或「结果待网页确认」，就请手动到 `https://sb.sb/checkin/` 签到 —— 这正是当前站点的实际状态：**自动化签到被 Cap.js 阻塞**。

## 未做的验证

- 未在真机 Egern 运行；YAML/JS 仅做静态语法校验。
- 按任务约束**未提交真实签到 POST**，因此服务端对 `cap-token` 的强制程度、成功文案均为依据页面静态证据的推断。
- 签到成功路径只能靠网页确认，模块不会把重定向/未知响应当作成功。
