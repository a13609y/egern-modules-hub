#!/bin/sh
# 仓库统一门禁：本地和 CI（.github/workflows/validate.yml）跑的是同一条命令。
#
#   sh scripts/check_all.sh
#
# 覆盖面（顺序固定，任一失败即非零退出）：
#   1 全仓静态校验      python3 scripts/check_repo.py（YAML/元数据/链接/目录树/自引用/rewrites 守卫）
#   2 中国规则集专项     python3 rules/china/verify.py
#   3 BiliBili 行为测试  node rules/bilibili-redirect/test.mjs
#   4 Coolapk 行为测试   node <临时目录>/test.mjs（拷 test.mjs + coolapk.js→coolapk.mjs 到临时目录，
#                        不在工作区生成 coolapk.mjs，也不覆盖用户已有文件）
#   5 BiliBili 开关解析   python3 scripts/tests/test_bilibili_toggles.py（合成样本，无网络无凭据）
#   6 空白与冲突残留     git diff --check（工作区 vs HEAD）
#
# 与 CI 的差别只有一处：CI 的「空白与冲突残留」检查的是 PR base..HEAD（或 push 的 before..HEAD）
# 这段提交范围内的差异 —— 因为 CI 检出的工作区是干净的，工作区 diff 永远为空；
# 本地这一步查的是你还没提交的改动。其余步骤完全一致。
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

fail=0
step() { printf '\n== %s\n' "$1"; }
run() {
    name=$1
    shift
    if "$@"; then return 0; fi
    printf '[FAIL] %s\n' "$name"
    fail=1
    return 0
}

# ── 依赖：唯一第三方依赖 pyyaml；CI 会显式装同一版本，这里只在缺失时兜底 ──
if ! python3 -c 'import yaml' >/dev/null 2>&1; then
    echo '[info] 缺少 pyyaml，安装 pyyaml==6.0.2'
    python3 -m pip install --quiet --disable-pip-version-check pyyaml==6.0.2
fi
if ! command -v node >/dev/null 2>&1; then
    echo '[FAIL] 需要 node（行为测试用，CI 用 Node 22）'
    exit 1
fi

step '1/6 全仓静态校验 scripts/check_repo.py'
run 'check_repo' python3 scripts/check_repo.py

step '2/6 中国规则集 rules/china/verify.py'
run 'china verify' python3 rules/china/verify.py

step '3/6 BiliBili Redirect 行为测试'
run 'bilibili-redirect test' node rules/bilibili-redirect/test.mjs

step '4/6 Coolapk 行为测试（临时目录，不写工作区）'
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/egern-gate.XXXXXX")
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
cp rules/coolapk/test.mjs "$TMP_DIR/test.mjs"
cp rules/coolapk/coolapk.js "$TMP_DIR/coolapk.mjs"
run 'coolapk test' node "$TMP_DIR/test.mjs"

step '5/6 BiliBili 开关解析离线测试（合成样本）'
run 'bilibili toggles' python3 scripts/tests/test_bilibili_toggles.py

step '6/6 空白与冲突残留（工作区 vs HEAD）'
if git rev-parse --git-dir >/dev/null 2>&1; then
    run 'git diff --check' git diff --check
    run 'git diff --cached --check' git diff --cached --check
else
    echo '[info] 不是 git 工作区，跳过'
fi

if [ "$fail" -ne 0 ]; then
    printf '\n[FAIL] check_all 有失败项\n'
    exit 1
fi
printf '\n[PASS] check_all 全部通过\n'
