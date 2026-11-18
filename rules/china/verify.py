#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
中国规则集静态验收（独立于 sync.py，只读产物）
================================================

用法：
    python3 rules/china/verify.py                 # 默认校验 rules/china/china.yaml + china.txt
    python3 rules/china/verify.py <yaml> <txt>

检查项（全部为「不通过就非零退出」的硬断言）：
  1. YAML 可解析、顶层键只允许官方 rule_set 字段、no_resolve: true 出现在顶层且为 bool；
     集合内不允许出现 per-item 的 no_resolve（Egern 只认顶层）。
  2. IPv4 → ip_cidr_set，IPv6 → ip_cidr6_set，互不串门；每段都能被 ipaddress 解析；无过宽段。
  3. 每个 IP 段在文本版里都带 no-resolve（逐行）。
  4. 格式：无大写/无通配前缀/无空白/无重复；域名标签合法；后缀排序。
  5. 覆盖度锚点（qq.com / baidu.com / bilibili.com / taobao.com / cn）存在；
     国外大站不在集合内；裸 TLD 只允许 cn。
  6. 头部注释里的条数与实际一致（防止手改产物后忘记重生成）。
"""

import ipaddress
import re
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
YAML_P = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "china.yaml"
TXT_P = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "china.txt"

# 官方文档 https://egernapp.com/zh-CN/docs/configuration/rules/ 列出的 rule_set 字段
ALLOWED_KEYS = {
    "no_resolve", "domain_set", "domain_keyword_set", "domain_suffix_set",
    "domain_regex_set", "domain_wildcard_set", "geoip_set", "ip_cidr_set",
    "ip_cidr6_set", "url_regex_set", "asn_set", "user_agent_set", "ssid_set",
    "bssid_set", "cellular_set", "protocol_set", "dest_port_set",
    "and_set", "or_set", "not_set",
}
LABEL = re.compile(r"^[a-z0-9_](?:[a-z0-9_\-]{0,61}[a-z0-9_])?$")

ANCHORS = ("qq.com", "baidu.com", "bilibili.com", "taobao.com", "alipay.com", "cn")
FOREIGN_MUST_NOT = (
    "google.com", "youtube.com", "github.com", "gitlab.com", "openai.com",
    "facebook.com", "instagram.com", "twitter.com", "x.com", "netflix.com",
    "telegram.org", "wikipedia.org", "spotify.com", "reddit.com", "whatsapp.com",
    "cloudflare.com", "amazonaws.com", "googlevideo.com",
)

errs, notes = [], []


def check(cond, msg):
    if not cond:
        errs.append(msg)


def domain_ok(d):
    if not isinstance(d, str) or not d or d != d.strip() or d != d.lower():
        return False
    if any(c in d for c in " *+_'\"\t"):
        return False
    if len(d) > 253:
        return False
    return all(LABEL.match(lbl) for lbl in d.split("."))


def main():
    raw = YAML_P.read_text(encoding="utf-8")
    doc = yaml.safe_load(raw)
    check(isinstance(doc, dict), "YAML 顶层不是映射")

    unknown = set(doc) - ALLOWED_KEYS
    check(not unknown, f"出现官方 schema 之外的键：{sorted(unknown)}")

    # 1. no_resolve：顶层、布尔 true
    check("no_resolve" in doc, "缺少顶层 no_resolve")
    check(doc.get("no_resolve") is True, f"no_resolve 不是布尔 true：{doc.get('no_resolve')!r}")

    suffix = doc.get("domain_suffix_set") or []
    exact = doc.get("domain_set") or []
    keyword = doc.get("domain_keyword_set") or []
    regex = doc.get("domain_regex_set") or []
    v4 = doc.get("ip_cidr_set") or []
    v6 = doc.get("ip_cidr6_set") or []

    for name, coll in (("domain_suffix_set", suffix), ("domain_set", exact),
                       ("ip_cidr_set", v4), ("ip_cidr6_set", v6)):
        check(isinstance(coll, list), f"{name} 不是列表")
        # 集合内的元素必须是字符串，不能是 {value: ..., no_resolve: ...} 这种结构
        bad = [x for x in coll if not isinstance(x, str)]
        check(not bad, f"{name} 内部出现了非字符串条目（no_resolve 只能写在顶层）：{bad[:2]}")

    # 2/3. IP 段
    for s in v4:
        try:
            net = ipaddress.ip_network(s, strict=True)
            check(net.version == 4, f"ip_cidr_set 里有 IPv6：{s}")
            check(net.prefixlen >= 8, f"ip_cidr_set 有过宽段：{s}")
        except ValueError as exc:
            errs.append(f"ip_cidr_set 非法：{s}（{exc}）")
    for s in v6:
        try:
            net = ipaddress.ip_network(s, strict=True)
            check(net.version == 6, f"ip_cidr6_set 里有 IPv4：{s}")
            check(net.prefixlen >= 16, f"ip_cidr6_set 有过宽段：{s}")
        except ValueError as exc:
            errs.append(f"ip_cidr6_set 非法：{s}（{exc}）")

    # 4. 域名格式
    for name, coll in (("domain_suffix_set", suffix), ("domain_set", exact)):
        bad = [d for d in coll if not domain_ok(d)]
        check(not bad, f"{name} 有非法条目：{bad[:5]}")
        check(len(coll) == len(set(coll)), f"{name} 有重复")
        if name == "domain_suffix_set":
            check(coll == sorted(coll), f"{name} 未排序（会影响生成幂等）")
    for r in regex:
        try:
            re.compile(r)
        except re.error as exc:
            errs.append(f"domain_regex_set 正则不合法：{r}（{exc}）")

    # 裸 TLD
    bare = [d for d in list(suffix) + list(exact) if "." not in d]
    check(set(bare) <= {"cn"}, f"出现了未授权的裸 TLD：{sorted(set(bare) - {'cn'})}")

    # 5. 覆盖度锚点 / 国外泄漏
    joined = set(suffix) | set(exact)

    def covered(d):
        return any(d == e or d.endswith("." + e) for e in joined)

    missing = [a for a in ANCHORS if not covered(a)]
    check(not missing, f"缺少覆盖度锚点：{missing}")
    leaked = [d for d in FOREIGN_MUST_NOT if d in joined]
    check(not leaked, f"国外域名泄漏：{leaked}")

    # 6. 文本版：每个 IP 行都带 no-resolve
    txt = TXT_P.read_text(encoding="utf-8")
    lines = [ln.strip() for ln in txt.splitlines()]
    body = [ln for ln in lines if ln and not ln.startswith("#")]
    t_suf = [ln for ln in body if ln.startswith("DOMAIN-SUFFIX,")]
    t_dom = [ln for ln in body if ln.startswith("DOMAIN,")]
    t_ip4 = [ln for ln in body if ln.startswith("IP-CIDR,")]
    t_ip6 = [ln for ln in body if ln.startswith("IP-CIDR6,")]
    check(len(t_suf) == len(suffix), f"文本后缀行 {len(t_suf)} ≠ YAML {len(suffix)}")
    check(len(t_dom) == len(exact), f"文本精确行 {len(t_dom)} ≠ YAML {len(exact)}")
    check(len(t_ip4) == len(v4), f"文本 IPv4 行 {len(t_ip4)} ≠ YAML {len(v4)}")
    check(len(t_ip6) == len(v6), f"文本 IPv6 行 {len(t_ip6)} ≠ YAML {len(v6)}")
    miss4 = [ln for ln in t_ip4 if not ln.endswith(",no-resolve")]
    miss6 = [ln for ln in t_ip6 if not ln.endswith(",no-resolve")]
    check(not miss4, f"{len(miss4)} 条 IPv4 文本行缺 no-resolve，例：{miss4[:2]}")
    check(not miss6, f"{len(miss6)} 条 IPv6 文本行缺 no-resolve，例：{miss6[:2]}")
    check(len(body) == len(set(body)), "文本版有重复行")

    # 6'. 头部注释条数与实际一致
    m = re.search(r"# 后缀 (\d+) / 精确 (\d+) / 关键词 (\d+) / 正则 (\d+)", raw)
    check(bool(m), "YAML 头部注释缺条数行（产物被手改过？）")
    if m:
        got = tuple(int(x) for x in m.groups())
        exp = (len(suffix), len(exact), len(keyword), len(regex))
        check(got == exp, f"头部注释条数 {got} ≠ 实际 {exp}")
    m4 = re.search(r"# IPv4 (\d+) 段 / IPv6 (\d+) 段", raw)
    if m4:
        check(tuple(int(x) for x in m4.groups()) == (len(v4), len(v6)),
              f"头部 IPv4/IPv6 条数不符：{m4.groups()} vs {(len(v4), len(v6))}")

    v4_total = sum(ipaddress.ip_network(s).num_addresses for s in v4)
    notes.append(f"IPv4 {len(v4)} 段 = {v4_total} 个地址（占 ::/0 的 {v4_total / 2 ** 32:.2%}）")
    notes.append(f"IPv6 {len(v6)} 段（占地址空间的 {sum(ipaddress.ip_network(s).num_addresses for s in v6) / 2 ** 128:.3%}）")
    notes.append(f"域名：后缀 {len(suffix)} / 精确 {len(exact)} / 关键词 {len(keyword)} / 正则 {len(regex)}")
    notes.append(f"规则集顶层键：{sorted(doc)}")

    print("—— 统计 ——")
    for n in notes:
        print("  " + n)
    if errs:
        print(f"\n[FAIL] {len(errs)} 项不通过：")
        for e in errs:
            print("  - " + e)
        return 1
    print("\n[OK] schema / 样本 / 每个 IP no_resolve / 格式 / 幂等排序 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
