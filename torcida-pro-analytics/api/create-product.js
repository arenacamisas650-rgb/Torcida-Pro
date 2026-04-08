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

// ── normVariants ──────────────────────────────────────────────────────────────
// ✅ CORREÇÃO 1: removido .toUpperCase() que causava mismatch entre
//    options.values e variants[].values → gerava 422 na Nuvemshop.
// ✅ CORREÇÃO 2: deduplicação agora é case-insensitive (Set com lowercase).
//    Antes: seen.has("G") não detectava "g" como duplicata.
function normVariants(raw) {
  const arr = Array.isArray(raw) && raw.length ? raw : [{ values: ['Unico'], price: '0' }];

  // Diagnóstico: logar duplicatas no input antes de processar
  const inputVals = arr.map(v => {
    let val = v.values;
    if (Array.isArray(val)) val = val[0];
    if (Array.isArray(val)) val = val[0];
    return String(val || '').trim();
  }).filter(Boolean);
  const inputSet = new Set(inputVals.map(s => s.toLowerCase()));
  if (inputSet.size !== inputVals.length) {
    console.error('[normVariants] 🚨 Duplicatas detectadas no input:', inputVals);
  }

  const seen = new Set(); // lowercase — deduplicação case-insensitive
  const out  = [];

  for (const v of arr) {
    let val = v.values;
    if (Array.isArray(val)) val = val[0];
    if (Array.isArray(val)) val = val[0]; // dupla proteção contra [["P"]]
    val = String(val || '').trim();       // ✅ SEM toUpperCase
    const valKey = val.toLowerCase();
    if (!val || seen.has(valKey)) {
      if (val) console.warn('[normVariants] ⚠️ Duplicata removida:', val);
      continue;
    }
    seen.add(valKey);

    const p = parseFloat(String(v.price || '0').replace(',', '.'));
    const item = {
      price:            (!isNaN(p) && p > 0) ? p.toFixed(2) : '0.00',
      stock:            parseInt(v.stock) || 100,
      stock_management: true,
      sku:              v.sku || ('sku-' + valKey.replace(/\s+/g, '-')),
      values:           [val], // ✅ capitalização original preservada
    };
    if (v.compare_at_price) {
      const c = parseFloat(String(v.compare_at_price).replace(',', '.'));
      if (!isNaN(c) && c > p) item.compare_at_price = c.toFixed(2);
    }
    out.push(item);
  }

  const resultado = out.length
    ? out
    : [{ price: '0.00', stock: 100, stock_management: true, sku: 'sku-unico', values: ['Unico'] }];

  console.log('[normVariants] Tamanhos finais:', resultado.map(v => v.values[0]));
  return resultado;
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
  const variants     = normVariants(produto.variants);
  const optionValues = [...new Set(variants.map(v => v.values[0]).filter(Boolean))];
  const nome         = str(produto.name || produto.title) || 'Produto';
  const desc         = str(produto.description || produto.body_html) || '';
  const handleRaw    = str(produto.handle || produto.slug) || nome.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const handle       = handleRaw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]/g, '');
  const tags         = dedupTags(produto.tags);

  // ✅ CORREÇÃO 3: options[].name como objeto { pt } — Nuvemshop exige multilíngue
  //    Antes: options: [{ name: 'Tamanho', values: [...] }]  → ignorado ou erro silencioso
  //    Depois: options: [{ name: { pt: 'Tamanho' }, values: [...] }]
  const payload = {
    name:        { pt: nome },
    description: { pt: desc },
    handle:      { pt: handle },
    published:   true,
    options:     [{ name: { pt: 'Tamanho' }, values: optionValues }],
    variants,
  };
  if (tags)                    payload.tags            = tags;
  if (produto.seo_title)       payload.seo_title       = str(produto.seo_title);
  if (produto.seo_description) payload.seo_description = str(produto.seo_description);

  console.log('[CP] store=' + storeId + ' handle=' + handle);
  console.log('[CP] optionValues=' + JSON.stringify(optionValues));
  console.log('[CP] variants=' + JSON.stringify(variants.map(v => v.values[0])));

  // Segurança final: detectar duplicata residual antes de enviar
  const valoresFinais = variants.map(v => v.values[0]);
  const setFinal = new Set(valoresFinais.map(s => s.toLowerCase()));
  if (setFinal.size !== valoresFinais.length) {
    console.error('[CP] 🚨 DUPLICATA RESIDUAL detectada antes do POST!', valoresFinais);
    return res.status(400).json({
      error: 'Variantes duplicadas detectadas no servidor antes do envio',
      valores: valoresFinais,
    });
  }

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
    const json = JSON.parse(result.text);
    console.log('[CP] ✅ Criado na primeira tentativa! id=' + json.id);
    return res.status(200).json({ product_id: json.id, product: json });
  }

  // ── TENTATIVA 2: 422 → identificar causa → deletar e recriar ───────────────
  if (result.status === 422) {
    let detail422;
    try { detail422 = JSON.parse(result.text); } catch { detail422 = {}; }
    const msg422 = JSON.stringify(detail422).toLowerCase();

    // ✅ CORREÇÃO 4: diferenciar o tipo de 422
    //    "variant values should not be repeated" → problema no payload, NÃO adianta deletar e recriar
    //    outros 422 (handle duplicado, etc.) → tenta deletar e recriar
    if (msg422.includes('variant') && msg422.includes('repeat')) {
      console.error('[CP] 🚨 422 por VARIANTES DUPLICADAS — payload inválido, abortando sem deletar');
      console.error('[CP] Valores enviados:', valoresFinais);
      console.error('[CP] Detalhe API:', JSON.stringify(detail422));
      return res.status(422).json({
        error:        'Variantes duplicadas rejeitadas pela Nuvemshop',
        detail:       detail422,
        valores_enviados: valoresFinais,
        payload_sent: payload,
      });
    }

    console.log('[CP] 422 recebido (motivo: handle/outro) — buscando produto com handle=' + handle);

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
        const json = JSON.parse(result.text);
        console.log('[CP] ✅ Criado na segunda tentativa! id=' + json.id);
        return res.status(200).json({ product_id: json.id, product: json });
      }
    } else {
      console.warn('[CP] Produto não encontrado na busca — 422 por motivo desconhecido');
      console.warn('[CP] Detalhe API:', JSON.stringify(detail422));
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
