// api/delete-products.js — Vercel Function
// Convertido de netlify/functions/delete-products.js
// Deleta todos os produtos da loja, ou filtra por handles específicos.
// Body: {} (vazio = deleta tudo) | { "handles": ["camisa-barcelona-..."] }

const NS_BASE  = 'https://api.nuvemshop.com.br/v1';
const NS_STORE = process.env.NS_STORE_ID || '7475657';
const NS_TOKEN = process.env.NS_TOKEN || process.env.NUVEM_TOKEN || '';

function hdr(token) {
  return {
    'Authentication': `bearer ${token}`,
    'Content-Type':   'application/json',
    'User-Agent':     'TorcidaPro/2.0',
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const authHdr = req.headers['authorization'] || '';
  const token   = authHdr.replace(/^bearer\s+/i, '').trim() || NS_TOKEN;
  if (!token) return res.status(401).json({ error: 'Token ausente' });

  const body         = req.body || {};
  const filtroHandles = body.handles || null;

  // 1. Listar todos os produtos
  const listResp = await fetch(`${NS_BASE}/${NS_STORE}/products?per_page=200&fields=id,name,handle`, {
    headers: hdr(token),
  });
  const listText = await listResp.text();
  let produtos;
  try { produtos = JSON.parse(listText); } catch { produtos = []; }
  if (!Array.isArray(produtos)) produtos = produtos.results || [];

  console.log(`[delete-products] ${produtos.length} produto(s) encontrado(s) na loja`);

  // 2. Filtrar por handles se especificado
  const alvo = filtroHandles
    ? produtos.filter(p => {
        const h = typeof p.handle === 'object' ? (p.handle.pt || '') : (p.handle || '');
        return filtroHandles.some(f => h.includes(f) || f.includes(h));
      })
    : produtos;

  const resultado = { deletados: [], erros: [], total_na_loja: produtos.length };

  // 3. Deletar um por um
  for (const p of alvo) {
    const pid  = p.id;
    const nome = typeof p.name === 'object' ? (p.name.pt || pid) : (p.name || pid);
    try {
      const del = await fetch(`${NS_BASE}/${NS_STORE}/products/${pid}`, {
        method: 'DELETE',
        headers: hdr(token),
      });
      if (del.ok || del.status === 204 || del.status === 404) {
        console.log(`[delete-products] ✅ Deletado: ${nome} (id=${pid})`);
        resultado.deletados.push({ id: pid, nome });
      } else {
        const err = await del.text();
        console.error(`[delete-products] ❌ Falha ao deletar ${nome}: ${del.status} ${err}`);
        resultado.erros.push({ id: pid, nome, status: del.status, erro: err });
      }
    } catch (e) {
      resultado.erros.push({ id: pid, nome, erro: e.message });
    }
    // Delay para não throttle a API
    await new Promise(r => setTimeout(r, 300));
  }

  return res.status(200).json(resultado);
}
