// api/create-product.js — Vercel Function
// Convertido de netlify/functions/create-product.js
// ESTRATÉGIA BULLETPROOF: POST → 422 → buscar handle → DELETE → POST
// ═══════════════════════════════════════════════════════════════════════════

const NS_BASE  = 'https://api.nuvemshop.com.br/v1';
const NS_UA    = 'TorcidaPro/2.0 (contato@torcidapro.com.br)';
const STORE_ID = process.env.NS_STORE_ID || '7475657';
const TOKEN    = process.env.NS_TOKEN || process.env.NUVEM_TOKEN || '';

// ── helpers ──────────────────────────────────────────────────────────────────

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

function normVariants(raw) {
  const arr = Array.isArray(raw) && raw.length ? raw : [{ values: ['UNICO'], price: '0' }];
  const seen = new Set();
  const out  = [];
  for (const v of arr) {
    let val = v.values;
    if (Array.isArray(val)) val = val[0];
    if (Array.isArray(val)) val = val[0];
    val = String(val || '').trim().toUpperCase();
    if (!val || seen.has(val)) continue;
    seen.add(val);
    const p = parseFloat(String(v.price || '0').replace(',', '.'));
    const item = {
      price:            (!isNaN(p) && p > 0) ? p.toFixed(2) : '0.00',
      stock:            parseInt(v.stock) || 100,
      stock_management: true,
      sku:              v.sku || ('sku-' + val.toLowerCase()),
      values:           [val],
    };
    if (v.compare_at_price) {
      const c = parseFloat(String(v.compare_at_price).replace(',', '.'));
      if (!isNaN(c) && c > p) item.compare_at_price = c.toFixed(2);
    }
    out.push(item);
  }
  return out.length
    ? out
    : [{ price: '0.00', stock: 100, stock_management: true, sku: 'sku-unico', values: ['UNICO'] }];
}

function hdr(token) {
  return {
    'Authentication': 'bearer ' + token,
    'Content-Type':   'application/json',
    'User-Agent':     NS_UA,
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── listar todos os produtos e achar pelo handle ──────────────────────────────
async function acharPorHandle(handle, storeId, token) {
  console.log('[CP] Listando produtos para encontrar handle=' + handle);
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

// ── deletar produto ───────────────────────────────────────────────────────────
async function deletar(prodId, storeId, token) {
  console.log('[CP] Deletando produto id=' + prodId);
  const r = await fetch(`${NS_BASE}/${storeId}/products/${prodId}`, {
    method: 'DELETE', headers: hdr(token),
  }).catch(e => ({ ok: false, status: 0, statusText: e.message }));
  console.log('[CP] DELETE status=' + r.status);
  return r.ok || r.status === 204 || r.status === 404;
}

// ── POST produto ──────────────────────────────────────────────────────────────
async function criarProduto(payload, storeId, token) {
  const resp = await fetch(`${NS_BASE}/${storeId}/products`, {
    method: 'POST', headers: hdr(token), body: JSON.stringify(payload),
  });
  const text = await resp.text();
  return { status: resp.status, ok: resp.ok, text };
}

// ── handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method Not Allowed' });

  const body = req.body || {};

  // Token — 4 fontes de fallback
  const authHdr = req.headers['authorization'] || '';
  const token   = authHdr.replace(/^bearer\s+/i, '').trim() || body.token || TOKEN;
  const produto  = body.produto || body;
  const storeId  = body.store_id || body.storeId || produto.store_id || STORE_ID;

  if (!token) return res.status(401).json({ error: 'Token ausente' });

  // ── Normalizar ──────────────────────────────────────────────────────────────
const nome   = str(produto.name   || produto.nome   || '');
const desc   = str(produto.description || produto.descricao || '');
const handle = str(produto.handle || '');

if (!nome)   return res.status(400).json({ error: 'Campo "name" ausente no produto' });
if (!handle) return res.status(400).json({ error: 'Campo "handle" ausente no produto' });

const variants = normVariants(produto.variants);

// garante valores únicos e válidos
const optionValues = [
  ...new Set(
    variants
      .map(v => v?.values?.[0])
      .filter(Boolean)
      .map(v => String(v).trim().toUpperCase())
  )
];

// segurança
if (!optionValues.length) {
  console.error("❌ Nenhum valor de variante encontrado");
  return res.status(400).json({ error: "Sem variantes válidas" });
}

// ── Validar imagens ─────────────────────────────────────────────────────────
const rawImages = produto.imagens || produto.images || [];
console.log("🖼️ IMAGENS RECEBIDAS:", rawImages);
if (!rawImages.length) {
  console.error("❌ Produto sem imagens para enviar");
  return res.status(400).json({ error: "Produto sem imagens para enviar" });
}

const payload = {
  name:        { pt: nome },
  description: { pt: desc },
  handle:      { pt: handle },
  published:   true,

  images: rawImages.map(url => ({ src: url })),

  options: [
    {
      name: { pt: 'Tamanho' },
      values: optionValues
    }
  ],

  variants: variants
};

console.log("📦 PAYLOAD FINAL:", JSON.stringify(payload, null, 2));
  // ── TENTATIVA 1: POST direto ────────────────────────────────────────────────
  console.log('[CP] Tentativa 1: POST direto...');
  let result;
  try {
    result = await criarProduto(payload, storeId, token);
  } catch (e) {
    return res.status(502).json({ error: 'Erro de rede: ' + e.message });
  }

  console.log('[CP] Tentativa 1 status=' + result.status);

  if (result.ok) {
    let json;
    try { json = JSON.parse(result.text); } catch(e) {
      console.error('[CP] ⚠️ Resposta OK mas JSON inválido:', result.text);
      return res.status(200).json({ product_id: null, raw: result.text });
    }
    console.log('[CP] ✅ Criado na primeira tentativa! id=' + json.id);
    return res.status(200).json({ product_id: json.id, product: json });
  }

  // ── TENTATIVA 2: 422 → deletar e recriar ───────────────────────────────────
  if (result.status === 422) {
    console.log('[CP] 422 recebido — buscando produto com handle=' + handle);

    const existente = await acharPorHandle(handle, storeId, token).catch(e => {
      console.warn('[CP] Erro ao buscar: ' + e.message); return null;
    });

    if (existente) {
      console.log('[CP] Produto encontrado (id=' + existente.id + ') → deletando...');
      await deletar(existente.id, storeId, token);
      await sleep(1000);
      console.log('[CP] Tentativa 2: POST após deleção...');
      try {
        result = await criarProduto(payload, storeId, token);
        console.log('[CP] Tentativa 2 status=' + result.status);
      } catch (e) {
        return res.status(502).json({ error: 'Erro de rede na tentativa 2: ' + e.message });
      }

      if (result.ok) {
        let json;
        try { json = JSON.parse(result.text); } catch(e) {
          console.error('[CP] ⚠️ Resposta OK mas JSON inválido (t2):', result.text);
          return res.status(200).json({ product_id: null, raw: result.text });
        }
        console.log('[CP] ✅ Criado na segunda tentativa! id=' + json.id);
        return res.status(200).json({ product_id: json.id, product: json });
      }
    } else {
      console.warn('[CP] Produto não encontrado na busca — 422 por outro motivo');
    }
  }

  // ── Falhou em todas as tentativas ──────────────────────────────────────────
  let detail;
  try { detail = JSON.parse(result.text); } catch { detail = { raw: result.text }; }
  console.error('[CP] ❌ Falhou definitivamente: ' + result.status + ' ' + result.text);

  return res.status(result.status || 500).json({
    error:        'API Nuvemshop ' + result.status,
    detail,
    raw_response: result.text,
    payload_sent: payload,
  });
}
