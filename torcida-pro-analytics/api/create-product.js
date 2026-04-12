// api/create-product.js — Vercel Function
// ════════════════════════════════════════════════════════════════════════════
//  TORCIDA PRO — NuvemShop Integration v3.0
//  Estratégia: POST (criar) | PUT (atualizar) | retry inteligente em 422
//  Compatível com: await pipPublicarNuvemshop(produto, token, storeId, productId?)
// ════════════════════════════════════════════════════════════════════════════

const NS_BASE  = 'https://api.nuvemshop.com.br/v1';
const NS_UA    = 'TorcidaPro/3.0 (contato@torcidapro.com.br)';
const STORE_ID = process.env.NS_STORE_ID || '7475657';
const TOKEN    = process.env.NS_TOKEN || process.env.NUVEM_TOKEN || '';

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Extrai string segura de campos que podem ser objeto multilíngue */
function str(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') {
    return String(v.pt || v.es || v.en || Object.values(v)[0] || '').trim();
  }
  return String(v).trim();
}

/** Deduplica tags, retornando string CSV */
function dedupTags(tags) {
  if (!tags) return '';
  const raw = Array.isArray(tags) ? tags.join(',') : String(tags);
  return [...new Set(
    raw.split(',').map(t => t.trim()).filter(Boolean)
  )].join(',');
}

/** Gera handle seguro a partir de uma string */
function toHandle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // remove acentos
    .replace(/[^a-z0-9]+/g, '-')       // não-alfanum → hífen
    .replace(/^-+|-+$/g, '');          // trim de hífens
}

/** Gera sufixo único: timestamp em base36 (6 chars) */
function uniqSuffix() {
  return Date.now().toString(36).slice(-6);
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZAÇÃO DE VARIANTES
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Normaliza e deduplica variantes para o formato exato da Nuvemshop.
 *
 * Regras:
 *  - values[] deve ter exatamente 1 item por variante
 *  - Sem duplicatas (comparação case-insensitive)
 *  - SKU único garantido por timestamp base36
 *  - Preserva capitalização original do frontend
 *
 * @param {Array}  raw     - variantes cruas do frontend
 * @param {string} handle  - handle do produto (base para SKUs)
 * @param {string} suffix  - sufixo de unicidade (pode ser forçado para retry)
 */
function normVariants(raw, handle, suffix) {
  const arr = Array.isArray(raw) && raw.length
    ? raw
    : [{ values: ['Único'], price: '0', stock: 100 }];

  const skuBase = toHandle(handle || 'produto');
  const sfx     = suffix || uniqSuffix();
  const seen    = new Set();
  const out     = [];

  for (const v of arr) {
    // Extrair valor do tamanho (aceita string, array, { values }, { value }, { option1 })
    let val = v && typeof v === 'object'
      ? (Array.isArray(v.values) ? v.values[0] : (v.value || v.option1 || v.size || ''))
      : v;
    if (Array.isArray(val)) val = val[0];
    val = String(val || '').trim();

    const key = val.toLowerCase();
    if (!val || seen.has(key)) {
      if (val) console.warn(`[normVariants] ⚠️ Duplicata removida: "${val}"`);
      continue;
    }
    seen.add(key);

    const price = parseFloat(String(v?.price || '0').replace(',', '.'));
    // SKU: "camisa-barcelona-p-1x2y3z" — único por produto + tamanho + sessão
    const skuSlug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const sku = v?.sku
      ? String(v.sku).trim()
      : `${skuBase}-${skuSlug}-${sfx}`;

    const item = {
      price:            (!isNaN(price) && price > 0) ? price.toFixed(2) : '0.00',
      stock:            parseInt(v?.stock, 10) || 100,
      stock_management: true,
      sku,
      values:           [val],   // EXATAMENTE 1 item — obrigatório pela API
    };

    if (v?.compare_at_price) {
      const cap = parseFloat(String(v.compare_at_price).replace(',', '.'));
      if (!isNaN(cap) && cap > price) {
        item.compare_at_price = cap.toFixed(2);
      }
    }

    out.push(item);
  }

  if (!out.length) {
    // Fallback seguro
    out.push({
      price: '0.00', stock: 100, stock_management: true,
      sku:    `${skuBase}-unico-${sfx}`,
      values: ['Único'],
    });
  }

  console.log('[normVariants] Tamanhos:', out.map(v => v.values[0]));
  console.log('[normVariants] SKUs:',     out.map(v => v.sku));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function makeHeaders(token) {
  return {
    'Authentication': `bearer ${token}`,
    'Content-Type':   'application/json',
    'User-Agent':     NS_UA,
  };
}

async function nsRequest(method, url, token, body) {
  const opts = { method, headers: makeHeaders(token) };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  return { status: resp.status, ok: resp.ok, json, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// OPERAÇÕES NA API
// ─────────────────────────────────────────────────────────────────────────────

async function apiCreate(payload, storeId, token) {
  return nsRequest('POST', `${NS_BASE}/${storeId}/products`, token, payload);
}

async function apiUpdate(productId, payload, storeId, token) {
  return nsRequest('PUT', `${NS_BASE}/${storeId}/products/${productId}`, token, payload);
}

async function apiDelete(productId, storeId, token) {
  const r = await nsRequest('DELETE', `${NS_BASE}/${storeId}/products/${productId}`, token);
  return r.ok || r.status === 204 || r.status === 404;
}

/** Busca produto por handle varrendo páginas (paginação completa) */
async function findByHandle(handle, storeId, token) {
  console.log(`[NS] 🔍 Buscando produto handle="${handle}"...`);
  let page = 1;
  while (true) {
    const r = await nsRequest(
      'GET',
      `${NS_BASE}/${storeId}/products?per_page=200&page=${page}&fields=id,handle`,
      token
    );
    if (!r.ok) {
      console.warn(`[NS] ⚠️ Erro ao listar produtos (página ${page}): ${r.status}`);
      return null;
    }
    const list = Array.isArray(r.json) ? r.json : [];
    console.log(`[NS] Página ${page}: ${list.length} produto(s)`);
    if (!list.length) return null;
    const match = list.find(p => str(p.handle) === handle);
    if (match) {
      console.log(`[NS] ✅ Handle encontrado → id=${match.id}`);
      return match;
    }
    if (list.length < 200) return null;
    page++;
    await sleep(300); // throttle entre páginas
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUTOR DE PAYLOAD
// ─────────────────────────────────────────────────────────────────────────────

function buildPayload(produto, handle, variants, includeImages = true) {
  const nome = str(produto.name || produto.title) || 'Produto';
  const desc = str(produto.description || produto.body_html) || '';
  const tags = dedupTags(produto.tags);

  const optionValues = [...new Set(variants.map(v => v.values[0]).filter(Boolean))];

  const images = includeImages && Array.isArray(produto.images)
    ? produto.images
        .map((im, i) => {
          const src = typeof im === 'string' ? im : (im.src || im.url || '');
          if (!src || !src.startsWith('http')) return null;
          return { src, position: i + 1, alt: im.alt || nome };
        })
        .filter(Boolean)
    : [];

  const payload = {
    name:        { pt: nome },
    description: { pt: desc },
    handle:      { pt: handle },
    published:   produto.published !== false,
    // options[].name como objeto multilíngue — obrigatório pela Nuvemshop
    options:     [{ name: { pt: 'Tamanho' }, values: optionValues }],
    variants,
  };

  if (tags)                    payload.tags            = tags;
  if (produto.seo_title)       payload.seo_title       = str(produto.seo_title);
  if (produto.seo_description) payload.seo_description = str(produto.seo_description);
  if (images.length)           payload.images          = images;

  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASSIFICADOR DE ERRO 422
// ─────────────────────────────────────────────────────────────────────────────

function classify422(detail, variantValues) {
  const msg = JSON.stringify(detail || '').toLowerCase();

  // ── 1. SKU conflict — check FIRST, highest priority ──────────────────────
  // Nuvemshop returns: {"variants":[{"sku":["has already been taken"]}]}
  if (msg.includes('sku') || msg.includes('already taken') || msg.includes('already been taken')) {
    return 'SKU_CONFLICT';
  }

  // ── 2. True variant duplicate — only if payload itself has real duplicates ─
  // "variant values should not be repeated" can also appear on HANDLE conflicts.
  // We only treat it as VARIANT_DUPLICATE if the values[] we sent are actually duped.
  if (msg.includes('variant') && (msg.includes('repeat') || msg.includes('duplicat') || msg.includes('should not'))) {
    // Cross-check: are the values we sent actually duplicated?
    if (variantValues && Array.isArray(variantValues)) {
      const unique = new Set(variantValues.map(v => String(v).toLowerCase()));
      if (unique.size < variantValues.length) {
        return 'VARIANT_DUPLICATE'; // real duplicate in payload
      }
    }
    // No real duplicates in payload → this is a handle/product conflict
    return 'HANDLE_CONFLICT';
  }

  // ── 3. Handle conflict ────────────────────────────────────────────────────
  if (msg.includes('handle')) {
    return 'HANDLE_CONFLICT';
  }

  // ── 4. Unknown — treat as handle conflict to attempt delete+retry ─────────
  return 'HANDLE_CONFLICT';
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL — pipPublicarNuvemshop
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Publica ou atualiza um produto na Nuvemshop.
 *
 * @param {object} produto      - Dados do produto gerado pelo pipeline
 * @param {string} token        - Token de autenticação da Nuvemshop
 * @param {string} storeId      - ID da loja
 * @param {string|null} productId - ID do produto existente (para UPDATE) ou null (para CREATE)
 * @returns {Promise<object>}   - { product_id, product, action: 'created'|'updated' }
 * @throws {Error}              - Lança erro com mensagem clara em caso de falha definitiva
 */
async function pipPublicarNuvemshop(produto, token, storeId, productId = null) {
  const label = productId ? `UPDATE id=${productId}` : 'CREATE';
  console.log(`\n[NS] ════════ ${label} ════════`);

  // ── Validações básicas ────────────────────────────────────────────────────
  if (!token)   throw new Error('Token ausente');
  if (!storeId) throw new Error('storeId ausente');

  const nome      = str(produto.name || produto.title) || 'Produto';
  const handleRaw = str(produto.handle || produto.slug) || nome;
  const handle    = toHandle(handleRaw);

  console.log(`[NS] Nome:   ${nome}`);
  console.log(`[NS] Handle: ${handle}`);

  // ── MODO UPDATE ───────────────────────────────────────────────────────────
  if (productId) {
    console.log(`[NS] ✏️  Atualizando produto id=${productId}...`);

    const suffix   = uniqSuffix();
    const variants = normVariants(produto.variants, handle, suffix);
    const payload  = buildPayload(produto, handle, variants, false); // imagens via upload separado no update
    delete payload.handle; // handle não deve mudar no update

    const result = await apiUpdate(productId, payload, storeId, token);
    console.log(`[NS] PUT status=${result.status}`);

    if (result.ok) {
      console.log(`[NS] ✅ Produto atualizado! id=${result.json.id}`);
      return { product_id: result.json.id, product: result.json, action: 'updated' };
    }

    // 422 no update → regenerar SKUs e tentar novamente
    if (result.status === 422) {
      const errorType = classify422(result.json, null);
      console.warn(`[NS] ⚠️  422 no UPDATE (${errorType}). Regenerando SKUs e retentando...`);

      const suffix2   = uniqSuffix();
      const variants2 = normVariants(produto.variants, handle, suffix2);
      const payload2  = buildPayload(produto, handle, variants2, false);
      delete payload2.handle;

      await sleep(800);
      const result2 = await apiUpdate(productId, payload2, storeId, token);
      console.log(`[NS] PUT retry status=${result2.status}`);

      if (result2.ok) {
        console.log(`[NS] ✅ Produto atualizado no retry! id=${result2.json.id}`);
        return { product_id: result2.json.id, product: result2.json, action: 'updated' };
      }

      throw new Error(
        `[NS] ❌ Falha ao atualizar produto (${result2.status}): ${JSON.stringify(result2.json).slice(0, 200)}`
      );
    }

    throw new Error(
      `[NS] ❌ Erro ao atualizar produto (${result.status}): ${JSON.stringify(result.json).slice(0, 200)}`
    );
  }

  // ── MODO CREATE ───────────────────────────────────────────────────────────
  console.log(`[NS] 🚀 Criando produto "${nome}"...`);

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const suffix   = uniqSuffix();
    const variants = normVariants(produto.variants, handle, suffix);

    // Payload SEM imagens na tentativa 2+ (evita timeout e facilita diagnóstico)
    const includeImages = attempt === 1;
    const payload       = buildPayload(produto, handle, variants, includeImages);

    console.log(`[NS] Tentativa ${attempt}/${MAX_ATTEMPTS} | SKU sufixo: ${suffix} | imagens: ${includeImages}`);
    console.log(`[NS] Variantes: ${JSON.stringify(variants.map(v => ({ val: v.values[0], sku: v.sku })))}`);

    let result;
    try {
      result = await apiCreate(payload, storeId, token);
    } catch (e) {
      throw new Error(`[NS] ❌ Erro de rede na tentativa ${attempt}: ${e.message}`);
    }

    console.log(`[NS] POST status=${result.status}`);

    // ── Sucesso ──────────────────────────────────────────────────────────────
    if (result.ok) {
      console.log(`[NS] ✅ Produto criado! id=${result.json.id}`);
      return { product_id: result.json.id, product: result.json, action: 'created' };
    }

    // ── 422 — análise inteligente ─────────────────────────────────────────
    if (result.status === 422) {
      const sentValues = variants.map(v => v.values && v.values[0]);
      const errorType = classify422(result.json, sentValues);
      console.error(`[NS] 422 detectado — tipo: ${errorType}`);
      console.error(`[NS] Detalhe: ${JSON.stringify(result.json).slice(0, 400)}`);

      if (errorType === 'VARIANT_DUPLICATE') {
        // Só chegamos aqui se o payload enviado TEM valores realmente duplicados
        console.error('[NS] 🚨 Duplicata real em values[]. Valores:', variants.map(v => v.values[0]));
        console.error('[NS] Detalhe API:', JSON.stringify(result.json));
        throw new Error(
          `ERRO REAL: values[] duplicados no payload. Verifique _cdnMontarProduto. Valores: ${variants.map(v => v.values[0]).join(', ')}`
        );
      }

      if (errorType === 'SKU_CONFLICT') {
        // SKU já existente → próxima iteração gera novo suffix automaticamente
        console.warn(`[NS] ⚠️  SKU em conflito. Regenerando na tentativa ${attempt + 1}...`);
        await sleep(600 * attempt);
        continue;
      }

      if (errorType === 'HANDLE_CONFLICT' || errorType === 'UNKNOWN_422') {
        // Handle duplicado → localizar produto, deletar e recriar
        console.warn(`[NS] ⚠️  Conflito de handle ou 422 desconhecido. Buscando produto existente...`);

        const existing = await findByHandle(handle, storeId, token).catch(e => {
          console.warn(`[NS] Erro ao buscar por handle: ${e.message}`);
          return null;
        });

        if (existing) {
          console.log(`[NS] 🗑️  Deletando produto duplicado id=${existing.id}...`);
          const deleted = await apiDelete(existing.id, storeId, token);
          console.log(`[NS] DELETE ${deleted ? '✅ ok' : '⚠️ falhou (continuando mesmo assim)'}`);
          await sleep(1200); // aguardar propagação da deleção
          continue; // tentar criar novamente
        }

        // Não encontrou pelo handle — 422 por motivo desconhecido
        if (attempt < MAX_ATTEMPTS) {
          console.warn(`[NS] 422 sem handle duplicado. Aguardando e retentando...`);
          await sleep(1000 * attempt);
          continue;
        }
      }
    }

    // ── Erro não recuperável ─────────────────────────────────────────────────
    if (attempt === MAX_ATTEMPTS) {
      console.error(`[NS] ❌ Falha definitiva após ${MAX_ATTEMPTS} tentativas.`);
      console.error(`[NS] Último status: ${result.status} | Resposta: ${result.text.slice(0, 400)}`);
      throw new Error(
        `Falha ao criar produto "${nome}" (${result.status}): ${JSON.stringify(result.json).slice(0, 200)}`
      );
    }

    // Erro genérico não-422 — aguardar e tentar
    console.warn(`[NS] Erro ${result.status} na tentativa ${attempt}. Retentando...`);
    await sleep(800 * attempt);
  }

  throw new Error(`[NS] ❌ Todas as ${MAX_ATTEMPTS} tentativas falharam.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER VERCEL (HTTP endpoint)
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method Not Allowed' });

  const body     = req.body || {};
  const authHdr  = req.headers['authorization'] || '';
  const token    = authHdr.replace(/^bearer\s+/i, '').trim() || body.token || TOKEN;
  const produto  = body.produto || body;
  const storeId  = body.store_id || body.storeId || produto?.store_id || STORE_ID;
  // productId presente → UPDATE, ausente → CREATE
  const productId = body.product_id || body.productId || produto?.product_id || null;

  if (!token)   return res.status(401).json({ error: 'Token ausente' });
  if (!storeId) return res.status(400).json({ error: 'storeId ausente' });

  try {
    const result = await pipPublicarNuvemshop(produto, token, storeId, productId);
    return res.status(200).json(result);
  } catch (e) {
    console.error('[handler] ❌', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT para uso interno no pipeline (ESM)
// ─────────────────────────────────────────────────────────────────────────────
export { pipPublicarNuvemshop };
