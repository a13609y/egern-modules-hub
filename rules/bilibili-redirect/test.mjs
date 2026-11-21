// 行为测试：Node 模拟 Egern 全局（Egern / $request / $done / $persistentStore）。
// 这不是真机验证 —— 只证明脚本按时调用 $done、六组开关生效、失败路径不挂起。
// 运行：node rules/bilibili-redirect/test.mjs
import assert from 'node:assert/strict';

globalThis.Egern = 1;
let doneCalls = [];
globalThis.$done = (v) => { doneCalls.push(v); };
globalThis.$persistentStore = { read: () => null, write: () => true };

const mod = await import(new URL('./bilibili-redirect.bundle.js', import.meta.url).href);
const fn = mod.default;

async function run(env, url) {
  doneCalls = [];
  const req = { url, method: 'GET', headers: { Host: new URL(url).host } };
  globalThis.$request = req;
  const t0 = Date.now();
  await fn({ request: req, env });
  await new Promise((r) => setTimeout(r, 120)); // 等上游 microtask 调用 $done
  return { ms: Date.now() - t0, done: doneCalls.map((v) => ({ url: v && v.url, host: v && v.headers && v.headers.Host })) };
}

const A = await run({ Bili_OverseaVideo__cn_hk_eq_01_01_bilivideo_com: 'true' }, 'https://cn-hk-eq-01-03.bilivideo.com/upgcxcode/1/2/3.m4s?e=1');
const B = await run({}, 'https://cn-hk-eq-01-03.bilivideo.com/upgcxcode/1/2/3.m4s?e=1');
const C = await run({ Bili_OverseaVideo__cn_hk_eq_01_01_bilivideo_com: 'true', Bili_OverseaVideo__upos_sz_mirrorcos_bilivideo_com: 'true' }, 'https://cn-hk-eq-01-03.bilivideo.com/upgcxcode/1/2/3.m4s');
const D = await run({ Bili_BStar__upos_sz_mirror08c_bilivideo_com: 'true' }, 'https://upos-sz-mirroralibstar1.bilivideo.com/upgcxcode/9/8/7.m4s');
const E = await run({ Bili_MCDN__proxy_tf_all_ws_bilivideo_com: 'true' }, 'https://a1.mcdn.bilivideo.cn:9102/upgcxcode/5/6/7.m4s');
const F = await run(undefined, 'https://cn-hk-eq-01-03.bilivideo.com/upgcxcode/1.m4s');

assert.equal(A.done.length, 1, 'A 应调用一次 $done');
assert.match(A.done[0].url, /^https:\/\/cn-hk-eq-01-01\.bilivideo\.com\/upgcxcode\//, 'A 开关应生效');
assert.match(B.done[0].url, /^https:\/\/upos-sz-mirrorali\.bilivideo\.com\//, 'B 全关用默认');
assert.match(C.done[0].url, /^https:\/\/upos-sz-mirrorali\.bilivideo\.com\//, 'C 多开回落默认');
assert.match(D.done[0].url, /^https:\/\/upos-sz-mirror08c\.bilivideo\.com\//, 'D BStar 开关');
assert.equal(E.done[0].host, 'proxy-tf-all-ws.bilivideo.com', 'E MCDN 开关');
assert.equal(F.done.length, 1, 'F 失败路径仍按时结束');
for (const r of [A, B, C, D, E, F]) assert.ok(r.ms < 2000, '不应挂起：' + r.ms);

console.log('[test] ok', JSON.stringify({ A: A.done[0].url, B: B.done[0].url, E: E.done[0].url, max_ms: Math.max(A.ms, B.ms, C.ms, D.ms, E.ms, F.ms) }));
