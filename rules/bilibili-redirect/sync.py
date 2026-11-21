#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「BiliBili Redirect（可同步参数开关）」Egern 模块。

上游：Biliverse/Redirect（Apache-2.0）发布的 Egern 原生模块 + request.bundle.js
产物：
  rules/bilibili-redirect/bilibili-redirect.yaml        订阅模块（路径固定不变）
  rules/bilibili-redirect/bilibili-redirect.bundle.js   生成版 bundle = env 桥接 shim + 上游 bundle 原文

设计要点（见 README）：
  1. 六组参数（Host.OverseaVideo / Host.BStar / Host.PCDN / Host.MCDN / Storage /
     LogLevel）的每个上游候选值各生成一个 env_schema Toggle（options ["true","false"]）。
  2. Egern 的 env_schema 只声明模块环境变量，文档未说明它会给 compat_arguments /
     {{{占位符}}} 做替换，因此不在 YAML 侧依赖这种替换：
        - 脚本路径：生成版 bundle 在 Egern wrapper 内读 ctx.env，算出有效值后写入
          globalThis.$argument，再交给上游 bundle 原文执行（上游自己从 $argument 取值）。
        - 静态 url_rewrites 无法在 YAML 里按 env 分支，故按 Egern 文档用 http_request
          脚本等效执行原 12 条规则的「主机类 → 目标主机」前缀替换（保持 scheme、
          path、query、端口语义），见 shim 中的 REWRITE_RULES。
  3. 每组「恰好一个 Toggle 打开」才用该值；全关 / 多开 → 沿用 compat_arguments
     （即上游默认，或用户在模块引用里覆盖的值）。

用法：
  python3 sync.py                     # 拉上游最新 release → 生成（有变化才落盘）
  python3 sync.py --check             # 只校验现有产物与上游一致（不一致 exit 1）
  python3 sync.py --tag v0.2.25 --upstream-yaml x.yaml --upstream-js x.js   # 离线复现
任何漂移校验失败一律不落盘，保留上一版产物。
"""
import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
OUT_YAML = HERE / "bilibili-redirect.yaml"
OUT_JS = HERE / "bilibili-redirect.bundle.js"

RELEASES = "https://api.github.com/repos/Biliverse/Redirect/releases/latest"
ASSET = "https://github.com/Biliverse/Redirect/releases/download/{tag}/{name}"
SELF_JS_URL = (
    "https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/"
    "rules/bilibili-redirect/bilibili-redirect.bundle.js"
)

# 六组参数；TOKEN 只用于生成 env 键名（UI 上用 name 字段显示人类可读名称）
GROUPS = [
    ("Host.OverseaVideo", "OverseaVideo", "OverseaVideo CDN（港澳台）"),
    ("Host.BStar", "BStar", "BStar CDN（国际版）"),
    ("Host.PCDN", "PCDN", "PCDN 主机名（中国大陆）"),
    ("Host.MCDN", "MCDN", "MCDN 主机名（中国大陆）"),
    ("Storage", "Storage", "配置来源"),
    ("LogLevel", "LogLevel", "日志等级"),
]
GROUP_KEYS = [g[0] for g in GROUPS]

# 原 12 条静态 url_rewrites 的「主机类」；顺序保持上游顺序。用于：
#   1) 生成 shim 内的等效前缀替换规则
#   2) 校验上游 URL 重写集合没有漂移（新增主机类会失败，避免静默丢覆盖）
REWRITE_RULES = [
    (r"upos-sz-mirror[a-z0-9-]*ov\.bilivideo\.com", "Host.OverseaVideo"),
    (r"cn-hk-eq-[a-z0-9-]+\.bilivideo\.com", "Host.OverseaVideo"),
    (r"upos-hz-mirrorakam\.akamaized\.net", "Host.OverseaVideo"),
    (r"upos-sz-mirrorakam\.akamaized\.net", "Host.OverseaVideo"),
    (r"upos-sz-mirror[a-z0-9-]*bstar1\.bilivideo\.com", "Host.BStar"),
    (r"upos-bstar1-mirrorakam\.akamaized\.net", "Host.BStar"),
]

UNSUPPORTED_LOCATIONS = ("Host.PCDN", "Host.MCDN")  # 上游 url_rewrites 里未出现


# ─────────────────────────── 工具 ───────────────────────────
def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "egern-bili-sync/2.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        data = r.read()
    if r.status != 200 or not data:
        raise RuntimeError(f"fetch failed {r.status} {url}")
    return data


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_")


def env_key(token: str, value: str) -> str:
    return f"Bili_{token}__{slug(value)}"


def q(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")


# ───────────────────── 上游解析 / 漂移校验 ─────────────────────
def parse_candidates(desc: str) -> dict:
    """从上游 compat_arguments_desc 里解析每组候选值（保持顺序、去重）。"""
    found, cur = {}, None
    head = re.compile(r"^\s{0,4}([A-Za-z][\w.]*):\s*\[")
    item = re.compile(r"^\s*[├└]\s*([^:]+):\s*")
    for line in desc.splitlines():
        m = head.match(line)
        if m:
            cur = m.group(1)
            found.setdefault(cur, [])
            continue
        m = item.match(line)
        if m and cur:
            v = m.group(1).strip()
            if v and v not in found[cur]:
                found[cur].append(v)
    return found


def host_fragment(match: str) -> str:
    s = re.sub(r"^\^https?:\\/\\/", "", match)
    s = s.split("(?:")[0]
    return re.sub(r"\\/upgcxcode\\/$", "", s)


def load_upstream(ytext: str, js: str):
    data = yaml.safe_load(ytext)
    for key in ("name", "compat_arguments", "url_rewrites", "scriptings", "mitm"):
        if not data.get(key):
            raise SystemExit(f"漂移：上游模块缺少或为空 {key}")
    args = data["compat_arguments"]
    for key in GROUP_KEYS:
        if key not in args:
            raise SystemExit(f"漂移：compat_arguments 缺少 {key}")

    cands = parse_candidates(data.get("compat_arguments_desc") or "")
    for key, token, _ in GROUPS:
        values = cands.get(key) or []
        if len(values) < 1:
            raise SystemExit(f"漂移：无法从 compat_arguments_desc 解析 {key} 的候选值")
        if key != "Host.MCDN" and len(values) < 2:
            raise SystemExit(f"漂移：{key} 候选值少于 2 个（{values}）")

    # 静态 URL 重写集合必须与 shim 的等效规则完全对应
    frags = set()
    schemes = {}
    for rw in data["url_rewrites"]:
        loc = rw.get("location", "")
        for token in UNSUPPORTED_LOCATIONS:
            if "{{{" + token + "}}}" in loc:
                raise SystemExit(f"漂移：url_rewrites 出现了未覆盖的 {token} 目标：{loc}")
        frag = host_fragment(rw["match"])
        frags.add(frag)
        schemes.setdefault(frag, set()).add("https" if rw["match"].startswith("^https") else "http")
    expected = {r for r, _ in REWRITE_RULES}
    if frags != expected:
        raise SystemExit(
            "漂移：上游 url_rewrites 主机类集合变化 —— 上游 %s / 本仓库 %s"
            % (sorted(frags), sorted(expected))
        )
    for frag, sch in schemes.items():
        if sch != {"http", "https"}:
            raise SystemExit(f"漂移：{frag} 只覆盖了 {sorted(sch)}")

    # bundle 结构锚点
    for anchor in (
        "globalThis.$argument=a.parse",
        "\U0001f6a9 执行结束",
        "$persistentStore.read",
        'case"Egern"',
    ):
        if anchor not in js:
            raise SystemExit(f"漂移：上游 bundle 缺少锚点 {anchor!r}")
    if "export default" in js or "export{" in js:
        raise SystemExit("漂移：上游 bundle 已自带 export，wrapper 需要重写")

    return data, cands


# ─────────────────────────── shim 模板 ───────────────────────────
SHIM = r"""// ─────────── env bridge (generated by sync.py — do not edit) ───────────
const __biliGroups = __GROUPS__;
const __biliFallback = __BASE__;
const __biliTruthy = function (v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "on" || s === "yes";
};
const __biliEnv = (ctx && ctx.env) || {};
const __biliParse = function (raw) {
  return String(raw || "").replace(/^\?/, "").split("&").filter(Boolean).map(function (seg) {
    const i = seg.indexOf("=");
    const k = i < 0 ? seg : seg.slice(0, i);
    const v = i < 0 ? "" : seg.slice(i + 1);
    let dk = k, dv = v;
    try { dk = decodeURIComponent(k); } catch (e) { dk = k; }
    try { dv = decodeURIComponent(v); } catch (e) { dv = v; }
    return [dk, dv.replace(/"/g, "")];
  });
};
const __biliValues = {};
__biliParse(typeof __biliEnv["_compat.$argument"] === "string" && __biliEnv["_compat.$argument"].trim()
  ? __biliEnv["_compat.$argument"] : __biliFallback).forEach(function (kv) {
  // 未被替换的上游占位符（如 "{{{Host.BStar}}}"）不可用，丢弃后回落到烘焙默认值
  if (kv[1].indexOf("{{{") >= 0 || kv[0].indexOf("{{{") >= 0) return;
  __biliValues[kv[0]] = kv[1];
});
const __biliEffective = {};
__biliGroups.forEach(function (g) {
  const on = g.toggles.filter(function (t) { return __biliTruthy(__biliEnv[t[0]]); });
  let value;
  if (on.length === 1) value = on[0][1];
  else value = __biliValues[g.argument] !== undefined ? __biliValues[g.argument] : g.fallback;
  __biliValues[g.argument] = value;
  __biliEffective[g.argument] = value;
});
const __biliArgument = Object.keys(__biliValues).map(function (k) {
  return encodeURIComponent(k) + "=" + encodeURIComponent(__biliValues[k]);
}).join("&");
const __biliTargets = Object.keys(__biliEffective).map(function (k) { return __biliEffective[k]; });
// 原 12 条静态 url_rewrites 的等效「主机类 → 目标主机」表（顺序同上游）
const __biliRewrite = __REWRITE__;

const __biliHeaderObj = function (h) {
  const o = {};
  if (!h) return o;
  if (typeof h.forEach === "function") { h.forEach(function (v, k) { o[k] = v; }); return o; }
  Object.keys(h).forEach(function (k) { o[k] = h[k]; });
  return o;
};
// 等效原 url_rewrites：仅改主机与端口，scheme/path/query 原样保留
const __biliStaticRewrite = function (url) {
  let u;
  try { u = new URL(url); } catch (e) { return url; }
  if (!u.pathname.startsWith("/upgcxcode/")) return url;
  if (__biliTargets.indexOf(u.hostname) >= 0) return url; // 已是某组选中的目标，避免二次改写
  let hit = null;
  for (let i = 0; i < __biliRewrite.length; i++) {
    if (new RegExp(__biliRewrite[i][0]).test(u.hostname)) { hit = __biliRewrite[i]; break; }
  }
  if (!hit) return url;
  const portOk = u.protocol === "http:"
    ? (u.port === "" || u.port === "80")
    : (u.port === "" || u.port === "443" || u.port === "4483");
  if (!portOk) return url;
  const target = __biliEffective[hit[1]];
  if (!target) return url;
  u.hostname = target;
  u.port = "";
  return u.toString();
};
// 供上游 bundle 使用：$argument（值来自 ctx.env）+ $request（来自 ctx.request）
globalThis.$argument = __biliArgument;
if (ctx && ctx.request) {
  const __biliInHeaders = __biliHeaderObj(ctx.request.headers);
  const __biliInUrl = ctx.request.url;
  const __biliNewUrl = __biliStaticRewrite(__biliInUrl);
  if (__biliNewUrl !== __biliInUrl) {
    // 与 Egern url_rewrites 的 header 模式一致：改 URI 时同步 Host / :authority
    let __biliNewHost = "";
    try { __biliNewHost = new URL(__biliNewUrl).hostname; } catch (e) { __biliNewHost = ""; }
    Object.keys(__biliInHeaders).forEach(function (k) {
      const lk = String(k).toLowerCase();
      if ((lk === "host" || lk === ":authority") && __biliNewHost) __biliInHeaders[k] = __biliNewHost;
    });
  }
  globalThis.$request = {
    url: __biliNewUrl,
    method: ctx.request.method || "GET",
    headers: __biliInHeaders
  };
}
if (!globalThis.$persistentStore && ctx && ctx.storage) {
  globalThis.$persistentStore = {
    read: function (k) { try { const v = ctx.storage.get(k); return v === undefined ? null : v; } catch (e) { return null; } },
    write: function (v, k) {
      try {
        if (v === null || v === undefined) ctx.storage.delete(k);
        else ctx.storage.set(k, String(v));
        return true;
      } catch (e) { return false; }
    }
  };
}

const __biliRewriteUrl = function (res) {
  if (!res || typeof res.url !== "string") return res;
  const next = __biliStaticRewrite(res.url);
  if (next === res.url) return res;
  let target = "";
  try { target = new URL(next).hostname; } catch (e) { target = ""; }
  res.url = next;
  if (res.headers && typeof res.headers === "object") {
    Object.keys(res.headers).forEach(function (k) {
      const lk = String(k).toLowerCase();
      if (lk === "host" || lk === ":authority") res.headers[k] = target;
    });
  }
  return res;
};

let __biliResolve;
const __biliPromise = new Promise(function (r) { __biliResolve = r; });
globalThis.$done = function (res) { __biliResolve(__biliRewriteUrl(res === undefined ? undefined : res)); };
// ─────────── end env bridge ───────────
"""


def build_shim(data, cands, defaults) -> str:
    groups = []
    for key, token, _ in GROUPS:
        values = cands[key]
        groups.append(
            {
                "argument": key,
                "fallback": defaults[key],
                "toggles": [[env_key(token, v), v] for v in values],
            }
        )
    rewrite = [[r"^" + frag + r"$", target] for frag, target in REWRITE_RULES]
    out = SHIM
    out = out.replace("__GROUPS__", json.dumps(groups, ensure_ascii=False))
    out = out.replace("__BASE__", json.dumps(defaults["_argstring"], ensure_ascii=False))
    out = out.replace("__REWRITE__", json.dumps(rewrite, ensure_ascii=False))
    return out


def build_bundle(js: str, tag: str, shim: str) -> str:
    header = (
        "/*! BiliBili Redirect (Egern) — generated by a13609y/egern-modules-hub\n"
        " *  This file is a derivative work of Biliverse/Redirect request.bundle.js %s,\n"
        " *  Copyright Biliverse/Redirect contributors, licensed under the Apache License 2.0.\n"
        " *  Modifications: an env_schema toggle bridge reads ctx.env, resolves the effective\n"
        " *  Host.OverseaVideo/Host.BStar/Host.PCDN/Host.MCDN/Storage/LogLevel values, sets\n"
        " *  globalThis.$argument (and $request/$persistentStore fallbacks) before running the\n"
        " *  upstream bundle verbatim, and re-applies the four upstream static url_rewrites\n"
        " *  host classes on the returned request. Upstream code below is unmodified.\n"
        " *  See NOTICE and LICENSE in this directory.\n"
        " */\n"
    )
    return (
        header
        + "export default async function (ctx) {\n"
        + shim
        + "// ===== upstream request.bundle.js "
        + tag
        + " (verbatim) =====\n"
        + js
        + "\n// ===== end upstream =====\n"
        + "// 用文档中的返回值约定交付结果（不重复调用原生 $done）\n"
        + "if (typeof setTimeout === \"function\") {\n"
        + "  return await Promise.race([__biliPromise, new Promise(function (r) {\n"
        + "    setTimeout(function () { r(undefined); }, 5000);\n"
        + "  })]);\n"
        + "}\n"
        + "return await __biliPromise;\n"
        + "}\n"
    )


# ─────────────────────────── 生成 YAML ───────────────────────────
def build_yaml(data, cands, defaults, tag) -> dict:
    schema = {}
    for key, token, label in GROUPS:
        values = cands[key]
        for i, v in enumerate(values):
            desc = f"归属 {label}（{key}）。该组内只有恰好一个开关为开时，才使用本项；全关或多开时沿用上游默认值 {defaults[key]}。"
            if len(values) == 1:
                desc = f"归属 {label}（{key}）。该组只有一个上游候选值：打开时使用 {v}，关闭时沿用上游默认值 {defaults[key]}。"
            schema[env_key(token, v)] = {
                "name": v,
                "description": desc,
                "options": ["true", "false"],
            }

    scripts = []
    for entry in data["scriptings"]:
        for kind, body in entry.items():
            item = dict(body)
            item["script_url"] = SELF_JS_URL
            # 上游的 env._compat.$argument 用的是 {{{占位符}}}；env_schema 是否参与
            # compat_arguments 替换在官方文档中没有承诺，保留这些占位符会在 UI 未设置时
            # 让脚本收到字面量。故删除它：默认值已烘焙进 bundle 的 bridge，开关值走 ctx.env。
            # 保留上游 env._compat.$argument（含 {{{占位符}}}）：
            #   - 若 Egern 对模块 env 做 compat_arguments 替换 → 旧引用/覆盖继续生效（与上游一致）
            #   - 若不做替换（文档未承诺）→ shim 检出 "{{{" 并丢弃该值，回落到烘焙的默认值
            # 因此两种运行时下行为都正确，且不需要假设 env_schema 参与占位符替换。
            scripts.append({kind: item})

    doc = {
        "name": data["name"],
        "description": (
            (data.get("description") or "").rstrip()
            + "\n可同步参数开关版：六组参数（Host.OverseaVideo / Host.BStar / Host.PCDN / "
            "Host.MCDN / Storage / LogLevel）的每个上游候选值都是独立的开关；每组恰好一个打开时"
            "按所选值生效，全关或多开时按上游默认。"
            f"\n上游版本：{tag}（由 a13609y/egern-modules-hub 每日自动生成，请勿手改本文件）"
        ),
        "compat_arguments": defaults["compat_arguments"],
        "compat_arguments_desc": (
            (data.get("compat_arguments_desc") or "").rstrip()
            + "\n\n[开关说明] 本模块在上游参数之外提供 env_schema 开关：每个候选值一个 Toggle。"
            "同一组内只认「恰好一个为开」的选项；全关或多开时回到 compat_arguments 中的默认值"
            "（Host.OverseaVideo/Host.BStar/Host.PCDN/Host.MCDN 默认 "
            f"{defaults['Host.OverseaVideo']} / {defaults['Host.BStar']} / "
            f"{defaults['Host.PCDN']} / {defaults['Host.MCDN']}，Storage 默认 {defaults['Storage']}，"
            f"LogLevel 默认 {defaults['LogLevel']}）。"
            "\n[实现] 开关值经 ctx.env 读取，由生成版脚本写入 $argument 并在请求脚本中执行原 url_rewrites 的主机替换；"
            "本模块不再使用静态 url_rewrites，MITM 范围与上游一致。"
        ),
        "env_schema": schema,
        "open_url": data.get("open_url"),
        "author": data.get("author"),
        "homepage": data.get("homepage"),
        "icon": data.get("icon"),
        "dns": data.get("dns") or {},
        "scriptings": scripts,
        "mitm": data["mitm"],
    }
    return {k: v for k, v in doc.items() if v is not None}


class _Dumper(yaml.SafeDumper):
    pass


def _str_rep(dumper, data):
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


_Dumper.add_representer(str, _str_rep)


def dump_yaml(doc: dict) -> str:
    head = (
        "# 自动生成：python3 rules/bilibili-redirect/sync.py（上游 Biliverse/Redirect）\n"
        "# 请勿手改；修改生成逻辑请改 sync.py，每日 GitHub Actions 会重新生成覆盖本文件。\n"
        "# Apache-2.0：见同目录 LICENSE / NOTICE。\n"
    )
    return head + yaml.dump(
        doc, Dumper=_Dumper, allow_unicode=True, sort_keys=False, default_flow_style=False, width=4096
    )


# ─────────────────────────── 校验 ───────────────────────────
def validate_module(ytext: str, js: str, tag: str) -> None:
    data = yaml.safe_load(ytext)
    for key in ("name", "compat_arguments", "env_schema", "scriptings", "mitm"):
        assert data.get(key), f"生成结果缺少 {key}"
    assert "url_rewrites" not in data or not data["url_rewrites"], "生成结果不应含静态 url_rewrites"

    # 开关：每组每个候选值一个 Toggle，键唯一、值域 ["true","false"]
    keys = list(data["env_schema"])
    assert len(keys) == len(set(keys)), "env_schema 键重复"
    for k, v in data["env_schema"].items():
        assert v["options"] == ["true", "false"], f"{k} 不是 Toggle"
        assert v.get("name") and v.get("description"), f"{k} 缺少 name/description"

    # 脚本：全部指向本仓库生成版 bundle，match/env 与上游一致
    urls = {s[list(s)[0]]["script_url"] for s in data["scriptings"]}
    assert urls == {SELF_JS_URL}, f"script_url 不一致: {urls}"
    for s in data["scriptings"]:
        body = s[list(s)[0]]
        arg = body.get("env", {}).get("_compat.$argument", "")
        assert arg.count("{{{") == 6, "scripting env 应保留 6 个上游占位符（作为兼容回落）"
    for k, v in data["env_schema"].items():
        assert "{{{" not in k + v["name"] + v["description"], f"env_schema 含占位符: {k}"

    # bundle：wrapper + 上游原文
    assert js.count("export default async function (ctx)") == 1
    assert "// ===== end upstream =====" in js
    for anchor in ("globalThis.$argument = __biliArgument", "__biliRewriteUrl"):
        assert anchor in js, f"bundle 缺少 {anchor}"
    assert tag in js, "bundle 头部未记录上游 tag"


# ─────────────────────────── 主流程 ───────────────────────────
def collect(tag, ytext, js):
    data, cands = load_upstream(ytext, js)
    args = data["compat_arguments"]
    defaults = {k: args[k] for k in GROUP_KEYS}
    defaults["compat_arguments"] = args
    defaults["_argstring"] = "&".join(
        f"{q(k)}={q(defaults[k])}" for k in GROUP_KEYS
    )
    shim = build_shim(data, cands, defaults)
    doc = build_yaml(data, cands, defaults, tag)
    ytext_out = dump_yaml(doc)
    js_out = build_bundle(js, tag, shim)
    validate_module(ytext_out, js_out, tag)
    return ytext_out, js_out, cands


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只比较，不落盘")
    ap.add_argument("--dry-run", action="store_true", help="打印生成的 YAML")
    ap.add_argument("--tag")
    ap.add_argument("--upstream-yaml")
    ap.add_argument("--upstream-js")
    a = ap.parse_args()

    if a.upstream_yaml and a.upstream_js:
        tag = a.tag or "v0.0.0-local"
        ytext = Path(a.upstream_yaml).read_text(encoding="utf-8")
        js = Path(a.upstream_js).read_text(encoding="utf-8")
    else:
        tag = a.tag or json.loads(fetch(RELEASES).decode())["tag_name"]
        ytext = fetch(ASSET.format(tag=tag, name="BiliBili.Redirect.yaml")).decode("utf-8")
        js = fetch(ASSET.format(tag=tag, name="request.bundle.js")).decode("utf-8")

    if "BiliBili.Redirect.yaml" not in ytext and "compat_arguments" not in ytext:
        raise SystemExit("上游 YAML 内容异常")

    ytext_out, js_out, cands = collect(tag, ytext, js)
    counts = ", ".join(f"{k}={len(cands[k])}" for k, _, _ in GROUPS)
    print(f"upstream tag={tag}; toggles: {counts}")

    if a.dry_run:
        print(ytext_out)
        return 0

    cur_y = OUT_YAML.read_text(encoding="utf-8") if OUT_YAML.exists() else ""
    cur_j = OUT_JS.read_text(encoding="utf-8") if OUT_JS.exists() else ""
    changed = (cur_y != ytext_out) or (cur_j != js_out)
    if a.check:
        if changed:
            print("CHECK FAILED: 生成产物与当前文件不一致（需重新运行 sync.py）")
            return 1
        print("CHECK OK: 产物与上游一致")
        return 0
    if not changed:
        print("无变化，未写入")
        return 0

    # 原子写：先写临时文件，再替换
    OUT_YAML.write_text(ytext_out, encoding="utf-8")
    OUT_JS.write_text(js_out, encoding="utf-8")
    print(f"WROTE {OUT_YAML.name} ({len(ytext_out.encode())} B), {OUT_JS.name} ({len(js_out.encode())} B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
