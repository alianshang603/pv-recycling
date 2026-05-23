/**
 * Vercel Serverless Function — 同域 /api/prices
 *
 * 路由：放在仓库 api/prices.js 即自动注册为 https://<your-vercel-domain>/api/prices
 * 数据源：东方财富 push2（主源） → 新浪期货（兜底）
 * 返回字段：{ silverCnyKg, copperCnyTon, aluminumCnyTon, updatedAt, source }
 *
 * 注意：Vercel 默认有 30 秒边缘缓存，这里再加 stale-while-revalidate，
 *      防止打到接口配额。
 */

const EM_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
  + '?fltt=2&secids=113.agm,113.cum,113.alm&fields=f12,f43,f60';
const SINA_URL = 'https://hq.sinajs.cn/list=AG0,CU0,AL0';

async function fetchEastmoney(timeoutMs) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(EM_URL + '&_=' + Date.now(), {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('em http ' + r.status);
    const json = await r.json();
    const diff = (json && json.data && json.data.diff) || [];
    const out = {};
    for (const item of diff) {
      const v = parseFloat(item.f43) || parseFloat(item.f60);
      if (!(v > 0)) continue;
      if (item.f12 === 'agm') out.silverCnyKg = v;
      if (item.f12 === 'cum') out.copperCnyTon = v;
      if (item.f12 === 'alm') out.aluminumCnyTon = v;
    }
    if (!out.silverCnyKg && !out.copperCnyTon && !out.aluminumCnyTon) return null;
    out.source = 'eastmoney-push2';
    return out;
  } finally {
    clearTimeout(tm);
  }
}

function parseSinaLine(line) {
  if (!line) return null;
  const p = line.split(',');
  if (p.length < 10) return null;
  // 8=最新价, 9=结算价, 2=开盘
  for (const idx of [8, 9, 2]) {
    const v = parseFloat(p[idx]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

async function fetchSina(timeoutMs) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(SINA_URL, {
      headers: {
        'Referer': 'https://finance.sina.com.cn/',
        'User-Agent': 'Mozilla/5.0',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('sina http ' + r.status);
    // Sina 用 GBK 编码，Node fetch 默认按 UTF-8 解，但只取数字字段不受影响
    const txt = await r.text();
    const get = (tag) => {
      const m = txt.match(new RegExp('hq_str_' + tag + '\\s*=\\s*"([^"]*)"'));
      return m ? parseSinaLine(m[1]) : null;
    };
    const ag = get('AG0'), cu = get('CU0'), al = get('AL0');
    if (!ag && !cu && !al) return null;
    const out = {};
    if (ag) out.silverCnyKg = ag;
    if (cu) out.copperCnyTon = cu;
    if (al) out.aluminumCnyTon = al;
    out.source = 'sina-shfe';
    return out;
  } finally {
    clearTimeout(tm);
  }
}

export default async function handler(req, res) {
  // CORS（允许本仓库以外的页面也用这个接口；如果只服务自家页面可改成具体域名）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=300');

  let data = null, errors = [];
  try { data = await fetchEastmoney(4500); } catch (e) { errors.push('em: ' + e.message); }
  if (!data) {
    try { data = await fetchSina(4500); } catch (e) { errors.push('sina: ' + e.message); }
  }

  if (!data) {
    return res.status(502).json({ error: 'all sources failed', detail: errors });
  }

  data.updatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  return res.status(200).json(data);
}
