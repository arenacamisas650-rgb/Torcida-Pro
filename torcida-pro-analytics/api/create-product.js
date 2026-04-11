// api/create-product.js — Vercel Function
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
// ✅ SKU dinâmico: "{handle}-p", "{handle}-m" — nunca genérico "sku-p"
// ✅ SEM toUpperCase — preserva capitalização do frontend
// ✅ Deduplicação case-insensitive
// ✅ Aceita strings, { values:["P"] }, { option1:"P" }
function normVariants(raw, handle) {
  const arr = Array.isArray(raw) && raw.length ? raw : [{ values: ['Unico'], price: '0' }];

  // Base do SKU derivada do handle: "camisa-barcelona-2026"
  const skuBase = (handle || 'produto')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Diagnóstico de duplicatas no input
  const inputVals = arr.map(v => {
    let val = v && typeof v === 'object'
      ? (Array.isArray(v.values) ? v.values[0] : (v.value || v.option1 || ''))
      : v;
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
    let val = v && typeof v === 'object'
      ? (Array.isArray(v.values) ? v.values[0] : (v.value || v.option1 || ''))
      : v;
    if (Array.isArray(val)) val = val[0]; // [["P"]] → "P"
    if (Array.isArray(val)) val = val[0]; // dupla proteção
    val = String(val || '').trim();       // ✅ SEM toUpperCase

    const valKey = val.toLowerCase();
    if (!val || seen.has(valKey)) {
      if (val) console.warn('[normVariants] ⚠️ Duplicata removida:', val);
      continue;
    }
    seen.add(valKey);

    const p = parseFloat(String(v.price || '0').replace(',', '.'));
    // ✅ SKU único e dinâmico: "camisa-barcelona-2026-p"
    const skuSufixo = valKey.replace(/[^a-z0-9]+/g, '-');
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

  const resultado = out.length
    ? out
    : [{ price: '0.00', stock: 100, stock_management: true, sku: `${skuBase}-unico`, values: ['Unico'] }];

  console.log('[normVariants] Tamanhos:', resultado.map(v => v.values[0]));
  console.log('[normVariants] SKUs:', resultado.map(v => v.sku));
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

// ── acharPorHandle ────────────────────────────────────────────────────────────
async function acharPorHandle(handle, storeId, token) {
  console.log('[CP] Buscando produto com handle=' + handle);
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

// ── deletar ───────────────────────────────────────────────────────────────────
async function deletar(prodId, storeId, token) {
  console.log('[CP] Deletando produto id=' + prodId);
  const r = await fetch(`${NS_BASE}/${storeId}/products/${prodId}`, {
    method: 'DELETE', headers: hdr(token),
  }).catch(e => ({ ok: false, status: 0, statusText: e.message }));
  console.log('[CP] DELETE status=' + r.status);
  return r.ok || r.status === 204 || r.status === 404;
}

// ── criarProduto ──────────────────────────────────────────────────────────────
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

  const authHdr = req.headers['authorization'] || '';
  const token   = authHdr.replace(/^bearer\s+/i, '').trim() || body.token || TOKEN;
  const produto  = body.produto || body;
  const storeId  = body.store_id || body.storeId || produto.store_id || STORE_ID;

  if (!token) return res.status(401).json({ error: 'Token ausente' });

  // ── Montar handle antes de normalizar variantes (SKU depende dele) ──────────
  const nome      = str(produto.name || produto.title) || 'Produto';
  const desc      = str(produto.description || produto.body_html) || '';
  const handleRaw = str(produto.handle || produto.slug)
    || nome.toLowerCase().replace(/[^a-z0-9]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const handle    = handleRaw
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]/g, '');
  const tags      = dedupTags(produto.tags);

  // ✅ handle passado para SKU dinâmico: "camisa-barcelona-2026-p"
  const variants     = normVariants(produto.variants, handle);
  const optionValues = [...new Set(variants.map(v => v.values[0]).filter(Boolean))];

  // ✅ Validação de segurança: bloquear duplicatas residuais antes de enviar
  const valoresFinais = variants.map(v => v.values[0]);
  const setFinal = new Set(valoresFinais.map(s => s.toLowerCase()));
  if (setFinal.size !== valoresFinais.length) {
    console.error('[CP] 🚨 DUPLICATA RESIDUAL detectada antes do POST!', valoresFinais);
    return res.status(400).json({
      error:   'Variantes duplicadas detectadas no servidor antes do envio',
      valores: valoresFinais,
    });
  }

  // ✅ Imagens: aceita { src }, { url }, ou string direta
  const images = Array.isArray(produto.images)
    ? produto.images
        .map((im, i) => {
          const src = typeof im === 'string' ? im : (im.src || im.url || '');
          if (!src || !src.startsWith('http')) return null;
          return { src, position: i + 1, alt: im.alt || nome };
        })
        .filter(Boolean)
    : [];

  // ✅ options[].name deve ser STRING SIMPLES — objeto multilíngue causa duplicatas de variantes na Nuvemshop
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
  // Imagens enviadas no payload de criação (quando a API aceitar)
  if (images.length > 0)       payload.images          = images;

  console.log('[CP] store=' + storeId + ' | handle=' + handle);
  console.log('[CP] optionValues=' + JSON.stringify(optionValues));
  console.log('[CP] variants=' + JSON.stringify(variants.map(v => ({ val: v.values[0], sku: v.sku }))));
  console.log('[CP] images=' + images.length + ' imagem(ns)');

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
    console.log('[CP] ✅ Criado! id=' + json.id);
    return res.status(200).json({ product_id: json.id, product: json });
  }

  // ── TENTATIVA 2: 422 → identificar causa → deletar handle duplicado e recriar
  if (result.status === 422) {
    let detail422 = {};
    try { detail422 = JSON.parse(result.text); } catch { /* ignorar */ }
    const msg422 = JSON.stringify(detail422).toLowerCase();

    console.error('[CP] 422 recebido. Detalhe:', JSON.stringify(detail422));

    // 422 por variantes duplicadas → payload inválido, não adianta deletar/recriar
    if (msg422.includes('variant') && (msg422.includes('repeat') || msg422.includes('duplicat'))) {
      console.error('[CP] 🚨 422 VARIANTES DUPLICADAS — abortando sem deletar');
      return res.status(422).json({
        error:            'Variantes duplicadas rejeitadas pela Nuvemshop',
        detail:           detail422,
        valores_enviados: valoresFinais,
        payload_sent:     payload,
      });
    }

    // 422 por handle duplicado → buscar, deletar e recriar
    console.log('[CP] 422 por handle duplicado — buscando...');
    const existente = await acharPorHandle(handle, storeId, token).catch(e => {
      console.warn('[CP] Erro ao buscar: ' + e.message); return null;
    });

    if (existente) {
      console.log('[CP] Produto encontrado (id=' + existente.id + ') → deletando...');
      await deletar(existente.id, storeId, token);
      await sleep(1000);

      // Remove imagens do payload na recriação — serão enviadas via upload-image depois
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
        console.log('[CP] ✅ Criado na tentativa 2! id=' + json.id);
        return res.status(200).json({ product_id: json.id, product: json });
      }
    } else {
      console.warn('[CP] Produto não encontrado pelo handle — 422 por motivo desconhecido');
    }
  }

  // ── Falhou definitivamente ─────────────────────────────────────────────────
  let detail;
  try { detail = JSON.parse(result.text); } catch { detail = { raw: result.text }; }
  console.error('[CP] ❌ Falhou: ' + result.status + ' | ' + result.text.slice(0, 300));

  return res.status(result.status || 500).json({
    error:        'API Nuvemshop ' + result.status,
    detail,
    raw_response: result.text,
    payload_sent: payload,
  });
}
