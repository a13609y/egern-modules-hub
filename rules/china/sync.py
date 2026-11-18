#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
中国规则集生成器（Egern rule_set）
=================================

产出（与本脚本同目录，文件名与目录同名）：

    china.yaml   Egern 规则集：domain_suffix_set / domain_set / domain_regex_set
                 + ip_cidr_set（IPv4）+ ip_cidr6_set（IPv6）+ no_resolve: true
    china.txt    通用文本（Surge / Clash / Loon 的 RULE-SET 行格式）

上游（均为 MIT 许可，见 README）：
    v2fly/domain-list-community  data/cn（= include:tld-cn + include:geolocation-cn，本地递归展开）
    gaoyifan/china-operator-ip   ip-lists 分支 china.txt（IPv4）/ china6.txt（IPv6）

设计要点：
  * 只 GET raw.githubusercontent.com / codeload（CDN），不调用 api.github.com、不带 token；
    一次 codeload tar 包拿全仓 data 文件，避免为几百个 include 发几百次请求。
  * 重试有限（默认 3 次，指数退避），总请求数约 3 个。
  * 先「抓取 → 解析 → 校验」全部通过，才写文件；任何一步失败都抛异常，
    磁盘上的旧产物保持原样（工作流据此不提交，订阅端继续用上一版）。
  * 输出完全确定（排序、无时间戳），同一上游重跑字节一致 → 工作流可以「无变化不提交」。
"""

import ipaddress
import os
import re
import sys
import tarfile
import io
import time
import urllib.request
from pathlib import Path

UA = "egern-modules-hub-china-sync/1.1 (+https://github.com/a13609y/egern-modules-hub)"
HERE = Path(__file__).resolve().parent
OUT_YAML = Path(os.environ.get("CHINA_OUT_YAML", HERE / "china.yaml"))
OUT_TXT = Path(os.environ.get("CHINA_OUT_TXT", HERE / "china.txt"))

# 上游地址（环境变量可覆盖，只为本地测试注入坏数据用；生产不设置）
V2FLY_TAR = os.environ.get(
    "CHINA_V2FLY_TAR",
    "https://codeload.github.com/v2fly/domain-list-community/tar.gz/refs/heads/master",
)
IPV4_URL = os.environ.get(
    "CHINA_IPV4_URL",
    "https://raw.githubusercontent.com/gaoyifan/china-operator-ip/ip-lists/china.txt",
)
IPV6_URL = os.environ.get(
    "CHINA_IPV6_URL",
    "https://raw.githubusercontent.com/gaoyifan/china-operator-ip/ip-lists/china6.txt",
)

# v2fly 的入口清单：data/cn 现在只剩两行 include，这里仍然以 cn 为准，递归展开
V2FLY_ROOTS = ("cn",)

LABEL = re.compile(r"^[a-z0-9_](?:[a-z0-9_\-]{0,61}[a-z0-9_])?$")
DOMAIN_OK = re.compile(r"^[a-z0-9.][a-z0-9.\-]{1,251}$")

# —— 安全护栏 ——
# 裸 TLD 一律视为「过宽」：出现 com/net/org 这类后缀等于让整条规则集失效（全部直连）。
BARE_TLD_ALLOW = {"cn"}          # .cn 是大陆地区 TLD，属于本规则集的正当目标
BARE_TLD_DENY = {               # 只要出现就报错（上游抽风/被投毒的第一信号）
    "com", "net", "org", "io", "co", "me", "cc", "tv", "info", "biz", "xyz",
    "top", "site", "online", "shop", "app", "dev", "cloud", "asia", "mobi",
    "pro", "vip", "club", "live", "link", "wang", "ren", "gov", "edu", "mil",
    "int", "arpa", "local", "localhost", "internal",
}
# 这些明显属于「国外、需要代理」的域名不该出现在中国规则集里（命中即失败）
FOREIGN_MUST_NOT = (
    "google.com", "youtube.com", "github.com", "gitlab.com", "openai.com",
    "facebook.com", "instagram.com", "twitter.com", "x.com", "netflix.com",
    "telegram.org", "wikipedia.org", "spotify.com", "reddit.com", "whatsapp.com",
    "cloudflare.com", "amazonaws.com", "googlevideo.com",
)
# 条数区间：低于下限说明上游残缺/改版，高于上限说明误展开了 !cn 之类的清单
LIMITS = {
    "suffix": (1500, 40000),
    "exact": (0, 3000),
    "keyword": (0, 200),
    "regex": (0, 400),
    "ipv4": (1000, 20000),
    "ipv6": (200, 40000),
}
MAX_V4_FRACTION = 0.35      # 中国 IPv4 段占全球地址空间上限（现约 0.09）
MAX_V6_FRACTION = 0.05      # IPv6 同理（现约 0.005）
V4_MIN_PREFIX = 8           # 拒绝比 /8 更宽的 IPv4 段
V6_MIN_PREFIX = 16          # 拒绝比 /16 更宽的 IPv6 段


# ---------------------------------------------------------------- 抓取

def fetch(url: str, binary: bool = False, attempts: int = 3):
    """GET + 有限重试（3 次，退避 2s/5s）。不重定向到非预期主机。"""
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
            with urllib.request.urlopen(req, timeout=60) as r:
                if getattr(r, "status", 200) not in (None, 200):
                    raise RuntimeError(f"HTTP {r.status}")
                data = r.read()
            if not data:
                raise RuntimeError("空响应")
            return data if binary else data.decode("utf-8", "replace")
        except Exception as exc:                                  # noqa: BLE001
            last = exc
            if i + 1 < attempts:
                time.sleep(2 + 3 * i)
    raise RuntimeError(f"抓取失败（已重试 {attempts} 次）：{url} → {last}")


# ---------------------------------------------------------------- 解析

def norm_domain(raw: str):
    d = raw.strip().lower()
    for p in ("+.", "*.", "*.", "."):
        if d.startswith(p):
            d = d[len(p):]
            break
    d = d.strip("'\"").rstrip(".")
    if not d or len(d) > 253 or "." not in d and d not in BARE_TLD_ALLOW:
        return None
    if not DOMAIN_OK.match(d):
        return None
    for lbl in d.split("."):
        if not LABEL.match(lbl):
            return None
    return d


class DLC:
    """本地解析 v2fly/domain-list-community 的 data 目录，递归展开 include。"""

    def __init__(self, data_dir: Path):
        self.dir = data_dir
        self.cache = {}

    def node(self, name: str):
        if name in self.cache:
            return self.cache[name]
        res = {"suffix": set(), "exact": set(), "keyword": set(), "regex": set()}
        self.cache[name] = res          # 先占位，防止循环 include
        path = self.dir / name
        if not path.exists():
            print(f"[warn] 缺少 data/{name}（上游删除或改名）", file=sys.stderr)
            return res
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            line = line.split("@", 1)[0].strip()      # 丢掉 @cn / @ads 之类属性
            if not line:
                continue
            if line.startswith("include:"):
                sub = self.node(line[len("include:"):].strip())
                for k in res:
                    res[k] |= sub[k]
            elif line.startswith("domain:"):
                d = norm_domain(line[7:])
                if d:
                    res["suffix"].add(d)
            elif line.startswith("full:"):
                d = norm_domain(line[5:])
                if d:
                    res["exact"].add(d)
            elif line.startswith("keyword:"):
                k = line[8:].strip().lower()
                if 1 < len(k) <= 60:
                    res["keyword"].add(k)
            elif line.startswith("regexp:"):
                r = line[7:].strip()
                if 3 < len(r) <= 120:
                    res["regex"].add(r)
            elif ":" not in line:
                d = norm_domain(line)                 # 裸域名 = 后缀匹配
                if d:
                    res["suffix"].add(d)
        return res


def prune_subsumed(items, keep_exact=()):
    """父后缀已存在时丢弃其子域（精确条目除外），显著压小体积。"""
    items = sorted(items, key=lambda x: (x.count("."), len(x), x))
    kept, kept_set = [], set()
    for d in items:
        covered = False
        if d not in keep_exact:
            parts = d.split(".")
            for i in range(1, len(parts) - 1):
                if ".".join(parts[i:]) in kept_set:
                    covered = True
                    break
        if covered:
            continue
        kept.append(d)
        kept_set.add(d)
    return sorted(kept)


def parse_cidr_list(text: str, version: int):
    """解析纯 CIDR 行列表；返回 (networks_sorted_str, 问题行列表)。"""
    nets, bad, dup = set(), [], 0
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        try:
            net = ipaddress.ip_network(line, strict=False)
        except ValueError:
            bad.append(line[:40])
            continue
        if net.version != version:
            bad.append(f"v{net.version}:{line}"[:40])
            continue
        if net.prefixlen < (V4_MIN_PREFIX if version == 4 else V6_MIN_PREFIX):
            bad.append(f"过宽:{line}"[:40])
            continue
        if str(net) in nets:
            dup += 1
        nets.add(str(net))
    return sorted(nets, key=lambda s: (int(s.split("/")[1]), ipaddress.ip_network(s).network_address)), bad, dup


# ---------------------------------------------------------------- 组装

def collect():
    report = []

    raw = fetch(V2FLY_TAR, binary=True)
    report.append(f"v2fly tar {len(raw) / 1024:.0f} KB")
    tf = tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz")
    data_root = None
    for m in tf.getmembers():
        if m.name.endswith("/data") and m.isdir():
            data_root = m.name
            break
    if data_root is None:
        raise RuntimeError("v2fly tar 包里找不到 data/ 目录")
    # 直接从 tar 读，不落盘
    files = {}
    for m in tf.getmembers():
        if m.isfile() and m.name.startswith(data_root + "/"):
            files[m.name[len(data_root) + 1:]] = m
    report.append(f"v2fly data 文件 {len(files)} 个")

    class TarDLC(DLC):
        def __init__(self):                     # noqa: D107
            self.cache = {}

        def node(self, name):                   # noqa: D102
            if name in self.cache:
                return self.cache[name]
            res = {"suffix": set(), "exact": set(), "keyword": set(), "regex": set()}
            self.cache[name] = res
            m = files.get(name)
            if m is None:
                print(f"[warn] tar 里缺少 data/{name}", file=sys.stderr)
                return res
            text = tf.extractfile(m).read().decode("utf-8", "replace")
            for line in text.splitlines():
                self._feed(line, res)
            return res

        def _feed(self, line, res):             # noqa: D102
            line = line.split("#", 1)[0].strip()
            if not line:
                return
            line = line.split("@", 1)[0].strip()
            if not line:
                return
            if line.startswith("include:"):
                sub = self.node(line[len("include:"):].strip())
                for k in res:
                    res[k] |= sub[k]
            elif line.startswith("domain:"):
                d = norm_domain(line[7:])
                if d:
                    res["suffix"].add(d)
            elif line.startswith("full:"):
                d = norm_domain(line[5:])
                if d:
                    res["exact"].add(d)
            elif line.startswith("keyword:"):
                k = line[8:].strip().lower()
                if 1 < len(k) <= 60:
                    res["keyword"].add(k)
            elif line.startswith("regexp:"):
                r = line[7:].strip()
                if 3 < len(r) <= 120:
                    res["regex"].add(r)
            elif ":" not in line:
                d = norm_domain(line)
                if d:
                    res["suffix"].add(d)

    tree = TarDLC()
    suffix, exact, keyword, regex = set(), set(), set(), set()
    for root in V2FLY_ROOTS:
        n = tree.node(root)
        suffix |= n["suffix"]
        exact |= n["exact"]
        keyword |= n["keyword"]
        regex |= n["regex"]
    report.append(
        f"v2fly cn 展开：后缀 {len(suffix)} / 精确 {len(exact)} / 关键词 {len(keyword)} / 正则 {len(regex)}"
    )

    exact -= suffix
    suffix = prune_subsumed(suffix, keep_exact=exact)

    v4, bad4, dup4 = parse_cidr_list(fetch(IPV4_URL), 4)
    v6, bad6, dup6 = parse_cidr_list(fetch(IPV6_URL), 6)
    report.append(f"gaoyifan IPv4 {len(v4)} 条（坏行 {len(bad4)} / 重复 {dup4}）")
    report.append(f"gaoyifan IPv6 {len(v6)} 条（坏行 {len(bad6)} / 重复 {dup6}）")
    if bad4:
        print(f"[warn] IPv4 坏行示例：{bad4[:5]}", file=sys.stderr)
    if bad6:
        print(f"[warn] IPv6 坏行示例：{bad6[:5]}", file=sys.stderr)
    return suffix, exact, keyword, regex, v4, v6, report


# ---------------------------------------------------------------- 校验（写盘前）

def validate(suffix, exact, keyword, regex, v4, v6):
    for name, items in (("suffix", suffix), ("exact", exact), ("keyword", keyword),
                        ("regex", regex), ("ipv4", v4), ("ipv6", v6)):
        lo, hi = LIMITS[name]
        if not lo <= len(items) <= hi:
            raise ValueError(f"{name} 条数 {len(items)} 越界（允许 {lo}..{hi}），疑似上游残缺或误展开")

    if len(suffix) != len(set(suffix)) or len(v4) != len(set(v4)) or len(v6) != len(set(v6)):
        raise ValueError("存在重复条目")

    # 裸 TLD / 过宽后缀
    for d in list(suffix) + list(exact):
        if "." not in d:
            if d in BARE_TLD_DENY or d not in BARE_TLD_ALLOW:
                raise ValueError(f"出现未授权的裸 TLD：{d}")

    # 必含项（覆盖度锚点）：允许被子域/父后缀覆盖（qq.com 已覆盖 weixin.qq.com）
    joined = set(suffix) | set(exact)

    def covered(d):
        return any(d == e or d.endswith("." + e) for e in joined)

    for must in ("qq.com", "baidu.com", "bilibili.com", "taobao.com", "weixin.qq.com", "alipay.com", "cn"):
        if not covered(must):
            raise ValueError(f"缺少必备条目：{must}")

    # 国外域名泄漏（等于把代理域名送进直连）
    leaked = [d for d in FOREIGN_MUST_NOT if d in joined]
    if leaked:
        raise ValueError(f"国外域名泄漏进中国规则集：{leaked}")

    # IP 全部可解析 + 同族 + 不含过宽段
    v4_total = 0
    for s in v4:
        net = ipaddress.ip_network(s)
        assert net.version == 4, s
        v4_total += net.num_addresses
    v6_total = 0
    for s in v6:
        net = ipaddress.ip_network(s)
        assert net.version == 6, s
        v6_total += net.num_addresses
    if v4_total / 2 ** 32 > MAX_V4_FRACTION:
        raise ValueError(f"IPv4 覆盖 {v4_total / 2 ** 32:.1%} 超过上限，疑似误收超大段")
    if v6_total / 2 ** 128 > MAX_V6_FRACTION:
        raise ValueError(f"IPv6 覆盖 {v6_total / 2 ** 128:.2%} 超过上限，疑似误收超大段")

    # IPv4 / IPv6 不能串门
    for s in v4:
        if ":" in s:
            raise ValueError(f"IPv6 段出现在 ip_cidr_set：{s}")
    for s in v6:
        if ":" not in s:
            raise ValueError(f"IPv4 段出现在 ip_cidr6_set：{s}")

    for r in regex:
        re.compile(r)


# ---------------------------------------------------------------- 生成

HEADER = """\
# 中国规则集（Egern rule_set）
# 自动生成，请勿手改。生成器：rules/china/sync.py
# 上游：v2fly/domain-list-community · gaoyifan/china-operator-ip
# 后缀 {ns} / 精确 {ne} / 关键词 {nk} / 正则 {nr}
# IPv4 {n4} 段 / IPv6 {n6} 段

# IP 类规则只用「已知目的 IP」判断，不为了匹配而额外做一次 DNS 解析
no_resolve: true
"""


def build(suffix, exact, keyword, regex, v4, v6):
    out = [HEADER.format(ns=len(suffix), ne=len(exact), nk=len(keyword), nr=len(regex),
                         n4=len(v4), n6=len(v6))]
    if suffix:
        out.append("domain_suffix_set:\n" + "\n".join(f"  - {d}" for d in sorted(suffix)) + "\n")
    if exact:
        out.append("domain_set:\n" + "\n".join(f"  - {d}" for d in sorted(exact)) + "\n")
    if keyword:
        out.append("domain_keyword_set:\n" + "\n".join(f"  - {k}" for k in sorted(keyword)) + "\n")
    if regex:
        out.append("domain_regex_set:\n" + "\n".join(f"  - {r}" for r in sorted(regex)) + "\n")
    out.append("ip_cidr_set:\n" + "\n".join(f"  - {s}" for s in v4) + "\n")
    out.append("ip_cidr6_set:\n" + "\n".join(f"  - {s}" for s in v6) + "\n")
    return "\n".join(out)


def build_txt(suffix, exact, keyword, regex, v4, v6):
    """通用文本版：Surge / Clash / Loon 的 RULE-SET 行；IP 行逐条带 no-resolve。"""
    L = [
        "# 中国规则集（通用文本：DOMAIN-SUFFIX / DOMAIN / IP-CIDR / IP-CIDR6）",
        "# 自动生成，请勿手改。生成器：rules/china/sync.py",
        f"# 后缀 {len(suffix)} / 精确 {len(exact)} / 关键词 {len(keyword)} / 正则 {len(regex)}"
        f" / IPv4 {len(v4)} / IPv6 {len(v6)}",
        "",
    ]
    L += [f"DOMAIN-SUFFIX,{d}" for d in sorted(suffix)]
    L += [f"DOMAIN,{d}" for d in sorted(exact)]
    L += [f"DOMAIN-KEYWORD,{k}" for k in sorted(keyword)]
    L += [f"IP-CIDR,{s},no-resolve" for s in v4]
    L += [f"IP-CIDR6,{s},no-resolve" for s in v6]
    return "\n".join(L) + "\n"


def write_if_changed(path: Path, text: str) -> bool:
    data = text.encode("utf-8")
    if path.exists() and path.read_bytes() == data:
        return False
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)                 # 先写临时文件，再原子替换
    os.replace(tmp, path)
    return True


def main():
    suffix, exact, keyword, regex, v4, v6, report = collect()
    validate(suffix, exact, keyword, regex, v4, v6)   # 校验不过 → 抛异常，旧产物不动
    y, t = build(suffix, exact, keyword, regex, v4, v6), build_txt(suffix, exact, keyword, regex, v4, v6)
    cy = write_if_changed(OUT_YAML, y)
    ct = write_if_changed(OUT_TXT, t)
    for line in report:
        print("  " + line)
    print(f"  产出：后缀 {len(suffix)} / 精确 {len(exact)} / 关键词 {len(keyword)} / 正则 {len(regex)}"
          f" / IPv4 {len(v4)} / IPv6 {len(v6)}")
    print(f"  写入：china.yaml {'已更新' if cy else '无变化'}"
          f"（{len(y.encode()) / 1024:.0f} KB） / china.txt {'已更新' if ct else '无变化'}"
          f"（{len(t.encode()) / 1024:.0f} KB）")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:                                 # noqa: BLE001
        print(f"[FAIL] {exc}", file=sys.stderr)
        sys.exit(1)
