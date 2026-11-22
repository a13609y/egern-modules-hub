/**
 * ⛽ 全国实时油价小组件 v4.6.3（Egern 模块版 · 预测统一元/升 + 四油品区间（汽油/柴油密度换算）/ 中号右栏三块 36pt 铺满 / 三尺寸预测文案精简）
 *
 * 现价源：http://m.qiyoujiage.com/（省份 / 城市页面）
 * 历史源：BesFuel（https://github.com/BensonLaur/BesFuel）已核实的发改委调价历史（元/升，真实节点）
 * 预测源：极数本源 全国油价 API（POST https://v1.apizero.cn/api/oil-price，文档 https://apizero.cn/aidocs/oil-price）
 *
 * 数据诚实性（不要造假数据）
 * ─────────────────────────────────────────────────────────────
 * - 「最近调价」的日期 / 方向 / 幅度来自站点页面 tishi 文本（真实），或 BesFuel 最新官方节点
 * - 「涨跌预测」只来自文档写明的 data.forecast 文本（方向 + 元/升区间 / 元/吨；只有统一吨价时按
 *   汽油 0.725 kg/L、柴油 0.835 kg/L 换算成四油品元/升区间并标「约」，不编造 92/95/98 标号差异），且必须同时满足：
 *   预测窗口（data.next_adjustment 的月日）在未来、缓存不超过 15 天；任一不满足就显示「暂无预测」。
 *   历史幅度、过期窗口、本地 10 工作日推算一律不进预测位，绝不把老数据/推算说成预测。
 * - 「下轮预计调价时间」优先用文档 data.next_adjustment 的月/日（标「服务提示」）；无则回退
 *   BesFuel 窗口或本地 10 工作日推算（标「预计」）；窗口已过期显示「待更新」。
 * - 请求配额：文档写明未带 Key 每天 5 次 / QPS 2；本脚本自设北京时区每天最多 1 次请求，
 *   失败也算一次、不即时重试，429（4029 QPS / 4030 额度）当天封停。三尺寸共用同一 storage
 *   缓存与预算键；跨设备 / 跨进程无硬保证（Egern storage 无原子 CAS），读不到预算即故障关闭。
 * - API Key 只放本机 Egern 模块参数（默认空），绝不写入仓库、日志或聊天内容。
 * - 走势图优先用 BesFuel 快照里逐期核实的官方调价历史（最多 10 个真实节点，普通直线连接，
 *   缺口断线、「不作调整」空心点）；未收录则不画曲线，只用本脚本真实抓到的价格快照兜底。
 */

const PAD2 = (n) => String(n).padStart(2, "0");
const MD = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
const MDs = (d) => `${d.getMonth() + 1}/${d.getDate()}`;   // 紧凑日期：宽预算紧张的行用（同图表横轴风格）
const YMD = (d) => `${d.getFullYear()}-${PAD2(d.getMonth() + 1)}-${PAD2(d.getDate())}`;

/** 10 个工作日（跳过周六周日；不含法定节假日调整，故只称「预计」） */
function addWorkdays(date, n) {
  const d = new Date(date.getTime());
  let c = 0;
  while (c < n) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) c++;
  }
  return d;
}

function b64(str) {
  // UTF-8 字节化后再 Base64（SVG 里含中文「第N轮」，不能按 charCode 直接编码）
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  const C = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i], b2 = bytes[i + 1], b3 = bytes[i + 2];
    out += C[b1 >> 2];
    out += C[((b1 & 3) << 4) | ((b2 === undefined ? 0 : b2) >> 4)];
    out += b2 === undefined ? "=" : C[((b2 & 15) << 2) | ((b3 === undefined ? 0 : b3) >> 6)];
    out += b3 === undefined ? "=" : C[b3 & 63];
  }
  return out;
}

/**
 * 官方核价历史走势图（纯字符串 SVG，无外部资源，最多渲染最近 10 个真实节点）。
 * 语义对齐 BesFuel：横轴 = 真实「价格执行/公告日期」，纵轴 = 元/升；相邻真实节点之间用普通直线连接，
 * 直线只表示两次真实调价之间的价差趋势（不是逐日价格，也不插入虚构调价）；浅橙渐变面积仅作视觉填充；
 * 历史缺口处断线（不跨缺口连线、不填充缺口），官方「不作调整」为空心节点；
 * 末点用绿色大圆强调，不写价格标签（参考图无末点价签，避免压线/压节点）。
 * points: [{ v:number, d:"YYYY-MM-DD", kind:"price"|"unchanged" }]
 * opt: { w, h, gaps:number[](断线起点索引，基于传入的完整序列), labels:string[](与 points 等长) }
 */
function chartSVG(points, opt) {
  const W = Math.max(120, Math.round(opt.w));
  const H = Math.max(46, Math.round(opt.h));
  const MAXP = 10;
  const srcN = points.length;
  const cut = srcN > MAXP ? srcN - MAXP : 0;   // 只截取最近 10 个真实节点，不改写时间/价格
  const pts = cut ? points.slice(cut) : points;
  const n = pts.length;
  const vals = pts.map((p) => p.v);
  const padL = Math.round(Math.min(30, Math.max(25, W * 0.12)));
  const padR = 11, padT = 10, padB = 16;
  const iw = Math.max(20, W - padL - padR);
  const ih = Math.max(16, H - padT - padB);
  const yBase = padT + ih;
  const dmin = Math.min(...vals), dmax = Math.max(...vals);
  const span = dmax - dmin;
  let lo, hi;
  if (!(span > 0.02)) { lo = dmin - 0.05; hi = dmax + 0.05; }
  else { lo = dmin - span * 0.22; hi = dmax + span * 0.22; }
  const X = (i) => (n === 1 ? padL + iw / 2 : padL + (iw * i) / (n - 1));
  const Y = (v) => padT + ih * (1 - (v - lo) / (hi - lo));
  const LINE = "#FF9F0A", GREEN = "#34C759", GRID = "#8E8E93", TXT = "#8E8E93";
  const gaps = (Array.isArray(opt.gaps) ? opt.gaps : []).map((i) => i - cut).filter((i) => i > 0 && i < n);
  let s = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}'>`;
  s += "<defs><linearGradient id='fillg' x1='0' y1='0' x2='0' y2='1'>" +
    `<stop offset='0' stop-color='${LINE}' stop-opacity='0.34'/>` +
    `<stop offset='0.7' stop-color='${LINE}' stop-opacity='0.11'/>` +
    `<stop offset='1' stop-color='${LINE}' stop-opacity='0.02'/></linearGradient></defs>`;

  // Y 轴刻度：只刻真实价格（最大 / 中值 / 最小），不虚构数值；文字夹在画布内不切边
  const ticks = (dmax - dmin) < 0.005 ? [dmax] : H >= 56 ? [dmax, (dmax + dmin) / 2, dmin] : [dmax, dmin];
  ticks.forEach((v) => {
    const y = +Y(v).toFixed(1);
    if (y > padT + 0.5 && y < yBase - 0.5) {
      s += `<line x1='${padL}' y1='${y}' x2='${W - padR}' y2='${y}' stroke='${GRID}' stroke-opacity='0.20' stroke-width='0.7' stroke-dasharray='2 3'/>`;
    }
    const ty = Math.min(yBase - 1, Math.max(padT + 6, y + 2.4)).toFixed(1);
    s += `<text x='${padL - 4}' y='${ty}' font-size='7' fill='${TXT}' text-anchor='end'>${v.toFixed(2)}</text>`;
  });
  // 大图加淡淡竖网格（每个真实节点一条），小图省略以免显脏
  if (H >= 90) {
    for (let i = 0; i < n; i++) {
      s += `<line x1='${X(i).toFixed(1)}' y1='${padT}' x2='${X(i).toFixed(1)}' y2='${yBase}' stroke='${GRID}' stroke-opacity='0.10' stroke-width='0.6'/>`;
    }
  }

  // 缺口分段：每段是一串连续的真实节点，段与段之间不连线、不填充
  const runs = [];
  let cur = [];
  for (let i = 0; i < n; i++) {
    const p = { x: +X(i).toFixed(1), y: +Y(vals[i]).toFixed(1) };
    if (i === 0 || gaps.includes(i)) { if (cur.length) runs.push(cur); cur = [p]; }
    else cur.push(p);
  }
  if (cur.length) runs.push(cur);

  // 浅橙渐变面积：只在有 ≥2 个连续节点的段内封闭到基线
  let fd = "";
  for (const r of runs) {
    if (r.length < 2) continue;
    fd += `M${r[0].x.toFixed(1)} ${yBase.toFixed(1)} ` +
      r.map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") +
      ` L${r[r.length - 1].x.toFixed(1)} ${yBase.toFixed(1)} Z `;
  }
  if (fd) s += `<path d='${fd.trim()}' fill='url(#fillg)' stroke='none'/>`;

  // 普通折线（直线连接真实节点）；缺口处 M 重新起笔
  let ld = "";
  for (const r of runs) {
    ld += `M${r[0].x.toFixed(1)} ${r[0].y.toFixed(1)} ` +
      r.slice(1).map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + " ";
  }
  if (ld) s += `<path d='${ld.trim()}' fill='none' stroke='${LINE}' stroke-width='${H >= 90 ? 2.2 : 1.9}' stroke-linejoin='round' stroke-linecap='round'/>`;

  // 节点圆点：普通实心橙、官方「不作调整」空心；末点最后画绿色大圆（强调，不写价签）
  const rBase = H >= 90 ? 3 : 2.3;
  for (let i = 0; i < n - 1; i++) {
    const x = X(i).toFixed(1), y = Y(vals[i]).toFixed(1);
    if (pts[i].kind === "unchanged") s += `<circle cx='${x}' cy='${y}' r='${rBase}' fill='none' stroke='${LINE}' stroke-width='1.2'/>`;
    else s += `<circle cx='${x}' cy='${y}' r='${rBase}' fill='${LINE}'/>`;
  }
  const lx = X(n - 1).toFixed(1), ly = Y(vals[n - 1]).toFixed(1);
  const rLast = H >= 90 ? 5 : 4.2;
  if (pts[n - 1].kind === "unchanged") s += `<circle cx='${lx}' cy='${ly}' r='${rLast}' fill='none' stroke='${GREEN}' stroke-width='2'/>`;
  else s += `<circle cx='${lx}' cy='${ly}' r='${rLast}' fill='${GREEN}'/>`;

  // 横轴：首 / 中 / 尾真实日期（M/D），先量宽再决定是否画中间标签，保证不切边、不互相遮挡
  if (opt.labels && opt.labels.length === srcN) {
    const lfs = 7;
    const lw = (t) => String(t).length * lfs * 0.58;
    const first = opt.labels[cut], lastL = opt.labels[srcN - 1];
    if (n === 1) {
      s += `<text x='${(padL + (W - padR)) / 2}' y='${H - 3}' font-size='${lfs}' fill='${TXT}' text-anchor='middle'>${lastL}</text>`;
    } else {
      s += `<text x='${padL}' y='${H - 3}' font-size='${lfs}' fill='${TXT}' text-anchor='start'>${first}</text>`;
      s += `<text x='${W - padR}' y='${H - 3}' font-size='${lfs}' fill='${TXT}' text-anchor='end'>${lastL}</text>`;
    }
    if (n >= 4) {
      const mt = opt.labels[cut + Math.floor((n - 1) / 2)];
      const mx = (padL + (W - padR)) / 2;
      if (mx - lw(mt) / 2 > padL + lw(first) + 3 && mx + lw(mt) / 2 < W - padR - lw(lastL) - 3) {
        s += `<text x='${mx.toFixed(1)}' y='${H - 3}' font-size='${lfs}' fill='${TXT}' text-anchor='middle'>${mt}</text>`;
      }
    }
  }
  s += "</svg>";
  return "data:image/svg+xml;base64," + b64(s);
}

export default async function (ctx) {
  // ════════════════════════════════════════════════════════════
  // 1. 参数解析（地区 / 趋势 / 刷新间隔 / 油品 / 升数）
  // ════════════════════════════════════════════════════════════
  const rawRegion = String(
    ctx.env.region ?? ctx.env.REGION ?? ctx.env.city ?? ctx.env.CITY ?? ""
  ).trim();

  const PROV = {
    "北京":"beijing","上海":"shanghai","天津":"tianjin","重庆":"chongqing",
    "广东":"guangdong","江苏":"jiangsu","浙江":"zhejiang","山东":"shandong",
    "河南":"henan","河北":"hebei","四川":"sichuan","湖北":"hubei","湖南":"hunan",
    "安徽":"anhui","福建":"fujian","江西":"jiangxi","辽宁":"liaoning",
    "陕西":"shanxi-3","海南":"hainan","山西":"shanxi","吉林":"jilin",
    "黑龙江":"heilongjiang","云南":"yunnan","贵州":"guizhou","广西":"guangxi",
    "甘肃":"gansu","青海":"qinghai","宁夏":"ningxia","新疆":"xinjiang",
    "西藏":"xizang","内蒙古":"neimenggu",
  };
  const CITY = {
    "广州":"guangzhou","深圳":"shenzhen","珠海":"zhuhai","东莞":"dongguan","佛山":"foshan",
    "南京":"nanjing","苏州":"suzhou","无锡":"wuxi","常州":"changzhou","杭州":"hangzhou",
    "宁波":"ningbo","温州":"wenzhou","济南":"jinan","青岛":"qingdao","烟台":"yantai",
    "郑州":"zhengzhou","洛阳":"luoyang","石家庄":"shijiazhuang","唐山":"tangshan",
    "保定":"baoding","成都":"chengdu","绵阳":"mianyang","武汉":"wuhan","宜昌":"yichang",
    "长沙":"changsha","株洲":"zhuzhou","合肥":"hefei","芜湖":"wuhu","福州":"fuzhou",
    "厦门":"xiamen","泉州":"quanzhou","南昌":"nanchang","赣州":"ganzhou","沈阳":"shenyang",
    "大连":"dalian","西安":"xian","海口":"haikou","三亚":"sanya","太原":"taiyuan",
    "长春":"changchun","哈尔滨":"haerbin","昆明":"kunming","贵阳":"guiyang",
    "南宁":"nanning","桂林":"guilin","兰州":"lanzhou","西宁":"xining",
    "银川":"yinchuan","乌鲁木齐":"wulumuqi","拉萨":"lasa","呼和浩特":"huhehaote",
  };
  const CITY_PROV = {
    "广州":"广东","深圳":"广东","珠海":"广东","东莞":"广东","佛山":"广东",
    "南京":"江苏","苏州":"江苏","无锡":"江苏","常州":"江苏",
    "杭州":"浙江","宁波":"浙江","温州":"浙江",
    "济南":"山东","青岛":"山东","烟台":"山东",
    "郑州":"河南","洛阳":"河南","石家庄":"河北","唐山":"河北","保定":"河北",
    "成都":"四川","绵阳":"四川","武汉":"湖北","宜昌":"湖北",
    "长沙":"湖南","株洲":"湖南","合肥":"安徽","芜湖":"安徽",
    "福州":"福建","厦门":"福建","泉州":"福建","南昌":"江西","赣州":"江西",
    "沈阳":"辽宁","大连":"辽宁","西安":"陕西","海口":"海南","三亚":"海南",
    "太原":"山西","长春":"吉林","哈尔滨":"黑龙江","昆明":"云南","贵阳":"贵州",
    "南宁":"广西","桂林":"广西","兰州":"甘肃","西宁":"青海","银川":"宁夏",
    "乌鲁木齐":"新疆","拉萨":"西藏","呼和浩特":"内蒙古",
  };

  let regionParam = rawRegion
    .replace(/^https?:\/\/[^/]+\//i, "")
    .replace(/\.s?html?$/i, "")
    .replace(/\\/g, "/")
    .replace(/\s+/g, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();

  if (/[\u4e00-\u9fa5]/.test(regionParam)) {
    const segs = regionParam.split(/[\/、,，]/).filter(Boolean);
    const cn = [...new Set(segs)].join("");
    if (PROV[cn]) regionParam = PROV[cn];
    else if (segs.length === 2 && PROV[segs[0]] && CITY[segs[1]]) regionParam = PROV[segs[0]] + "/" + CITY[segs[1]];
    else if (cn.length > 2 && PROV[cn.slice(0, 2)] && CITY[cn.slice(2)]) regionParam = PROV[cn.slice(0, 2)] + "/" + CITY[cn.slice(2)];
    else if (CITY[cn]) regionParam = (CITY_PROV[cn] ? PROV[CITY_PROV[cn]] + "/" : "") + CITY[cn];
    else regionParam = "";
  }

  const validRegion = /^[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(regionParam);
  const regionInvalid = !validRegion;
  if (!validRegion) regionParam = "hainan/haikou";
  const regionCandidates = regionParam.includes("/")
    ? [regionParam, regionParam.split("/")[0]]
    : [regionParam];

  // ── BesFuel 官方核价历史：地区/油品映射 ─────────────────────────
  // BesFuel（MIT 代码）把各地发改委公告逐期核成 data/prices.json 的 region.grades[].history，
  // 节点是「价格执行日 + 元/升」，这才是真实逐轮历史；本组件只读取该快照，不自行推算价格。
  const revProv = {};
  Object.keys(PROV).forEach((cn) => { revProv[PROV[cn]] = cn; });
  const revCity = {};
  Object.keys(CITY).forEach((cn) => { revCity[CITY[cn]] = cn; });
  let cnProv = revProv[regionParam.split("/")[0]] || "";
  let cnCity = "";
  if (regionParam.includes("/")) {
    const c = revCity[regionParam.split("/")[1]];
    if (c) { cnCity = c; if (!cnProv) cnProv = CITY_PROV[c] || ""; }
  }
  // 省级默认价区（BesFuel 无「全省唯一价」时取该省主价区，图注会显示 BesFuel 的完整价区名）
  const BF_PROV = {
    "北京": "beijing", "天津": "tianjin", "上海": "shanghai", "重庆": "chongqing",
    "河北": "hebei", "山西": "shanxi", "内蒙古": "inner-mongolia-east", "吉林": "jilin",
    "黑龙江": "heilongjiang-south", "江苏": "jiangsu", "浙江": "zhejiang", "安徽": "anhui",
    "福建": "fujian", "江西": "jiangxi", "山东": "shandong", "河南": "henan", "湖南": "hunan",
    "广东": "guangdong", "广西": "guangxi", "海南": "hainan", "四川": "sichuan-zone1",
    "贵州": "guizhou-zone1", "云南": "yunnan-kunming", "西藏": "xizang-lhasa",
    "陕西": "shaanxi-midnorth", "青海": "qinghai-zone1", "宁夏": "ningxia",
    "新疆": "xinjiang-karamay-main",
  };
  const BF_CITY = {
    "西安": "shaanxi-xian", "汉中": "shaanxi-south", "安康": "shaanxi-south", "商洛": "shaanxi-south",
    "昆明": "yunnan-kunming", "曲靖": "yunnan-zone2", "楚雄": "yunnan-zone2", "玉溪": "yunnan-zone2",
    "昭通": "yunnan-zone3", "红河": "yunnan-zone3", "文山": "yunnan-zone3", "大理": "yunnan-zone3",
    "普洱": "yunnan-zone4", "保山": "yunnan-zone4", "丽江": "yunnan-zone4",
    "西双版纳": "yunnan-zone5", "德宏": "yunnan-zone5", "迪庆": "yunnan-zone5", "怒江": "yunnan-zone5", "临沧": "yunnan-zone5",
    "拉萨": "xizang-lhasa", "昌都": "xizang-changdu", "阿里": "xizang-ngari",
    "克拉玛依": "xinjiang-karamay-main", "独山子": "xinjiang-dushanzi",
    "呼和浩特": "inner-mongolia-west", "包头": "inner-mongolia-west", "鄂尔多斯": "inner-mongolia-west",
    "乌海": "inner-mongolia-west", "巴彦淖尔": "inner-mongolia-west", "阿拉善": "inner-mongolia-west",
  };
  const bfKey = regionInvalid ? null : (cnCity && BF_CITY[cnCity]) || BF_PROV[cnProv] || null;
  const BF_GRADE = { p92: "92", p95: "95", p98: "98", diesel: "diesel" };
  const BF_URLS = [
    "https://raw.githubusercontent.com/BensonLaur/BesFuel/main/data/prices.json",
    "https://gcore.jsdelivr.net/gh/BensonLaur/BesFuel@main/data/prices.json",
    "https://bensonlaur.github.io/BesFuel/data/prices.json",
  ];
  const BF_TTL = 6 * 3600 * 1000;
  const BF_CACHE = `oilprice_bf_v1_${bfKey || "none"}`;
  const bfHostOf = (u) => (String(u).match(/^https?:\/\/([^/]+)/) || [])[1] || "BesFuel";

  /** 从 BesFuel 快照里摘出本地区的四种油品历史（只保留事实字段，附带来源域名与核对日期） */
  function bfSlice(json, key) {
    if (!json || typeof json !== "object" || !json.regions || typeof json.regions !== "object") return null;
    const r = json.regions[key];
    if (!r || !r.grades || typeof r.grades !== "object") return null;
    const gaps = (Array.isArray(r.historyGaps) ? r.historyGaps : [])
      .filter((g) => g && /^\d{4}-\d{2}-\d{2}$/.test(String(g.date)))
      .map((g) => String(g.date));
    const checked = String(r.checkedAt || json.checkedAt || "");
    const notice = r.latestNotice && typeof r.latestNotice === "object" ? r.latestNotice : {};
    const grades = {};
    for (const gk of ["92", "95", "98", "diesel"]) {
      const e = r.grades[gk];
      if (!e || !Array.isArray(e.history)) continue;
      const pts = e.history
        .filter((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) && isFinite(x.price) && x.price >= 0)
        .map((x) => ({ date: String(x.date), price: +x.price, kind: "price" }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      if (!pts.length) continue;
      const last = pts[pts.length - 1];
      // 与 BesFuel lib/history.js 同一规则：已核实的「不作调整」是观察节点（空心），不是新的价格生效日
      if (notice.kind === "unchanged" && /^\d{4}-\d{2}-\d{2}$/.test(String(notice.date)) &&
          String(notice.date) > last.date && /^\d{4}-\d{2}-\d{2}$/.test(checked) &&
          String(notice.date) <= checked && notice.sourceUrl &&
          isFinite(e.price) && Math.abs(+e.price - last.price) < 0.005 &&
          !gaps.some((d) => d > last.date && d <= String(notice.date))) {
        pts.push({ date: String(notice.date), price: last.price, kind: "unchanged" });
      }
      grades[gk] = { price: isFinite(e.price) ? +e.price : last.price, history: pts.slice(-36) };
    }
    if (!Object.keys(grades).length) return null;
    const na = json.nationalAdjustment && typeof json.nationalAdjustment === "object" ? json.nationalAdjustment : {};
    const nw = na.nextAdjustment && typeof na.nextAdjustment === "object" ? na.nextAdjustment : {};
    // 下轮幅度：只有快照里携带真实金额（forecast.amountPerLiter）时才采信，并原样带来源
    const fcRaw = na.forecast && typeof na.forecast === "object" ? na.forecast : null;
    let fc = null;
    if (fcRaw) {
      const amt = parseFloat(fcRaw.amountPerLiter);
      const dRaw = String(fcRaw.direction || "").toLowerCase();
      const dir = /涨|升|up/.test(dRaw) ? "up" : /跌|降|down/.test(dRaw) ? "down" : /平|搁浅|flat/.test(dRaw) ? "flat" : "";
      const win = /^\d{4}-\d{2}-\d{2}$/.test(String(fcRaw.windowDate || "")) ? String(fcRaw.windowDate) : "";
      if (dir && isFinite(amt) && amt > 0) fc = { dir, amt, window: win, src: String(fcRaw.sourceName || ""), updated: String(fcRaw.updatedAt || "") };
    }
    return {
      key, name: String(r.name || key), checkedAt: checked,
      priceScope: String(r.priceScope || ""), gaps, grades, fc,
      nextDate: /^\d{4}-\d{2}-\d{2}$/.test(String(nw.date || "")) ? String(nw.date) : "",
      nextLabel: String(nw.dateLabel || ""),
      nextSrc: String(nw.sourceName || ""),
      nextUrl: String(nw.sourceUrl || ""),
    };
  }

  /** 读取并缓存历史切片；6 小时内复用缓存，源失效时退回旧缓存并标记 stale */
  async function bfLoad() {
    let cached = null;
    try { cached = ctx.storage.getJSON(BF_CACHE); } catch (_) {}
    const usable = cached && cached.grades && cached.grades[BF_GRADE[FUEL_KEY]];
    if (usable && cached.fetchedAt && Date.now() - cached.fetchedAt < BF_TTL) {
      return { slice: cached, stale: false, err: "" };
    }
    const started = Date.now();
    let err = "";
    for (const url of BF_URLS) {
      if (Date.now() - started > 13000) { err = err || "历史源总超时"; break; }
      try {
        const resp = await ctx.http.get(url, {
          headers: { "user-agent": "EgernOilWidget/4.1 (BesFuel official-price history)", accept: "application/json" },
          timeout: 6000,
        });
        if (!resp || resp.status !== 200) { err = `HTTP ${resp ? resp.status : "?"}`; continue; }
        const txt = await resp.text();
        if (!txt || txt.length < 1000) { err = "响应过短"; continue; }
        let json = null;
        try { json = JSON.parse(txt); } catch (_) { err = "JSON 解析失败"; continue; }
        const slice = bfSlice(json, bfKey);
        if (!slice) { err = "缺少该地区数据"; continue; }
        slice.fetchedAt = Date.now();
        slice.source = bfHostOf(url);
        slice.sourceUrl = url;
        try { ctx.storage.setJSON(BF_CACHE, slice); } catch (_) {}
        return { slice, stale: false, err: "" };
      } catch (e) { err = (e && e.message) || "网络错误"; }
    }
    if (usable) return { slice: cached, stale: true, err };
    return { slice: null, stale: true, err };
  }

  // 默认打开：未配置（undefined）、空串（模块模板未填）都按 true 处理，只有显式 false/0/no/off 才关
  const trendRaw = String(ctx.env.SHOW_TREND ?? "true").trim().toLowerCase();
  const SHOW_TREND = !["false", "0", "no", "off", "hide", "隐藏"].includes(trendRaw);

  const fuelRaw = String(ctx.env.FUEL ?? "95").trim().toLowerCase();
  const FUEL_KEY = /98/.test(fuelRaw) ? "p98"
    : /92/.test(fuelRaw) ? "p92"
    : /(柴油|0号|diesel)/.test(fuelRaw) ? "diesel"
    : "p95";
  const FUEL_LABEL = { p92: "92号", p95: "95号", p98: "98号", diesel: "柴油" }[FUEL_KEY];

  let liters = parseFloat(String(ctx.env.FULL_LITERS ?? "50"));
  if (!isFinite(liters) || liters <= 0 || liters > 200) liters = 50;

  const family = String(ctx.widgetFamily ?? "systemMedium");
  const isSmall = family === "systemSmall";
  const isLarge = family === "systemLarge" || family === "systemExtraLarge";
  const isAccessory = /^accessory/.test(family);

  const now = new Date();
  const timeStr = `${PAD2(now.getHours())}:${PAD2(now.getMinutes())}`;
  let refreshHours = parseFloat(String(ctx.env.REFRESH_HOURS ?? "6"));
  if (!isFinite(refreshHours) || refreshHours < 1 || refreshHours > 24) refreshHours = 6;
  const refreshTime = new Date(Date.now() + refreshHours * 3600 * 1000).toISOString();

  // ════════════════════════════════════════════════════════════
  // 2. 调色板（深浅色自适应）
  // ════════════════════════════════════════════════════════════
  const backgroundColor = { light: "#FFFFFF", dark: "#1C1C1E" };
  const COLORS = {
    primary:    { light: "#111111", dark: "#FFFFFF" },
    secondary:  { light: "#6B6B70", dark: "#C7C7CC" },
    tertiary:   { light: "#9A9A9F", dark: "#8E8E93" },
    card:       { light: "#F7F7F9", dark: "#2C2C2E" },
    cardBorder: { light: "#E8E8EC", dark: "#3A3A3C" },
    up:         { light: "#FF3B30", dark: "#FF6B6B" },
    down:       { light: "#16A34A", dark: "#34D399" },
    p92:        { light: "#FF9F0A", dark: "#FFB347" },
    p95:        { light: "#FF7A1A", dark: "#FF8F4D" },
    p98:        { light: "#FF3B30", dark: "#FF6B6B" },
    diesel:     { light: "#2E9E4B", dark: "#4CD07A" },
  };
  const tint = (c, a) => ({ light: c.light + a, dark: c.dark + a });

  // ── 中/大号专属配色（参考图：同色系浅底卡 + 同色标签 + 黑色大单价；浅/深色各一套）
  //    只给中/大号用，small 仍走上面的 COLORS，结构与配色逐字不变。
  const MC = {
    pump:   { light: "#FF9F0A", dark: "#FFB347" },
    p92:    { light: "#E08700", dark: "#FFC061" },
    p95:    { light: "#EE6B3B", dark: "#FF9E75" },
    p98:    { light: "#E4473F", dark: "#FF8177" },
    diesel: { light: "#1E9C53", dark: "#5FD98A" },
    bg: {
      p92:    tint({ light: "#FF9F0A", dark: "#FFB347" }, "2B"),
      p95:    tint({ light: "#FF7A1A", dark: "#FF8F4D" }, "2B"),
      p98:    tint({ light: "#FF3B30", dark: "#FF6B6B" }, "29"),
      diesel: tint({ light: "#2E9E4B", dark: "#4CD07A" }, "2B"),
    },
  };

  // ════════════════════════════════════════════════════════════
  // 3. 缓存读取 + 抓取（保持原有接口 / 超时 / 兜底策略）
  // ════════════════════════════════════════════════════════════
  const CACHE_KEY = `oilprice_v31_${regionInvalid ? "__invalid__" : regionParam}`;
  let prices = { p92: null, p95: null, p98: null, diesel: null };
  let regionName = "";
  let adj = null;                       // { month, day, dir, range, unit }
  let hist = [];                        // [{ d:"YYYY-MM-DD", v:{p92..} }]
  let hasCache = false;

  try {
    const cached = ctx.storage.getJSON(CACHE_KEY);
    if (cached && cached.prices) {
      prices = cached.prices;
      regionName = cached.regionName || "";
      adj = cached.adj || null;
      hist = Array.isArray(cached.hist) ? cached.hist.filter((h) => h && h.d && h.v) : [];
      hasCache = true;
    }
  } catch (_) {}

  let fetchError = false;
  let errorMsg = "";

  if (regionInvalid) {
    fetchError = true;
    errorMsg = "地区参数无效";
  } else try {
    let html = "";
    let lastStatus = 0;
    for (const cand of regionCandidates) {
      const resp = await ctx.http.get(`http://m.qiyoujiage.com/${cand}.shtml`, {
        headers: {
          referer: "http://m.qiyoujiage.com/",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
        timeout: 15000,
      });
      lastStatus = resp.status;
      if (resp.status === 200) { html = await resp.text(); break; }
    }
    if (!html) throw new Error(`HTTP ${lastStatus}: 页面不存在`);

    const titleMatch = html.match(/<title>([^_]+)_/);
    if (titleMatch?.[1]) {
      regionName = titleMatch[1].trim().replace(/(油价|实时|今日|最新|查询|价格)/g, "").trim();
    }

    // 汽柴油价格
    const regPrice = /<dl>[\s\S]+?<dt>(.*油)<\/dt>[\s\S]+?<dd>(.*)\(元\)<\/dd>/gm;
    const priceList = [];
    let m = null;
    while ((m = regPrice.exec(html)) !== null) {
      if (m.index === regPrice.lastIndex) regPrice.lastIndex++;
      priceList.push({ name: m[1].trim(), value: m[2].trim() });
    }

    if (priceList.length >= 3) {
      const nameMap = {
        "92 号": "p92", "92": "p92",
        "95 号": "p95", "95": "p95",
        "98 号": "p98", "98": "p98",
        "0 号": "diesel", "柴油": "diesel",
      };
      const next = { p92: null, p95: null, p98: null, diesel: null };
      priceList.forEach((item) => {
        const key = Object.keys(nameMap).find((k) => item.name.includes(k));
        if (key) {
          const v = parseFloat(item.value);
          if (!isNaN(v)) next[nameMap[key]] = v;
        }
      });
      prices = next;

      // 调价信息（站点 tishi 文本，真实数据；不含变化率，所以不做幅度预测）
      if (SHOW_TREND) {
        const tIdx = html.indexOf('class="tishi"');
        const seg = tIdx >= 0 ? html.slice(tIdx, tIdx + 900) : "";
        if (seg) {
          const segText = seg
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<br\s*\/?>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ");
          const dm = segText.match(/(\d{1,2})月(\d{1,2})日/);
          const dirWord = (segText.match(/(下跌|下调|上涨|上调|搁浅)/) || [])[1] || "";
          const perL = (segText.match(/([\d.]+)\s*元\/升/g) || []).map((x) => x.match(/([\d.]+)/)[1]);
          let range = "", unit = "元/升";
          if (perL.length >= 2) range = `${perL[0]}-${perL[1]}`;
          else if (perL.length === 1) range = perL[0];
          else {
            const perT = (segText.match(/([\d.]+)\s*元(?:\/吨)?/g) || []).map((x) => x.match(/([\d.]+)/)[1]);
            if (perT.length >= 2) { range = `${perT[0]}-${perT[1]}`; unit = "元/吨"; }
            else if (perT.length === 1) { range = perT[0]; unit = "元/吨"; }
          }
          if (dm) {
            adj = {
              month: +dm[1],
              day: +dm[2],
              dir: /下跌|下调|搁浅/.test(dirWord) ? (dirWord === "搁浅" ? "flat" : "down")
                 : /上涨|上调/.test(dirWord) ? "up" : "flat",
              range,
              unit,
            };
          }
        }
      }

      // 真实价格快照：点日期用网页给出的最近调价日（真实），无则用今天。
      // 同日期只更新数值；价格没变不新增点（不重复填点、不伪造历史）。
      let pd = YMD(now);
      if (adj && adj.month && adj.day) {
        const ad = new Date(now.getFullYear(), adj.month - 1, adj.day);
        if (ad.getTime() - now.getTime() > 45 * 86400000) ad.setFullYear(now.getFullYear() - 1);
        if (ad.getTime() <= now.getTime()) pd = YMD(ad);
      }
      const snap = { p92: prices.p92, p95: prices.p95, p98: prices.p98, diesel: prices.diesel };
      if (hist.length === 0) {
        hist.push({ d: pd, v: snap });
      } else {
        const lastRec = hist[hist.length - 1];
        const changed = ["p92", "p95", "p98", "diesel"].some(
          (k) => snap[k] !== null && lastRec.v[k] !== null && lastRec.v[k] !== undefined && Math.abs(snap[k] - lastRec.v[k]) >= 0.005
        );
        if (lastRec.d === pd) lastRec.v = snap;
        else if (changed) hist.push({ d: pd > lastRec.d ? pd : YMD(now), v: snap });
        else { /* 价格未变：不新增点，避免用重复点人为拉长曲线 */ }
      }
      if (hist.length > 12) hist = hist.slice(hist.length - 12);

      ctx.storage.setJSON(CACHE_KEY, { prices, regionName, adj, hist });
    } else {
      if (!hasCache) { fetchError = true; errorMsg = "解析失败"; }
    }
  } catch (e) {
    if (!hasCache) { fetchError = true; errorMsg = e.message; }
  }

  // 官方核价历史（BesFuel 快照，独立于现价源：现价失败也照常尝试，历史失败也不影响现价）
  let bf = null, bfStale = false, bfErr = "", bfReason = "";
  if (SHOW_TREND && !isSmall && !isAccessory && !regionInvalid) {
    if (!bfKey) bfReason = "uncovered";
    else {
      const r = await bfLoad();
      bf = r.slice; bfStale = !!r.stale; bfErr = r.err || "";
      if (!bf) bfReason = "fail";
    }
  }

  // ════════════════════════════════════════════════════════════
  // 3b. 官方涨跌预测（POST https://v1.apizero.cn/api/oil-price）
  //     合约只按官方文档实现（未实机试调）：鉴权 Authorization: Bearer <API Key>（可选，
  //     匿名每天 5 次 · QPS 2）；字段 data.update_date / data.prices[] / data.next_adjustment /
  //     data.forecast；forecast 是自然语言文本，单位见文档示例「预计下调630元/吨(0.48元/升-0.57元/升)」。
  //     配额：自设「北京时间每天最多 1 次」，失败也算一次、不即时重试，429 当天封停；
  //     三尺寸共用同一 storage 键（缓存 + 预算）；读不到预算即故障关闭（不发请求，只用缓存）。
  // ════════════════════════════════════════════════════════════
  const FC_URL = "https://v1.apizero.cn/api/oil-price";
  const FC_ON = !["false", "0", "no", "off", "hide", "隐藏"].includes(String(ctx.env.FORECAST ?? "true").trim().toLowerCase());
  const OIL_KEY = String(ctx.env.OIL_API_KEY ?? "").trim();   // 只放本机 Egern 参数：不打印、不落盘、不进仓库
  const FC_BUDGET = "oilprice_fc_budget_v1";                  // 三尺寸共享的请求预算（北京时间日界）
  const FC_DATA = `oilprice_fc_v1_${cnProv || "none"}`;       // 三尺寸共享的预测缓存
  const bjDay = (ms) => { const d = new Date(ms + 8 * 3600 * 1000); return `${d.getUTCFullYear()}-${PAD2(d.getUTCMonth() + 1)}-${PAD2(d.getUTCDate())}`; };

  // ── 单位归一 + 四油品区间（v4.6.2）：三尺寸预测统一「元/升」区间，与「最近调价」同单位 ────────
  //  文档 forecast 可能是「元/升」区间，也可能只给「元/吨」。只给吨价时按公开密度换算并标「约」=估算：
  //    汽油 92/95/98 共用 0.725 kg/L（GB 17930 车用汽油 20℃ 密度 0.720–0.775 的常用折算值）
  //      → 1 吨 = 1000 / 0.725 ≈ 1379.31 升
  //    柴油 0.835 kg/L → 1 吨 = 1000 / 0.835 ≈ 1197.60 升
  //  实测接口只给一个统一吨价（「预计下调油价390元/吨」，无分油号数据）→ 汽油、柴油各按自己密度换算：
  //    390 / 1379.31 ≈ 0.28（92/95/98 同值，绝不编造三个标号的细微差异）、390 / 1197.60 ≈ 0.33（柴油）
  //    → 四油品合成区间「↓约0.28-0.33」；换算后同值（如幅度极小）就不强做区间，仍显示单值。
  //  若 forecast 文本或接口行真给出分油品吨价（确证的分油号数据），逐油品换算后取最小–最大。
  const FC_VERSION = 4;
  const DENS = { gas: 0.725, diesel: 0.835 };
  const LPT_GAS = 1000 / DENS.gas, LPT_DIESEL = 1000 / DENS.diesel;   // ≈1379.31 / ≈1197.60
  const two = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const isDiesel = (x) => /diesel|柴油/i.test(String((x && (x.type || x.name)) || ""));
  const lptOf = (x) => (isDiesel(x) ? LPT_DIESEL : LPT_GAS);

  /** 吨价候选 → 元/升（按油品密度，est=true 标「约」）。去重后只剩一个值 → 单值（同值不强做区间）。 */
  function fcFromTons(list, dir) {
    const vals = [];
    for (const it of list) {
      const ton = Math.abs(Number(it && it.ton));
      if (!isFinite(ton) || ton <= 0) continue;
      const v = ton / lptOf(it);
      if (v >= 0.005) vals.push(+two(v));
    }
    const uniq = [...new Set(vals)].sort((a, b) => a - b);
    if (!uniq.length) return null;
    const lo = uniq[0], hi = uniq[uniq.length - 1];
    return { dir, amt: lo === hi ? two(lo) : `${two(lo)}-${two(hi)}`, unit: "元/升", est: true, basis: "ton", lo, hi, spread: lo !== hi };
  }

  /** 统一吨价（接口没说汽油/柴油）→ 汽油 + 柴油各按自己密度换算，合成四油品区间。 */
  function tonPair(tons) {
    const out = [];
    for (const t of tons) { out.push({ ton: t, type: "gasoline_92" }); out.push({ ton: t, type: "diesel_0" }); }
    return out;
  }

  /** 接口若真的给出分油品吨价（确证分油号数据，≥2 条）→ [{ton,type}]；否则 null（不猜、不补） */
  function perGradeTons(d) {
    const out = [];
    const arr = d && Array.isArray(d.prices) ? d.prices : [];
    for (const p of arr) {
      const n = p ? (p.change_per_ton ?? p.changePerTon ?? p.ton_change) : null;
      if (typeof n === "number" && isFinite(n) && n !== 0) out.push({ ton: Math.abs(n), type: String(p.type || p.name || "") });
    }
    const map = d ? (d.change_per_ton || d.ton_changes) : null;
    if (map && typeof map === "object") for (const k of Object.keys(map)) {
      const n = map[k];
      if (typeof n === "number" && isFinite(n) && n !== 0) out.push({ ton: Math.abs(n), type: k });
    }
    return out.length >= 2 ? out : null;
  }

  /** forecast 自然语言 → { dir, amt, unit:"元/升", est, basis, lo, hi }
   *  优先级：⓪ 确证分油品吨价（接口行）→ ① 明示「元/升」区间 → ② 明示「元/升」单值 → ③「分」
   *  → ④ 文本里分汽/柴油吨价 → ⑤ 统一吨价按汽油 0.725 + 柴油 0.835 两头换算成区间（est=true，标「约」）。
   *  解析不出或换算后 ≤0.00 → null（预测位写「暂无预测」，绝不显示吨价、绝不补数字）。 */
  function fcParse(txt, gradeTons) {
    const s = String(txt ?? "").replace(/\s+/g, "");
    if (!s) return null;
    const dir = /上调|上涨/.test(s) ? "up" : /下调|下跌/.test(s) ? "down" : /搁浅|不作调整|不调整|持平/.test(s) ? "flat" : "";
    if (!dir) return null;
    if (dir === "flat") return { dir, amt: "", unit: "元/升", est: false, basis: "flat" };
    if (Array.isArray(gradeTons) && gradeTons.length) {            // ⓪ 确证分油号吨价优先
      const r = fcFromTons(gradeTons, dir);
      if (r) return r;
    }
    const N = "([0-9]+(?:\\.[0-9]+)?)";
    const DASH = "(?:-|~|—|至|到)";
    // ① 元/升区间（单位可能只写在后面、也可能两边都写）
    let m = s.match(new RegExp(`${N}(?:元\\/升)?${DASH}${N}元\\/升`)) || s.match(new RegExp(`每升${N}${DASH}${N}元`));
    if (m) {
      const a = +m[1], b = +m[2];
      if (a >= 0.005 && b >= 0.005) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        return lo === hi
          ? { dir, amt: two(lo), unit: "元/升", est: false, basis: "litre", lo, hi: lo }
          : { dir, amt: `${two(lo)}-${two(hi)}`, unit: "元/升", est: false, basis: "litre", lo, hi };
      }
    }
    // ② 元/升单值
    m = s.match(new RegExp(`${N}元\\/升`)) || s.match(new RegExp(`每升${N}元`));
    if (m && +m[1] >= 0.005) return { dir, amt: two(+m[1]), unit: "元/升", est: false, basis: "litre", lo: +m[1], hi: +m[1] };
    // ③ 「分」口径：1 分 = 0.01 元/升
    m = s.match(new RegExp(`${N}分(?:钱)?(?:\\/升|每升)?`));
    if (m) { const v = +m[1] / 100; if (v >= 0.005) return { dir, amt: two(v), unit: "元/升", est: false, basis: "fen", lo: v, hi: v }; }
    // ④ 文本写明分汽/柴油吨价 → 各自密度换算；统一吨价放进 flatT 走 ⑤
    const gasT = [], dieT = [], flatT = [];
    for (const seg of s.split(/[，,、；;。]/)) {
      for (const x of seg.matchAll(new RegExp(`${N}元(?:\\/吨|每吨)`, "g"))) {
        const t = +x[1];
        if (!(t > 0)) continue;
        const g = /汽油|92号|95号|98号/.test(seg), dd = /柴油/.test(seg);
        if (g && !dd) gasT.push(t); else if (dd && !g) dieT.push(t); else flatT.push(t);
      }
    }
    if (gasT.length || dieT.length) {
      const list = [];
      for (const t of gasT) list.push({ ton: t, type: "gasoline_92" });
      for (const t of dieT) list.push({ ton: t, type: "diesel_0" });
      const r = fcFromTons(list, dir);
      if (r) return r;
    }
    // ⑤ 统一吨价（没说汽油/柴油）→ 汽油 + 柴油 两头 → 四油品区间（标「约」）
    if (flatT.length) return fcFromTons(tonPair(flatT), dir);
    // ⑥ 兜底：任意「X元/吨」写法（含区间）
    m = s.match(new RegExp(`${N}(?:元(?:\\/吨|每吨))?${DASH}${N}元(?:\\/吨|每吨)`));
    if (m) {
      const r = fcFromTons(tonPair([+m[1], +m[2]]), dir);
      if (r) return r;
    }
    m = s.match(new RegExp(`${N}元(?:\\/吨|每吨)`)) || s.match(new RegExp(`每吨${N}元`));
    if (m) return fcFromTons(tonPair([+m[1]]), dir);
    return null;
  }

  /** 旧缓存兼容（v4.6.0/4.6.1 可能把吨价原样存进 fc.unit=元/吨，或只存了汽油单值）：
   *  · API 原文（forecastText）里还有原始吨价 → 能按新口径（汽油 + 柴油）恢复区间，才升级成区间；
   *  · 只有当时换算出的单值、没有原始吨价 → 保留该单值（不反推「伪区间 / 伪精度」），等正常刷新；
   *  · 只写 FC_DATA，绝不碰 FC_BUDGET —— 同日预算原样保留，不会因为归一而多发一次请求。 */
  function fcCompat(rec) {
    if (!rec || typeof rec !== "object" || rec.fcv === FC_VERSION) return rec;
    const old = rec.fc || null;
    let fc = null;
    const fromText = fcParse(rec.forecastText);
    if (fromText) fc = fromText;
    else if (old && old.dir && old.dir !== "flat") {
      const parts = String(old.amt || "").split("-").map((x) => +x).filter((v) => isFinite(v) && v > 0);
      if (String(old.unit) === "元/吨" && parts.length) fc = fcFromTons(tonPair(parts), old.dir);
      else if (String(old.unit) === "元/升" && parts.length) {
        const lo = Math.min(...parts), hi = Math.max(...parts);
        fc = { dir: old.dir, amt: lo === hi ? two(lo) : `${two(lo)}-${two(hi)}`, unit: "元/升", est: !!old.est, basis: "legacy", lo, hi };
      }
    }
    return { ...rec, fc: fc || null, fcv: FC_VERSION };
  }

  /** next_adjustment 形如「下次油价7月3日24时调整」：只认真实写出的月/日，不推算 */
  function fcNextDate(txt, base) {
    const m = String(txt ?? "").match(/(\d{1,2})月(\d{1,2})日/);
    if (!m) return null;
    const d = new Date(base.getFullYear(), +m[1] - 1, +m[2]);
    if (d.getTime() < base.getTime() - 30 * 86400000) d.setFullYear(base.getFullYear() + 1);   // 跨年提示
    return isNaN(d.getTime()) ? null : d;
  }

  let fcData = null, fcState = "", fcNote = "";
  if (FC_ON && cnProv && !regionInvalid) {
    try { fcData = ctx.storage.getJSON(FC_DATA); } catch (_) { fcData = null; }
    if (fcData && fcData.fcv !== FC_VERSION) {                     // 旧缓存（含吨价）就地归一，只写 FC_DATA
      fcData = fcCompat(fcData);
      try { ctx.storage.setJSON(FC_DATA, fcData); } catch (_) {}
    }
    const todayBJ = bjDay(Date.now());
    let budget = null, budgetOk = true;
    try { budget = ctx.storage.getJSON(FC_BUDGET); } catch (_) { budgetOk = false; }
    const saveBudget = (state, code) => {
      try { ctx.storage.setJSON(FC_BUDGET, { day: todayBJ, state, code: code || 0, at: new Date().toISOString() }); } catch (_) {}
    };
    if (!budgetOk) {
      fcState = "no-budget";                       // 故障关闭：读不到预算就不发请求
    } else if (budget && budget.day === todayBJ) {
      fcState = String(budget.state || "used");    // 今天已请求过（成功/失败都算），不重试
    } else {
      saveBudget("reserved", 0);                   // 先落预算再发请求：中途失败也算今天已用
      let resp = null, body = null, status = 0;
      try {
        const headers = { "content-type": "application/json", accept: "application/json", "user-agent": "EgernOilWidget/4.6.3" };
        if (OIL_KEY) headers.authorization = `Bearer ${OIL_KEY}`;
        resp = await ctx.http.post(FC_URL, { headers, body: { province: cnProv }, timeout: 8000 });
        status = resp ? resp.status : 0;
        if (status !== 429) { try { body = await resp.json(); } catch (_) { body = null; } }
      } catch (e) {
        fcNote = (e && e.message) || "网络错误";
      }
      const code = body && typeof body.code === "number" ? body.code : -1;
      const quota = status === 429 || code === 4029 || code === 4030;
      const auth = code === 4011 || code === 4013 || code === 4014 || code === 4015;
      if (quota) { fcState = "quota"; saveBudget("quota", code); }
      else if (auth) { fcState = "auth"; saveBudget("auth", code); }
      else if (code === 0 && body && body.data && typeof body.data === "object") {
        const d = body.data;
        const nd = fcNextDate(d.next_adjustment, now);
        const rec = {
          day: todayBJ, fetchedAt: Date.now(),
          updateDate: String(d.update_date || "").slice(0, 10),
          province: String(d.province || cnProv),
          forecastText: String(d.forecast || ""),
          nextText: String(d.next_adjustment || ""),
          fc: fcParse(d.forecast, perGradeTons(d)), fcv: FC_VERSION,
          nextDate: nd ? YMD(nd) : "",
        };
        try { ctx.storage.setJSON(FC_DATA, rec); } catch (_) {}
        fcData = rec;
        fcState = rec.fc || rec.nextDate ? "ok" : "empty";
        saveBudget(rec.fc || rec.nextDate ? "ok" : "fail", 0);
      } else {
        fcState = "fail";
        saveBudget("fail", code);
        if (!fcNote) fcNote = `HTTP ${status}${code >= 0 ? ` · code ${code}` : ""}`;
      }
    }
  }

  // ════════════════════════════════════════════════════════════
  // 4. 派生数据（最近调价 / 涨跌预测 / 下轮时间 / 走势点）
  // ════════════════════════════════════════════════════════════
  let adjDate = null;
  if (adj) {
    adjDate = new Date(now.getFullYear(), adj.month - 1, adj.day);
    if (adjDate.getTime() - now.getTime() > 45 * 86400000) adjDate.setFullYear(now.getFullYear() - 1); // 跨年
  }
  // 下轮日期只认「未来」：日期早于今天的一律不再当下一轮（否则会把过去错当下一轮）
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let nextDate = null, nextSource = "local", nextStale = false;
  const bfNextD = bf && /^\d{4}-\d{2}-\d{2}$/.test(bf.nextDate || "") ? new Date(`${bf.nextDate}T00:00:00`) : null;
  if (bfNextD && !isNaN(bfNextD.getTime()) && bfNextD.getTime() >= today0.getTime()) {
    nextDate = bfNextD;
    nextSource = "besfuel";
  } else {
    if (bfNextD && !isNaN(bfNextD.getTime())) nextStale = true;   // 快照里的窗口已过期
    if (adjDate) {
      const local = addWorkdays(adjDate, 10);  // 退回本地规则推算（只用于「时间」，不用于幅度）
      if (local.getTime() >= today0.getTime()) nextDate = local;
      else nextStale = true;
    }
  }

  // 涨跌预测只认：文档 forecast + 未来预测窗口 + 15 天内缓存。三者缺一 → 暂无预测
  const FC_FRESH_MS = 15 * 86400000;
  const fcNextD = fcData && /^\d{4}-\d{2}-\d{2}$/.test(fcData.nextDate || "") ? new Date(`${fcData.nextDate}T00:00:00`) : null;
  const fcWindowOk = !!(fcNextD && !isNaN(fcNextD.getTime()) && fcNextD.getTime() >= today0.getTime());
  const fcValid = !!(fcData && fcData.fc && fcWindowOk && (Date.now() - (fcData.fetchedAt || 0)) <= FC_FRESH_MS);
  const fcArrow = !fcValid ? "" : fcData.fc.dir === "up" ? "↑" : fcData.fc.dir === "down" ? "↓" : "→";
  const fcEst = !!(fcValid && fcData.fc.est);                 // 吨价换算来的估算值 → 前面加「约」
  const fcAmt = fcValid ? (fcData.fc.dir === "flat" ? "搁浅" : `${fcArrow}${fcEst ? "约" : ""}${fcData.fc.amt}`) : "";
  const fcUnit = fcValid && fcData.fc.dir !== "flat" ? "元/升" : "";   // 三尺寸统一元/升（与最近调价同单位）
  const fcColor = !fcValid ? COLORS.secondary : fcData.fc.dir === "up" ? COLORS.up : fcData.fc.dir === "down" ? COLORS.down : COLORS.secondary;
  const fcText = fcValid ? fcAmt : "暂无预测";                 // 缺有效数据 → 暂无预测（不冒充）
  // v4.6.3：中号 / 小号预测位只写「方向 + 数值/区间」——不带「约」（估算标记）也不带单位。
  const fcPlain = fcValid ? (fcData.fc.dir === "flat" ? "搁浅" : `${fcArrow}${fcData.fc.amt}`) : "暂无预测";

  // 下轮预计调价时间：优先文档 next_adjustment（服务提示），否则回退已有窗口并标「预计」
  const apiNext = fcWindowOk;
  const nextShow = apiNext ? fcNextD : nextDate;
  const api24 = apiNext && /24时|24:00/.test(String((fcData && fcData.nextText) || ""));
  const nextTimeTxt = nextShow ? `${MDs(nextShow)}${apiNext ? (api24 ? " 24时" : "") : " 24时"}` : "待更新";
  const nextNote = apiNext ? "服务提示" : nextDate ? "本地预计" : nextStale ? "窗口已过" : "暂无窗口";

  const allRows = [
    { key: "p92", label: "92号", price: prices.p92, color: COLORS.p92 },
    { key: "p95", label: "95号", price: prices.p95, color: COLORS.p95 },
    { key: "p98", label: "98号", price: prices.p98, color: COLORS.p98 },
    { key: "diesel", label: "柴油", price: prices.diesel, color: COLORS.diesel },
  ];
  const hasAnyPrice = allRows.some((r) => r.price !== null && r.price !== undefined);

  const focusRow = allRows.find((r) => r.key === FUEL_KEY && r.price !== null) || allRows.find((r) => r.price !== null) || allRows[1];
  const focusPrice = focusRow && focusRow.price !== null ? focusRow.price : null;
  const fmt = (v) => (v === null || v === undefined || isNaN(v) ? "--" : v.toFixed(2));
  const titleText = regionName ? `${regionName}实时油价` : "实时油价";

  const adjTxt = adj && adj.range
    ? `${adj.dir === "down" ? "↓" : adj.dir === "up" ? "↑" : "→"}${adj.range}`
    : "暂无数据";
  const adjUnit = adj && adj.unit ? adj.unit : "";
  const adjTxtSmall = adjUnit && adj && adj.range ? `${adjTxt} ${adjUnit}` : adjTxt;
  const adjColor = adj && adj.dir === "up" ? COLORS.up : adj && adj.dir === "down" ? COLORS.down : COLORS.secondary;

  // 走势：优先用 BesFuel 已核实的官方调价历史（真实价格节点 · 元/升，最多最近 10 轮，普通折线连接）；
  // 历史源失效且无缓存时，退回本脚本自己抓到的价格快照并明确标注；都没有就显示「暂无历史」，绝不画推测曲线。
  let series = [], seriesKind = "none";
  if (SHOW_TREND) {
    const g = bf && bf.grades ? bf.grades[BF_GRADE[FUEL_KEY]] : null;
    if (g && Array.isArray(g.history) && g.history.length >= 1) {
      series = g.history.map((p) => ({ v: p.price, d: p.date, kind: p.kind || "price" }));
      seriesKind = "official";
    } else {
      series = hist
        .filter((h) => h.v && h.v[FUEL_KEY] !== null && h.v[FUEL_KEY] !== undefined && !isNaN(h.v[FUEL_KEY]))
        .map((h) => ({ v: h.v[FUEL_KEY], d: h.d, kind: "price" }));
      if (series.length >= 2) seriesKind = "local"; else series = [];
    }
  }
  const mdLabel = (d) => {
    const part = String(d).split("-");
    return part.length === 3 ? `${+part[1]}/${+part[2]}` : String(d);
  };
  const seriesLabels = series.map((p) => mdLabel(p.d));
  const seriesGaps = seriesKind === "official" && bf && Array.isArray(bf.gaps)
    ? series.map((p, i) => (i > 0 && bf.gaps.some((d) => d > series[i - 1].d && d < p.d) ? i : -1)).filter((i) => i > 0)
    : [];

  // 最新官方核价与涨跌语义（同价重复的「不调整」节点不算涨跌）
  const bfGradeMissing = !!(bf && bf.grades && !bf.grades[BF_GRADE[FUEL_KEY]]);
  if (bfGradeMissing && !series.length) bfReason = "grade";
  const bfLatest = seriesKind === "official" ? series[series.length - 1] : null;
  const bfPrev = bfLatest ? [...series].reverse().find((p) => Math.abs(p.v - bfLatest.v) >= 0.005) : null;
  const bfDelta = bfLatest ? (bfLatest.kind === "unchanged" ? 0 : bfPrev ? bfLatest.v - bfPrev.v : 0) : null;
  const bfArrow = bfDelta === null ? "" : bfDelta > 0.004 ? "↑" : bfDelta < -0.004 ? "↓" : "→";
  const bfDateLabel = bfLatest ? `${+bfLatest.d.slice(5, 7)}/${+bfLatest.d.slice(8, 10)}` : "";
  const bfDeltaTxt = bfLatest ? (bfLatest.kind === "unchanged" ? "官方不调整" : `${bfArrow}${Math.abs(bfDelta).toFixed(2)}`) : "";
  const bfColor = bfDelta !== null && bfDelta > 0.004 ? COLORS.up : bfDelta !== null && bfDelta < -0.004 ? COLORS.down : COLORS.secondary;
  const bfRangeTxt = seriesKind === "official" && series.length
    ? `${mdLabel(series[0].d)}-${mdLabel(series[series.length - 1].d)} · ${series.length} 个官方节点`
    : "";
  const bfCapShort = null;   // 中号图下注释行已删除（高度让给图表），来源说明改到 README / 大号图注

  const bfCapLong = bfLatest
    ? `${FUEL_LABEL} · 官方核价历史（元/升）· 最新 ${bfLatest.v.toFixed(2)} · ${bfDateLabel} 生效 · 较上轮 ${bfDeltaTxt}`
    : bfReason === "uncovered"
      ? "BesFuel 尚未收录该价区的官方核价历史，本组件只显示当前价，不猜测曲线"
      : bfReason === "grade"
        ? `BesFuel 未收录 ${FUEL_LABEL} 官方核价（该油号未逐期核价），不推算曲线`
        : bfReason === "fail"
          ? "官方核价历史暂不可用：现价与调价信息照常显示，下次刷新自动重试"
          : "暂无官方核价历史数据";
  const bfMetaTxt = seriesKind === "official"
    ? `BesFuel ${bf.name} · 核对 ${bf.checkedAt ? `${bf.checkedAt.slice(5, 7)}/${bf.checkedAt.slice(8, 10)}` : "—"} · ${series.length} 个官方节点${bfStale ? " · 缓存" : ""} · 数据为公告事实`
    : seriesKind === "local"
      ? "本地快照走势（官方历史源不可用，仅显示本机真实抓到的调价快照）"
      : "";



  // 文本宽度估算（保守口径，只用于「选最大可容纳字号」与溢出断言，不改文案）：
  //  CJK 1.02em / 数字 0.57em / 点逗号斜杠 0.31em / 连字符 0.37em / 箭头 0.6em / 空格 0.3em，粗体 ×1.04
  const CH_EM = (ch) => {
    const c = ch.codePointAt(0);
    if (c > 0x2e80) return 1.02;
    if ("0123456789".includes(ch)) return 0.57;
    if (ch === "." || ch === "," || ch === "/" || ch === "·") return 0.31;
    if (ch === "-" || ch === "+" || ch === "~") return 0.37;
    if (ch === "↓" || ch === "↑" || ch === "→") return 0.6;
    if (ch === "%" || ch === "¥") return 0.72;
    if (ch === " " || ch === "\u00a0") return 0.3;
    return 0.56;
  };
  const textWidth = (s, size, weight) => {
    let w = 0;
    for (const ch of String(s)) w += CH_EM(ch) * size;
    return w * (weight === "bold" || weight === "semibold" || weight === "heavy" || weight === "black" ? 1.04 : 1);
  };

  // ════════════════════════════════════════════════════════════
  // 5. 通用构件（只用官方支持字段：无 justifyContent，无 alignItems:'stretch'）
  //    高度口径：stack 的显式 height 按「含 padding 的边框盒」处理（保守），
  //    所以内容可用高度 = height - 上下 padding；所有固定高度都按此核算预算。
  //    禁止同一节点同时给 flex 与 height（会导致卡片被拉伸压到标题行上）。
  // ════════════════════════════════════════════════════════════
  const hDivider = { type: "stack", height: 1, backgroundColor: COLORS.cardBorder, children: [{ type: "spacer" }] };
  const vDivider = (h) => ({ type: "stack", width: 1, height: h, backgroundColor: COLORS.cardBorder, children: [{ type: "spacer" }] });
  const fuelIcon = (size, tintColor) => ({ type: "image", src: "sf-symbol:fuelpump.fill", width: size, height: size, color: tintColor || COLORS.p92 });
  const refreshIcon = (size) => ({ type: "image", src: "sf-symbol:arrow.clockwise", width: size, height: size, color: COLORS.tertiary });

  // ── v4.6.4 布局修复：容器宽度自适应居中 ─────────────────────────────
  //  原实现把内容宽度按 iPhone 标准尺寸写死：小号 158-2*10=138、中号 338-20=318、大号 338-24=314。
  //  Plus / Pro Max / iPad 上小号实际 170pt、中号/大号 364pt，Egern 里 widget 子元素默认「左上对齐」，
  //  于是固定的 138/318 只占左边，多出来的 12/26pt 全堆在右侧 → 「默认右边留白不对称」；
  //  开显示放大后逻辑尺寸回到 158/338，内容正好铺满，所以「放大反而正常」。
  //  Egern 文档只暴露 ctx.widgetFamily、没有容器宽高，无法按宽度重算像素，因此用官方对齐语义解决：
  //  纵向 stack + alignItems:'center'（文档：column 下 center = 子元素水平居中）把定宽内容居中，
  //  多余空间左右均分 → 任意容器宽度左右留白对称，且在 158/338 上位置与原来逐像素一致。
  const centerColumn = (children, gap) => ({
    type: "stack", direction: "column", alignItems: "center", flex: 1, gap: gap === undefined ? 6 : gap,
    children,
  });

  // 顶部标题行：小油泵图标 + 标题（自然左对齐）+ 弹性留白 + 刷新图标 + 时间（弱化）
  // 行高显式给出，标题行与下方卡片各有独立高度与间距，互不重叠。
  function headerNode(o) {
    return {
      type: "stack", direction: "row", alignItems: "center", width: o.w, height: o.h, gap: o.gap === undefined ? 4 : o.gap,
      children: [
        fuelIcon(o.icon, o.pump),
        { type: "text", text: titleText, flex: 1, font: { size: o.title, weight: "semibold" }, textColor: COLORS.secondary, maxLines: 1, minScale: 0.7 },
        ...(o.withTime === false ? [] : [
          refreshIcon(o.clock),
          { type: "text", text: timeStr, font: { size: o.time }, textColor: COLORS.tertiary, maxLines: 1 },
        ]),
      ],
    };
  }

  // 油价卡：显式宽高（不带 flex），内容 = 标签胶囊 + 价格；价格字号永远大于标签
  function fuelCard(row, o) {
    return {
      type: "stack", direction: "column", alignItems: "center", width: o.w, height: o.h,
      gap: o.gap || 0, padding: o.padding,
      backgroundColor: tint(row.color, "1F"), borderRadius: o.radius,
      children: [
        { type: "spacer" },
        {
          type: "stack", direction: "row", alignItems: "center", padding: [1, 4, 1, 4],
          backgroundColor: tint(row.color, "33"), borderRadius: 6,
          children: [{ type: "text", text: row.label, font: { size: o.labelSize, weight: "bold" }, textColor: row.color, maxLines: 1, minScale: 0.8 }],
        },
        { type: "text", text: fmt(row.price), width: o.w - 2 * o.padding[1] - 2, font: { size: o.priceSize, weight: "bold" }, textColor: COLORS.primary, maxLines: 1, minScale: 0.6, textAlign: "center" },
        { type: "spacer" },
      ],
    };
  }

  // 四连卡行：行高固定，卡片等宽，彼此不因 flex 抢高度
  function fuelRow(o) {
    return {
      type: "stack", direction: "row", alignItems: "center", width: o.w, height: o.h, gap: o.gap,
      children: allRows.map((r) => fuelCard(r, { ...o, w: o.cardW, gap: o.cardGap === undefined ? 1 : o.cardGap })),
    };
  }

  // 中号右栏三块（v4.6.2）：最近调价 / 涨跌预测 / 下轮预计时间 —— 三块严格等高 36pt，
  //   36×3 + 块距 4×2 = 116 = 左栏（四卡 46 + 4 + 图 66），右栏总高仍与左栏逐像素对齐。
  //   块内「紧凑两行」骨架：标题 10pt（行高 13）+ 数值 15.5pt（行高 20）+ 只补 1~3pt 顶留白，
  //     半空 → 36pt 被标题与数值铺满（旧版 9pt / 13.5pt + 上下 2/4pt 留白）；
  //   标题 10pt 都是在 75pt 内整行放得下的短标签（「下轮预计时间」≤63.6pt），不再靠 minScale 缩字。
  //   最近调价不带日期副行、不显示剩余天数；预测块标题只「涨跌预测」、数值只方向+区间（v4.6.3 去掉「约」与单位）。
  const adjBlockM = (o) => {
    const w = o.w, gapM = 4;
    const h = (o.totalH - gapM * 2) / 3;                 // (116 - 8) / 3 = 36：三块严格等高
    const TITLE_H = 13;                                  // 10pt 行高（1.25 保守口径）
    const block = (label, value, color, divider) => ({
      type: "stack", direction: "column", alignItems: "start", width: w, height: h, gap: 0,
      children: [
        ...(divider ? [{ type: "stack", height: 1, width: w - 10, backgroundColor: COLORS.cardBorder, children: [{ type: "spacer" }] }] : []),
        { type: "spacer", length: divider ? 2 : 3 },     // 分隔线 1 / 顶留白 2 → 三块标题同基线
        { type: "text", text: label, width: w, font: { size: 10, weight: "semibold" }, textColor: COLORS.tertiary, maxLines: 1, minScale: 0.8 },
        { type: "text", text: value, width: w, font: { size: 15.5, weight: "bold" }, textColor: color, maxLines: 1, minScale: 0.74 },
      ],
    });
    return {
      type: "stack", direction: "column", alignItems: "start", width: w, gap: gapM,
      children: [
        block("最近调价", adjTxt, adjColor, false),
        block("涨跌预测", fcPlain, fcColor, true),
        block("下轮预计时间", nextTimeTxt, COLORS.secondary, true),
      ],
    };
  };

  function emptyNode(msg, size, w) {
    return {
      type: "stack", direction: "column", alignItems: "center", flex: 1, width: w || 300, gap: 3,
      children: [
        { type: "spacer" },
        { type: "image", src: "sf-symbol:exclamationmark.triangle.fill", width: 18, height: 18, color: COLORS.p98 },
        { type: "text", text: msg, width: (w || 300) - 8, font: { size: size || 11 }, textColor: COLORS.secondary, maxLines: 2, textAlign: "center", minScale: 0.8 },
        { type: "spacer" },
      ],
    };
  }

  const errText = regionInvalid ? "地区参数错误" : fetchError ? "获取失败" : "暂无数据";

  // ── 锁屏 accessory 尺寸（避免返回非法结构）────────────────────
  if (isAccessory) {
    return {
      type: "widget", padding: 2, refreshAfter: refreshTime,
      backgroundColor: { light: "#00000000", dark: "#00000000" },
      children: [{ type: "text", text: `${FUEL_LABEL} ${fmt(focusPrice)}`, font: { size: 13, weight: "semibold" }, maxLines: 1, minScale: 0.7 }],
    };
  }

  // ════════════════════════════════════════════════════════════
  // 6. 小号 158×158：标题与更新时间同一行（左＝油泵+地区油价，右＝刷新图标+时间，中间 flex 撑开）/ 2×2 四格
  //    widget padding 9/10 → 可用 138×140；标题行 18 + gap 6 + 网格 97 + gap 6 + 下轮调价行 13
  //    = 140，正好填满内高（标题行与四格一个像素都没动，只在原底部空白处补下轮调价信息）
  // ════════════════════════════════════════════════════════════
  if (isSmall) {
    const SW = 138;                      // 158 - 左右 padding 各 10
    const GAP = 6;
    const CELL_W = (SW - GAP) / 2;       // 66：两列严格等宽
    const CELL_H = 46;
    const ROW_GAP = 5;
    const FOOT_H = 13;                   // 底部下轮行：只占原空白区，不挤压四格
    const cell = (r) => ({
      type: "stack", direction: "column", alignItems: "center",
      width: CELL_W, height: CELL_H, gap: 1, padding: [2, 2, 2, 2],
      backgroundColor: tint(r.color, "1F"), borderRadius: 10,
      children: [
        { type: "spacer" },
        { type: "text", text: r.label, width: CELL_W - 6, font: { size: 10, weight: "semibold" }, textColor: r.color, maxLines: 1, minScale: 0.8, textAlign: "center" },
        { type: "text", text: fmt(r.price), width: CELL_W - 6, font: { size: 16, weight: "bold" }, textColor: COLORS.primary, maxLines: 1, minScale: 0.5, textAlign: "center" },
        { type: "spacer" },
      ],
    });
    const gridRow = (a, b) => ({
      type: "stack", direction: "row", alignItems: "center", width: SW, height: CELL_H, gap: GAP,
      children: [cell(a), cell(b)],
    });
    // 底部行（v4.6.0 起替原下轮行；v4.6.3 只留方向+数值/区间，不再写标题/日期/单位/约）：
    // 四格与标题行一个像素不动；无有效预测写「暂无预测」，绝不补数字。
    // v4.6.3：底行只写「方向 + 数值/区间」（无预测标题、无日期、无单位、无「约」），行高/宽度/位置不变。
    const footNode = {
      type: "stack", direction: "row", alignItems: "center", width: SW, height: FOOT_H, gap: 2,
      children: [
        { type: "text", text: fcPlain, width: SW, font: { size: 10, weight: "semibold" }, textColor: fcColor, maxLines: 1, minScale: 0.6, textAlign: "center" },
      ],
    };
    return {
      type: "widget",
      padding: [9, 10, 9, 10], gap: 0, backgroundColor, refreshAfter: refreshTime,
      children: [centerColumn([
        {
          // 标题行：油泵图标 + 地区油价（左，flex 占满中间）→ 刷新图标 + 更新时间（右），同一行，无独立时间行
          type: "stack", direction: "row", alignItems: "center", width: SW, height: 18, gap: 3,
          children: [
            fuelIcon(13),
            { type: "text", text: `${regionName || "全国"}油价`, flex: 1, font: { size: 12.5, weight: "semibold" }, textColor: COLORS.secondary, maxLines: 1, minScale: 0.75 },
            refreshIcon(9),
            { type: "text", text: `${hasAnyPrice ? "更新 " : ""}${timeStr}${hasCache && fetchError ? " · 缓存" : ""}`, font: { size: 9.5 }, textColor: COLORS.tertiary, maxLines: 1, minScale: 0.75 },
          ],
        },
        hasAnyPrice
          ? {
              type: "stack", direction: "column", alignItems: "center", width: SW, gap: ROW_GAP,
              children: [gridRow(allRows[0], allRows[1]), gridRow(allRows[2], allRows[3])],
            }
          : {
              type: "stack", direction: "column", alignItems: "center", flex: 1, width: SW, gap: 4,
              children: [
                { type: "spacer" },
                { type: "image", src: "sf-symbol:exclamationmark.triangle.fill", width: 16, height: 16, color: COLORS.p98 },
                { type: "text", text: errText, width: SW, font: { size: 12 }, textColor: COLORS.secondary, maxLines: 2, textAlign: "center", minScale: 0.8 },
                { type: "text", text: "等系统下次刷新重试", width: SW, font: { size: 9 }, textColor: COLORS.tertiary, maxLines: 1, textAlign: "center" },
                { type: "spacer" },
              ],
            },
        // 下轮调价行：只在四格下方（原空白区）出现，错误态不显示
        ...(hasAnyPrice ? [footNode] : []),
      ], 6)],
    };
  }

  // ════════════════════════════════════════════════════════════
  // 7. 中/大号共用构件：参考图风格（同色系浅底卡 + 同色标签 + 黑色大单价，无胶囊）
  //    卡片显式宽高、无 flex；中大号专用配色 MC，与 small 使用的 COLORS 完全隔离。
  // ════════════════════════════════════════════════════════════
  const mlRows = allRows.map((r) => ({ ...r, color: MC[r.key], bg: MC.bg[r.key] }));
  // 卡内左右留白 = padding 左右（中号 3pt）→ 文本盒宽 = 卡宽 - 2*padding，数字离卡片边框 ≥3pt
  //（旧版 padding 左右 1pt、文本盒 = 卡宽-4，92 号数字几乎贴到卡边）
  function fuelCardML(row, o) {
    const boxW = o.w - 2 * (Array.isArray(o.padding) ? o.padding[1] : o.padding);
    return {
      type: "stack", direction: "column", alignItems: "center", width: o.w, height: o.h,
      gap: 0, padding: o.padding,
      backgroundColor: row.bg, borderRadius: o.radius,
      children: [
        { type: "spacer" },
        { type: "text", text: row.label, width: boxW, font: { size: o.labelSize, weight: "bold" }, textColor: row.color, maxLines: 1, minScale: 0.8, textAlign: "center" },
        { type: "text", text: fmt(row.price), width: boxW, font: { size: o.priceSize, weight: "bold" }, textColor: COLORS.primary, maxLines: 1, minScale: 0.6, textAlign: "center" },
        { type: "spacer" },
      ],
    };
  }
  function fuelRowML(o) {
    return {
      type: "stack", direction: "row", alignItems: "center", width: o.w, height: o.h, gap: o.gap,
      children: mlRows.map((r) => fuelCardML(r, { ...o, w: o.cardW })),
    };
  }

  // ════════════════════════════════════════════════════════════
  // 8. 中号 338×158：上＝油泵+地区实时油价 / 右＝刷新时间；四卡+折线图在左，调价与下轮日期在右
  //    widget padding [9,10,6,10] → 内高 143；标题行 20 + gap 6 + 主体 116（留 1px 余量）
  //    主体宽 318 严格分配：左栏 230 | 竖分隔留白 6 | 线 1 | 竖分隔留白 6 | 右栏 75 = 318
  //    （旧版 230+7+1+7+80=325 超宽 7pt，右栏被挤出右边距 → 左右不对称，本次按预算收平）
  //    竖直：左栏 = 卡行 46 + gap 4 + 图 66 = 116；右栏上块 46、下块 66，同 gap 4 → 两块边界与
  //    左栏卡行底/图底严格对齐（不是只改文字，块高与位置都按预算给）。
  // ════════════════════════════════════════════════════════════
  if (!isLarge) {
    const pad = [9, 10, 6, 10];
    const contentW = 338 - pad[1] - pad[3];        // 318
    const DIV_W = 1, DIV_GAP = 6;                  // 竖分隔线两侧留白相等 → 右栏与左栏留白对称
    const LEFT_W = 230, RIGHT_W = contentW - LEFT_W - DIV_GAP * 2 - DIV_W;   // 75
    const CARD_GAP_M = 4, CARD_W_M = (LEFT_W - CARD_GAP_M * 3) / 4, CARD_H_M = 46;   // 54.5
    const CARD_PAD_M = 3;                          // 卡内左右留白，数字离卡边 ≥3pt（旧版 1pt 贴边）
    const BODY_GAP_M = 4;                          // 卡行与图表间距，右栏两块沿用同一间距
    const CHART_W_M = LEFT_W, CHART_H_M = 66;
    const chartNodeM = SHOW_TREND && series.length >= 1
      ? { type: "image", src: chartSVG(series, { w: CHART_W_M, h: CHART_H_M, gaps: seriesGaps, labels: seriesLabels }), width: CHART_W_M, height: CHART_H_M }
      : {
          type: "stack", direction: "column", alignItems: "center", width: CHART_W_M, height: CHART_H_M, gap: 1,
          children: [
            { type: "spacer" },
            { type: "text", text: SHOW_TREND ? (bfReason === "uncovered" ? "BesFuel 未收录该价区" : bfReason === "grade" ? "BesFuel 未核价该油号" : "官方历史暂不可用") : "走势已关闭", width: CHART_W_M, font: { size: 9 }, textColor: COLORS.tertiary, maxLines: 1, textAlign: "center", minScale: 0.7 },
            { type: "text", text: SHOW_TREND ? "当前价照常显示，下次刷新重试" : "可在设置里打开", width: CHART_W_M, font: { size: 8 }, textColor: COLORS.tertiary, maxLines: 1, textAlign: "center", minScale: 0.7 },
            { type: "spacer" },
          ],
        };

    return {
      type: "widget",
      padding: pad, gap: 0, backgroundColor, refreshAfter: refreshTime,
      children: [centerColumn([
        headerNode({ w: contentW, h: 20, icon: 14, title: 14, time: 11.5, clock: 11.5, pump: MC.pump }),
        hasAnyPrice
          ? {
              type: "stack", direction: "row", alignItems: "start", gap: DIV_GAP, width: contentW,
              children: [
                {
                  type: "stack", direction: "column", alignItems: "start", width: LEFT_W, gap: BODY_GAP_M,
                  children: [
                    fuelRowML({ w: LEFT_W, h: CARD_H_M, cardW: CARD_W_M, gap: CARD_GAP_M, labelSize: 10, priceSize: 18, radius: 11, padding: [3, CARD_PAD_M, 3, CARD_PAD_M] }),
                    chartNodeM,
                  ],
                },
                vDivider(CARD_H_M + BODY_GAP_M + CHART_H_M - 4),
                adjBlockM({ w: RIGHT_W, totalH: CARD_H_M + 4 + 66 }),
              ],
            }
          : emptyNode(errText, 12, contentW),
      ], 6)],
    };
  }

  // ════════════════════════════════════════════════════════════
  // 9. 大号 338×354：全宽四卡 → 大图 → 横分隔线 → 底部左调价与下轮日期 / 竖分隔 / 右加满费用
  //    widget padding [10,12,8,12] → 内容 314×336；24+6+78+6+126+6+12+6+1+6+58 = 329（留 7px 余量）
  //    图下只留一行精简图注（来源与核对明细见 README），不再堆来源/核对长注释
  // ════════════════════════════════════════════════════════════
  const padL = [10, 12, 8, 12];
  const contentW_L = 338 - padL[1] - padL[3];       // 314
  const CARD_GAP_L = 6, CARD_W_L = (contentW_L - CARD_GAP_L * 3) / 4, CARD_H_L = 78;
  const CHART_W_L = contentW_L, CHART_H_L = 126;
  const fillCost = focusPrice !== null ? focusPrice * liters : null;
  const chartNodeL = SHOW_TREND && series.length >= 1
    ? { type: "image", src: chartSVG(series, { w: CHART_W_L, h: CHART_H_L, gaps: seriesGaps, labels: seriesLabels }), width: CHART_W_L, height: CHART_H_L }
    : {
        type: "stack", direction: "column", alignItems: "center", width: contentW_L, height: CHART_H_L, gap: 3,
        backgroundColor: COLORS.card, borderRadius: 12,
        children: [
          { type: "spacer" },
          { type: "text", text: SHOW_TREND ? bfCapLong : "走势已关闭", width: contentW_L - 16, font: { size: 10.5 }, textColor: COLORS.secondary, maxLines: 2, textAlign: "center", minScale: 0.75 },
          { type: "text", text: SHOW_TREND ? (bfReason === "uncovered" ? "BesFuel 只收录已核价的价区；当前价仍来自汽油价格网" : bfReason === "grade" ? "BesFuel 未对 98 号逐期核价，不使用邻近油号推算" : "当前价与调价信息照常显示，下次刷新自动重试") : "可在模块设置里打开", width: contentW_L - 16, font: { size: 9 }, textColor: COLORS.tertiary, maxLines: 1, textAlign: "center", minScale: 0.7 },
          { type: "spacer" },
        ],
      };
  // 图注：一行讲清「哪个油品 / 最近一轮何时生效 / 较上轮多少」，来源与核对明细移 README
  const capTextL = seriesKind === "official"
    ? `${FUEL_LABEL} 官方核价 · ${bf.name} · ${bfDateLabel} 生效 · 最新 ${bfLatest ? bfLatest.v.toFixed(2) : "--"} · ${series.length < 2 ? "仅 1 轮" : bfDeltaTxt}${bfStale ? " · 缓存" : ""}`
    : `本地快照走势 · ${series.length} 个真实节点 · 官方源暂不可用`;
  const capNodeL = SHOW_TREND && series.length >= 1
    ? { type: "text", text: capTextL, width: CHART_W_L, font: { size: 9 }, textColor: bfLatest ? bfColor : COLORS.tertiary, maxLines: 1, minScale: 0.75, textAlign: "center" }
    : null;
  const colW_L = (contentW_L - 1 - 20) / 2;         // 两栏 + 1px 分隔 + 10×2 间距

  // 大号底栏（v4.6.0）：左块改为「涨跌预测」（原最近调价位置），副行保留下轮预计调价时间与最近调价幅度，
  // 不再显示剩余天数；无有效预测写「暂无预测」。标题 v4.6.3 只留「涨跌预测」，数值仍「约 + 元/升」。
  const bigMainLabel = "涨跌预测";   // v4.6.3：去掉「（全国）」，其余不动
  const bigMainVal = fcValid ? (fcData.fc.dir === "flat" ? "搁浅" : `${fcAmt}${fcUnit ? " " + fcUnit : ""}`) : "暂无预测";
  const bigMainColor = fcValid ? fcColor : COLORS.secondary;
  // 大号预测值按 146.5pt（colW_L）预算取最大可容纳字号：区间「↓约0.28-0.33 元/升」比单值长
  let bigMainSize = 17;
  while (bigMainSize > 13 && textWidth(bigMainVal, bigMainSize, "bold") > colW_L) bigMainSize -= 0.5;
  const adjShort = adj && adj.range
    ? `${adj.dir === "down" ? "↓" : adj.dir === "up" ? "↑" : "→"}${String(adj.range).split("-")[0]}`
    : "";
  // 大号底部左栏只有 146.5pt：一行放「下轮时间 + 最近调价」，原字号放得下，不加「距 N 天」
  const bigSub = nextShow
    ? `${MDs(nextShow)} 24时 ${apiNext ? "提示" : "预计"}${adjShort ? ` · 最近 ${adjShort}` : ""}`
    : adjDate ? `最近 ${adjShort || "—"} · ${MDs(adjDate)} 24时` : "下轮时间待更新";

  return {
    type: "widget",
    padding: padL, gap: 0, backgroundColor, refreshAfter: refreshTime,
    children: [centerColumn([
      headerNode({ w: contentW_L, h: 24, icon: 17, title: 16, time: 12.5, clock: 13, pump: MC.pump }),
      hasAnyPrice
        ? {
            type: "stack", direction: "column", alignItems: "center", gap: 6,
            children: [
              fuelRowML({ w: contentW_L, h: CARD_H_L, cardW: CARD_W_L, gap: CARD_GAP_L, labelSize: 12, priceSize: 26, radius: 14, padding: [6, 2, 6, 2] }),
              chartNodeL,
              ...(capNodeL ? [capNodeL] : []),
              hDivider,
              {
                type: "stack", direction: "row", alignItems: "center", width: contentW_L, height: 58, gap: 10,
                children: [
                  ...(SHOW_TREND ? [{
                    type: "stack", direction: "column", alignItems: "start", width: colW_L, gap: 2,
                    children: [
                      { type: "text", text: bigMainLabel, width: colW_L, font: { size: 10 }, textColor: COLORS.tertiary, maxLines: 1 },
                      { type: "text", text: bigMainVal, width: colW_L, font: { size: bigMainSize, weight: "bold" }, textColor: bigMainColor, maxLines: 1, minScale: 0.7 },
                      { type: "text", text: bigSub, width: colW_L, font: { size: 9.5 }, textColor: COLORS.secondary, maxLines: 1, minScale: 0.7 },
                    ],
                  }, vDivider(44)] : []),
                  {
                    type: "stack", direction: "column", alignItems: "start", width: SHOW_TREND ? colW_L : contentW_L, gap: 2,
                    children: [
                      {
                        type: "stack", direction: "row", alignItems: "center", gap: 3,
                        children: [
                          { type: "image", src: "sf-symbol:fuelpump.fill", width: 11, height: 11, color: COLORS.tertiary },
                          { type: "text", text: `${focusRow.label}加满 ${liters}L`, font: { size: 10 }, textColor: COLORS.secondary, maxLines: 1, minScale: 0.8 },
                        ],
                      },
                      { type: "text", text: fillCost !== null ? `¥${fillCost.toFixed(2)}` : "暂无数据", width: SHOW_TREND ? colW_L : contentW_L, font: { size: 20, weight: "bold" }, textColor: COLORS.primary, maxLines: 1, minScale: 0.6 },
                      { type: "text", text: focusPrice !== null ? `单价 ${focusPrice.toFixed(2)} 元/升 · 现价 汽油价格网` : "单价暂无数据", width: SHOW_TREND ? colW_L : contentW_L, font: { size: 9 }, textColor: COLORS.tertiary, maxLines: 1, minScale: 0.7 },
                    ],
                  },
                ],
              },
            ],
          }
        : emptyNode(errText, 13, contentW_L),
    ], 6)],
  };
}