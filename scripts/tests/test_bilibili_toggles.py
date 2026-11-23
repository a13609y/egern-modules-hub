#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""离线行为测试：BiliBili Redirect 生成器里的纯函数
=================================================

被测对象：`rules/bilibili-redirect/sync.py` 的 `candidates()` / `toggle_key()` / `label()`。
选它的理由：它是本仓库风险最高的生成物之一 —— 六组 Toggle 的解析、env_schema 键名和
展示名全部由这三个函数生成；解析跑偏或键名撞车会静默丢开关，而生成物是每日自动覆盖的，
手改无从留存。

约束：合成样本、无网络、无凭据、不写任何生产文件（只在内存里跑纯函数）；
`sync.py` 只有 `main()` 会联网写盘，导入本身是安全的。

运行：python3 scripts/tests/test_bilibili_toggles.py
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SYNC = ROOT / "rules" / "bilibili-redirect" / "sync.py"

fails: list[str] = []


def check(name: str, cond: bool, extra: object = None) -> None:
    if cond:
        print("  [ok] " + name)
    else:
        fails.append(name)
        print("  [FAIL] " + name + ("" if extra is None else f" -> {extra!r}"))


def load():
    spec = importlib.util.spec_from_file_location("bili_sync", SYNC)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise RuntimeError(f"无法加载 {SYNC}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# 合成上游 compat_arguments_desc：四组主机 + Storage / LogLevel，另加两组异常数据
DESC = """Host.OverseaVideo: 默认 upos-sz-mirrorali.bilivideo.com（可选值见开关列表，同组只开一个）
    ├ cn-hk-eq-01-01.bilivideo.com: 香港 01
    └ cn-hk-eq-01-03.bilivideo.com: 香港 03
Host.BStar: 默认 upos-sz-mirrorali.bilivideo.com
    └ upos-sz-mirroralibstar1.bilivideo.com: 国际版 A
Host.PCDN: 默认 upos-sz-mirrorali.bilivideo.com
    └ upos-sz-mirror08c.bilivideo.com: 华为云 08c
Host.MCDN: 默认 proxy-tf-all-ws.bilivideo.com
    └ proxy-tf-all-ws.bilivideo.com: MCDN 代理
Storage: 默认 env
    └ env: 环境变量
LogLevel: 默认 info
    └ info: 信息
"""

# 异常样本 1：未知分组写在最前（此时没有任何已知分组在上下文中，必须整段忽略）
DESC_UNKNOWN_FIRST = """Unknown.Group: 默认 x
    └ y: z
Host.PCDN: 默认 upos-sz-mirrorali.bilivideo.com
    └ upos-sz-mirror08c.bilivideo.com: 华为云 08c
"""

# 异常样本 2：同一分组重复声明时，第二次声明重置候选列表（不累加、不残留旧值）
DESC_DUP = """Host.MCDN: 默认 proxy-tf-all-ws.bilivideo.com
    └ proxy-tf-all-ws.bilivideo.com: MCDN 代理
Host.MCDN: 默认 a.example
    └ b.example: 只有这一项
"""


def main() -> int:
    mod = load()
    print("== 正常分支：六组候选解析")
    cands = mod.candidates(DESC)
    check("六组全部解析出来", set(cands) == set(mod.ALL_GROUPS), sorted(cands))
    check("OverseaVideo 两个候选且保持上游顺序",
          [v for v, _ in cands["Host.OverseaVideo"]]
          == ["cn-hk-eq-01-01.bilivideo.com", "cn-hk-eq-01-03.bilivideo.com"],
          cands["Host.OverseaVideo"])
    check("说明文本随候选保留（├/└ 前缀已剥离）",
          cands["Host.MCDN"][0] == ("proxy-tf-all-ws.bilivideo.com", "MCDN 代理"),
          cands["Host.MCDN"])
    check("每组至少一个候选（空组会让生成物缺开关）",
          all(cands[g] for g in mod.ALL_GROUPS),
          {g: len(cands[g]) for g in mod.ALL_GROUPS})

    print("== 异常分支：脏样本不炸、也不发明候选")
    check("空字符串 → {}", mod.candidates("") == {})
    check("None → {}", mod.candidates(None) == {})
    unknown = mod.candidates(DESC_UNKNOWN_FIRST)
    check("未知分组（写在最前）不会被当成候选", "Unknown.Group" not in unknown, sorted(unknown))
    check("未知分组之后的已知分组仍能正常解析",
          [v for v, _ in unknown.get("Host.PCDN", [])] == ["upos-sz-mirror08c.bilivideo.com"],
          unknown.get("Host.PCDN"))
    dup = mod.candidates(DESC_DUP)
    check("同组重复声明时以最后一次为准（不累加）",
          [v for v, _ in dup["Host.MCDN"]] == ["b.example"], dup["Host.MCDN"])

    print("== 开关键名：env_schema key")
    key = mod.toggle_key("Host.OverseaVideo", "cn-hk-eq-01-01.bilivideo.com")
    check("键名形如 Bili_<组>__<值>",
          key == "Bili_OverseaVideo__cn_hk_eq_01_01_bilivideo_com", key)
    check("键名只含 [A-Za-z0-9_]（Egern env 键不做转义）",
          all(c.isalnum() or c == "_" for c in key), key)
    keys = [mod.toggle_key(g, v) for g in mod.ALL_GROUPS for v, _ in cands[g]]
    check("全部开关键名唯一（撞车会静默丢开关）", len(keys) == len(set(keys)),
          len(keys) - len(set(keys)))

    print("== 展示名：label()")
    check("香港机房写成「香港 xx」",
          mod.label("Host.OverseaVideo", "cn-hk-eq-01-01.bilivideo.com").startswith("港澳台：香港 01"),
          mod.label("Host.OverseaVideo", "cn-hk-eq-01-01.bilivideo.com"))
    check("Storage 写成「配置来源：」",
          mod.label("Storage", "env") == "配置来源：env", mod.label("Storage", "env"))
    check("LogLevel 写成「日志：」",
          mod.label("LogLevel", "info") == "日志：info", mod.label("LogLevel", "info"))
    check("已知主机用短名表",
          mod.label("Host.BStar", "upos-sz-mirroralibstar1.bilivideo.com")
          == "国际版：upos-sz-mirroralibstar1.bilivideo.com"
          or "国际版" in mod.label("Host.BStar", "upos-sz-mirroralibstar1.bilivideo.com"),
          mod.label("Host.BStar", "upos-sz-mirroralibstar1.bilivideo.com"))
    check("未知主机回退为原值（不伪造短名）",
          mod.label("Host.PCDN", "nope.example").endswith("nope.example"),
          mod.label("Host.PCDN", "nope.example"))
    check("所有候选都有非空展示名",
          all(mod.label(g, v).strip() for g in mod.ALL_GROUPS for v, _ in cands[g]))

    if fails:
        print(f"\n[FAIL] {len(fails)} 项失败：{fails}")
        return 1
    print(f"\n[test] ok switches={len(keys)} groups={len(mod.ALL_GROUPS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
