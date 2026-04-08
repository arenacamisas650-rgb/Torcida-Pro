// api/update-product.js — Vercel Function
// Convertido de netlify/functions/update-product.js
// Proxy seguro: PUT /v1/{store_id}/products/{product_id}
// Body: { product_id, store_id?, produto: { ... } }

const NS_BASE  = 'https://api.nuvemshop.com.br/v1';
const NS_UA    = 'TorcidaPro/2.0 (contato@torcidapro.com.br)';
const STORE_ID = process.env.NS_STORE_ID || '7475657';
const TOKEN    = process.env.NS_TOKEN || process.env.NUVEM_TOKEN || '';

function sanitizarVariantes(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return undefined;
  const seen      = new Set();
  const resultado = [];
  for (const v of variants) {
    let valor;
    if (typeof v === 'string') {
      valor = v.trim();
    } else if (Array.isArray(v.values) && v.values.length > 0) {
      let raw = v.values[0];
      if (Array.isArray(raw)) raw = raw[0];
      valor = String(raw || '').trim().toUpperCase();
    } else if (v.value) {
      valor = String(v.value).trim();
    } else {
      valor = 'UNICO';
    }
    if (!valor || seen.has(valor)) continue;
    seen.add(valor);
    const variante = {
      price:            String(v.price || '0'),
      stock:            v.stock ?? 100,
      stock_management: true,
      values:           [valor],
    };
    if (v.compare_at_price) variante.compare_at_price = String(v.compare_at_price);
    if (v.sku) variante.sku = v.sku;
    resultado.push(variante);
  }
  return resultado.length > 0 ? resultado : undefined;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['PUT', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const authHdr = req.headers['authorization'] || '';
  const token   = authHdr.replace(/^bearer\s+/i, '').trim() || TOKEN;
  if (!token) return res.status(401).json({ error: 'Token Nuvemshop não encontrado.' });

  const body = req.body || {};
  const store_id   = body.store_id   || STORE_ID;
  const product_id = body.product_id;
  const produto    = body.produto;

  if (!product_id) return res.status(400).json({ error: 'Campo product_id é obrigatório.' });
  if (!produto)    return res.status(400).json({ error: 'Campo produto é obrigatório.' });

  const variantsSanitizadas  = sanitizarVariantes(produto.variants);
  const payloadNuvemshop = {
    ...produto,
    ...(variantsSanitizadas ? { variants: variantsSanitizadas } : {}),
  };
  // Campos que a Nuvemshop não aceita no PUT
  delete payloadNuvemshop.option1;
  delete payloadNuvemshop.option2;
  delete payloadNuvemshop.option3;

  try {
    const url  = `${NS_BASE}/${store_id}/products/${product_id}`;
    const resp = await fetch(url, {
      method:  'PUT',
      headers: { 'Authentication': `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': NS_UA },
      body: JSON.stringify(payloadNuvemshop),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return res.status(resp.status).json({
        error:       data.description || data.message || `HTTP ${resp.status}`,
        ns_response: data,
      });
    }

    console.log('[update-product] ✅ Produto atualizado:', product_id);
    return res.status(200).json({ product_id: data.id, product: data });

  } catch (err) {
    console.error('[update-product] Erro interno:', err.message);
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}
