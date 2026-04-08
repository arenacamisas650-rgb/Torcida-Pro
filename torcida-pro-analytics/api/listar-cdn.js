// api/listar-cdn.js — Vercel Function
// Integração com Cloudinary: lista imagens de uma pasta específica
// Endpoint: GET /api/listar-cdn?pasta=camisas&max=500
// ═══════════════════════════════════════════════════════════════

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const API_KEY    = process.env.CLOUDINARY_API_KEY    || '';
const API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

// ── Autenticação Basic para Cloudinary Admin API ──────────────────────────────
function basicAuth() {
  const credentials = `${API_KEY}:${API_SECRET}`;
  return 'Basic ' + Buffer.from(credentials).toString('base64');
}

// ── Buscar recursos do Cloudinary via Admin API ───────────────────────────────
async function listarCloudinary(pasta = '', maxResults = 500) {
  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    throw new Error('Variáveis CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY e CLOUDINARY_API_SECRET não configuradas.');
  }

  const allFiles = [];
  let nextCursor = null;

  do {
    const params = new URLSearchParams({
      type:        'upload',
      max_results: Math.min(maxResults - allFiles.length, 500),
      ...(pasta       ? { prefix: pasta }         : {}),
      ...(nextCursor  ? { next_cursor: nextCursor } : {}),
    });

    const url = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/resources/image?${params}`;

    const resp = await fetch(url, {
      headers: {
        'Authorization': basicAuth(),
        'Content-Type':  'application/json',
      },
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Cloudinary API ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const resources = data.resources || [];

    // Montar URL pública de cada imagem
    for (const r of resources) {
      const url = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${r.public_id}.${r.format}`;
      allFiles.push(url);
    }

    nextCursor = data.next_cursor || null;

  } while (nextCursor && allFiles.length < maxResults);

  return allFiles;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')    return res.status(405).json({ success: false, error: 'Método não permitido. Use GET.' });

  const pasta      = req.query?.pasta || '';
  const maxResults = Math.min(parseInt(req.query?.max || '500'), 2000);

  try {
    console.log(`[listar-cdn] Buscando imagens Cloudinary | pasta="${pasta}" | max=${maxResults}`);

    const files = await listarCloudinary(pasta, maxResults);

    console.log(`[listar-cdn] ✅ ${files.length} imagem(ns) encontrada(s)`);

    return res.status(200).json({
      success: true,
      total:   files.length,
      files,
    });

  } catch (error) {
    console.error('[listar-cdn] ❌ Erro:', error.message);
    return res.status(500).json({
      success: false,
      error:   error.message,
      files:   [],
    });
  }
}
