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

  // ── Extrair credenciais e produto do payload ─────────────────────
  const { store_id, produto } = req.body || {};

  // Aceitar token via Authorization header ou campo no body
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const token = authHeader.replace(/^bearer\s+/i, '').trim()
    || req.body?.token
    || req.body?.access_token
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

  // ── Sanitizar produto — SEM reconstruir variants ─────────────────
  try {
    const sanitizado = sanitizarProduto(produto);

    // Validação anti-422: variantes duplicadas detectadas no backend
    const variantErr = validarVariants(sanitizado.variants);
    if (variantErr) {
      return res.status(422).json({
        error: variantErr,
        campo: 'variants',
        dica:  'Cada tamanho (values[]) deve ser único. "Variant values should not be repeated"',
      });
    }

    console.log('[create-product] store_id:', store_id);
    console.log('[create-product] variants:', JSON.stringify(sanitizado.variants?.map(v => ({
      values: v.values, price: v.price, sku: v.sku,
    }))));
    console.log('[create-product] images:', sanitizado.images?.length, 'itens');

    // ── POST para Nuvemshop ──────────────────────────────────────────
    const nsUrl  = `https://api.nuvemshop.com.br/v1/${store_id}/products`;
    const nsResp = await fetch(nsUrl, {
      method:  'POST',
      headers: {
        'Authentication': `bearer ${token}`,
        'Content-Type':   'application/json',
        'User-Agent':     'TorcidaPro/1.0',
      },
      body: JSON.stringify(sanitizado),
    });

    const nsData = await nsResp.json().catch(() => ({}));

    if (!nsResp.ok) {
      // Estruturar o erro 422 da Nuvemshop para facilitar debug no frontend
      const primeiroErro = extrairPrimeiroErro(nsData);
      console.error('[create-product] Nuvemshop erro', nsResp.status, JSON.stringify(nsData));
      return res.status(nsResp.status).json({
        error:       primeiroErro.mensagem,
        campo:       primeiroErro.campo,
        motivo:      primeiroErro.motivo,
        todos:       nsData,
        api_status:  nsResp.status,
      });
    }

    // ── Sucesso ──────────────────────────────────────────────────────
    console.log('[create-product] ✅ Produto criado:', nsData.id, nsData.name?.pt);
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
//  sanitizarProduto — limpa o payload SEM recriar variants ou preços
// ══════════════════════════════════════════════════════════════════════
function sanitizarProduto(p) {
  const out = {};

  // name
  out.name = typeof p.name === 'object'
    ? p.name
    : { pt: String(p.name || p.titulo || p.title || 'Produto').trim() };

  // description
  out.description = typeof p.description === 'object'
    ? p.description
    : { pt: String(p.description || p.descricao_html || p.descricao || '').trim() };

  // handle / slug
  if (p.handle || p.slug) {
    const raw = String(p.handle || p.slug || '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (raw) out.handle = { pt: raw };
  }

  // published
  out.published = p.published !== undefined ? Boolean(p.published) : true;

  // seo
  if (p.seo_title)       out.seo_title       = { pt: String(p.seo_title).trim() };
  if (p.seo_description) out.seo_description = { pt: String(p.seo_description).trim() };

  // tags: string CSV ou array
  if (p.tags) {
    out.tags = Array.isArray(p.tags)
      ? p.tags.filter(Boolean).join(',')
      : String(p.tags).trim();
  }

  // ── options — OBRIGATÓRIO quando variants usam values[] ──────────
  if (Array.isArray(p.options) && p.options.length > 0) {
    out.options = p.options.map(opt => ({
      name:   typeof opt.name === 'object' ? opt.name : { pt: String(opt.name || 'Tamanho') },
      values: Array.isArray(opt.values) ? opt.values.map(v => String(v).trim()).filter(Boolean) : [],
    }));
  }

  // ── variants — NUNCA recriar; usar exatamente o que o frontend enviou ──
  if (Array.isArray(p.variants) && p.variants.length > 0) {
    out.variants = p.variants.map((v, idx) => {
      const vOut = {};

      // values[]: obrigatório, nunca alterar
      vOut.values = Array.isArray(v.values)
        ? v.values.map(x => String(x).trim()).filter(Boolean)
        : [String(v.value || v.option1 || `Tamanho${idx + 1}`).trim()];

      // price: string numérica
      vOut.price = String(Number(String(v.price || '99.90').replace(',', '.')).toFixed(2));

      // compare_at_price: apenas quando > price e é número válido
      if (v.compare_at_price !== undefined && v.compare_at_price !== null && v.compare_at_price !== '') {
        const cap = Number(String(v.compare_at_price).replace(',', '.'));
        const prc = Number(vOut.price);
        if (!isNaN(cap) && cap > prc) {
          vOut.compare_at_price = cap.toFixed(2);
        }
        // se cap <= price: omitir (não enviar null — Nuvemshop rejeita)
      }

      // stock
      vOut.stock = typeof v.stock === 'number' ? v.stock : (parseInt(v.stock, 10) || 100);

      // sku: apenas se fornecido e não vazio
      if (v.sku && String(v.sku).trim()) {
        vOut.sku = String(v.sku).trim();
      }

      // NUNCA incluir: option1, option2, option3, stock_management
      // Esses campos causam 422 na Nuvemshop quando variants usam values[]

      return vOut;
    });
  }

  // ── images — array de objetos {src} com URLs válidas ────────────
  if (Array.isArray(p.images) && p.images.length > 0) {
    out.images = p.images
      .map(img => {
        const src = typeof img === 'string' ? img : (img.src || img.url || '');
        return src && src.startsWith('http') ? { src: src.trim() } : null;
      })
      .filter(Boolean)
      .slice(0, 10); // Nuvemshop aceita no máximo 10 imagens
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
      return `Variant sem values[] definido`;
    }
    const key = v.values.join('|');
    if (seen.has(key)) {
      return `"Variant values should not be repeated" — tamanho "${key}" duplicado`;
    }
    seen.add(key);
  }

  // Validar new Set size === variants.length (exigência do enunciado)
  if (new Set(variants.map(v => v.values.join('|'))).size !== variants.length) {
    return 'Existem variantes duplicadas no payload — corrija antes de publicar';
  }

  return null; // OK
}

// ══════════════════════════════════════════════════════════════════════
//  extrairPrimeiroErro — estrutura o erro 422 da Nuvemshop
// ══════════════════════════════════════════════════════════════════════
function extrairPrimeiroErro(nsData) {
  // Nuvemshop retorna erros como { "campo": ["mensagem"] } ou { description: "..." }
  if (!nsData || typeof nsData !== 'object') {
    return { campo: '', motivo: '', mensagem: 'Erro desconhecido da Nuvemshop' };
  }

  // Tentar campo description direto
  if (nsData.description && typeof nsData.description === 'string') {
    return { campo: '', motivo: '', mensagem: nsData.description };
  }

  // Iterar sobre campos de erro
  const camposIgnorar = new Set(['code', 'description', 'message', 'error']);
  for (const [campo, erros] of Object.entries(nsData)) {
    if (camposIgnorar.has(campo)) continue;
    const msgs = Array.isArray(erros) ? erros : [String(erros)];
    const motivo = msgs[0] || '';
    return {
      campo,
      motivo,
      mensagem: `❌ Campo rejeitado: ${campo} | Motivo: ${motivo} | Valor: ${JSON.stringify({ campo, motivo, todos: nsData })}`,
    };
  }

  return { campo: '', motivo: '', mensagem: JSON.stringify(nsData) };
}
