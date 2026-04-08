// api/upload-image.js — Vercel Function
// Upload de imagem para o Cloudinary (signed upload via API key/secret)
// E depois associa a URL ao produto na Nuvemshop.
//
// Body: { src?, file_base64?, product_id, store_id?, pasta?, public_id? }
//   - src: URL pública já existente → só associa na Nuvemshop (sem re-upload)
//   - file_base64: imagem em base64 → faz upload no Cloudinary e associa
// ═══════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const API_KEY    = process.env.CLOUDINARY_API_KEY    || '';
const API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

const NS_BASE  = 'https://api.nuvemshop.com.br/v1';
const NS_UA    = 'TorcidaPro/2.0 (contato@torcidapro.com.br)';
const STORE_ID = process.env.NS_STORE_ID || '7475657';
const TOKEN    = process.env.NS_TOKEN || process.env.NUVEM_TOKEN || '';

// ── Gera assinatura Cloudinary (signed upload) ────────────────────────────────
function gerarAssinatura(params) {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('sha256').update(sorted + API_SECRET).digest('hex');
}

// ── Upload para Cloudinary ────────────────────────────────────────────────────
async function uploadCloudinary(fileBase64, pasta = 'camisas', publicId = '') {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder    = pasta;

  const paramsSig = { folder, timestamp };
  if (publicId) paramsSig.public_id = publicId;

  const signature = gerarAssinatura(paramsSig);

  const form = new URLSearchParams();
  form.append('file',      'data:image/jpeg;base64,' + fileBase64);
  form.append('timestamp', timestamp);
  form.append('api_key',   API_KEY);
  form.append('signature', signature);
  form.append('folder',    folder);
  if (publicId) form.append('public_id', publicId);

  const resp = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body:   form,
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `Cloudinary ${resp.status}`);
  return data.secure_url;
}

// ── Associar imagem ao produto na Nuvemshop ───────────────────────────────────
async function associarNuvemshop(src, productId, storeId, token, position, alt) {
  const payload = { src };
  if (position !== undefined) payload.position = position;
  if (alt)                    payload.alt       = alt;

  const resp = await fetch(`${NS_BASE}/${storeId}/products/${productId}/images`, {
    method:  'POST',
    headers: {
      'Authentication': `bearer ${token}`,
      'Content-Type':   'application/json',
      'User-Agent':     NS_UA,
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.description || data.message || `Nuvemshop ${resp.status}`);
  return data;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Use POST.' });

  const authHdr = req.headers['authorization'] || '';
  const token   = authHdr.replace(/^bearer\s+/i, '').trim() || TOKEN;
  if (!token) return res.status(401).json({ error: 'Token Nuvemshop não encontrado.' });

  const body       = req.body || {};
  const product_id = body.product_id;
  const store_id   = body.store_id || STORE_ID;

  if (!product_id) return res.status(400).json({ error: 'Campo product_id é obrigatório.' });

  let src = body.src || '';

  // ── Se vier base64, faz upload no Cloudinary primeiro ───────────────────────
  if (!src && body.file_base64) {
    if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
      return res.status(500).json({ error: 'Variáveis Cloudinary não configuradas.' });
    }
    try {
      console.log('[upload-image] Fazendo upload no Cloudinary...');
      src = await uploadCloudinary(body.file_base64, body.pasta || 'camisas', body.public_id || '');
      console.log('[upload-image] ✅ Upload Cloudinary:', src);
    } catch (e) {
      return res.status(500).json({ error: 'Erro no upload Cloudinary: ' + e.message });
    }
  }

  if (!src || !src.startsWith('http')) {
    return res.status(400).json({ error: 'Informe src (URL) ou file_base64.' });
  }

  // ── Associar na Nuvemshop ────────────────────────────────────────────────────
  try {
    const data = await associarNuvemshop(src, product_id, store_id, token, body.position, body.alt);
    console.log('[upload-image] ✅ Imagem associada na Nuvemshop:', data.id, src);
    return res.status(201).json({ image_id: data.id, src, nuvemshop: data });
  } catch (e) {
    console.error('[upload-image] ❌ Erro Nuvemshop:', e.message);
    return res.status(500).json({ error: e.message, src });
  }
}
