#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 YouTube 增强（Egern 原生 YAML）—— rules/youtube/sync.py

上游（全部按 commit SHA 固定，raw 路径不可变）：
  · 模块骨架  IBL3ND/module @ a185a5f38f0c3acaa107ce1f05304fd3204edc2a : Egern-YouTube.yaml
  · 请求脚本  IBL3ND/js     @ 9d93c69aa5eba5ced74524dc7e928fa7fb98378b : youtube-request.js
  · 响应脚本  IBL3ND/js     @ 23866dcb42822eb4b266f48b4903298514396be2 : youtube-response.js
  · 字幕脚本  IBL3ND/js     @ ab98a8752875488c50b9522f19c817d6882ed35a : YT-CC-ASR-Auto.js
内容来源链（证据见 README / NOTICE）：Maasea/sgmodule（Apache-2.0）→ gholts/surge
（youtube-enhance.sgmodule 自述 "Based on Maasea's code (Apache-2.0)"）→ IBL3ND 打包。

原生化改造（本脚本做的全部转换）：
  1. `compat_arguments` / `compat_arguments_schema` / `env._compat.$argument` 全部去掉；
     8 个开关改成 Egern 原生 `env_schema`（Toggle），脚本内由生成的前缀把 ctx.env
     转成上游读取的 `$argument` JSON（上游代码逐字节原样保留）。
  2. 统一 `rewrites` → 官方文档化的 `url_rewrites`：redirect → location+status_code；
     respond 200 空体 → `http://reject-200/`；respond 302 + Location → location+status_code。
  3. `屏蔽选段按钮` 是上游死开关（未传给任何脚本，脚本里也不读）→ 删除并在 README 标注。

确定性 / 安全：
  · 只读 raw.githubusercontent，按 commit SHA + sha256 双固定；哈希不符即失败。
  · 只做文本转换，**不执行**下载回来的 JS；静态扫描拒绝新增外联/危险 API。
  · 任一校验失败 → 不写任何文件、非零退出，保留上一版生成物。

用法： python3 rules/youtube/sync.py [--check]
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import urllib.request

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = "https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/youtube"
HUB = "https://github.com/a13609y/egern-modules-hub"

PIN = {
    "module": ("IBL3ND/module", "a185a5f38f0c3acaa107ce1f05304fd3204edc2a",
               "Egern-YouTube.yaml",
               "8faa25c71f728cb9883eb465a2600da65581dfd03ed628fe8dd8608cb66fa2d1"),
    "request": ("IBL3ND/js", "9d93c69aa5eba5ced74524dc7e928fa7fb98378b",
                "youtube-request.js",
                "ab292484d12fa3169ed696b0fe1aac2aeeba33668565b2376c57b45f667c7d5e"),
    "response": ("IBL3ND/js", "23866dcb42822eb4b266f48b4903298514396be2",
                 "youtube-response.js",
                 "de3063780539333e1caf2c462496cee07851cdf669a0d2773d0c1da2a77355d1"),
    "dual_subs": ("IBL3ND/js", "ab98a8752875488c50b9522f19c817d6882ed35a",
                  "YT-CC-ASR-Auto.js",
                  "48072040d392b2f160106b93c0b15642e8c782cc63f1ecf8fbe5c3b5c966a488"),
}

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
# 上游允许的外联主机（字幕翻译是唯一的出站请求）；出现新主机即人工复核
ALLOWED_HOSTS = {"translate.googleapis.com"}

TOP_ALLOWED = {"name", "description", "author", "homepage", "icon", "open_url",
               "env_schema", "rules", "url_rewrites", "scriptings", "mitm"}


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "egern-modules-hub-sync/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


def fetch_pinned(key: str) -> str:
    repo, commit, path, digest = PIN[key]
    url = f"https://raw.githubusercontent.com/{repo}/{commit}/{path}"
    text = fetch(url)
    got = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if got != digest:
        raise SystemExit(f"[FAIL] {repo}/{path} sha256 不符（期望 {digest} 实得 {got}），保留上一版")
    return text


def convert_rewrites(entries: list) -> list:
    """统一 rewrites（上游 14 条 redirect/respond）→ 文档化 url_rewrites。"""
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


def bundle(kind: str, body: str) -> str:
    repo, commit, path, digest = PIN[kind]
    head = prelude(kind, commit)
    return f"{head}{body}\n}}\n"  # 闭合 export default


def scan_js(name: str, text: str) -> None:
    if re.search(r"\beval\s*\(", text) or "new Function(" in text or "XMLHttpRequest" in text:
        raise SystemExit(f"[FAIL] {name} 含动态执行/自建请求 API，拒绝发布")
    hosts = {m.group(1).split("/")[0] for m in re.finditer(r"https?://([^\s\"'`)]+)", text)}
    extra = hosts - ALLOWED_HOSTS
    if extra:
        raise SystemExit(f"[FAIL] {name} 出现未登记外联主机 {sorted(extra)}，需人工复核后加入 ALLOWED_HOSTS")


def build(module_yaml: str, js: dict) -> tuple[str, dict, dict]:
    data = yaml.safe_load(module_yaml)
    for k in ("name", "description", "scriptings", "mitm", "rewrites", "rules"):
        if not data.get(k):
            raise SystemExit(f"[FAIL] 上游缺少 {k}，保留上一版")
    if "compat_arguments" not in data:
        raise SystemExit("[FAIL] 上游已无 compat_arguments，结构变化需人工核对")

    rewrites = convert_rewrites(data["rewrites"])
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

    out = {
        "name": "📺 YouTube: ✨ 增强",
        "description": ("YouTube 去广告、后台播放、画中画、最高画质与原生下载。\n"
                        "8 个开关是本仓库生成的 Egern 原生 env_schema（不再是 compat_arguments 占位符）。\n"
                        "上游：IBL3ND/module@%s · IBL3ND/js 脚本 · 原始来源 Maasea（Apache-2.0）→ gholts。"
                        % PIN["module"][1][:8]),
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

    text = ("# 自动生成：python3 rules/youtube/sync.py（上游 IBL3ND/module@%s）。\n"
            "# 请勿手改；改生成逻辑请改 sync.py，每日 GitHub Actions 会重新生成覆盖本文件。\n"
            "# 许可：Apache-2.0（Maasea/sgmodule 链条），见同目录 LICENSE / NOTICE。\n"
            "# 未使用统一 rewrites：上游 14 条已逐条转成官方文档化的 url_rewrites（reject-200 / 重定向）。\n"
            % PIN["module"][1][:8]) + yaml.safe_dump(out, allow_unicode=True, sort_keys=False,
                                                      width=10000)

    bundles = {}
    for pkey in ("request", "response", "dual_subs"):
        bundles[BUNDLE_SRC[pkey]] = bundle(pkey, js[pkey])
    return text, bundles, out


BUNDLE_SRC = {v[0]: v[1] for v in BUNDLE.values()}


def verify(text: str, bundles: dict, out: dict, js: dict) -> None:
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
        scan_js(name, b)
    hosts = d["mitm"]["hostnames"]
    inc = hosts["includes"] if isinstance(hosts, dict) else hosts
    for must in ("youtubei.googleapis.com", "www.youtube.com", "*.googlevideo.com"):
        assert must in inc, f"mitm 缺少 {must}"
    assert len(d["url_rewrites"]) == PIN_REWRITES[0], "url_rewrites 条数与上游 rewrites 不一致"


PIN_REWRITES = [0]


def main() -> None:
    check = "--check" in sys.argv
    up = {k: fetch_pinned(k) for k in PIN}
    PIN_REWRITES[0] = len(yaml.safe_load(up["module"])["rewrites"])
    text, bundles, out = build(up["module"], up)
    verify(text, bundles, out, up)

    changed = []
    files = {"youtube.yaml": text, **bundles}
    for name, body in files.items():
        path = os.path.join(HERE, name)
        old = open(path, encoding="utf-8").read() if os.path.exists(path) else None
        if old != body:
            changed.append(name)
            if not check:
                open(path, "w", encoding="utf-8").write(body)
    print(json.dumps({"upstream": {k: v[1][:8] for k, v in PIN.items()},
                      "toggles": len(TOGGLE_KEYS), "url_rewrites": len(out["url_rewrites"]),
                      "scriptings": len(out["scriptings"]), "bundles": sorted(bundles),
                      "changed": changed, "check": check}, ensure_ascii=False))


if __name__ == "__main__":
    main()
