// 行为测试：把生成的 bundle 当纯函数跑，验证开关选值 / 全关 / 多开 / Storage / 重写等价性。
// 用法：node test.mjs   （需要 bilibili-redirect.bundle.js 已生成）
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = join(here, '.test-bundle.mjs');
copyFileSync(join(here, 'bilibili-redirect.bundle.js'), tmp);
const YAML = readFileSync(join(here, 'bilibili-redirect.yaml'), 'utf8');

// Egern 运行时全局：平台探测 + $done/$script 兜底
globalThis.Egern = { version: 'test' };
let doneCalls = 0;
globalThis.$done = () => { doneCalls++; };

const { default: handler } = await import(tmp);

// 静音上游 console.log，只保留测试自身输出
const realLog = console.log.bind(console);
const _origLog = console.log; console.log = (...a) => { const s = String(a[0] ?? ''); if (/^[✓✗]|^\d+ passed|^schema|\(undefined\)/.test(s) === false && !a.includes('✗')) { /* drop upstream noise */ } else realLog(...a); };
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; realLog('✓', name); }
  else { fail++; realLog('✗', name, extra === undefined ? '' : String(extra).slice(0, 300)); }
};

// env_schema 的键 → 直接打开某组某个候选值
const schema = (() => {
  const m = YAML.match(/^env_schema:\n([\s\S]*?)\n(?:open_url|author|homepage):/m);
  const out = {};
  for (const line of m[1].split('\n')) {
    const k = line.match(/^ {2}([A-Za-z0-9_.]+):\s*$/);
    if (k) { out[k[1]] = null; continue; }
    const n = line.match(/^ {4}name: (.+)$/);
    if (n) { const keys = Object.keys(out); out[keys[keys.length - 1]] = n[1].trim(); }
  }
  return out;
})();
const T = (token, value) => Object.keys(schema).find(k => k.toLowerCase().startsWith(`bili_${token}__`) && schema[k] === value);
check('schema: 六组共 55 个 Toggle', Object.keys(schema).length === 55, Object.keys(schema).length);

const storage = () => {
  const map = new Map();
  return {
    get: k => (map.has(k) ? map.get(k) : null),
    set: (k, v) => map.set(k, String(v)),
    delete: k => map.delete(k),
    getJSON: k => (map.has(k) ? JSON.parse(map.get(k)) : null),
    setJSON: (k, v) => map.set(k, JSON.stringify(v)),
  };
};

const run = async (url, env, opts = {}) => {
  const ctx = {
    env: env || {},
    request: { url, method: opts.method || 'GET', headers: Object.assign({ Host: new URL(url).hostname, 'User-Agent': 't' }, opts.headers || {}) },
    storage: opts.storage || storage(),
  };
  return handler(ctx);
};

const host = r => (r && r.url ? new URL(r.url).hostname : '(undefined)');
const ALI = 'upos-sz-mirrorali.bilivideo.com';
const HW = 'upos-sz-mirrorhw.bilivideo.com';
const COS = 'upos-sz-mirrorcos.bilivideo.com';

// ── 1. 全关：沿用上游默认（compat_arguments）──
{
  const r = await run(`https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/1/2/3.m4s?e=1&u=2`);
  check('全关 → OverseaVideo 上游默认', host(r) === ALI, host(r));
}
// ── 2. 单选：OverseaVideo 用 cos ──
{
  const r = await run(`https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/1/2/3.m4s?e=1&u=2`,
    { [T('overseavideo', COS)]: 'true' });
  check('单选 OverseaVideo=cos 生效', host(r) === COS, host(r));
}
// ── 3. 单选 cosov（ov 主机类）──
{
  const r = await run(`https://cn-hk-eq-01-03.bilivideo.com/upgcxcode/9/9/9.flv?token=ab`,
    { [T('overseavideo', 'upos-sz-mirrorcosov.bilivideo.com')]: 'true' });
  check('单选 OverseaVideo=cosov 对 cn-hk-eq 主机生效', host(r) === 'upos-sz-mirrorcosov.bilivideo.com', host(r));
}
// ── 4. 多开：回上游默认 ──
{
  const r = await run(`https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s`, {
    [T('overseavideo', COS)]: 'true', [T('overseavideo', HW)]: 'true',
  });
  check('多开 → 回上游默认', host(r) === ALI, host(r));
}
// ── 5. 关闭（false）等于未开 ──
{
  const r = await run(`https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s`, {
    [T('overseavideo', COS)]: 'false', [T('overseavideo', HW)]: 'true',
  });
  check('false 不参与计数 → HW 生效', host(r) === HW, host(r));
}
// ── 6. BStar 单选 ──
{
  const r = await run(`https://upos-sz-mirrorhwbstar1.bilivideo.com/upgcxcode/b.m4s`,
    { [T('bstar', 'upos-sz-mirror08c.bilivideo.com')]: 'true' });
  check('BStar 单选生效', host(r) === 'upos-sz-mirror08c.bilivideo.com', host(r));
}
// ── 7. BStar 未选中时回默认，且不串到 OverseaVideo ──
{
  const r = await run(`https://upos-bstar1-mirrorakam.akamaized.net/upgcxcode/c.m4s`,
    { [T('overseavideo', COS)]: 'true' });
  check('只开 OverseaVideo 不影响 BStar', host(r) === ALI, host(r));
}
// ── 8. PCDN 单选（:4480）──
{
  const r = await run(`https://x1.bilivideo.com:4480/upgcxcode/d.m4s?xy_usource=foo`,
    { [T('pcdn', HW)]: 'true' });
  check('PCDN 单选生效', host(r) === 'foo', `xy_usource 优先: ${host(r)}`);
  const r2 = await run(`https://x1.bilivideo.com:4480/upgcxcode/d.m4s`,
    { [T('pcdn', HW)]: 'true' });
  check('PCDN 单选生效（无 xy_usource → 用开关值）', host(r2) === HW, host(r2));
}
// ── 9. MCDN 只有一项：开=用该值，关=默认 ──
{
  const urls = ['https://a1.mcdn.bilivideo.cn:4483/upgcxcode/e.m4s?x=1', 'https://a1.mcdn.bilivideo.cn:4483/upgcxcode/e.m4s?originalUrl=1'];
  const r = await run(urls[0], { [T('mcdn', 'proxy-tf-all-ws.bilivideo.com')]: 'true' });
  check('MCDN 开 → proxy-tf-all-ws', host(r) === 'proxy-tf-all-ws.bilivideo.com', host(r));
  const r2 = await run(urls[0], {});
  check('MCDN 关 → 上游默认', host(r2) === 'proxy-tf-all-ws.bilivideo.com', host(r2));
  const r3 = await run(urls[1], { [T('mcdn', 'proxy-tf-all-ws.bilivideo.com')]: 'true' });
  check('originalUrl 已存在则不改写', host(r3) === 'a1.mcdn.bilivideo.cn', host(r3));
}
// ── 10. Storage：Argument / PersistentStore / database ──
{
  const st = storage();
  st.set('@Biliverse.Redirect.Settings', JSON.stringify({ Storage: 'Argument' }));
  const r = await run(`https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s`, { [T('storage', 'PersistentStore')]: 'true' }, { storage: st });
  check('Storage=PersistentStore 单选不崩且仍按默认重写', host(r) === ALI, host(r));
  const r2 = await run(`https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s`, { [T('storage', 'database')]: 'true' });
  check('Storage=database 单选可用', host(r2) === ALI, host(r2));
  const r3 = await run(`https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s`, {
    [T('storage', 'database')]: 'true', [T('storage', 'Argument')]: 'true',
  });
  check('Storage 多开 → 回上游默认 Argument', host(r3) === ALI, host(r3));
}
// ── 11. LogLevel 单选生效（DEBUG 时输出被保留，不抛错）──
{
  for (const lv of ['OFF', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'ALL']) {
    let ok = true;
    try { await run(`https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s`, { [T('loglevel', lv)]: 'true' }); }
    catch (e) { ok = false; }
    check(`LogLevel=${lv} 单选可用`, ok);
  }
  const r = await run(`https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s`, {
    [T('loglevel', 'OFF')]: 'true', [T('loglevel', 'ALL')]: 'true',
  });
  check('LogLevel 多开 → 回默认 WARN', host(r) === ALI, host(r));
}
// ── 12. 重写等价性：保留 path / query / scheme ──
{
  const src = 'https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/11/22/33.m4s?e=65535&deadline=1&uipk=5&platform=html5';
  const r = await run(src, { [T('overseavideo', COS)]: 'true' });
  const a = new URL(src), b = new URL(r.url);
  check('path 保留', a.pathname === b.pathname, b.pathname);
  check('query 保留', a.search === b.search, b.search);
  check('scheme 保留', a.protocol === b.protocol, b.protocol);
  check('Host 头跟随改写', r.headers.Host === COS, r.headers.Host);
  const rh = await run('http://upos-sz-mirroraliov.bilivideo.com:80/upgcxcode/x.m4s?q=1', { [T('overseavideo', COS)]: 'true' });
  check('http:80 → 目标无端口', host(rh) === COS && new URL(rh.url).port === '', rh.url);
  const r4483 = await run('https://upos-sz-mirroraliov.bilivideo.com:4483/upgcxcode/x.m4s', { [T('overseavideo', COS)]: 'true' });
  check('https:4483 → 目标无端口', host(r4483) === COS && new URL(r4483.url).port === '', r4483.url);
}
// ── 13. 不相关请求原样透传（不扩大改写范围）──
{
  const src = 'https://api.bilibili.com/x/player/playurl?bvid=1';
  const r = await run(src, { [T('overseavideo', COS)]: 'true' });
  check('非 upgcxcode 路径不改写', r.url === src, r.url);
  // 非 /upgcxcode/ 路径：模块 scriptings.match 已限定 /upgcxcode/ 或 MCDN/PCDN 主机，
  // 脚本不会被触发；直接调用时上游逻辑仍按主机类改名（上游原有行为，未扩大范围）。
  const matches = [...YAML.matchAll(/^ {4}match: (.+)$/gm)].map(m => m[1]);
  check('每条 scripting.match 都限定在原规则路径/主机内',
    matches.length === 7 && matches.every(m => /upgcxcode|mcdn\\.bilivideo\\.cn|:4480/.test(m)), matches.join(' | '));
  const src3 = 'https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/a.m4s';
  const r3 = await run(src3, { [T('overseavideo', COS)]: 'true' });
  check('已是目标主机不二次改写', r3.url === src3, r3.url);
  const src4 = 'https://example.com/upgcxcode/a.m4s';
  const r4 = await run(src4, { [T('overseavideo', COS)]: 'true' });
  check('非受控主机不改写', r4.url === src4, r4.url);
}
// ── 14. 未设置任何开关（全新安装，ctx.env 为空）──
{
  const r = await run(`https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s`, {});
  check('空 env → 上游默认，不崩', host(r) === ALI, host(r));
}
// ── 15. 组间独立：OverseaVideo 与 BStar 同时各单选一个 ──
{
  const r = await run('https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s', {
    [T('overseavideo', COS)]: 'true', [T('bstar', HW)]: 'true',
  });
  check('两组各自单选互不干扰（ov）', host(r) === COS, host(r));
  const r2 = await run('https://upos-sz-mirrorbstar1.bilivideo.com/upgcxcode/a.m4s', {
    [T('overseavideo', COS)]: 'true', [T('bstar', HW)]: 'true',
  });
  check('两组各自单选互不干扰（bstar）', host(r2) === HW, host(r2));
}
// ── 16a. 占位符未被替换（Egern 不做 compat_arguments 替换的情形）→ 回落烘焙默认 ──
{
  const lit = 'Host.OverseaVideo={{{Host.OverseaVideo}}}&Host.BStar={{{Host.BStar}}}&Host.PCDN={{{Host.PCDN}}}&Host.MCDN={{{Host.MCDN}}}&Storage={{{Storage}}}&LogLevel={{{LogLevel}}}';
  const r = await run('https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s', { '_compat.$argument': lit });
  check('占位符未替换 → 回落默认而不是把 {{{}}} 当主机名', host(r) === ALI, host(r));
  const r2 = await run('https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s',
    { '_compat.$argument': lit, [T('overseavideo', COS)]: 'true' });
  check('占位符未替换 + 单选开关 → 开关仍生效', host(r2) === COS, host(r2));
}
// ── 16. 兜底 env：$argument 传入值仍被尊重（旧配置兼容）──
{
  const r = await run('https://upos-sz-mirroraliov.bilivideo.com/upgcxcode/a.m4s',
    { '_compat.$argument': 'Host.OverseaVideo=upos-sz-mirrorhwov.bilivideo.com&Host.BStar=upos-sz-mirrorali.bilivideo.com&Host.PCDN=upos-sz-mirrorali.bilivideo.com&Host.MCDN=proxy-tf-all-ws.bilivideo.com&Storage=Argument&LogLevel=WARN' });
  check('旧 $argument 保留时优先它（全关情形）', host(r) === 'upos-sz-mirrorhwov.bilivideo.com', host(r));
}

realLog(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
