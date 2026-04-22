// ══════════════════════════════════════════════════════════════════════
//  api/create-product.js — Vercel Serverless Function
//  Torcida Pro Analytics · Backend de publicação Nuvemshop
// ──────────────────────────────────────────────────────────────────────
//  REGRAS CRÍTICAS:
//  1. NUNCA reconstruir variants — usar exatamente o que o frontend envia
//  2. NUNCA recalcular preços — usar price/compare_at_price do payload
//  3. NUNCA duplicar values[] — apenas sanitizar e validar
//  4. Apenas sanitizar: images, handle, strings vazias, compare_at_price
//  5. Fazer apenas POST/PUT para a Nuvemshop com o payload do frontend
// ══════════════════════════════════════════════════════════════════════

const APP_VERSION = '2.1.0';

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

  // ── FIX #11: req.body pode ser undefined se Content-Type errado ───
  // Vercel parseia automaticamente para application/json, mas protege
  // contra Content-Type incorreto que resulta em body undefined.
  let body = req.body;
  if (!body || typeof body !== 'object') {
    const ct = req.headers['content-type'] || '';
    const errMsg = ct.includes('application/json')
      ? 'Corpo da requisição vazio ou inválido'
      : `Content-Type inválido: "${ct}" — use application/json`;
    return res.status(400).json({ error: errMsg });
  }

  // ── Extrair credenciais e produto do payload ─────────────────────
  const { store_id, produto } = body;

  // Aceitar token via Authorization header ou campo no body
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^bearer\s+/i, '').trim()
    || body.token
    || body.access_token
    || '';

  // ── Validações básicas ───────────────────────────────────────────
  if (!token) {
    return res.status(401).json({ error: 'Token de acesso ausente' });
  }
  if (!store_id) {
    return res.status(400).json({ error: 'store_id ausente' });
  }
  if (!produto) {
    return res.status(400).json({ error: 'Payload de produto ausente' });
  }

  try {
    const sanitizado = sanitizarProduto(produto);

    // ── FIX #8: Validar imagens obrigatórias antes do POST ──────────
    if (!sanitizado.images || sanitizado.images.length === 0) {
      return res.status(400).json({
        error: 'Produto sem imagens válidas — adicione ao menos 1 imagem com URL https://',
        campo: 'images',
        dica:  'images deve ser array com pelo menos 1 objeto { src: "https://..." }',
      });
    }

    // ── FIX #6: Validar options[].values não vazio ──────────────────
    if (Array.isArray(sanitizado.options)) {
      for (const opt of sanitizado.options) {
        if (!opt.values || opt.values.length === 0) {
          return res.status(422).json({
            error: 'options[].values está vazio — defina pelo menos um valor de opção (ex: "P")',
            campo: 'options',
            dica:  'options[0].values deve conter os tamanhos: ["P","M","G","GG"]',
          });
        }
      }
    }

    // ── FIX #7: Validar variants[].values contra options[].values ───
    const optionValues = sanitizado.options?.[0]?.values || [];
    if (optionValues.length > 0 && Array.isArray(sanitizado.variants)) {
      for (const v of sanitizado.variants) {
        const val = v.values?.[0];
        if (val && !optionValues.includes(val)) {
          return res.status(422).json({
            error: `variant.values[0] "${val}" não está em options[0].values (${optionValues.join(', ')})`,
            campo: 'variants',
            dica:  'Cada variant.values[0] deve existir em options[0].values — verifique a consistência do payload',
          });
        }
      }
    }

    // ── Validação anti-422: variantes duplicadas ─────────────────────
    const variantErr = validarVariants(sanitizado.variants);
    if (variantErr) {
      return res.status(422).json({
        error: variantErr,
        campo: 'variants',
        dica:  'Cada tamanho (values[]) deve ser único. "Variant values should not be repeated"',
      });
    }

    // ── FIX #10: Log do payload completo sanitizado antes do POST ───
    console.log('[create-product] store_id:', store_id);
    console.log('[create-product] name:', sanitizado.name?.pt || sanitizado.name);
    console.log('[create-product] handle:', sanitizado.handle);
    console.log('[create-product] options:', JSON.stringify(sanitizado.options));
    console.log('[create-product] variants:', JSON.stringify(sanitizado.variants?.map(v => ({
      values: v.values, price: v.price, sku: v.sku, stock: v.stock,
    }))));
    console.log('[create-product] images:', sanitizado.images?.length, 'itens');
    console.log('[create-product] payload completo:', JSON.stringify({
      name:            sanitizado.name,
      handle:          sanitizado.handle,
      published:       sanitizado.published,
      options:         sanitizado.options,
      variants:        sanitizado.variants?.map(v => ({ values: v.values, price: v.price, sku: v.sku })),
      images_count:    sanitizado.images?.length,
      seo_title:       sanitizado.seo_title,
    }));

    // ── POST para Nuvemshop ──────────────────────────────────────────
    const nsUrl    = `https://api.nuvemshop.com.br/v1/${store_id}/products`;
    // FIX #9: User-Agent com versão dinâmica para facilitar debug de rate limit
    const nsResult = await nsPost(nsUrl, sanitizado, token);

    // ── FIX #5: Upsert — se 422 por handle duplicado, tenta PUT ────
    if (!nsResult.ok && nsResult.status === 422) {
      const errBody  = nsResult.data;
      const errText  = JSON.stringify(errBody).toLowerCase();
      const isDupHandle = errText.includes('handle') && (
        errText.includes('taken') || errText.includes('already') || errText.includes('duplicat') || errText.includes('exist')
      );

      if (isDupHandle) {
        console.log('[create-product] Handle duplicado detectado — tentando PUT (upsert)...');
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
          // PUT também falhou — retornar erro do PUT
          const errPut = extrairPrimeiroErro(putResult.data);
          console.error('[create-product] Nuvemshop PUT erro', putResult.status, JSON.stringify(putResult.data));
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

      // 422 por outro motivo — retornar erro estruturado
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

    // ── Sucesso ──────────────────────────────────────────────────────
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
//  Helpers HTTP — abstraem fetch para Nuvemshop
// ══════════════════════════════════════════════════════════════════════
function nsHeaders(token) {
  return {
    // FIX #9: User-Agent com versão do app
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

// Busca ID de produto existente pelo handle para upsert
async function buscarProdutoPorHandle(storeId, handle, token) {
  try {
    // handle pode ser string ou { pt: 'slug' } — normalizar
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
//  sanitizarProduto — limpa o payload SEM recriar variants ou preços
// ══════════════════════════════════════════════════════════════════════
function sanitizarProduto(p) {
  const out = {};

  // ── name ─────────────────────────────────────────────────────────
  out.name = typeof p.name === 'object'
    ? p.name
    : { pt: String(p.name || p.titulo || p.title || 'Produto').trim() };

  // ── description ──────────────────────────────────────────────────
  out.description = typeof p.description === 'object'
    ? p.description
    : { pt: String(p.description || p.descricao_html || p.descricao || '').trim() };

  // ── FIX #1: handle como string simples — a Nuvemshop não aceita {pt:...} ──
  // O frontend pode enviar handle como string ou como { pt: 'slug' }
  // Normaliza para string limpa em ambos os casos.
  if (p.handle || p.slug) {
    const raw = typeof p.handle === 'object'
      ? String(p.handle.pt || p.handle.en || '').trim()
      : String(p.handle || p.slug || '').trim();
    const slug = raw.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (slug) out.handle = slug;  // ✅ string simples — NÃO { pt: slug }
  }

  // ── published ─────────────────────────────────────────────────────
  out.published = p.published !== undefined ? Boolean(p.published) : true;

  // ── FIX #2: seo_title e seo_description como strings simples ─────
  // A Nuvemshop aceita esses campos como string — NÃO como { pt: '...' }
  if (p.seo_title) {
    const s = String(p.seo_title).trim();
    if (s) out.seo_title = s;                     // ✅ string simples
  }
  if (p.seo_description) {
    const s = String(p.seo_description).trim();
    if (s) out.seo_description = s;               // ✅ string simples
  }

  // ── FIX #3: tags — omitir quando vazio para evitar 422 ───────────
  // Algumas versões da API retornam 422 com tags:["is invalid"] para string vazia
  if (p.tags) {
    const tagsStr = Array.isArray(p.tags)
      ? p.tags.filter(Boolean).join(',')
      : String(p.tags).trim();
    if (tagsStr) out.tags = tagsStr;              // ✅ omite quando ''
  }

  // ── options — OBRIGATÓRIO quando variants usam values[] ──────────
  if (Array.isArray(p.options) && p.options.length > 0) {
    out.options = p.options.map(opt => ({
      name:   typeof opt.name === 'object' ? opt.name : { pt: String(opt.name || 'Tamanho') },
      values: Array.isArray(opt.values)
        ? [...new Set(opt.values.map(v => String(v).trim()).filter(Boolean))]  // dedup aqui também
        : [],
    }));
  }

  // ── variants — NUNCA recriar; usar exatamente o que o frontend enviou ──
  if (Array.isArray(p.variants) && p.variants.length > 0) {
    out.variants = p.variants.map((v, idx) => {
      const vOut = {};

      // values[]: obrigatório — 1 valor por variant, nunca vazio
      vOut.values = Array.isArray(v.values)
        ? v.values.map(x => String(x).trim()).filter(Boolean)
        : [String(v.value || v.option1 || `Tamanho${idx + 1}`).trim()];

      // price: string numérica
      vOut.price = String(Number(String(v.price || '99.90').replace(',', '.')).toFixed(2));

      // compare_at_price: SOMENTE quando > price — nunca enviar null
      if (v.compare_at_price !== undefined && v.compare_at_price !== null && v.compare_at_price !== '') {
        const cap = Number(String(v.compare_at_price).replace(',', '.'));
        const prc = Number(vOut.price);
        if (!isNaN(cap) && cap > prc) {
          vOut.compare_at_price = cap.toFixed(2);
        }
        // cap <= price → omitir completamente (Nuvemshop rejeita)
      }

      // stock
      vOut.stock = typeof v.stock === 'number' ? v.stock : (parseInt(v.stock, 10) || 100);

      // FIX #4: stock_management: true — necessário para a Nuvemshop gravar o stock
      // Sem esse campo, o estoque enviado é ignorado e o produto aparece sem controle de estoque
      vOut.stock_management = true;

      // sku: apenas se fornecido e não vazio
      if (v.sku && String(v.sku).trim()) {
        vOut.sku = String(v.sku).trim();
      }

      // NUNCA incluir: option1, option2, option3
      // (stock_management: true é o único campo extra permitido além de values[], price, stock, sku)

      return vOut;
    });
  }

  // ── images — array de objetos {src} com URLs válidas, máx 10 ─────
  if (Array.isArray(p.images) && p.images.length > 0) {
    const imgs = p.images
      .map(img => {
        const src = typeof img === 'string' ? img : (img.src || img.url || '');
        return src && src.startsWith('http') ? { src: src.trim() } : null;
      })
      .filter(Boolean)
      .slice(0, 10);
    // Atribuir somente se houver imagens válidas — FIX #8 detecta ausência antes do POST
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
    const key = v.values.map(x => String(x).trim().toUpperCase()).join('|');
    if (seen.has(key)) {
      return `"Variant values should not be repeated" — tamanho "${key}" duplicado`;
    }
    seen.add(key);
  }

  return null; // ✅ OK
}

// ══════════════════════════════════════════════════════════════════════
//  extrairPrimeiroErro — FIX #12: trata estrutura aninhada do 422
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

  // Coletar todos os erros folha para montar mensagem legível
  const erros = [];
  _coletarErros(nsData, '', erros);

  if (erros.length === 0) {
    // Nenhum erro folha encontrado — usar description ou serializar
    const msg = typeof nsData.description === 'string' ? nsData.description : JSON.stringify(nsData);
    return { campo: '', motivo: '', mensagem: msg };
  }

  const primeiro = erros[0];
  return {
    campo:    primeiro.campo,
    motivo:   primeiro.motivo,
    mensagem: `❌ Campo rejeitado: ${primeiro.campo || '(desconhecido)'} | Motivo: ${primeiro.motivo} | Valor: ${JSON.stringify({ campo: primeiro.campo, motivo: primeiro.motivo, todos: nsData })}`,
  };
}

// Percorre recursivamente o objeto de erro e extrai mensagens folha
function _coletarErros(obj, caminhoPai, resultado) {
  if (resultado.length >= 5) return; // limitar para não explodir em erros grandes

  for (const [chave, valor] of Object.entries(obj)) {
    const caminho = caminhoPai ? `${caminhoPai}.${chave}` : chave;

    // Ignorar campos de metadados da resposta
    if (['code', 'message', 'error', 'status', 'statusCode'].includes(chave)) continue;

    if (Array.isArray(valor)) {
      // Formato b: { "campo": ["mensagem1", "mensagem2"] }
      const msgs = valor.filter(x => typeof x === 'string');
      if (msgs.length > 0) {
        resultado.push({ campo: caminho, motivo: msgs.join('; ') });
      } else {
        // Array de objetos — continuar recursão
        valor.forEach((item, i) => {
          if (item && typeof item === 'object') {
            _coletarErros(item, `${caminho}[${i}]`, resultado);
          }
        });
      }
    } else if (valor && typeof valor === 'object') {
      // Formato a: aninhado — { "variants": { "0": { "values": ["..."] } } }
      // Verificar se tem string folha direta
      const subVals = Object.values(valor);
      const temStringDireta = subVals.some(sv => typeof sv === 'string');
      if (temStringDireta) {
        const msg = subVals.filter(sv => typeof sv === 'string').join('; ');
        resultado.push({ campo: caminho, motivo: msg });
      } else {
        _coletarErros(valor, caminho, resultado);
      }
    } else if (typeof valor === 'string' && chave !== 'description') {
      // String direta que não é description genérica
      resultado.push({ campo: caminho, motivo: valor });
    }
  }
}
