// rules/youtube/test-toggles.mjs —— 离线回归：8 个开关默认关 + 开关桥「缺失/false/true/非法」
// 运行：node rules/youtube/test-toggles.mjs      （无网络、无凭据，读生成物）
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS = ["blockUpload", "blockShorts", "autoHd", "blockGames",
              "blockVerticalLive", "jumpAhead", "blockStore", "nativeDownload"];
let fails = 0;
const check = (cond, msg) => { if (!cond) { fails++; console.log("  [FAIL] " + msg); } else console.log("  [ok] " + msg); };

// ── 1. YAML：env_schema 保留 options（渲染 Toggle），scriptings 的 env 默认全 false
const yaml = readFileSync(join(HERE, "youtube.yaml"), "utf8");
check(KEYS.every(k => new RegExp(`\\n  ${k}:\\n    name:`).test(yaml)), "env_schema 含 8 个键");
const envBlocks = (yaml.match(/    env:\n/g) || []).length;
check((yaml.match(/    options:\n    - 'true'\n    - 'false'\n/g) || []).length === KEYS.length,
      "8 个 env_schema 条目均保留 options ['true','false']");
for (const k of KEYS) {
  const on = (yaml.match(new RegExp(`      ${k}: 'true'`, "g")) || []).length;
  const off = (yaml.match(new RegExp(`      ${k}: 'false'`, "g")) || []).length;
  check(on === 0 && off === envBlocks, `${k}: 每个 scriptings 的 env 默认 'false'（${envBlocks} 块），无 'true'（on=${on}, off=${off}）`);
}
check(/default_value/.test(yaml) === false, "env_schema 未写入未核实的 default_value 字段");

// ── 2. JS 开关桥：真实执行生成的前缀（只跑桥，不跑上游正文）
const bundle = readFileSync(join(HERE, "youtube-request.js"), "utf8");
const endMark = "  try { globalThis.$argument = JSON.stringify(__ytArg); } catch (e) {}";
const idx = bundle.indexOf(endMark);
check(idx > 0, "youtube-request.js 含开关桥前缀");
check(!/__ytDef = \{[^}]*: true/.test(bundle), "开关桥的默认值表不含 true（默认全关）");
const head = bundle.slice(0, idx + endMark.length) + "\n}\n";
const dir = mkdtempSync(join(tmpdir(), "yt-bridge-"));
const file = join(dir, "bridge.mjs");
writeFileSync(file, head);
const run = async (env) => {
  globalThis.$argument = undefined;
  const fn = (await import("file://" + file + "?" + Math.random())).default;
  await fn({ env });
  return JSON.parse(globalThis.$argument);
};

const cases = [
  ["未设置（ctx.env 为空）", {}, false],
  ["no env at all", undefined, false],
  ["显式 false", { blockUpload: "false" }, false],
  ["显式 true", { blockUpload: "true" }, true],
  ["大写 TRUE", { blockUpload: "TRUE" }, true],
  ["1", { blockUpload: "1" }, true],
  ["off", { blockUpload: "off" }, false],
  ["0", { blockUpload: "0" }, false],
  ["空串", { blockUpload: "" }, false],
  ["非法值 garbage", { blockUpload: "garbage" }, false],
  ["非法值 enabled", { blockUpload: "enabled" }, false],
  ["前后空格 \" true \"", { blockUpload: " true " }, true],
];
for (const [label, env, want] of cases) {
  const arg = await run(env);
  check(KEYS.every(k => arg[k] === false || (k === "blockUpload" && want === true)),
        `${label} → blockUpload=${arg.blockUpload}（期望 ${want}）`);
  check(typeof arg === "object" && Object.keys(arg).length === 8, `${label} → $argument 仍含 8 个键`);
  if (want) check(KEYS.filter(k => arg[k] === true).length === 1, `${label} → 仅打开的键为 true`);
}
rmSync(dir, { recursive: true, force: true });

console.log(fails ? `\n[FAIL] ${fails} 项未通过` : "\n[PASS] 开关默认关 + 开关桥全部通过");
process.exit(fails ? 1 : 0);
