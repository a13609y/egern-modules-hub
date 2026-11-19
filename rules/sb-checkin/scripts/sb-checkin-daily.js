// sb.sb（烧饼论坛）每日签到（schedule）
// 依据静态证据实现的表单接口：
//   GET  https://sb.sb/checkin/                 -> 200 text/html，需登录 Cookie
//   POST https://sb.sb/checkin/                 -> application/x-www-form-urlencoded
//        字段：_csrf（hidden，取自 GET 页面 .signin-form 内的 name="_csrf"）
//              message（可选，<=100 字）
//              cap-token（页面上的 Cap.js 人机验证成功后才由前端注入）
// 安全默认：ALLOW_POST 未设为 true 时只做只读预检，绝不产生签到副作用。
// 判定原则：只有页面出现明确成功文案才算成功；302/303 等重定向一律视为「结果待网页确认」，
//           绝不把重定向当成功。检测到明确的 Cap.js 人机验证标记时立即停止并提醒人工签到，
//           不做任何绕过。

const BASE = "https://sb.sb";
const URL_CHECKIN = BASE + "/checkin/";
const KEY_COOKIE = "sb_checkin.cookie";
const KEY_DONE = "sb_checkin.last_done"; // 最后一次确认成功的本地日期 YYYY-MM-DD
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

// 页面里明确的人机验证标记（Cap.js）
const CAP_RE = /cap-token|data-signin-cap|Cap\.js|cap\.js|人机验证/i;

function todayKey() {
  const d = new Date();
  const p = (n) => (n < 10 ? "0" + n : String(n));
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function notify(ctx, title, body) {
  try {
    ctx.notify({ title: title, body: body, sound: false });
  } catch (e) {
    /* 通知不可用时静默 */
  }
}

// 从签到页 HTML 的 .signin-form 中取出 _csrf；找不到返回 null
function extractCsrf(html) {
  const i = html.indexOf("signin-form");
  if (i < 0) return null;
  const end = html.indexOf("</form>", i);
  const seg = end > i ? html.slice(i, end) : html.slice(i, i + 4000);
  const m = seg.match(/name="_csrf"\s+value="([^"]+)"/);
  return m ? m[1] : null;
}

export default async function (ctx) {
  const env = ctx.env || {};
  const allowPost = String(env.ALLOW_POST || "false").toLowerCase() === "true";
  const message = String(env.MESSAGE || "").slice(0, 100);
  const done = todayKey();

  let cookie = String(env.COOKIE || "").trim();
  if (!cookie) {
    try {
      cookie = ctx.storage.get(KEY_COOKIE) || "";
    } catch (e) {
      cookie = "";
    }
  }
  if (!cookie) {
    notify(
      ctx,
      "sb.sb 签到：缺少 Cookie",
      "请在 Egern 开启 MITM 后，用浏览器打开 https://sb.sb/checkin/（已登录状态）以采集 Cookie"
    );
    return;
  }

  // 幂等：同日已确认成功则不再提交
  let lastDone = "";
  try {
    lastDone = ctx.storage.get(KEY_DONE) || "";
  } catch (e) {
    lastDone = "";
  }
  if (lastDone === done) return;

  const headers = {
    Cookie: cookie,
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "zh-Hans-CN,zh;q=0.9",
  };

  // 1) 只读预检：GET 签到页，确认登录态与 CSRF
  let html = "";
  let status = 0;
  try {
    const resp = await ctx.http.get(URL_CHECKIN, {
      headers: headers,
      timeout: 20000,
      redirect: "follow",
    });
    status = resp.status;
    html = await resp.text();
  } catch (e) {
    notify(ctx, "sb.sb 签到：请求失败", "GET /checkin/ 网络错误，稍后重试");
    return;
  }

  if (status === 401 || status === 403) {
    notify(ctx, "sb.sb 签到：Cookie 失效", "请在 Egern MITM 下重新访问 https://sb.sb/checkin/ 并登录");
    return;
  }
  if (status !== 200) {
    notify(ctx, "sb.sb 签到：异常状态", "GET /checkin/ 返回 " + status);
    return;
  }
  const loggedIn = /nav-user-logout|logout/i.test(html);
  if (!loggedIn) {
    notify(ctx, "sb.sb 签到：未登录", "采集到的 Cookie 不含有效登录态，请重新在 Egern MITM 下访问 sb.sb 并登录");
    return;
  }

  const csrf = extractCsrf(html);
  if (!csrf) {
    // 表单不存在通常表示今日已签到（页面切换为已签到视图），保守起见不提交
    notify(ctx, "sb.sb 签到：未找到签到表单", "可能今日已签到，或页面结构变化；未提交，请网页确认");
    return;
  }

  // 2) 人机验证阻断：页面存在明确 Cap.js 标记时停止，不提交、不绕过
  if (CAP_RE.test(html)) {
    try {
      ctx.storage.set("sb_checkin.cap_blocked", done);
    } catch (e) {}
    notify(
      ctx,
      "sb.sb 签到：需人工签到（Cap.js 人机验证）",
      allowPost
        ? "签到页存在 Cap.js 人机验证标记，已停止自动提交，请手动打开 https://sb.sb/checkin/ 签到"
        : "签到页存在 Cap.js 人机验证标记，自动提交不可行，请手动打开 https://sb.sb/checkin/ 签到"
    );
    return;
  }

  if (!allowPost) {
    // 只读模式：不产生任何副作用，仅记录预检通过
    try {
      ctx.storage.set("sb_checkin.preflight", done + " ok");
    } catch (e) {}
    return;
  }

  // 3) 提交签到表单（仅在未检测到人机验证标记时才会走到这里）
  let body = "_csrf=" + encodeURIComponent(csrf);
  if (message) body += "&message=" + encodeURIComponent(message);

  let postStatus = 0;
  let postText = "";
  try {
    const resp = await ctx.http.post(URL_CHECKIN, {
      headers: {
        Cookie: cookie,
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml",
        Origin: BASE,
        Referer: URL_CHECKIN,
      },
      body: body,
      timeout: 30000,
      redirect: "manual", // 不跟随重定向：重定向不等于签到成功
    });
    postStatus = resp.status;
    try {
      postText = await resp.text();
    } catch (e) {
      postText = "";
    }
  } catch (e) {
    notify(ctx, "sb.sb 签到：提交失败", "POST /checkin/ 网络错误");
    return;
  }

  // 4) 判定结果：只认明确成功文案，重定向/其他一律保守报告
  if (CAP_RE.test(postText)) {
    notify(ctx, "sb.sb 签到：被人机验证拦截", "站点要求 Cap.js 验证，已停止，请人工在网页签到");
    return;
  }

  const successText = /签到成功|签到已完成|已签到|明天再来/.test(postText);
  if (postStatus === 200 && successText) {
    try {
      ctx.storage.set(KEY_DONE, done);
    } catch (e) {}
    notify(ctx, "sb.sb 签到成功", done + (message ? "（含留言）" : ""));
    return;
  }

  // 重定向（301/302/303/307/308）不再视为成功
  const isRedirect = postStatus >= 300 && postStatus < 400;
  notify(
    ctx,
    "sb.sb 签到：结果待网页确认",
    (isRedirect ? "POST 返回重定向 " + postStatus + "（不代表签到成功）" : "POST 返回 " + postStatus) +
      "；未记录为成功，请打开 https://sb.sb/checkin/ 确认"
  );
}
