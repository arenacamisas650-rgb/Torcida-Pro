// ══════════════════════════════════════════════════════════════════════
//  api/create-product.js — Vercel Serverless Function
//  Torcida Pro Analytics · Backend de publicação Nuvemshop
// ──────────────────────────────────────────────────────────────────────
//  REGRAS CRÍTICAS:
//  1. NUNCA recriar variants — usar exatamente o que o frontend envia
//  2. NUNCA recalcular preços — usar price/compare_at_price do payload
//  3. NUNCA duplicar values[] — desduplicar na sanitização
//  4. Personalização NUNCA vira segunda option — apenas ajusta o preço
//  5. Apenas 1 option permitida: Tamanho
// ══════════════════════════════════════════════════════════════════════

const APP_VERSION = '2.2.0';

export default async function handler(req, res) {

  // ── CORS ──────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // ── Proteger contra body undefined (Content-Type errado) ──────────
  let body = req.body;
  if (!body || typeof body !== 'object') {
    const ct = req.headers['content-type'] || '';
    const errMsg = ct.includes('application/json')
      ? 'Corpo da requisição vazio ou inválido'
      : `Content-Type inválido: "${ct}" — use application/json`;
    return res.status(400).json({ error: errMsg });
  }

  // ── Extrair credenciais ─────────────────────────────────────────────
  const { store_id, produto } = body;

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^bearer\s+/i, '').trim()
    || body.token
    || body.access_token
    || '';

  // ── Validações básicas ──────────────────────────────────────────────
  if (!token)    return res.status(401).json({ error: 'Token de acesso ausente' });
  if (!store_id) return res.status(400).json({ error: 'store_id ausente' });
  if (!produto)  return res.status(400).json({ error: 'Payload de produto ausente' });

  try {
    // ── Sanitizar e reconstruir payload seguro ──────────────────────
    const sanitizado = sanitizarProduto(produto);

    // ── Validar imagens obrigatórias ────────────────────────────────
    if (!sanitizado.images || sanitizado.images.length === 0) {
      return res.status(400).json({
        error: 'Produto sem imagens válidas — adicione ao menos 1 imagem com URL https://',
        campo: 'images',
        dica:  'images deve ser array com pelo menos 1 objeto { src: "https://..." }',
      });
    }

    // ── Validar options[].values não vazio ──────────────────────────
    if (Array.isArray(sanitizado.options)) {
      for (const opt of sanitizado.options) {
        if (!opt.values || opt.values.length === 0) {
          return res.status(422).json({
            error: 'options[].values está vazio — defina pelo menos um tamanho (ex: "P")',
            campo: 'options',
            dica:  'options[0].values deve conter os tamanhos: ["P","M","G","GG"]',
          });
        }
      }
    }

    // ── Validar variants[].values contra options[].values ───────────
    const optionValues = sanitizado.options?.[0]?.values || [];
    if (optionValues.length > 0 && Array.isArray(sanitizado.variants)) {
      for (const v of sanitizado.variants) {
        const val = v.values?.[0];
        if (val && !optionValues.includes(val)) {
          return res.status(422).json({
            error: `variant.values[0] "${val}" não está em options[0].values (${optionValues.join(', ')})`,
            campo: 'variants',
            dica:  'Cada variant.values[0] deve existir em options[0].values',
          });
        }
      }
    }

    // ── Validação anti-422: variantes duplicadas ────────────────────
    const variantErr = validarVariants(sanitizado.variants);
    if (variantErr) {
      return res.status(422).json({
        error: variantErr,
        campo: 'variants',
        dica:  'Cada tamanho (values[]) deve ser único. "Variant values should not be repeated"',
      });
    }

    // ── Log do payload sanitizado para debug ────────────────────────
    console.log('[create-product] store_id:', store_id);
    console.log('[create-product] name:', sanitizado.name?.pt || sanitizado.name);
    console.log('[create-product] handle:', sanitizado.handle);
    console.log('[create-product] options:', JSON.stringify(sanitizado.options));
    console.log('[create-product] variants:', JSON.stringify(sanitizado.variants?.map(v => ({
      values: v.values, price: v.price, sku: v.sku, stock: v.stock,
    }))));
    console.log('[create-product] images:', sanitizado.images?.length, 'itens');

    // ── POST para Nuvemshop ─────────────────────────────────────────
    const nsUrl    = `https://api.nuvemshop.com.br/v1/${store_id}/products`;
    const nsResult = await nsPost(nsUrl, sanitizado, token);

    // ── Upsert: 422 por handle duplicado → tenta PUT ────────────────
    if (!nsResult.ok && nsResult.status === 422) {
      const errBody  = nsResult.data;
      const errText  = JSON.stringify(errBody).toLowerCase();
      const isDupHandle = errText.includes('handle') && (
        errText.includes('taken') || errText.includes('already') ||
        errText.includes('duplicat') || errText.includes('exist')
      );

      if (isDupHandle) {
        console.log('[create-product] Handle duplicado — tentando PUT (upsert)...');
        const existingId = await buscarProdutoPorHandle(store_id, sanitizado.handle, token);
        if (existingId) {
          const putUrl    = `${nsUrl}/${existingId}`;
          const putResult = await nsPut(putUrl, sanitizado, token);
          if (putResult.ok) {
            console.log('[create-product] ✅ Produto atualizado (upsert):', putResult.data.id);
            return res.status(200).json({
              success:    true,
              product_id: putResult.data.id,
              product:    putResult.data,
              mode:       'updated',
            });
          }
          const errPut = extrairPrimeiroErro(putResult.data);
          console.error('[create-product] PUT erro', putResult.status, JSON.stringify(putResult.data));
          return res.status(putResult.status).json({
            error:      errPut.mensagem,
            campo:      errPut.campo,
            motivo:     errPut.motivo,
            todos:      putResult.data,
            api_status: putResult.status,
            mode:       'update_failed',
          });
        }
      }

      // 422 por outro motivo
      const primeiroErro = extrairPrimeiroErro(errBody);
      console.error('[create-product] Nuvemshop 422:', JSON.stringify(errBody));
      return res.status(422).json({
        error:      primeiroErro.mensagem,
        campo:      primeiroErro.campo,
        motivo:     primeiroErro.motivo,
        todos:      errBody,
        api_status: 422,
      });
    }

    if (!nsResult.ok) {
      const primeiroErro = extrairPrimeiroErro(nsResult.data);
      console.error('[create-product] Nuvemshop erro', nsResult.status, JSON.stringify(nsResult.data));
      return res.status(nsResult.status).json({
        error:      primeiroErro.mensagem,
        campo:      primeiroErro.campo,
        motivo:     primeiroErro.motivo,
        todos:      nsResult.data,
        api_status: nsResult.status,
      });
    }

    const nsData = nsResult.data;
    console.log('[create-product] ✅ Produto criado:', nsData.id, nsData.name?.pt || nsData.name);
    return res.status(200).json({
      success:    true,
      product_id: nsData.id,
      product:    nsData,
      mode:       'created',
    });

  } catch (err) {
    console.error('[create-product] Erro interno:', err);
    return res.status(500).json({ error: err.message || 'Erro interno do servidor' });
  }
}

// ══════════════════════════════════════════════════════════════════════
//  Helpers HTTP
// ══════════════════════════════════════════════════════════════════════
function nsHeaders(token) {
  return {
    'User-Agent':     `TorcidaPro/${APP_VERSION}`,
    'Authentication': `bearer ${token}`,
    'Content-Type':   'application/json',
  };
}

async function nsPost(url, body, token) {
  const resp = await fetch(url, {
    method:  'POST',
    headers: nsHeaders(token),
    body:    JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

async function nsPut(url, body, token) {
  const resp = await fetch(url, {
    method:  'PUT',
    headers: nsHeaders(token),
    body:    JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

async function buscarProdutoPorHandle(storeId, handle, token) {
  try {
    const slug = typeof handle === 'object' ? (handle.pt || '') : String(handle || '');
    if (!slug) return null;
    const url  = `https://api.nuvemshop.com.br/v1/${storeId}/products?handle=${encodeURIComponent(slug)}&per_page=1`;
    const resp = await fetch(url, { headers: nsHeaders(token) });
    if (!resp.ok) return null;
    const data = await resp.json().catch(() => []);
    const list = Array.isArray(data) ? data : (data.results || []);
    return list[0]?.id || null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  sanitizarProduto
//  ─────────────────────────────────────────────────────────────────────
//  REGRA CRÍTICA SOBRE PERSONALIZAÇÃO:
//  Personalização NUNCA deve virar uma segunda option. A Nuvemshop só
//  aceita variants com values[] correspondendo 1:1 a options[0].values.
//  Se o frontend enviar variants com 2 values (tamanho + personalização),
//  isso causa "Variant values should not be repeated" porque dois variants
//  de tamanho "M" (um com personalização, outro sem) têm o mesmo key.
//
//  SOLUÇÃO: manter apenas 1 option (Tamanho). Personalização deve ser
//  tratada como produto separado com preço maior, NÃO como variant.
// ══════════════════════════════════════════════════════════════════════
function sanitizarProduto(p) {
  const out = {};

  // ── name ───────────────────────────────────────────────────────────
  out.name = typeof p.name === 'object'
    ? p.name
    : { pt: String(p.name || p.titulo || p.title || 'Produto').trim() };

  // ── description ────────────────────────────────────────────────────
  out.description = typeof p.description === 'object'
    ? p.description
    : { pt: String(p.description || p.descricao_html || p.descricao || '').trim() };

  // ── handle: SEMPRE string simples — Nuvemshop rejeita {pt:...} ─────
  if (p.handle || p.slug) {
    const raw = typeof p.handle === 'object'
      ? String(p.handle.pt || p.handle.en || '').trim()
      : String(p.handle || p.slug || '').trim();
    const slug = raw.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (slug) out.handle = slug;
  }

  // ── published ──────────────────────────────────────────────────────
  out.published = p.published !== undefined ? Boolean(p.published) : true;

  // ── seo_title e seo_description como strings simples ───────────────
  if (p.seo_title) {
    const s = String(p.seo_title).trim();
    if (s) out.seo_title = s;
  }
  if (p.seo_description) {
    const s = String(p.seo_description).trim();
    if (s) out.seo_description = s;
  }

  // ── tags ───────────────────────────────────────────────────────────
  if (p.tags) {
    const tagsStr = Array.isArray(p.tags)
      ? p.tags.filter(Boolean).join(',')
      : String(p.tags).trim();
    if (tagsStr) out.tags = tagsStr;
  }

  // ── options ────────────────────────────────────────────────────────
  if (Array.isArray(p.options) && p.options.length > 0) {
    out.options = p.options
      .filter(Boolean)
      .slice(0, 2)
      .map((opt, index) => {
        const name = typeof opt.name === 'object'
          ? opt.name
          : { pt: String(opt.name || (index === 0 ? 'Tamanho' : 'Personalização')).trim() };

        const values = Array.isArray(opt.values)
          ? [...new Set(opt.values.flatMap(v => Array.isArray(v) ? v : [v])
              .map(v => String(v || '').trim())
              .filter(Boolean))]
          : [];

        return { name, values };
      })
      .filter(opt => opt.values.length > 0);
  }

  // ── variants ───────────────────────────────────────────────────────
  if (Array.isArray(p.variants) && p.variants.length > 0) {
    const seen = new Map();

    for (const v of p.variants) {
      let values = [];
      if (Array.isArray(v.values) && v.values.length > 0) {
        values = v.values.flatMap(item => Array.isArray(item) ? item : [item])
          .map(item => String(item || '').trim())
          .filter(Boolean);
      } else {
        if (v.option1) values.push(String(v.option1).trim());
        if (v.option2) values.push(String(v.option2).trim());
        if (v.value) values.push(String(v.value).trim());
      }

      if (!values.length) continue;
      const key = values.map(vv => vv.toUpperCase()).join('|');
      if (!key) continue;

      const vOut = {
        values,
        price: String(Number(String(v.price ?? '99.90').replace(',', '.')).toFixed(2)),
        stock: typeof v.stock === 'number' ? v.stock : (parseInt(v.stock, 10) || 100),
        stock_management: true,
      };

      if (v.sku && String(v.sku).trim()) {
        vOut.sku = String(v.sku).trim();
      }

      if (v.compare_at_price !== undefined && v.compare_at_price !== null && String(v.compare_at_price).trim() !== '') {
        const cap = Number(String(v.compare_at_price).replace(',', '.'));
        if (!isNaN(cap)) {
          vOut.compare_at_price = cap.toFixed(2);
        }
      }

      if (seen.has(key)) {
        console.warn(`[sanitizarProduto] ⚠️ Variant duplicada "${key}" — mantendo a última ocorrência`);
      }
      seen.set(key, vOut);
    }

    out.variants = [...seen.values()];
  }

  const variantValuesCount = Array.isArray(out.variants) && out.variants.length > 0
    ? Math.max(...out.variants.map(v => Array.isArray(v.values) ? v.values.length : 0))
    : 0;

  if ((!out.options || !Array.isArray(out.options) || out.options.length === 0) && variantValuesCount > 0) {
    out.options = Array.from({ length: variantValuesCount }, (_, index) => {
      const values = [...new Set(
        out.variants.map(v => String(v.values[index] || '').trim()).filter(Boolean)
      )];
      return {
        name: { pt: index === 0 ? 'Tamanho' : 'Personalização' },
        values,
      };
    }).filter(opt => opt.values.length > 0);
  }

  if (Array.isArray(out.options)) {
    out.options = out.options.map((opt, index) => {
      const values = Array.isArray(opt.values)
        ? [...new Set(opt.values.map(v => String(v || '').trim()).filter(Boolean))]
        : [];
      const name = typeof opt.name === 'object'
        ? opt.name
        : { pt: String(opt.name || (index === 0 ? 'Tamanho' : 'Personalização')).trim() };
      return { name, values };
    }).filter(opt => opt.values.length > 0);
  }

  // ── images ─────────────────────────────────────────────────────────
  if (Array.isArray(p.images) && p.images.length > 0) {
    const imgs = p.images
      .map(img => {
        const src = typeof img === 'string' ? img : (img.src || img.url || '');
        return src && src.startsWith('http') ? { src: src.trim() } : null;
      })
      .filter(Boolean)
      .slice(0, 10);
    if (imgs.length > 0) out.images = imgs;
  }

  return out;
}

// ══════════════════════════════════════════════════════════════════════
//  validarVariants — retorna string de erro ou null se OK
// ══════════════════════════════════════════════════════════════════════
function validarVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return null;

  const seen = new Set();
  for (const v of variants) {
    if (!Array.isArray(v.values) || v.values.length === 0) {
      return 'Variant sem values[] definido — cada variante precisa de pelo menos 1 valor';
    }

    const cleanedValues = v.values.map(val => String(val || '').trim()).filter(Boolean);
    if (cleanedValues.length !== v.values.length) {
      return 'Variant contém valores vazios ou inválidos';
    }

    const key = cleanedValues.map(val => val.toUpperCase()).join('|');
    if (seen.has(key)) {
      return `"Variant values should not be repeated" — variante "${key}" duplicada`;
    }
    seen.add(key);
  }

  return null; // ✅ OK
}

// ══════════════════════════════════════════════════════════════════════
//  extrairPrimeiroErro — trata estrutura aninhada do 422 da Nuvemshop
//
//  Formatos reais da Nuvemshop:
//  a) { "description": "Unprocessable Entity", "variants": { "0": { "values": ["should not be repeated"] } } }
//  b) { "campo": ["mensagem"] }
//  c) { "description": "string de erro" }
// ══════════════════════════════════════════════════════════════════════
function extrairPrimeiroErro(nsData) {
  if (!nsData || typeof nsData !== 'object') {
    return { campo: '', motivo: '', mensagem: 'Erro desconhecido da Nuvemshop' };
  }

  const erros = [];
  _coletarErros(nsData, '', erros);

  if (erros.length === 0) {
    const msg = typeof nsData.description === 'string' ? nsData.description : JSON.stringify(nsData);
    return { campo: '', motivo: '', mensagem: msg };
  }

  const primeiro = erros[0];
  return {
    campo:    primeiro.campo,
    motivo:   primeiro.motivo,
    mensagem: `❌ Campo rejeitado: ${primeiro.campo || '(desconhecido)'} | Motivo: ${primeiro.motivo}`,
  };
}

function _coletarErros(obj, caminhoPai, resultado) {
  if (resultado.length >= 5) return;

  for (const [chave, valor] of Object.entries(obj)) {
    const caminho = caminhoPai ? `${caminhoPai}.${chave}` : chave;

    if (['code', 'message', 'error', 'status', 'statusCode'].includes(chave)) continue;

    if (Array.isArray(valor)) {
      const msgs = valor.filter(x => typeof x === 'string');
      if (msgs.length > 0) {
        resultado.push({ campo: caminho, motivo: msgs.join('; ') });
      } else {
        valor.forEach((item, i) => {
          if (item && typeof item === 'object') {
            _coletarErros(item, `${caminho}[${i}]`, resultado);
          }
        });
      }
    } else if (valor && typeof valor === 'object') {
      const subVals = Object.values(valor);
      const temStringDireta = subVals.some(sv => typeof sv === 'string');
      if (temStringDireta) {
        const msg = subVals.filter(sv => typeof sv === 'string').join('; ');
        resultado.push({ campo: caminho, motivo: msg });
      } else {
        _coletarErros(valor, caminho, resultado);
      }
    } else if (typeof valor === 'string' && chave !== 'description') {
      resultado.push({ campo: caminho, motivo: valor });
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  sanitizeNuvemshopPayload — função pública exportável para uso no
//  frontend também. Aplica as mesmas regras do backend.
//  Uso: const payload = sanitizeNuvemshopPayload(rawPayload);
// ══════════════════════════════════════════════════════════════════════
export function sanitizeNuvemshopPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('sanitizeNuvemshopPayload: payload inválido ou ausente');
  }

  const sanitizado = sanitizarProduto(payload);

  // Validações obrigatórias
  if (!sanitizado.images || sanitizado.images.length === 0) {
    throw new Error('Produto sem imagens válidas');
  }

  if (Array.isArray(sanitizado.options)) {
    for (const opt of sanitizado.options) {
      if (!opt.values || opt.values.length === 0) {
        throw new Error('options[].values está vazio');
      }
    }
  }

  const variantErr = validarVariants(sanitizado.variants);
  if (variantErr) {
    throw new Error(variantErr);
  }

  if (Array.isArray(sanitizado.options) && Array.isArray(sanitizado.variants)) {
    const optionCount = sanitizado.options.length;
    for (const variant of sanitizado.variants) {
      if (!Array.isArray(variant.values) || variant.values.length !== optionCount) {
        throw new Error(
          `Inconsistência: cada variant deve ter ${optionCount} values, ` +
          `mas variant.values tem ${variant.values?.length || 0}.`
        );
      }
      for (let i = 0; i < optionCount; i += 1) {
        const allowed = sanitizado.options[i]?.values || [];
        const current = String(variant.values[i] || '').trim();
        if (allowed.length > 0 && current && !allowed.includes(current)) {
          throw new Error(
            `Variant values[${i}] "${current}" não existe em options[${i}].values. Verifique a ordem e os valores.`
          );
        }
      }
    }
  }

  console.log('PAYLOAD FINAL NUVEMSHOP', JSON.stringify(sanitizado, null, 2));
  return sanitizado;
}

// ══════════════════════════════════════════════════════════════════════
//  getOpenRouterKey — helper padronizado para buscar a chave OpenRouter
//  Uso no frontend: const key = getOpenRouterKey();
//
//  IMPORTANTE: Remova qualquer referência a window._anthropicKey neste
//  módulo. Use sempre esta função.
// ══════════════════════════════════════════════════════════════════════
export function getOpenRouterKey() {
  return (
    (typeof window !== 'undefined' ? window._openRouterKey : null) ||
    (typeof localStorage !== 'undefined' ? (
      localStorage.getItem('openrouter_api_key') ||
      localStorage.getItem('torcida_openrouter_key')
    ) : null) ||
    ''
  ).trim();
}

// ══════════════════════════════════════════════════════════════════════
//  exportarCSVNuvemshop — gera CSV compatível com importação direta
//  Cabeçalhos em PT-BR conforme Nuvemshop suporta
//
//  Uso: const csvString = exportarCSVNuvemshop(produtos);
// ══════════════════════════════════════════════════════════════════════
export function exportarCSVNuvemshop(produtos) {
  if (!Array.isArray(produtos) || produtos.length === 0) {
    throw new Error('exportarCSVNuvemshop: array de produtos vazio');
  }

  // Cabeçalhos em PT-BR exatos — conforme Nuvemshop importação
  const headers = ['Nome', 'Descrição', 'Preço', 'Preço Comparativo', 'SKU', 'Estoque', 'Imagens', 'Variação 1 Valor'];
  const rows    = [headers.join(',')];

  for (const produto of produtos) {
    const name        = typeof produto.name === 'object' ? (produto.name.pt || '') : (produto.name || '');
    const description = typeof produto.description === 'object'
      ? (produto.description.pt || '')
      : (produto.description || '');

    const images = Array.isArray(produto.images)
      ? produto.images.map(img => typeof img === 'string' ? img : img.src).join('|')
      : '';

    const variants = Array.isArray(produto.variants) ? produto.variants : [];

    if (variants.length === 0) {
      // Produto sem variantes
      rows.push([
        csvEscape(name),
        csvEscape(description),
        produto.price || '',
        produto.compare_at_price || '',
        produto.sku || '',
        produto.stock || '',
        csvEscape(images),
        '',
      ].join(','));
    } else {
      // Uma linha por variante
      variants.forEach((v, idx) => {
        rows.push([
          idx === 0 ? csvEscape(name) : '',        // Nome apenas na 1ª linha
          idx === 0 ? csvEscape(description) : '',  // Descrição apenas na 1ª linha
          v.price || '',
          v.compare_at_price || '',
          v.sku || '',
          v.stock || '',
          idx === 0 ? csvEscape(images) : '',       // Imagens apenas na 1ª linha
          csvEscape((v.values || []).join('|')),    // Variação 1 Valor ex: "M" ou "GG"
        ].join(','));
      });
    }
  }

  return rows.join('\n');
}

// Escapa campo CSV (envolve em aspas se contém vírgula, aspas ou newline)
function csvEscape(value) {
  const str = String(value || '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
