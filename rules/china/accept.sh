#!/bin/sh
# 中国规则集本地验收（可重复跑）：./accept.sh
#   1 生成两次 → 字节一致（幂等）
#   2 独立静态验收 verify.py（schema / 样本 / 每个 IP no_resolve / 格式）
#   3 上游 404 → 非零退出且旧产物不变
#   4 上游格式错乱 → 非零退出且旧产物不变
#   5 上游塞 0.0.0.0/0 这种过宽段 → 被过滤，不进产物
#   6 产物被手改（删 no_resolve）→ verify.py 必须报错
set -u
cd "$(dirname "$0")" || exit 1
FAIL=0
ok()   { echo "  [PASS] $1"; }
bad()  { echo "  [FAIL] $1"; FAIL=1; }
sha()  { sha256sum china.yaml china.txt 2>/dev/null | tr '\n' ' '; }

echo "== 0. 首次生成"
python3 sync.py || bad "首次生成失败"

echo "== 1. 幂等（再跑一次，字节一致）"
A=$(sha)
python3 sync.py >/dev/null 2>&1 || bad "第二次生成失败"
B=$(sha)
[ "$A" = "$B" ] && ok "两次生成 sha256 相同" || bad "两次生成不一致：$A vs $B"
echo "     $B"

echo "== 2. 独立静态验收"
python3 verify.py && ok "verify.py 通过" || bad "verify.py 不通过"

echo "== 3. 上游 404 → 失败保留旧产物"
C=$(sha)
CHINA_IPV4_URL="https://raw.githubusercontent.com/gaoyifan/china-operator-ip/ip-lists/__no_such_file__.txt" \
  python3 sync.py >/tmp/t3.log 2>&1
rc=$?
[ $rc -ne 0 ] && ok "上游 404 时退出码非零（$rc）" || bad "上游 404 居然成功了"
[ "$C" = "$(sha)" ] && ok "旧产物未被破坏" || bad "失败时产物被改写了"
grep -q '抓到失败\|抓取失败' /tmp/t3.log && ok "报错信息含抓取失败" || bad "报错信息缺失：$(cat /tmp/t3.log)"

echo "== 4. 上游格式错乱（HTML 代替 CIDR）→ 失败保留旧产物"
printf '<html><body>404 Not Found</body></html>\n' >/tmp/garbage.txt
C=$(sha)
CHINA_IPV4_URL="file:///tmp/garbage.txt" python3 sync.py >/tmp/t4.log 2>&1
rc=$?
[ $rc -ne 0 ] && ok "条数下限拦住了坏上游（rc=$rc）" || bad "坏上游通过了校验"
[ "$C" = "$(sha)" ] && ok "旧产物未被破坏" || bad "失败时产物被改写了"
echo "     $(tail -1 /tmp/t4.log)"

echo "== 5. 过宽段 / 跨族条目必须被丢弃"
python3 - <<'PY'
import ipaddress
with open('/tmp/broad.txt','w') as f:
    f.write("0.0.0.0/0\n10.0.0.0/4\n")
    for i in range(1200):
        f.write(f"1.{i//256}.{i%256}.0/24\n")
    f.write("2001:db8::/32\n")   # 跨族：必须被丢弃
    f.write("not-a-cidr\n")
PY
T=$(mktemp -d)
CHINA_IPV4_URL="file:///tmp/broad.txt" CHINA_OUT_YAML="$T/c.yaml" CHINA_OUT_TXT="$T/c.txt" \
  python3 sync.py >/tmp/t5.log 2>&1
rc=$?
if [ $rc -eq 0 ] && ! grep -q '^  - 0\.0\.0\.0/0$' "$T/c.yaml" && ! grep -q '10\.0\.0\.0/4' "$T/c.yaml" \
   && ! grep -q '2001:db8' "$T/c.yaml"; then
  ok "0.0.0.0/0、10.0.0.0/4、跨族 IPv6 全部被过滤"
else
  bad "过宽/跨族条目漏进产物（rc=$rc）"
  tail -2 /tmp/t5.log
fi
echo "     $(grep -c '^  - ' "$T/c.yaml" 2>/dev/null) 条 IP + 域名条目，IPv4 段数 $(grep -c '^  - 1\.' "$T/c.yaml" 2>/dev/null)"
rm -rf "$T"

echo "== 6. 产物被手改 → verify.py 必须报错"
python3 - <<'PY'
s = open('china.yaml', encoding='utf-8').read()
open('/tmp/tampered.yaml','w',encoding='utf-8').write(s.replace('no_resolve: true\n', '', 1))
open('/tmp/tampered2.yaml','w',encoding='utf-8').write(
    s.replace('no_resolve: true\n', '').replace('ip_cidr_set:\n', 'ip_cidr_set:\n  - {value: 1.2.3.0/24, no_resolve: true}\n',1))
PY
python3 verify.py /tmp/tampered.yaml china.txt >/tmp/t6.log 2>&1 && bad "删掉 no_resolve 居然还通过" || ok "缺少 no_resolve 被判失败"
python3 verify.py /tmp/tampered2.yaml china.txt >/tmp/t6b.log 2>&1 && bad "per-item no_resolve 居然还通过" || ok "集合内 per-item no_resolve 被判失败"
echo "     $(grep -m1 '  - ' /tmp/t6.log)"

echo "== 7. 文本版漏 no-resolve → verify.py 必须报错"
python3 - <<'EOF'
import re
lines = open('china.txt', encoding='utf-8').read().splitlines()
for i, ln in enumerate(lines):
    if ln.startswith('IP-CIDR6,') and ln.endswith(',no-resolve'):
        lines[i] = ln[:-len(',no-resolve')]
        break
open('/tmp/bad2.txt','w',encoding='utf-8').write('\n'.join(lines)+'\n')
EOF
python3 verify.py china.yaml /tmp/bad2.txt >/tmp/t7.log 2>&1 && bad "漏 no-resolve 居然还通过" || ok "文本版漏 no-resolve 被判失败"
echo "     $(grep -m1 'no-resolve' /tmp/t7.log)"

echo "== 8. 与仓库国外域名规则集的重叠（信息项，不判失败）"
python3 - <<'PY'
import urllib.request, yaml
try:
    u="https://raw.githubusercontent.com/a13609y/egern-modules-hub/main/rulesets/foreign-domains/foreign-domains.yaml"
    req=urllib.request.Request(u, headers={"User-Agent":"accept"})
    d=yaml.safe_load(urllib.request.urlopen(req, timeout=60).read())
    foreign=set(d.get('domain_suffix_set') or []) | set(d.get('domain_set') or [])
    mine=set(yaml.safe_load(open('china.yaml',encoding='utf-8')).get('domain_suffix_set') or [])
    inter=mine & foreign
    print(f"     国外集 {len(foreign)} 条，中国集 {len(mine)} 条，交集 {len(inter)} 条"
          f"{'：'+str(sorted(inter)[:8]) if inter else ''}")
except Exception as e:
    print(f"     [skip] 线上对照失败：{e}")
PY

echo
[ $FAIL -eq 0 ] && echo "ACCEPT: 全部通过" || echo "ACCEPT: 存在失败项"
exit $FAIL
