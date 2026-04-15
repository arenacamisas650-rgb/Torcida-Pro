/**
 * ══════════════════════════════════════════════════════════════
 *  TORCIDA PRO — Servidor Local
 *  Resolve todos os erros de CORS ao abrir index.html via file://
 *
 *  Como usar:
 *    1. Instale o Node.js em nodejs.org (versão 18+)
 *    2. Abra o terminal nesta pasta
 *    3. Execute:  node server.js
 *    4. Acesse:   http://localhost:3000
 * ══════════════════════════════════════════════════════════════
 */

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const url      = require('url');

const PORT    = 3000;
const HTML    = 'index.html';           // seu arquivo principal
const FOLDER  = path.join(process.cwd()); // pasta onde está o server.js

// ── MIME types ────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── Helper: ler body JSON ─────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ── Helper: proxy HTTPS para a Nuvemshop ─────────────────────
function httpsReq(options, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Helper: resposta JSON ─────────────────────────────────────
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(body);
}

// ── Helper: extrair token e storeId ──────────────────────────
function getCreds(req, body) {
  const auth    = req.headers['authorization'] || '';
  const token   = auth.replace(/^bearer\s+/i, '').trim();
  const storeId = body?.store_id || '';
  return { token, storeId };
}

// ── Nuvemshop API base ────────────────────────────────────────
function nsBase(storeId) {
  return `api.nuvemshop.com.br/v1/${storeId}`;
}

// ══════════════════════════════════════════════════════════════
//  ROTAS DA API
// ══════════════════════════════════════════════════════════════
async function handleAPI(req, res, pathname, query, body) {

  const { token, storeId } = getCreds(req, body);

  // ── GET /api/get-store ─────────────────────────────────────
  if (pathname === '/api/get-store' && req.method === 'GET') {
    const sid = query.store_id || storeId;
    if (!token || !sid) return json(res, 400, { error: 'Token ou store_id ausentes' });
    try {
      const r = await httpsReq({
        hostname: `api.nuvemshop.com.br`,
        path:     `/v1/${sid}/store`,
        method:   'GET',
        headers:  { 'Authentication': `bearer ${token}`, 'User-Agent': 'TorcidaPro/1.0' },
      });
      return json(res, r.status, r.body);
    } catch(e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/get-products ──────────────────────────────────
  if (pathname === '/api/get-products' && req.method === 'GET') {
    const sid      = query.store_id || storeId;
    const perPage  = query.per_page || '10';
    const page     = query.page     || '1';
    const q        = query.q        || '';
    if (!token || !sid) return json(res, 400, { error: 'Token ou store_id ausentes' });
    const qs = `?per_page=${perPage}&page=${page}${q ? '&q=' + encodeURIComponent(q) : ''}`;
    try {
      const r = await httpsReq({
        hostname: 'api.nuvemshop.com.br',
        path:     `/v1/${sid}/products${qs}`,
        method:   'GET',
        headers:  { 'Authentication': `bearer ${token}`, 'User-Agent': 'TorcidaPro/1.0' },
      });
      return json(res, r.status, r.body);
    } catch(e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/create-product ───────────────────────────────
  if (pathname === '/api/create-product' && req.method === 'POST') {
    const sid = body?.store_id || storeId;
    if (!token || !sid) return json(res, 400, { error: 'Token ou store_id ausentes' });
    const payload = body?.produto || body;
    const str = JSON.stringify(payload);
    console.log(`[create-product] store=${sid} | name=${payload?.name?.pt || payload?.name}`);
    try {
      const r = await httpsReq({
        hostname: 'api.nuvemshop.com.br',
        path:     `/v1/${sid}/products`,
        method:   'POST',
        headers:  {
          'Authentication':  `bearer ${token}`,
          'Content-Type':    'application/json',
          'Content-Length':  Buffer.byteLength(str),
          'User-Agent':      'TorcidaPro/1.0',
        },
      }, str);
      console.log(`[create-product] resposta: HTTP ${r.status}`);
      if (!r.body.id && !r.body.product_id) {
        console.error('[create-product] Erro Nuvemshop:', JSON.stringify(r.body).slice(0, 300));
      }
      return json(res, r.status, r.body);
    } catch(e) {
      console.error('[create-product] Exceção:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  // ── PUT /api/update-product ────────────────────────────────
  if (pathname === '/api/update-product' && req.method === 'PUT') {
    const sid       = body?.store_id || storeId;
    const productId = body?.product_id;
    if (!token || !sid || !productId) return json(res, 400, { error: 'Campos obrigatórios ausentes' });
    const payload = body?.produto || body;
    const str = JSON.stringify(payload);
    try {
      const r = await httpsReq({
        hostname: 'api.nuvemshop.com.br',
        path:     `/v1/${sid}/products/${productId}`,
        method:   'PUT',
        headers:  {
          'Authentication':  `bearer ${token}`,
          'Content-Type':    'application/json',
          'Content-Length':  Buffer.byteLength(str),
          'User-Agent':      'TorcidaPro/1.0',
        },
      }, str);
      return json(res, r.status, r.body);
    } catch(e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── POST /api/upload-image ─────────────────────────────────
  if (pathname === '/api/upload-image' && req.method === 'POST') {
    const sid       = body?.store_id || storeId;
    const productId = body?.product_id;
    const src       = body?.src || '';
    if (!token || !sid || !productId || !src) return json(res, 400, { error: 'Campos obrigatórios ausentes' });
    const payload = JSON.stringify({ src, position: body?.position || 1, alt: body?.alt || { pt: '' } });
    try {
      const r = await httpsReq({
        hostname: 'api.nuvemshop.com.br',
        path:     `/v1/${sid}/products/${productId}/images`,
        method:   'POST',
        headers:  {
          'Authentication':  `bearer ${token}`,
          'Content-Type':    'application/json',
          'Content-Length':  Buffer.byteLength(payload),
          'User-Agent':      'TorcidaPro/1.0',
        },
      }, payload);
      console.log(`[upload-image] produto=${productId} src=${src.slice(0,60)} → HTTP ${r.status}`);
      return json(res, r.status, r.body);
    } catch(e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ── GET /api/listar-cdn ────────────────────────────────────
  // Lê o arquivo imagens/index.json (coloque seus arquivos lá)
  // OU lê diretamente a pasta /imagens e lista os arquivos
  if (pathname === '/api/listar-cdn' && req.method === 'GET') {
    // Tenta ler imagens/index.json primeiro
    const indexPath = path.join(FOLDER, 'imagens', 'index.json');
    if (fs.existsSync(indexPath)) {
      try {
        const data = fs.readFileSync(indexPath, 'utf8');
        return json(res, 200, JSON.parse(data));
      } catch(e) {
        return json(res, 500, { error: 'Erro ao ler index.json: ' + e.message });
      }
    }

    // Fallback: lista arquivos da pasta /imagens automaticamente
    const imgDir = path.join(FOLDER, 'imagens');
    if (fs.existsSync(imgDir)) {
      const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
      const arquivos = fs.readdirSync(imgDir)
        .filter(f => exts.includes(path.extname(f).toLowerCase()));
      console.log(`[listar-cdn] ${arquivos.length} arquivo(s) encontrado(s) em /imagens`);
      return json(res, 200, arquivos);
    }

    // Nenhum arquivo — retorna lista vazia com instrução
    console.warn('[listar-cdn] Pasta /imagens não encontrada. Crie a pasta e adicione index.json ou imagens.');
    return json(res, 200, []);
  }

  // ── Rota não encontrada ────────────────────────────────────
  return json(res, 404, { error: 'Rota não encontrada: ' + pathname });
}

// ══════════════════════════════════════════════════════════════
//  SERVIDOR PRINCIPAL
// ══════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query    = parsed.query;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    });
    return res.end();
  }

  // ── Rotas /api/* ──────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    let body = {};
    try {
      if (['POST','PUT','PATCH'].includes(req.method)) body = await readBody(req);
    } catch(e) { /* ignora erros de parse */ }
    return handleAPI(req, res, pathname, query, body);
  }

  // ── Arquivos estáticos (index.html, imagens/, etc.) ───────
  let filePath = pathname === '/' ? `/${HTML}` : pathname;
  filePath = path.join(FOLDER, filePath);

  // Segurança: impede path traversal
  if (!filePath.startsWith(FOLDER)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type':  mime,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end(`404 — Arquivo não encontrado: ${pathname}`);
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  ⚡ TORCIDA PRO — Servidor iniciado              ║');
  console.log(`║  🌐 Acesse:  http://localhost:${PORT}               ║`);
  console.log('║                                                  ║');
  console.log('║  📁 Estrutura esperada na pasta:                 ║');
  console.log('║     index.html        ← seu arquivo principal    ║');
  console.log('║     server.js         ← este servidor            ║');
  console.log('║     imagens/          ← pasta com as fotos       ║');
  console.log('║       index.json      ← lista dos arquivos       ║');
  console.log('║                                                  ║');
  console.log('║  Para parar o servidor: Ctrl + C                 ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ Porta ${PORT} já em uso. Feche outro servidor ou mude a porta no server.js.`);
  } else {
    console.error('❌ Erro no servidor:', e.message);
  }
});
