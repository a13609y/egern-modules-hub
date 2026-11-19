// sb.sb Cookie 采集（http_request）
// 只读：仅从请求头取 Cookie，不读/不改请求体，不返回任何修改，请求原样放行。
// 只匹配签到页请求（https://sb.sb/checkin/ 系），不采集其他页面/接口的请求。
// 只保存「更长的那份 Cookie」（登录态通常长于游客态），避免游客 Cookie 覆盖登录态。
// 绝不写入日志、不打印 Cookie 值；存储中只存 Cookie 串本身（Egern 本地 storage）。

const KEY_COOKIE = "sb_checkin.cookie";
const KEY_AT = "sb_checkin.cookie_at";

export default async function (ctx) {
  try {
    const req = ctx.request;
    if (!req || !req.headers) return; // pass-through

    // 双保险：yaml 的 match 已限定签到页，这里再校验一次路径，非 /checkin 一律放行不采集。
    let path = "";
    try {
      path = req.url ? new URL(req.url).pathname : "";
    } catch (e) {
      path = "";
    }
    if (path && !path.startsWith("/checkin")) return; // pass-through
    let cookie = "";
    try {
      cookie = req.headers.get("cookie") || "";
      if (!cookie && typeof req.headers.getAll === "function") {
        cookie = (req.headers.getAll("cookie") || []).join("; ");
      }
    } catch (e) {
      return;
    }
    if (!cookie || cookie.length < 20) return;

    let prev = "";
    try {
      prev = ctx.storage.get(KEY_COOKIE) || "";
    } catch (e) {
      prev = "";
    }
    if (cookie.length >= prev.length) {
      try {
        ctx.storage.set(KEY_COOKIE, cookie);
        ctx.storage.set(KEY_AT, String(Date.now()));
      } catch (e) {
        // 存储失败不影响网络请求
      }
    }
  } catch (e) {
    // 任何异常都不改变请求
  }
  return; // 不返回 request 对象 => 请求保持原样
}
