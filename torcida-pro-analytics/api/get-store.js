// api/get-store.js — Vercel Function
// Convertido de netlify/functions/get-store.js
// Proxy seguro: GET /v1/{store_id}/store
// Query params: store_id (opcional)

const NS_BASE  = 'https://api.nuvemshop.com.br/v1';
const NS_UA    = 'TorcidaPro/2.0 (contato@torcidapro.com.br)';
const STORE_ID = process.env.NS_STORE_ID || '7475657';
const TOKEN    = process.env.NS_TOKEN || process.env.NUVEM_TOKEN || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido. Use GET.' });

  const authHdr = req.headers['authorization'] || '';
  const token   = authHdr.replace(/^bearer\s+/i, '').trim() || TOKEN;
  if (!token) return res.status(401).json({ error: 'Token Nuvemshop não encontrado.' });

  const storeId = req.query?.store_id || STORE_ID;

  try {
    const url  = `${NS_BASE}/${storeId}/store`;
    const resp = await fetch(url, {
      method:  'GET',
      headers: { 'Authentication': `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': NS_UA },
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return res.status(resp.status).json({
        error:       data.description || data.message || `HTTP ${resp.status}`,
        ns_response: data,
      });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('[get-store] Erro interno:', err.message);
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}
