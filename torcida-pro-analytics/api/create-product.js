// api/create-product.js — Vercel Function
// ESTRATÉGIA: POST → se 422 → logar erro real → deletar handle → recriar
// ═══════════════════════════════════════════════════════════════════════════

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
  return [...new Set(raw.split(',').map(t => t.trim()).filter(Boolean))].join(',');
}

// ✅ Passa variantes do frontend sem re-normalizar
// Apenas garante: values[] é array de string, sem duplicatas, SKU presente
function normVariants(raw, handle) {
  const arr = Array.isArray(raw) && raw.length ? raw : [{ values: ['Unico'], price: '0' }];

  const skuBase = (handle || 'produto')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const seen = new Set();
  const out  = [];

  for (const v of arr) {
    // Extrai o valor da variante — aceita { values:["P"] }, { value:"P" }, { option1:"P" }, "P"
    let val = v && typeof v === 'object'
      ? (Array.isArray(v.values) ? v.values[0] : (v.value || v.option1 || ''))
      : v;
    if (Array.isArray(val)) val = val[0];
    val = String(val || '').trim();

    const key = val.toLowerCase();
    if (!val || seen.has(key)) {
      if (val) console.warn('[normVariants] duplicata removida:', val);
      continue;
    }
    seen.add(key);

    const p = parseFloat(String(v.price || '0').replace(',', '.'));
    const skuSufixo = key.replace(/[^a-z0-9]+/g, '-');
    const sku = (v && v.sku) ? String(v.sku).trim() : `${skuBase}-${skuSufixo}`;

    const item = {
      price:            (!isNaN(p) && p > 0) ? p.toFixed(2) : '0.00',
      stock:            parseInt(v.stock) || 100,
      stock_management: true,
      sku,
      values:           [val],
    };
    if (v && v.compare_at_price) {
      const c = parseFloat(String(v.compare_at_price).replace(',', '.'));
      if (!isNaN(c) && c > p) item.compare_at_price = c.toFixed(2);
    }
    out.push(item);
  }

  return out.length
    ? out
    : [{ price: '0.00', stock: 100, stock_management: true, sku: `${skuBase}-unico`, values: ['Unico'] }];
}

function hdr(token) {
  return {
    'Authentication': 'bearer ' + token,
    'Content-Type':   'application/json',
    'User-Agent':     NS_UA,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function acharPorHandle(handle, storeId, token) {
  let page = 1;
  while (true) {
    const url  = `${NS_BASE}/${storeId}/products?per_page=200&page=${page}&fields=id,handle`;
    const resp = await fetch(url, { headers: hdr(token) });
    if (!resp.ok) { console.warn('[CP] Erro ao listar: ' + resp.status); return null; }
    const arr  = await resp.json().catch(() => []);
    const list = Array.isArray(arr) ? arr : [];
    console.log(`[CP] Página ${page}: ${list.length} produto(s)`);
    if (!list.length) return null;
    const match = list.find(p => str(p.handle) === handle);
    if (match) { console.log('[CP] Match! id=' + match.id); return match; }
    if (list.length < 200) return null;
    page++;
  }
}

async function deletar(prodId, storeId, token) {
  const r = await fetch(`${NS_BASE}/${storeId}/products/${prodId}`, {
    method: 'DELETE', headers: hdr(token),
  }).catch(e => ({ ok: false, status: 0, statusText: e.message }));
  console.log('[CP] DELETE status=' + r.status);
  return r.ok || r.status === 204 || r.status === 404;
}

async function criarProduto(payload, storeId, token) {
  const resp = await fetch(`${NS_BASE}/${storeId}/products`, {
    method: 'POST', headers: hdr(token), body: JSON.stringify(payload),
  });
  const text = await resp.text();
  return { status: resp.status, ok: resp.ok, text };
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

  // ── Handle e nome ─────────────────────────────────────────────────────────
  const nome      = str(produto.name || produto.title) || 'Produto';
  const desc      = str(produto.description || produto.body_html) || '';
  const handleRaw = str(produto.handle || produto.slug)
    || nome.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const handle    = handleRaw
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]/g, '');
  const tags      = dedupTags(produto.tags);

  // ── Variantes ─────────────────────────────────────────────────────────────
  const variants     = normVariants(produto.variants, handle);
  const optionValues = [...new Set(variants.map(v => v.values[0]).filter(Boolean))];

  console.log('[CP] handle=' + handle);
  console.log('[CP] optionValues=' + JSON.stringify(optionValues));
  console.log('[CP] variants=' + JSON.stringify(variants.map(v => v.values[0])));

  // ── Imagens ───────────────────────────────────────────────────────────────
  const images = Array.isArray(produto.images)
    ? produto.images
        .map((im, i) => {
          const src = typeof im === 'string' ? im : (im.src || im.url || '');
          if (!src || !src.startsWith('http')) return null;
          return { src, position: i + 1, alt: im.alt || nome };
        })
        .filter(Boolean)
    : [];

  // ── Payload ───────────────────────────────────────────────────────────────
  // ✅ options[].name = STRING SIMPLES — objeto multilíngue causa 422 "variant values repeated"
  const payload = {
    name:        { pt: nome },
    description: { pt: desc },
    handle:      { pt: handle },
    published:   true,
    options:     [{ name: 'Tamanho', values: optionValues }],
    variants,
  };
  if (tags)                    payload.tags            = tags;
  if (produto.seo_title)       payload.seo_title       = str(produto.seo_title);
  if (produto.seo_description) payload.seo_description = str(produto.seo_description);
  if (images.length > 0)       payload.images          = images;

  // ── TENTATIVA 1: POST direto ──────────────────────────────────────────────
  console.log('[CP] Tentativa 1: POST direto...');
  let result;
  try {
    result = await criarProduto(payload, storeId, token);
  } catch (e) {
    return res.status(502).json({ error: 'Erro de rede: ' + e.message });
  }
  console.log('[CP] Tentativa 1 status=' + result.status);

  if (result.ok) {
    const json = JSON.parse(result.text);
    console.log('[CP] Criado! id=' + json.id);
    return res.status(200).json({ product_id: json.id, product: json });
  }

  // ── TENTATIVA 2: qualquer 422 → logar, buscar handle, deletar, recriar ───
  if (result.status === 422) {
    let detail422 = {};
    try { detail422 = JSON.parse(result.text); } catch { detail422 = { raw: result.text }; }

    // Log completo do erro para diagnóstico
    console.error('[CP] 422 DETALHE COMPLETO:', JSON.stringify(detail422));
    console.error('[CP] 422 RAW TEXT:', result.text.slice(0, 500));

    // Sempre tenta deletar handle e recriar — independente da mensagem
    console.log('[CP] Buscando handle existente para deletar: ' + handle);
    const existente = await acharPorHandle(handle, storeId, token).catch(e => {
      console.warn('[CP] Erro ao buscar: ' + e.message); return null;
    });

    if (existente) {
      console.log('[CP] Produto existente id=' + existente.id + ' → deletando...');
      await deletar(existente.id, storeId, token);
      await sleep(1500);

      const payloadSemImagens = { ...payload };
      delete payloadSemImagens.images;

      console.log('[CP] Tentativa 2: POST após deleção...');
      try {
        result = await criarProduto(payloadSemImagens, storeId, token);
        console.log('[CP] Tentativa 2 status=' + result.status);
      } catch (e) {
        return res.status(502).json({ error: 'Erro de rede na tentativa 2: ' + e.message });
      }

      if (result.ok) {
        const json = JSON.parse(result.text);
        console.log('[CP] Criado na tentativa 2! id=' + json.id);
        return res.status(200).json({ product_id: json.id, product: json });
      }

      // Log da falha na tentativa 2 também
      let detail2 = {};
      try { detail2 = JSON.parse(result.text); } catch { detail2 = { raw: result.text }; }
      console.error('[CP] Tentativa 2 falhou. Status=' + result.status + ' Detalhe:', JSON.stringify(detail2));

      return res.status(result.status || 500).json({
        error:         'Falhou após deletar e recriar',
        status_t1:     422,
        status_t2:     result.status,
        detail_t1:     detail422,
        detail_t2:     detail2,
        payload_sent:  payloadSemImagens,
      });
    } else {
      console.warn('[CP] Handle não encontrado na loja — 422 por motivo desconhecido');
      return res.status(422).json({
        error:        '422 da Nuvemshop — handle não existe na loja',
        detail:       detail422,
        raw:          result.text.slice(0, 500),
        payload_sent: payload,
      });
    }
  }

  // ── Outros erros ──────────────────────────────────────────────────────────
  let detail;
  try { detail = JSON.parse(result.text); } catch { detail = { raw: result.text }; }
  console.error('[CP] Erro ' + result.status + ':', result.text.slice(0, 300));

  return res.status(result.status || 500).json({
    error:        'API Nuvemshop ' + result.status,
    detail,
    payload_sent: payload,
  });
}
