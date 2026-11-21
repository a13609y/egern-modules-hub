// 行为测试（Node 模拟 Egern 全局：$request/$done/$persistentStore/Egern）。
// 这不是真机验证：只证明脚本按时调用 $done、开关生效、失败不吞请求。
// 运行：node rules/bilibili-redirect/test.mjs
import assert from 'node:assert/strict';
const log = (...a) => console.log('[test]', ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x)));
globalThis.Egern = 1;const mod = await import(new URL('./bilibili-redirect.bundle.js', import.meta.url).href + '?' + Date.now());
const fn = mod.default;
const run = async (env, url) => {
  doneCalls = [];
  globalThis.$request = { url, method: 'GET', headers: { Host: new URL(url).host } };
  const t0 = Date.now();
  await Promise.race([fn({ request: globalThis.$request, env }), new Promise(r => setTimeout(() => r('TIMEOUT'), 3000))]);
  await new Promise(r => setTimeout(r, 150)); return { ms: Date.now() - t0, done: doneCalls.map(c => ({ url: c.v && c.v.url, host: c.v && c.v.headers && c.v.headers.Host })) };
};
const A = await run({ Bili_OverseaVideo__cn_hk_eq_01_01_bilivideo_com: 'true' }, 'https://cn-hk-eq-01-03.bilivideo.com/upgcxcode/1/2/3.m4s?e=1')));
const B = await run({}, 'https://cn-hk-eq-01-03.bilivideo.com/upgcxcode/1/2/3.m4s?e=1')));
const C = await run({ Bili_OverseaVideo__cn_hk_eq_01_01_bilivideo_com: 'true', Bili_OverseaVideo__upos_sz_mirrorcos_bilivideo_com: 'true' }, 'https://cn-hk-eq-01-03.bilivideo.com/upgcxcode/1/2/3.m4s')));
const Dd = await run({ Bili_BStar__upos_sz_mirror08c_bilivideo_com: 'true' }, 'https://upos-sz-mirroralibstar1.bilivideo.com/upgcxcode/9/8/7.m4s')));
const E = await run({ Bili_MCDN__proxy_tf_all_ws_bilivideo_com: 'true' }, 'https://a1.mcdn.bilivideo.cn:9102/upgcxcode/5/6/7.m4s')));
const F = await run(undefined, 'https://cn-hk-eq-01-03.bilivideo.com/upgcxcode/1.m4s')));

assert.equal(A.done.length, 1, 'A 应调用一次 $done');
assert.match(A.done[0].url, /^https:\/\/cn-hk-eq-01-01\.bilivideo\.com\/upgcxcode\//, 'A 开关应生效');
assert.match(B.done[0].url, /^https:\/\/upos-sz-mirrorali\.bilivideo\.com\//, 'B 默认值');
assert.match(C.done[0].url, /^https:\/\/upos-sz-mirrorali\.bilivideo\.com\//, 'C 多开回落默认');
assert.match(Dd.done[0].url, /^https:\/\/upos-sz-mirror08c\.bilivideo\.com\//, 'D BStar 开关');
assert.equal(E.done[0].host, 'proxy-tf-all-ws.bilivideo.com', 'E MCDN');
assert.equal(F.done.length, 1, 'F 失败路径仍按时结束');
for (const r of [A, B, C, Dd, E, F]) assert.ok(r.ms < 2000, '不应挂起：' + r.ms);
log('all assertions passed', { A: A.done[0].url, B: B.done[0].url });
