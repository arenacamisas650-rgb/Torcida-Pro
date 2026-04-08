// api/shopify-proxy.js
// Vercel Serverless Function — substitui netlify/functions/shopify-proxy
// Endpoint: /api/shopify-proxy?shop=loja.myshopify.com&endpoint=products.json

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Shopify-Access-Token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── Parâmetros ────────────────────────────────────────────────────────────
  const { shop, endpoint } = req.query;

  if (!shop || !endpoint) {
    return res.status(400).json({
      error: 'Parâmetros obrigatórios: shop e endpoint',
      exemplo: '/api/shopify-proxy?shop=loja.myshopify.com&endpoint=products.json'
    });
  }

  // ── Token via env var (configurar no painel Vercel) ───────────────────────
  const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!SHOPIFY_TOKEN) {
    return res.status(500).json({
      error: 'SHOPIFY_ACCESS_TOKEN não configurada nas variáveis de ambiente da Vercel'
    });
  }

  // ── Chamada à API Shopify ─────────────────────────────────────────────────
  try {
    const url = `https://${shop}/admin/api/2024-01/${endpoint}`;

    const shopifyRes = await fetch(url, {
      method: req.method,
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json',
      },
      body: ['POST', 'PUT'].includes(req.method)
        ? JSON.stringify(req.body)
        : undefined,
    });

    const data = await shopifyRes.json();
    return res.status(shopifyRes.status).json(data);

  } catch (error) {
    console.error('[shopify-proxy] Erro:', error);
    return res.status(500).json({
      error: 'Erro interno ao chamar API Shopify',
      details: error.message
    });
  }
}
