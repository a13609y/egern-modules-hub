#!/usr/bin/env python3
"""跟随可莉 Pinterest 上游，生成 Egern 原生 response_jq 模块。

上游的 Surge/Loon 规则本身就是 jq：本同步器只提取其 HTTPS 路径白名单和
`.data |= map(select(...))` 过滤器，直接写入 Egern 的 response_jq；不生成、修改或
删除既有 pinterest.js，确保旧订阅仍可继续取用该文件。
"""
import re
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCES = [
    ("surge", "https://raw.githubusercontent.com/axtyet/Luminous/main/Repcz/Surge/Module/Kelee/Pinterest_remove_ads.sgmodule"),
    ("surge", "https://raw.githubusercontent.com/ifflagged/Romeo/main/Modules/Surge/Kelee/Pinterest_remove_ads.sgmodule"),
    ("surge", "https://raw.githubusercontent.com/bunizao/Mirrored/main/Chores/sgmodule/Pinterest_remove_ads.sgmodule"),
    ("loon", "https://raw.githubusercontent.com/ifflagged/Romeo/main/Modules/Loon/Kelee/Pinterest_remove_ads.lpx"),
    ("loon", "https://raw.githubusercontent.com/fkingikelee/fkikelee/main/lpx/Pinterest_remove_ads.lpx"),
]
SURGE_JQ = re.compile(r"^http-response-jq\s+(\S+)\s+'([^']*)'\s*$")
LOON_JQ = re.compile(r'response\s+if\s+\$\{url\}\s*~=\s*/(.+?)/[a-z]*\s+then\s+response\.json\.jq\("([^"]*)"\)')
EXPECTED = [
    r"^https://api\.pinterest\.com/v\d+/feeds/home/\?",
    r"^https://api\.pinterest\.com/v\d+/pins/\d+/related/modules/\?",
]
FILTER = '.data |= map(select(.is_promoted == false or .is_promoted == "false"))'


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "egern-modules-hub-sync"})
    with urllib.request.urlopen(req, timeout=25) as response:
        return response.read().decode("utf-8", "replace")


def parse(text):
    paths, filters = [], []
    for line in text.splitlines():
        s = line.strip()
        match = SURGE_JQ.match(s) or LOON_JQ.search(s)
        if match:
            paths.append(match.group(1))
            filters.append(match.group(2))
    return paths, filters


def native_match(upstream):
    """将上游 HTTPS regex 规范为 Egern response_jq 的完整 URL regex。"""
    p = upstream.replace(r"\/", "/")
    # 上游用 v\d 表示版本；原生模块沿用已发布模块的 v\d+ 规范，覆盖多位 API 版本而不改变路径族。
    p = p.replace(r"/v\d/", r"/v\d+/")
    if not p.startswith("^https://"):
        raise AssertionError(f"上游不是 HTTPS 完整 URL 白名单: {upstream}")
    return p


def build_yaml(paths, filters):
    if paths != EXPECTED:
        raise AssertionError(f"上游路径白名单变化，拒绝扩大/缩小范围: {paths}")
    if any(f != FILTER for f in filters):
        raise AssertionError(f"上游 jq 过滤器变化，拒绝猜测语义: {filters}")
    rewrites = "\n".join(
        "  - response_jq:\n      match: '" + path + "'\n      filter: '" + FILTER.replace("'", "''") + "'"
        for path in paths
    )
    return f'''name: Pinterest 去广告（原生）
description: 仅移除首页流和相关内容接口 data 数组中不满足上游 is_promoted=false/"false" 条件的条目。
author: 可莉
homepage: https://github.com/a13609y/egern-modules-hub/tree/main/rules/pinterest
icon: https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rules/pinterest/icon.png

rules:
  - domain:
      match: ads.pinterest.com
      policy: REJECT
  - domain:
      match: ad.pinterest.com
      policy: REJECT
  - domain:
      match: ct.pinterest.com
      policy: REJECT
  - domain:
      match: trk.pinterest.com
      policy: REJECT

mitm:
  hostnames:
    - api.pinterest.com

body_rewrites:
{rewrites}
'''


def main():
    last_error = None
    for _kind, url in SOURCES:
        try:
            paths, filters = parse(fetch(url))
            # 去重保序；镜像偶尔会同时给出重复规则。
            pairs = list(dict.fromkeys(zip((native_match(p) for p in paths), filters)))
            paths, filters = map(list, zip(*pairs)) if pairs else ([], [])
            content = build_yaml(paths, filters)
        except Exception as exc:  # noqa: BLE001
            last_error = f"{url} → {exc}"
            print(f"跳过 {last_error}", file=sys.stderr)
            continue
        output = HERE / "pinterest.yaml"
        old = output.read_text(encoding="utf-8") if output.exists() else ""
        if old != content:
            output.write_text(content, encoding="utf-8")
            print(f"写入 pinterest.yaml ({len(content)} bytes)")
        else:
            print("内容一致，未改动")
        print(f"上游 {url}")
        print(f"原生 response_jq 路径 {len(paths)} 条：{paths}")
        return 0
    print(f"所有上游都失败或不兼容：{last_error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
