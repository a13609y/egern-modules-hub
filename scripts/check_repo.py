#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全仓静态校验（贡献改动的最小门禁）
==================================

用法：
    python3 scripts/check_repo.py            # 校验当前工作区
    python3 scripts/check_repo.py --quiet    # 只打印失败

检查项（任一不通过即非零退出）：
  1. YAML 可解析：部分模块用 {{{ARG}}} 占位，Egern 先替换后解析，
     所以解析前把占位替换成无害裸标记（不改类型语义，只校验结构）。
  2. 模块目录约定：rules/*、rulesets/*、widgets/* 一级目录必须有 README.md、
     至少一个 .yaml，且 YAML 文件名等于目录名或「目录名-xxx.yaml」。
  3. 模块元数据：模块类 YAML 必须有 name / description；规则集类 YAML 必须带
     Egern 官方 rule_set 字段之一；顶层键必须都是已知字段（防拼错）。
  4. Markdown 相对链接可解析（跳过 http(s)/锚点/代码块内内容）。
  5. 根 README「目录结构」代码块里列出的目录必须真实存在。
  6. 指向本仓库的 raw.githubusercontent / github blob|tree 链接，其路径必须存在。
  7. 统一 `rewrites` 守卫：顶层出现 `rewrites` 时，文件头必须有
     `# egern-rewrites: verified <版本>` 标记，否则视为未核实 schema，判失败；
     同时与 url_rewrites/header_rewrites/body_rewrites 混写只告警（兼容分支）。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QUIET = "--quiet" in sys.argv

# 默认自仓库坐标，git 里拿不到时兜底
DEFAULT_SLUG = "a13609y/egern-modules-hub"

TEMPLATE = re.compile(r"\{\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}\}")

# 元数据 + 模块配置 + rule_set 字段（Egern 官方文档）
META_KEYS = {
    "name", "description", "author", "homepage", "manual", "icon", "open_url",
    "compat_arguments", "compat_arguments_desc", "compat_arguments_schema",
    "env_schema",
}
MODULE_KEYS = {
    "dns", "rules", "url_rewrites", "header_rewrites", "body_rewrites",
    "map_locals", "scriptings", "mitm", "http_captures", "widgets",
    "bypass_tunnel_proxy", "real_ip_domains",
}
RULESET_KEYS = {
    "no_resolve", "domain_set", "domain_keyword_set", "domain_suffix_set",
    "domain_regex_set", "domain_wildcard_set", "geoip_set", "ip_cidr_set",
    "ip_cidr6_set", "url_regex_set", "asn_set", "user_agent_set", "ssid_set",
    "bssid_set", "cellular_set", "protocol_set", "dest_port_set",
    "and_set", "or_set", "not_set",
}
ALLOWED_KEYS = META_KEYS | MODULE_KEYS | RULESET_KEYS | {"rewrites"}
MODULE_DIRS = ("rules", "rulesets", "widgets")

errors: list[str] = []
warns: list[str] = []


def out(msg: str) -> None:
    if not QUIET:
        print(msg)


def err(msg: str) -> None:
    errors.append(msg)
    print("  [FAIL] " + msg)


def warn(msg: str) -> None:
    warns.append(msg)
    print("  [WARN] " + msg)


def ok(msg: str) -> None:
    out("  [ok] " + msg)


def rel(p: Path) -> str:
    try:
        return str(p.relative_to(ROOT))
    except ValueError:
        return str(p)


def tracked_files() -> list[Path]:
    try:
        res = subprocess.run(["git", "ls-files", "--cached", "--others",
                              "--exclude-standard"], cwd=ROOT, capture_output=True,
                             text=True, check=True)
        files = [ROOT / line for line in res.stdout.splitlines() if line]
        return [p for p in files if p.is_file()]
    except Exception:
        files = []
        for base, dirs, names in os.walk(ROOT):
            dirs[:] = [d for d in dirs if d != ".git"]
            files += [Path(base) / n for n in names]
        return files


def self_slug() -> str:
    try:
        url = subprocess.run(["git", "config", "--get", "remote.origin.url"],
                             cwd=ROOT, capture_output=True, text=True).stdout.strip()
        m = re.search(r"github\.com[:/]+([^/]+)/([^/]+?)(?:\.git)?$", url)
        if m:
            return f"{m.group(1)}/{m.group(2)}"
    except Exception:
        pass
    return DEFAULT_SLUG


# ── 1/3. YAML ────────────────────────────────────────────────────────────────
def check_yaml(files: list[Path]) -> None:
    import yaml

    yamls = [p for p in files if p.suffix in (".yaml", ".yml")]
    ok(f"{len(yamls)} 个 YAML")
    substituted = []
    for p in yamls:
        text = p.read_text(encoding="utf-8")
        names = TEMPLATE.findall(text)
        if names:
            substituted.append(rel(p))
            text = TEMPLATE.sub(lambda m: "__EGERN_ARG_" + m.group(1) + "__", text)
        try:
            data = yaml.safe_load(text)
        except Exception as e:  # noqa: BLE001
            first = str(e).splitlines()[0]
            err(f"{rel(p)} YAML 解析失败：{first}")
            continue
        if not isinstance(data, dict):
            err(f"{rel(p)} 顶层不是映射（实际 {type(data).__name__}）")
            continue

        keys = {str(k) for k in data}
        inside_module = any(rel(p).startswith(d + "/") for d in MODULE_DIRS)
        if not inside_module:
            # .github/workflows 等：只要求可解析（工作流里 `on:` 会被解析成布尔键）
            continue
        unknown = sorted(keys - ALLOWED_KEYS)
        if unknown:
            err(f"{rel(p)} 未知顶层字段 {unknown}（拼错或 Schema 外字段）")

        is_ruleset = bool(keys & RULESET_KEYS) and not (keys & MODULE_KEYS - {"no_resolve"})
        if is_ruleset:
            if not keys & RULESET_KEYS:
                err(f"{rel(p)} 规则集缺少 rule_set 字段")
        else:
            for k in ("name", "description"):
                v = data.get(k)
                if not isinstance(v, str) or not v.strip():
                    err(f"{rel(p)} 模块元数据缺少 {k}")

        # 7. 统一 rewrites 守卫
        if "rewrites" in data:
            if not re.search(r"^#\s*egern-rewrites:\s*verified\s+\S+", text, re.M):
                err(f"{rel(p)} 用了统一 rewrites，但文件头没有 "
                    f"'# egern-rewrites: verified <版本>' 标记（schema 未核实）")
            legacy = keys & {"url_rewrites", "header_rewrites", "body_rewrites"}
            if legacy:
                warn(f"{rel(p)} 统一 rewrites 与原生 {sorted(legacy)} 混写，需人工确认兼容分支")

    if substituted:
        out("  [info] 解析前做了 {{...}} 占位替换（Egern 运行时行为）："
            + ", ".join(substituted))


# ── 2. 模块目录约定 ──────────────────────────────────────────────────────────
def check_layout() -> None:
    for parent in MODULE_DIRS:
        base = ROOT / parent
        if not base.is_dir():
            continue
        for d in sorted(p for p in base.iterdir() if p.is_dir()):
            name = d.name
            if not (d / "README.md").is_file():
                err(f"{rel(d)}/ 缺少 README.md")
            yamls = sorted(d.glob("*.yaml")) + sorted(d.glob("*.yml"))
            if not yamls:
                err(f"{rel(d)}/ 没有 YAML 模块文件")
                continue
            for y in yamls:
                if y.stem != name and not y.stem.startswith(name + "-"):
                    err(f"{rel(y)} 文件名既不是 {name}.yaml 也不以 {name}- 开头")
    ok("模块目录约定（README + 同名 YAML）")


# ── 4. Markdown 相对链接 ─────────────────────────────────────────────────────
FENCE = re.compile(r"^(```|~~~).*?^\1[^\n]*$", re.M | re.S)
LINK = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")


def strip_fences(text: str) -> str:
    return FENCE.sub(lambda m: "\n" * m.group(0).count("\n"), text)


def check_md_links(files: list[Path]) -> None:
    mds = [p for p in files if p.suffix == ".md"]
    n = 0
    for p in mds:
        text = strip_fences(p.read_text(encoding="utf-8"))
        for target in LINK.findall(text):
            t = target.strip()
            if t.startswith(("http://", "https://", "mailto:", "#", "minis://", "tel:")):
                continue
            path = t.split("#", 1)[0].split("?", 1)[0]
            if not path:
                continue
            n += 1
            if not (p.parent / path).exists():
                err(f"{rel(p)} 链接指向不存在的路径：{target}")
    ok(f"{len(mds)} 个 Markdown，{n} 条相对链接")


# ── 5. 根 README 目录结构 ────────────────────────────────────────────────────
TREE_LINE = re.compile(r"^[\s│├└─┬┼|`\-]*([A-Za-z0-9_.\-]+/)")


def check_readme_tree() -> None:
    readme = ROOT / "README.md"
    if not readme.is_file():
        err("缺少根 README.md")
        return
    text = readme.read_text(encoding="utf-8")
    m = re.search(r"^##\s*目录结构\s*$(.*?)(?=^##\s|\Z)", text, re.M | re.S)
    if not m:
        warn("根 README 没有「## 目录结构」小节，跳过目录树校验")
        return
    block = re.search(r"```[^\n]*\n(.*?)```", m.group(1), re.S)
    if not block:
        warn("根 README「目录结构」里没有代码块，跳过")
        return
    checked = 0
    stack: list[tuple[int, Path]] = []
    for line in block.group(1).splitlines():
        hit = TREE_LINE.match(line)
        if not hit:
            continue
        token = hit.group(1)
        if token.rstrip("/") in ("...", "…"):
            continue
        col = hit.start(1)
        while stack and stack[-1][0] >= col:
            stack.pop()
        base = stack[-1][1] if stack else ROOT
        path = base / token
        while stack and stack[-1][0] >= col:
            stack.pop()
        stack.append((col, path))
        checked += 1
        if not path.exists():
            err(f"根 README 目录结构列了不存在的条目：{rel(base) if base != ROOT else ''}{token}")
    ok(f"根 README 目录结构 {checked} 个条目")


# ── 6. 指向本仓库的 URL ──────────────────────────────────────────────────────
SLUG = re.escape(self_slug())
SELF_URL = re.compile(
    r"https://(?:raw\.githubusercontent\.com/" + SLUG + r"/"
    r"|github\.com/" + SLUG + r"/(?:blob|tree)/)"
    r"(?:refs/heads/)?([A-Za-z0-9_.\-]+)/([^\s\"'`)\]<>]+)"
)
TEXT_EXT = {".md", ".yaml", ".yml", ".py", ".js", ".mjs", ".sh", ".html", ".json"}


def check_self_urls(files: list[Path]) -> None:
    n = 0
    for p in files:
        if p.suffix not in TEXT_EXT:
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        for ref, path in SELF_URL.findall(text):
            path = path.split("?")[0].split("#")[0].rstrip(".,;:")
            if not path:
                continue
            n += 1
            if not (ROOT / path).exists():
                err(f"{rel(p)} 引用了仓库内不存在的路径：{path}（ref={ref}）")
    ok(f"仓库内自引用 URL {n} 条")


def main() -> int:
    files = tracked_files()
    print(f"仓库根：{ROOT}（{len(files)} 个受版本控制文件，自仓库 {self_slug()}）")
    print("== 1/3 YAML 与元数据")
    check_yaml(files)
    print("== 2 模块目录约定")
    check_layout()
    print("== 4 Markdown 链接")
    check_md_links(files)
    print("== 5 根 README 目录结构")
    check_readme_tree()
    print("== 6 仓库内自引用")
    check_self_urls(files)
    print(f"\n结果：{len(errors)} 个错误，{len(warns)} 个告警")
    if errors:
        for e in errors[:20]:
            print(" - " + e)
        return 1
    print("[PASS] check_repo 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
