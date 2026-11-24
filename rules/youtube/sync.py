#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 YouTube 增强（Egern 原生 YAML）—— rules/youtube/sync.py

每次运行都**自动跟随上游 main 的最新提交**（不再有手改的 PIN）：

  1. 先用 GitHub REST API（无认证）解析两个上游仓库 main 的 HEAD：
       GET https://api.github.com/repos/IBL3ND/module/commits/main
       GET https://api.github.com/repos/IBL3ND/js/commits/main
     环境里若有 GITHUB_TOKEN / GH_TOKEN，仅作为 `Authorization` 头提升速率限制，
     其值从不打印、不写盘。
  2. 同一个 run 内**每个仓库只锁定一个 commit SHA**，四个文件都从
       https://raw.githubusercontent.com/<repo>/<resolved_sha>/<path>
     读取，因此生成物不会出现「YAML 来自 A 提交、脚本来自 B 提交」的版本混合。
  3. 每个文件读取后计算 sha256，连同 repo / commit / path / bytes 写入可审计的
     `SOURCE.lock`（外加生成物自身的 sha256 与派生计数）。上游一变，lock 就变，
     因此每日 cron 的提交是可复核的「从 X 到 Y」的变更。
  4. 只做文本转换，**绝不执行**下载回来的 JS；静态扫描拒绝新增外联主机与危险 API。

任一环节失败（API / 下载 / YAML 结构 / schema / 静态扫描 / 自检断言）→ 非零退出，
且**不写任何文件**，上一版生成物原样保留。

用法：
  python3 rules/youtube/sync.py            # 解析上游 main → 重新生成（无变化则不写）
  python3 rules/youtube/sync.py --check    # 只校验不写盘（CI 与本地验收用）
  python3 rules/youtube/sync.py --rev IBL3ND/js=<40位sha> --rev IBL3ND/module=<40位sha>
                                           # 手工锁定某次 run 的 SHA（离线复现 / 排障）
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = "https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/youtube"
HUB = "https://github.com/a13609y/egern-modules-hub"
API = "https://api.github.com"
UA = "egern-modules-hub-sync/2.0"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")

# key -> (仓库, 路径)。路径相对仓库根；脚本路径与上游 Egern-YouTube.yaml 的 script_url 同名。
SOURCES = {
    "module": ("IBL3ND/module", "Egern-YouTube.yaml"),
    "request": ("IBL3ND/js", "youtube-request.js"),
    "response": ("IBL3ND/js", "youtube-response.js"),
    "dual_subs": ("IBL3ND/js", "YT-CC-ASR-Auto.js"),
}
# 只允许从这两个仓库取源；出现别的仓库必须人工改白名单（防止被上游改成任意地址）
ALLOWED_REPOS = {"IBL3ND/module", "IBL3ND/js"}
BRANCH = "main"
MAX_BYTES = 4 * 1024 * 1024

# key, 默认, UI 名称, 说明（顺序即菜单顺序）
TOGGLES = [
    ("blockUpload", True, "隐藏「上传」入口", "隐藏导航栏中的「上传」入口"),
    ("blockShorts", True, "隐藏「Shorts」入口", "隐藏导航栏中的「Shorts」入口"),
    ("autoHd", True, "自动最高画质", "优先使用最高可用画质，并阻止自动降低画质"),
    ("blockGames", True, "隐藏小游戏推荐", "隐藏 YouTube Playables（小游戏）推荐"),
    ("blockVerticalLive", True, "隐藏竖屏直播推荐", "隐藏各界面中的竖屏直播推荐"),
    ("jumpAhead", True, "启用 Jump Ahead", "启用原生「Jump Ahead」跳转按钮，并去除其推广提示"),
    ("blockStore", True, "隐藏商店和购物板块", "隐藏视频下方和频道主页中的创作者商店、购物板块"),
    ("nativeDownload", True, "原生下载（实验性）", "实验性原生下载；未设置画质时使用 720p，服务器限制仍可能生效"),
]
TOGGLE_KEYS = [t[0] for t in TOGGLES]
BUNDLE = {"youtube-request.js": ("request", "youtube-request.js"),
          "youtube-response.js": ("response", "youtube-response.js"),
          "YT-CC-ASR-Auto.js": ("dual_subs", "youtube-dual-subs.js")}
BUNDLE_SRC = {v[0]: v[1] for v in BUNDLE.values()}
# 上游允许的外联主机（字幕翻译是唯一的出站请求）；出现新主机即人工复核
ALLOWED_HOSTS = {"translate.googleapis.com"}

TOP_ALLOWED = {"name", "description", "author", "homepage", "icon", "open_url",
               "env_schema", "rules", "url_rewrites", "scriptings", "mitm"}

LOCK_NAME = "SOURCE.lock"


# ── 网络（只读、无凭据要求） ──────────────────────────────────────────────
def _headers(api: bool) -> dict:
    h = {"User-Agent": UA}
    if api:
        h["Accept"] = "application/vnd.github+json"
        tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
        if tok:
            h["Authorization"] = "Bearer " + tok  # 仅提升速率，不打印
    return h


def fetch(url: str, api: bool = False) -> str:
    req = urllib.request.Request(url, headers=_headers(api))
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"[FAIL] {url} → HTTP {e.code}（不写文件，保留上一版）")
    except Exception as e:  # 网络错误/DNS/超时
        raise SystemExit(f"[FAIL] {url} → {type(e).__name__}: {e}（不写文件，保留上一版）")
    if len(raw) > MAX_BYTES:
        raise SystemExit(f"[FAIL] {url} 大小超过 {MAX_BYTES} 字节，拒绝处理")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise SystemExit(f"[FAIL] {url} 不是合法 UTF-8，拒绝处理")


def resolve_heads(overrides: dict) -> tuple[dict, dict]:
    """解析每个上游仓库 main 的 HEAD；返回 ({repo: sha}, {repo: 审计信息})。"""
    shas, meta = {}, {}
    for repo in sorted({v[0] for v in SOURCES.values()}):
        if repo not in ALLOWED_REPOS:
            raise SystemExit(f"[FAIL] 未登记的上游仓库 {repo}，需人工复核")
        if repo in overrides:
            sha = overrides[repo]
            info = {"branch": BRANCH, "commit": sha, "resolved_by": "cli:--rev",
                    "committed_at": None}
        else:
            url = f"{API}/repos/{repo}/commits/{BRANCH}"
            data = json.loads(fetch(url, api=True))
            sha = str(data.get("sha") or "").lower()
            if not SHA_RE.fullmatch(sha):
                raise SystemExit(f"[FAIL] {repo} main 的 SHA 异常: {sha!r}")
            committed = ((data.get("commit") or {}).get("committer") or {}).get("date")
            info = {"branch": BRANCH, "commit": sha,
                    "resolved_by": f"api:repos/{repo}/commits/{BRANCH}",
                    "committed_at": committed}
        if not SHA_RE.fullmatch(sha):
            raise SystemExit(f"[FAIL] {repo} 的 commit 不是 40 位小写 hex: {sha!r}")
        shas[repo] = sha
        meta[repo] = info
    return shas, meta


def fetch_source(key: str, shas: dict) -> str:
    """按本 run 锁定的 SHA 读取上游文件（内容只做哈希/文本处理，绝不执行）。"""
    repo, path = SOURCES[key]
    url = f"https://raw.githubusercontent.com/{repo}/{shas[repo]}/{path}"
    text = fetch(url)
    if not text.strip():
        raise SystemExit(f"[FAIL] {repo}/{path} 内容为空，保留上一版")
    return text


# ── 转换 ────────────────────────────────────────────────────────────────
def convert_rewrites(entries: list) -> list:
    """上游统一 rewrites（redirect/respond）→ 官方文档化的 url_rewrites。"""
    out = []
    for i, e in enumerate(entries):
        acts = e.get("actions") or []
        if len(acts) != 1:
            raise SystemExit(f"[FAIL] rewrites[{i}] 动作数不是 1，无法确定性转换")
        a = acts[0]
        if "redirect" in a:
            r = a["redirect"]
            if r.get("status") not in (301, 302, 307, 308):
                raise SystemExit(f"[FAIL] rewrites[{i}] redirect status 异常: {r.get('status')}")
            out.append({"match": e["match"], "location": r["location"], "status_code": r["status"]})
        elif "respond" in a:
            r = a["respond"]
            if "body" in r:
                raise SystemExit(f"[FAIL] rewrites[{i}] respond 带 body，无法用 url_rewrites 表达")
            hdrs = r.get("headers") or {}
            if hdrs:
                if list(hdrs) != ["Location"] or r.get("status") not in (301, 302, 307, 308):
                    raise SystemExit(f"[FAIL] rewrites[{i}] respond 头/状态异常: {r}")
                out.append({"match": e["match"], "location": hdrs["Location"],
                            "status_code": r["status"]})
            else:
                if r.get("status") != 200:
                    raise SystemExit(f"[FAIL] rewrites[{i}] 空体 respond 非 200: {r.get('status')}")
                out.append({"match": e["match"], "location": "http://reject-200/"})
        else:
            raise SystemExit(f"[FAIL] rewrites[{i}] 未知动作: {succinct(a)}")
    return out


def succinct(a: object) -> str:
    return json.dumps(a, ensure_ascii=False)[:120]


def prelude(kind: str, commit: str) -> str:
    toggles = ",".join(f"{k}: {'true' if d else 'false'}" for k, d, _, _ in TOGGLES)
    return f'''/*! YouTube 增强 · Egern 原生开关桥（由 rules/youtube/sync.py 生成，勿手改）
 *  内容上游：IBL3ND/js @ {commit}（原始来源 Maasea/sgmodule, Apache-2.0）
 *  作用：把 env_schema 的 Toggle 读成 ctx.env → $argument JSON；上游代码自下一行起逐字节原样。
 *  本 run 锁定的 repo/commit/sha256 见 rules/youtube/SOURCE.lock（上游一变即自动变更）。
 */
export default async function (ctx) {{
  var __ytEnv = (ctx && ctx.env) || {{}};
  var __ytDef = {{{toggles}}};
  var __ytArg = {{}};
  for (var __k in __ytDef) {{
    var __v = __ytEnv[__k];
    var __off = (__v === undefined || __v === null || String(__v).trim() === "");
    __ytArg[__k] = __off ? __ytDef[__k]
      : !/^(false|0|off|no)$/i.test(String(__v).trim().replace(/^\\\\?/, ""));
  }}
  try {{ globalThis.$argument = JSON.stringify(__ytArg); }} catch (e) {{}}
'''


def bundled_body(body: str) -> str:
    """上游文件带行尾空白，CI 的 `git diff --check` 会判失败；这里只做格式化（无语义改动）。"""
    return "\n".join(line.rstrip() for line in body.splitlines()) + "\n"


def bundle(kind: str, body: str, shas: dict) -> str:
    head = prelude(kind, shas[SOURCES[kind][0]])
    return f"{head}{bundled_body(body)}}}\n"  # 闭合 export default


def scan_js(name: str, text: str) -> None:
    if re.search(r"\beval\s*\(", text) or "new Function(" in text or "XMLHttpRequest" in text:
        raise SystemExit(f"[FAIL] {name} 含动态执行/自建请求 API，拒绝发布")
    hosts = {m.group(1).split("/")[0] for m in re.finditer(r"https?://([^\s\"'`)]+)", text)}
    extra = hosts - ALLOWED_HOSTS
    if extra:
        raise SystemExit(f"[FAIL] {name} 出现未登记外联主机 {sorted(extra)}，需人工复核后加入 ALLOWED_HOSTS")


def build(module_yaml: str, js: dict, shas: dict) -> tuple[str, dict, dict, int]:
    try:
        data = yaml.safe_load(module_yaml)
    except yaml.YAMLError as e:
        raise SystemExit(f"[FAIL] 上游 YAML 无法解析: {e}")
    if not isinstance(data, dict):
        raise SystemExit("[FAIL] 上游 YAML 顶层不是映射")
    for k in ("name", "description", "scriptings", "mitm", "rewrites", "rules"):
        if not data.get(k):
            raise SystemExit(f"[FAIL] 上游缺少 {k}，保留上一版")
    if "compat_arguments" not in data:
        raise SystemExit("[FAIL] 上游已无 compat_arguments，结构变化需人工核对")

    rewrites = convert_rewrites(data["rewrites"])
    n_rw = len(rewrites)
    scripts, seen_js = [], set()
    for s in data["scriptings"]:
        if len(s) != 1:
            raise SystemExit(f"[FAIL] scriptings 条目异常: {s}")
        kind, cfg = next(iter(s.items()))
        src = os.path.basename(cfg["script_url"].split("?")[0])
        if src not in BUNDLE:
            raise SystemExit(f"[FAIL] 未登记的上游脚本 {src}，需人工复核")
        pkey, outfile = BUNDLE[src]
        env_old = cfg.get("env") or {}
        if set(env_old) - {"_compat.$argument"}:
            raise SystemExit(f"[FAIL] 脚本 {cfg['name']} 出现未处理的环境变量 {sorted(env_old)}")
        cfg = {k: v for k, v in cfg.items() if k != "env"}
        cfg["script_url"] = f"{RAW}/{outfile}"
        cfg["env"] = {k: ("true" if d else "false") for k, d, _, _ in TOGGLES}
        scripts.append({kind: cfg})
        seen_js.add(pkey)
    if seen_js != {v[0] for v in BUNDLE.values()}:
        raise SystemExit("[FAIL] 上游脚本清单与本仓库登记的三份不一致，需人工核对")

    out = {
        "name": "📺 YouTube: ✨ 增强",
        "description": ("YouTube 去广告、后台播放、画中画、最高画质与原生下载。\n"
                        "8 个开关是本仓库生成的 Egern 原生 env_schema（不再是 compat_arguments 占位符）。\n"
                        "上游：IBL3ND/module@%s · IBL3ND/js@%s · 原始来源 Maasea（Apache-2.0）→ gholts。"
                        % (shas["IBL3ND/module"][:8], shas["IBL3ND/js"][:8])),
        "author": "Maasea, gholts, IBL3ND（Egern 原生化与整合：a13609y/egern-modules-hub）",
        "homepage": HUB + "/tree/main/rules/youtube",
        "icon": "play.rectangle.fill",
        "open_url": HUB + "/tree/main/rules/youtube",
        "env_schema": {k: {"name": n, "description": d, "options": ["true", "false"]}
                       for k, _default, n, d in TOGGLES},
        "rules": data["rules"],
        "url_rewrites": rewrites,
        "scriptings": scripts,
        "mitm": data["mitm"],
    }
    for k in out:
        if k not in TOP_ALLOWED:
            raise SystemExit(f"[FAIL] 生成物出现未登记顶层字段 {k}")

    text = ("# 自动生成：python3 rules/youtube/sync.py；上游按本 run 解析到的最新 main 提交取快照\n"
            "#   IBL3ND/module @ {m}（{m8}）\n"
            "#   IBL3ND/js     @ {j}（{j8}）\n"
            "# 精确锁定的 repo/commit/path/sha256 见同目录 {lock}（每次上游一变就自动变更）。\n"
            "# 请勿手改本文件；改生成逻辑请改 sync.py，每日 GitHub Actions 会重新解析上游 main 并覆盖本文件。\n"
            "# 许可：Apache-2.0（Maasea/sgmodule 链条），见同目录 LICENSE / NOTICE。\n"
            "# 上游统一 rewrites 的 {n} 条已逐条转成官方文档化的 url_rewrites（reject-200 / 重定向）。\n"
            .format(m=shas["IBL3ND/module"], m8=shas["IBL3ND/module"][:8],
                    j=shas["IBL3ND/js"], j8=shas["IBL3ND/js"][:8],
                    lock=LOCK_NAME, n=n_rw)
            + yaml.safe_dump(out, allow_unicode=True, sort_keys=False, width=10000))

    bundles = {BUNDLE_SRC[pkey]: bundle(pkey, js[pkey], shas)
               for pkey in ("request", "response", "dual_subs")}
    return text, bundles, out, n_rw


def verify(text: str, bundles: dict, out: dict, js: dict, n_rw: int) -> None:
    d = yaml.safe_load(text)
    assert set(d["env_schema"]) == set(TOGGLE_KEYS), "env_schema 与开关表不一致"
    assert "compat_arguments" not in d and "rewrites" not in d, "仍有兼容字段残留"
    assert len(d["scriptings"]) >= 8, "脚本条目少于上游"
    for s in d["scriptings"]:
        cfg = next(iter(s.values()))
        assert cfg["script_url"].startswith(RAW + "/"), "script_url 未指向本仓库"
        assert set(cfg["env"]) == set(TOGGLE_KEYS), f"{cfg['name']} env 不完整"
        assert "{{{" not in json.dumps(cfg), f"{cfg['name']} 残留占位符"
    for name, b in bundles.items():
        assert "_compat" not in b, f"{name} 残留兼容字段"
        assert "export default async function" in b and "$argument" in b, f"{name} 前缀异常"
        # 上游正文逐字节保留（只允许行尾空白被裁掉）
        pkey = next(k for k, v in BUNDLE.items() if v[1] == name)
        assert bundled_body(js[BUNDLE[pkey][0]]) in b, f"{name} 未逐字节保留上游正文"
        scan_js(name, b)
    hosts = d["mitm"]["hostnames"]
    inc = hosts["includes"] if isinstance(hosts, dict) else hosts
    for must in ("youtubei.googleapis.com", "www.youtube.com", "*.googlevideo.com"):
        assert must in inc, f"mitm 缺少 {must}"
    assert len(d["url_rewrites"]) == n_rw, "url_rewrites 条数与上游 rewrites 不一致"


def main() -> None:
    check = "--check" in sys.argv
    argv = sys.argv[1:]
    overrides = {}
    for i, a in enumerate(argv):
        if a == "--rev":
            if i + 1 >= len(argv):
                raise SystemExit("[FAIL] --rev 需要 REPO=SHA")
            repo, _, sha = argv[i + 1].partition("=")
            sha = sha.strip().lower()
            if repo not in ALLOWED_REPOS or not SHA_RE.fullmatch(sha):
                raise SystemExit(f"[FAIL] --rev 参数非法: {argv[i + 1]!r}")
            overrides[repo] = sha

    shas, meta = resolve_heads(overrides)

    up, records = {}, {}
    for key in SOURCES:
        text = fetch_source(key, shas)
        up[key] = text
        records[key] = {"repo": SOURCES[key][0], "path": SOURCES[key][1],
                        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                        "bytes": len(text.encode("utf-8"))}

    text, bundles, out, n_rw = build(up["module"], up, shas)
    verify(text, bundles, out, up, n_rw)

    files = {"youtube.yaml": text, **bundles}
    outputs = {n: {"sha256": hashlib.sha256(b.encode("utf-8")).hexdigest(),
                   "bytes": len(b.encode("utf-8"))} for n, b in files.items()}

    lock = {
        "schema": "egern-modules-hub/source-lock/v1",
        "module": "rules/youtube",
        "generated_by": "rules/youtube/sync.py",
        "upstream": {
            repo: {"branch": meta[repo]["branch"], "commit": shas[repo],
                   "resolved_by": meta[repo]["resolved_by"],
                   "committed_at": meta[repo].get("committed_at"),
                   "files": [{"path": v["path"], "bytes": v["bytes"], "sha256": v["sha256"]}
                             for k, v in sorted(records.items()) if v["repo"] == repo]}
            for repo in sorted(shas)
        },
        "derived": {"toggles": len(TOGGLE_KEYS), "url_rewrites": n_rw,
                    "scriptings": len(out["scriptings"])},
        "outputs": dict(sorted(outputs.items())),
    }
    files[LOCK_NAME] = json.dumps(lock, ensure_ascii=False, indent=2) + "\n"

    changed = []
    for name, body in files.items():
        path = os.path.join(HERE, name)
        old = open(path, encoding="utf-8").read() if os.path.exists(path) else None
        if old != body:
            changed.append(name)
            if not check:
                open(path, "w", encoding="utf-8").write(body)
    if not check and changed and LOCK_NAME not in changed:
        raise SystemExit("[FAIL] 生成物有变化但 SOURCE.lock 未变，锁文件逻辑异常")

    print(json.dumps({"upstream": {r: s[:8] for r, s in shas.items()},
                      "upstream_full": shas, "toggles": len(TOGGLE_KEYS),
                      "url_rewrites": n_rw, "scriptings": len(out["scriptings"]),
                      "bundles": sorted(bundles), "changed": sorted(changed),
                      "check": check}, ensure_ascii=False))


if __name__ == "__main__":
    main()