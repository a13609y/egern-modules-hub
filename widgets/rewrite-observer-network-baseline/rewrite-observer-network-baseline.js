// Egern 2.21.0 (786) rewrite observer — generic widget script.
// [DOC] ctx.http.get and Widget DSL: https://egernapp.com/zh-CN/docs/javascript-api
// This is a network baseline only. It does NOT assert that this request traverses
// any Egern rewrite stage; the app's generic-script routing behavior was not documented.
export default async function (ctx) {
  const probeUrl = ctx.env.PROBE_URL || 'https://www.apple.com/library/test/success.html';
  const started = Date.now();
  let status = 'ERROR';
  let detail = '';
  let color = '#9B2226';
  try {
    const response = await ctx.http.get(probeUrl, {
      timeout: 10000,
      redirect: 'manual',
      credentials: 'omit',
    });
    const elapsed = Date.now() - started;
    status = `HTTP ${response.status}`;
    detail = `${elapsed} ms · ${new URL(probeUrl).host}`;
    color = response.status >= 200 && response.status < 400 ? '#2D6A4F' : '#9B2226';
  } catch (error) {
    detail = String(error && error.message ? error.message : error).slice(0, 70);
  }
  const family = ctx.widgetFamily || 'unknown';
  return {
    type: 'widget',
    children: [
      { type: 'text', text: 'Rewrite Observer', font: { size: 'headline', weight: 'bold' }, textColor: '#FFFFFF' },
      { type: 'text', text: status, font: { size: 'title2', weight: 'semibold' }, textColor: '#FFFFFF' },
      { type: 'text', text: detail, font: { size: 'caption1' }, textColor: '#FFFFFFCC' },
      { type: 'text', text: `基线观测 · ${family}`, font: { size: 'caption2' }, textColor: '#FFFFFFAA' },
      { type: 'text', text: '脚本请求是否经过 rewrites：未断言', font: { size: 'caption2' }, textColor: '#FFFFFFAA' },
    ],
    backgroundColor: color,
    padding: 14,
    gap: 5,
    url: probeUrl,
  };
}
