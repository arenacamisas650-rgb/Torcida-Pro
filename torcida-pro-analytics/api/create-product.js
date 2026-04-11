// api/create-product.js — Vercel Function
// ══════════════════════════════════════════════════════════════════════════════
// ESTRATÉGIA: o frontend já monta o payload correto (options, variants, etc).
// O servidor NÃO re-normaliza variantes — apenas repassa o payload ao NS.
// Isso evita qualquer risco de duplicação introduzida pelo servidor.
// ══════════════════════════════════════════════════════════════════════════════

const NS_BASE  = 'https://api.nuvemshop.com.br/v1';
const NS_UA    = 'TorcidaPro/2.0 (contato@torcidapro.com.br)';
const STORE_ID = process.env.NS_STORE_ID || '7475657';
const TOKEN    = process.env.NS_TOKEN || process.env.NUVEM_TOKEN || '';

function str(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') return String(v.pt || v.es || v.en || Object.values(v)[0] || '').trim();
  return String(v).trim();
}

function dedupTags(tags) {
  if (!tags) return '';
  const raw = Array.isArray(tags) ? tags.join(',') : String(tags);
  return [...new Set(raw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean))].join(',');
}

function hdr(token) {
  return { 'Authentication': 'bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': NS_UA };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function acharPorHandle(handle, storeId, token) {
  let page = 1;
  while (true) {
    const resp = await fetch(`${NS_BASE}/${storeId}/products?per_page=200&page=${page}&fields=id,handle`, { headers: hdr(token) });
    if (!resp.ok) return null;
    const list = await resp.json().catch(() => []);
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return null;
    const match = arr.find(p => str(p.handle) === handle);
    if (match) return match;
    if (arr.length < 200) return null;
    page++;
  }
}

async function deletar(prodId, storeId, token) {
  const r = await fetch(`${NS_BASE}/${storeId}/products/${prodId}`, { method: 'DELETE', headers: hdr(token) })
    .catch(() => ({ ok: false, status: 0 }));
  return r.ok || r.status === 204 || r.status === 404;
}

async function postProduto(payload, storeId, token) {
  const resp = await fetch(`${NS_BASE}/${storeId}/products`, { method: 'POST', headers: hdr(token), body: JSON.stringify(payload) });
  const text = await resp.text();
  return { status: resp.status, ok: resp.ok, text };
}

function montarPayload(produto) {
  const nome = str(produto.name || produto.title) || 'Produto';
  const desc = str(produto.description || produto.body_html) || '';

  const handleRaw = str(produto.handle || produto.slug)
    || nome.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const handle = handleRaw.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]/g, '');

  // ── Variantes: usar exatamente o que o frontend enviou, apenas sanitizar ──
  let variants = Array.isArray(produto.variants) && produto.variants.length
    ? produto.variants
    : [{ price: '0.00', stock: 100, stock_management: true, sku: handle + '-unico', values: ['Unico'] }];

  variants = variants.map(v => {
    let val = Array.isArray(v.values) ? v.values[0] : (v.value || v.option1 || 'Unico');
    if (Array.isArray(val)) val = val[0];
    val = String(val || 'Unico').trim();
    const s = {
      price:            String(v.price || '0'),
      stock:            Number(v.stock ?? 100),
      stock_management: true,
      sku:              String(v.sku || (handle + '-' + val.toLowerCase())),
      values:           [val],
    };
    if (v.compare_at_price) {
      const c = parseFloat(String(v.compare_at_price));
      const p = parseFloat(String(v.price || '0'));
      if (!isNaN(c) && c > p) s.compare_at_price = String(v.compare_at_price);
    }
    return s;
  });

  // ── options[].name DEVE ser STRING SIMPLES — NS não aceita {pt:'Tamanho'} ──
  const optionValues = [...new Set(variants.map(v => v.values[0]).filter(Boolean))];
  const options = Array.isArray(produto.options) && produto.options.length
    ? produto.options.map(o => ({
        name:   typeof o.name === 'string' ? o.name : (o.name?.pt || 'Tamanho'),
        values: Array.isArray(o.values) ? o.values : optionValues,
      }))
    : [{ name: 'Tamanho', values: optionValues }];

  const images = Array.isArray(produto.images)
    ? produto.images.map((im, i) => {
        const src = typeof im === 'string' ? im : (im.src || im.url || '');
        if (!src || !src.startsWith('http')) return null;
        return { src, position: i + 1, alt: (im && im.alt) ? str(im.alt) : nome };
      }).filter(Boolean)
    : [];

  const payload = { name: { pt: nome }, description: { pt: desc }, handle: { pt: handle }, published: true, options, variants };
  const tags = dedupTags(produto.tags);
  if (tags)                    payload.tags            = tags;
  if (produto.seo_title)       payload.seo_title       = str(produto.seo_title);
  if (produto.seo_description) payload.seo_description = str(produto.seo_description);
  if (images.length > 0)       payload.images          = images;

  return { payload, handle };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method Not Allowed' });

  const body    = req.body || {};
  const authHdr = req.headers['authorization'] || '';
  const token   = authHdr.replace(/^bearer\s+/i, '').trim() || body.token || TOKEN;
  const produto = body.produto || body;
  const storeId = body.store_id || body.storeId || produto.store_id || STORE_ID;

  if (!token) return res.status(401).json({ error: 'Token ausente' });

  const { payload, handle } = montarPayload(produto);

  console.log('[CP] store=' + storeId + ' handle=' + handle);
  console.log('[CP] options=' + JSON.stringify(payload.options));
  console.log('[CP] variants=' + JSON.stringify(payload.variants.map(v => ({ val: v.values[0], sku: v.sku }))));

  // TENTATIVA 1
  let result;
  try { result = await postProduto(payload, storeId, token); }
  catch (e) { return res.status(502).json({ error: 'Erro de rede: ' + e.message }); }

  console.log('[CP] T1 status=' + result.status);
  if (result.ok) {
    const json = JSON.parse(result.text);
    console.log('[CP] ✅ id=' + json.id);
    return res.status(200).json({ product_id: json.id, product: json });
  }

  // TENTATIVA 2: 422 por handle duplicado → deletar e recriar
  if (result.status === 422) {
    let d = {};
    try { d = JSON.parse(result.text); } catch { /**/ }
    const msg = JSON.stringify(d).toLowerCase();
    console.error('[CP] 422 NS:', d.description || d.message || result.text.slice(0, 200));

    // Erros que não se resolvem recriando — retornar imediatamente
    if (msg.includes('variant') || msg.includes('option') || msg.includes('sku')) {
      return res.status(422).json({ error: d.description || d.message || 'Erro 422', detail: d, payload_sent: payload });
    }

    // Handle duplicado: deletar e recriar
    const existente = await acharPorHandle(handle, storeId, token).catch(() => null);
    if (existente) {
      console.log('[CP] Deletando id=' + existente.id + ' e recriando...');
      await deletar(existente.id, storeId, token);
      await sleep(1000);
      const p2 = { ...payload }; delete p2.images;
      try { result = await postProduto(p2, storeId, token); }
      catch (e) { return res.status(502).json({ error: 'Erro rede T2: ' + e.message }); }
      console.log('[CP] T2 status=' + result.status);
      if (result.ok) {
        const json = JSON.parse(result.text);
        console.log('[CP] ✅ T2 id=' + json.id);
        return res.status(200).json({ product_id: json.id, product: json });
      }
    }
  }

  let det;
  try { det = JSON.parse(result.text); } catch { det = { raw: result.text }; }
  console.error('[CP] ❌ status=' + result.status);
  return res.status(result.status || 500).json({
    error: det.description || det.message || 'API Nuvemshop ' + result.status,
    detail: det, raw_response: result.text, payload_sent: payload,
  });
}
