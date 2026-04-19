// ══════════════════════════════════════════════════════════════════════════════
//  api/create-product.js  —  Vercel Serverless Function
//  Proxy seguro: Frontend → Vercel → Nuvemshop API
//
//  CALLERS — todos usam exatamente este formato:
//    POST /api/create-product
//    Header: Authorization: bearer TOKEN
//    Body:   { store_id, produto: { name, description, handle, published,
//              tags, seo_title, seo_description, options, variants, images? } }
//
//  Fontes confirmadas no index.html:
//    1. nsPublishOne()         linha 14925  — sem images (upload separado)
//    2. handlePublishProduct() linha 20608  — sem images (upload separado)
//    3. pipPublicarNuvemshop() linha 21854  — images: ["url",...] (strings)
//
//  Filosofia: pass-through com normalização mínima.
//  O frontend (normalizarVariantesFrontend) já faz o trabalho pesado.
//  O backend APENAS: converte images, achata values[], remove campos proibidos.
//
//  Versão: 2025-07-integration
// ══════════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {

  // ── 0. Apenas POST ────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── 1. Body bruto ─────────────────────────────────────────────────────────
  const body = req.body || {};
  console.log('[API] payload original:', JSON.stringify(body, null, 2));

  // ── 2. Token — header Authorization OU body (fallback legado) ────────────
  //  Todos os callers enviam: Authorization: bearer TOKEN
  const authHeader = (req.headers['authorization'] || req.headers['Authorization'] || '').trim();
  const token =
    authHeader.replace(/^bearer\s+/i, '').trim() ||
    body.token           ||
    body.access_token    ||
    '';

  if (!token) {
    console.error('[API] ❌ Token ausente');
    return res.status(401).json({ success: false, error: 'Token de autenticação ausente' });
  }

  // ── 3. store_id — body.store_id OU body.storeId ──────────────────────────
  const storeId = String(body.store_id || body.storeId || '').trim();
  if (!storeId) {
    console.error('[API] ❌ store_id ausente');
    return res.status(400).json({ success: false, error: 'store_id ausente' });
  }

  // ── 4. Produto — aceita qualquer chave que o frontend use ─────────────────
  //  Todos os callers usam body.produto.
  //  Fallback para body.product / body.payload / body inteiro por robustez.
  const produto = body.produto || body.product || body.payload || body;

  // ── 5. Normalizar images ──────────────────────────────────────────────────
  //  Caller 3 (pipPublicarNuvemshop) envia:  images: ["https://...", ...]
  //  Callers 1 e 2 não enviam images (upload separado via /api/upload-image).
  //  A Nuvemshop exige:                      images: [{ src: "https://..." }]
  //
  //  Aceita:
  //    "https://..."          → { src: "https://..." }
  //    { src: "https://..." } → mantém
  //    { url: "..." }         → { src: "..." }
  //    { orig: "..." }        → { src: "..." }
  //    string vazia / sem http → descarta
  const rawImages = Array.isArray(produto.images) ? produto.images : [];
  const images = rawImages
    .map(im => {
      if (typeof im === 'string') return im.startsWith('http') ? { src: im } : null;
      const src = im.src || im.url || im.orig || '';
      return src.startsWith('http') ? { src } : null;
    })
    .filter(Boolean);

  // ── 6. Normalizar variants ────────────────────────────────────────────────
  //  normalizarVariantesFrontend já entrega:
  //    { price: "99.90", stock: 100, sku: "sku-p", values: ["P"], compare_at_price?: "120.00" }
  //
  //  O backend garante:
  //    - values é array plano de strings (nunca [["P"]])
  //    - compare_at_price null/undefined → omitido (causa 422)
  //    - option1/2/3 → removidos
  //    - stock_management / inventory_management → removidos
  const rawVariants = Array.isArray(produto.variants) ? produto.variants : [];
  const variants = rawVariants.map((v, idx) => {
    // Achatar values — nunca array dentro de array
    let values = [];
    if (Array.isArray(v.values)) {
      values = v.values.flat(Infinity).map(s => String(s).trim()).filter(Boolean);
    } else if (v.option1) {
      values = [String(v.option1).trim()];
    } else if (v.value) {
      values = [String(v.value).trim()];
    }

    if (values.length === 0) {
      console.warn(`[API] ⚠️ variants[${idx}].values vazio — usando fallback "UNICO"`);
      values = ['UNICO'];
    }

    // Montar variante — pass-through dos campos que o frontend já enviou
    const variant = { values };

    // price — obrigatório
    if (v.price !== undefined && v.price !== null) {
      variant.price = String(v.price);
    }

    // compare_at_price — OMITIR se null / undefined / 0 / "0.00" (causa 422)
    const cap = parseFloat(String(v.compare_at_price || '0').replace(',', '.'));
    if (cap > 0) {
      variant.compare_at_price = cap.toFixed(2);
    }
    // NÃO incluir compare_at_price se inválido — nunca colocar null

    // stock — pass-through (Nuvemshop aceita estoque inicial)
    if (v.stock !== undefined && v.stock !== null) {
      variant.stock = parseInt(v.stock) || 100;
    }

    // sku — pass-through
    if (v.sku) {
      variant.sku = String(v.sku).trim();
    }

    // Campos proibidos NÃO copiados: option1, option2, option3,
    //   stock_management, inventory_management

    return variant;
  });

  // ── 7. Normalizar options ─────────────────────────────────────────────────
  //  O frontend sempre envia options corretamente montados.
  //  Apenas garantimos a estrutura { name: {pt}, values: [...] }.
  const rawOptions = Array.isArray(produto.options) ? produto.options : [];
  const options = rawOptions.map(opt => {
    const optName =
      opt.name && typeof opt.name === 'object'
        ? opt.name
        : { pt: String(opt.name || 'Tamanho') };
    const optValues = Array.isArray(opt.values)
      ? opt.values.flat(Infinity).map(s => String(s).trim()).filter(Boolean)
      : [];
    return { name: optName, values: optValues };
  });

  // Se não veio options mas temos variants, reconstruir automaticamente
  const optionsFinal = options.length > 0
    ? options
    : variants.length > 0
      ? [{ name: { pt: 'Tamanho' }, values: variants.map(v => v.values[0]) }]
      : [];

  // ── 8. Payload final — pass-through + normalização mínima ─────────────────
  //  Filosofia: confiar no trabalho que o frontend já fez.
  //  Normalizar apenas o que pode causar 422.
  const payloadFinal = {
    // name — aceita { pt: "..." } (já enviado assim) ou string
    name: produto.name && typeof produto.name === 'object'
      ? produto.name
      : { pt: String(produto.name || produto.titulo || produto.title || '').trim() },

    // description — idem
    description: produto.description && typeof produto.description === 'object'
      ? produto.description
      : { pt: String(produto.description || produto.descricao || '').trim() },

    // handle — idem
    handle: produto.handle && typeof produto.handle === 'object'
      ? produto.handle
      : { pt: String(produto.handle || produto.slug || '').trim() },

    published: produto.published !== false,

    // tags — Nuvemshop aceita string com vírgulas
    tags: Array.isArray(produto.tags)
      ? produto.tags.join(',')
      : String(produto.tags || ''),

    seo_title:       produto.seo_title       || produto.titulo_seo    || '',
    seo_description: produto.seo_description || produto.meta_descricao || '',

    options: optionsFinal,
    variants,
  };

  // Incluir images apenas se houver (Caller 3 envia, Callers 1/2 não)
  if (images.length > 0) {
    payloadFinal.images = images;
  }

  // Garantir que campos proibidos não existam no nível raiz
  delete payloadFinal.option1;
  delete payloadFinal.option2;
  delete payloadFinal.option3;
  delete payloadFinal.stock_management;
  delete payloadFinal.inventory_management;

  console.log('[API] payload final:', JSON.stringify(payloadFinal, null, 2));

  // ── 9. Verificar existência — create-or-update inteligente ──────────────
  //
  //  Consulta GET /v1/{store_id}/products?handle={slug}&fields=id,handle,name
  //
  //  Resultado:
  //    • Produto encontrado com handle idêntico → produtoExistenteId = ID  → UPDATE (PUT)
  //    • Produto não encontrado                 → produtoExistenteId = null → CREATE (POST)
  //
  //  REGRA DE SEGURANÇA: só armazena o ID se handle retornado === handle enviado.
  //  Nunca atualiza produto errado por coincidência de busca.
  //  Erro de rede → assume CREATE (comportamento seguro).

  let produtoExistenteId = null;   // null = criar;  number = atualizar

  {
    const handleSlug   = payloadFinal.handle.pt || '';
    const checkHeaders = {
      'Authentication': `bearer ${token}`,
      'User-Agent':     'TorcidaPro/2.0 (https://torcidapro.com)',
    };

    console.log('[NUVEMSHOP] Verificando existência para handle:', handleSlug);

    try {
      const checkUrl  = `https://api.nuvemshop.com.br/v1/${storeId}/products` +
                        `?handle=${encodeURIComponent(handleSlug)}&fields=id,handle,name`;
      const checkResp = await fetch(checkUrl, { method: 'GET', headers: checkHeaders });

      if (checkResp.ok) {
        const checkData = await checkResp.json().catch(() => []);

        if (Array.isArray(checkData) && checkData.length > 0) {
          const encontrado       = checkData[0];
          // handle pode vir como { pt: "slug" } ou como string direta
          const handleEncontrado = typeof encontrado.handle === 'object'
            ? (encontrado.handle.pt || '')
            : String(encontrado.handle || '');

          // REGRA DE SEGURANÇA: só atualiza se o handle bate exatamente
          if (handleEncontrado === handleSlug) {
            produtoExistenteId   = encontrado.id;
            const nomeEncontrado = typeof encontrado.name === 'object'
              ? (encontrado.name.pt || '')
              : String(encontrado.name || '(sem nome)');

            console.log('[NUVEMSHOP] Produto existente encontrado');
            console.log('[NUVEMSHOP] ID:', produtoExistenteId);
            console.log('[NUVEMSHOP] Nome:', nomeEncontrado);
            console.log('[NUVEMSHOP] Ação: UPDATE');
          } else {
            // Handle diferente na resposta — não atualiza por segurança
            console.log(
              `[NUVEMSHOP] Handle retornado ("${handleEncontrado}") ≠ handle enviado ` +
              `("${handleSlug}") — segurança: assumindo CREATE`
            );
          }
        } else {
          console.log('[NUVEMSHOP] Produto novo');
          console.log('[NUVEMSHOP] Ação: CREATE');
        }
      } else {
        console.warn(`[NUVEMSHOP] Consulta de existência retornou ${checkResp.status} — assumindo CREATE`);
      }
    } catch (checkErr) {
      console.warn('[NUVEMSHOP] Erro na consulta de existência:', checkErr.message, '— assumindo CREATE');
    }
  }

  // ── 10. Padronizar tamanhos — variants.values e options.values ───────────
  //
  //  Garante que TODOS os tamanhos cheguem à Nuvemshop no mesmo formato canônico.
  //  Roda APÓS handle (§9) e ANTES das validações (§11), para que o check
  //  variants.values ⊆ options[0].values da Auditoria (§12) sempre passe.
  //
  //  Mapa canônico (case-insensitive, após trim):
  //    pp, p              → P
  //    m                  → M
  //    g, g1              → G
  //    gg, xg, xgg, g2    → GG
  //    único, unico, un   → P   (produto sem variante real)
  //    qualquer outro     → P   (fallback seguro)
  //
  //  Ordem de exibição: P → M → G → GG (ordem natural de vestuário)

  {
    // Tabela de normalização — chave: valor em minúsculas após trim
    const SIZE_MAP = {
      'pp':    'P',
      'p':     'P',
      'peq':   'P',
      'pequeno': 'P',
      'unico': 'P',
      'único': 'P',
      'un':    'P',
      'u':     'P',
      'm':     'M',
      'med':   'M',
      'medio': 'M',
      'médio': 'M',
      'g':     'G',
      'g1':    'G',
      'grande':'G',
      'gg':    'GG',
      'xg':    'GG',
      'xgg':   'GG',
      'g2':    'GG',
      'xl':    'GG',
      'xxl':   'GG',
    };

    // Ordem canônica de exibição
    const SIZE_ORDER = { P: 0, M: 1, G: 2, GG: 3 };

    // Função pura: normaliza um valor de tamanho para o canônico
    function normalizarTamanho(valor) {
      const k = String(valor || '').trim().toLowerCase();
      return SIZE_MAP[k] || String(valor || '').trim().toUpperCase() || 'P';
    }

    // ── Normalizar variants[].values ────────────────────────────────────────
    if (Array.isArray(payloadFinal.variants)) {
      payloadFinal.variants = payloadFinal.variants.map((v, i) => {
        const valuesNorm = (v.values || []).map(val => {
          const norm = normalizarTamanho(val);
          if (norm !== String(val).trim().toUpperCase()) {
            console.log(`[SIZE] variants[${i}].values: "${val}" → "${norm}"`);
          }
          return norm;
        });
        return { ...v, values: valuesNorm };
      });
    }

    // ── Normalizar options[0].values ────────────────────────────────────────
    if (Array.isArray(payloadFinal.options) && payloadFinal.options[0]) {
      const rawOpts = (payloadFinal.options[0].values || []).map(normalizarTamanho);

      // Deduplicar (mantendo a primeira ocorrência)
      const seen   = new Set();
      const unique = rawOpts.filter(v => {
        if (seen.has(v)) return false;
        seen.add(v);
        return true;
      });

      // Ordenar P → M → G → GG; o que não estiver no mapa vai para o fim
      unique.sort((a, b) => {
        const oa = SIZE_ORDER[a] ?? 99;
        const ob = SIZE_ORDER[b] ?? 99;
        return oa - ob;
      });

      payloadFinal.options[0] = { ...payloadFinal.options[0], values: unique };
    }

    // ── Reordenar variants na mesma ordem que options ───────────────────────
    //  Garante que variants[0] corresponda a options[0].values[0], etc.
    const optOrder = (payloadFinal.options?.[0]?.values || []);
    if (Array.isArray(payloadFinal.variants) && optOrder.length > 0) {
      payloadFinal.variants.sort((a, b) => {
        const ia = optOrder.indexOf(a.values?.[0]);
        const ib = optOrder.indexOf(b.values?.[0]);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
    }

    console.log('[SIZE] options finais:', payloadFinal.options?.[0]?.values);
    console.log('[SIZE] variants finais:', payloadFinal.variants?.map(v => v.values));
  }

  // ── 11. Validações pré-envio ──────────────────────────────────────────────
  const erros = [];

  if (!payloadFinal.name?.pt) {
    erros.push({ field: 'name', details: 'name.pt está vazio' });
  }
  if (!Array.isArray(payloadFinal.variants) || payloadFinal.variants.length === 0) {
    erros.push({ field: 'variants', details: 'variants vazio ou ausente' });
  }
  payloadFinal.variants.forEach((v, i) => {
    if (!Array.isArray(v.values) || v.values.length === 0) {
      erros.push({ field: `variants[${i}].values`, details: 'values é array vazio' });
    }
    if (v.values && v.values.some(val => Array.isArray(val))) {
      erros.push({ field: `variants[${i}].values`, details: 'values contém array dentro de array' });
    }
    if ('compare_at_price' in v && (v.compare_at_price === null || v.compare_at_price === undefined)) {
      erros.push({ field: `variants[${i}].compare_at_price`, details: 'compare_at_price é null — deve ser omitido' });
    }
  });

  if (erros.length > 0) {
    const primeiro = erros[0];
    console.error('[API] ❌ Validação pré-envio:', erros);
    console.error(`[API] Campo rejeitado pela Nuvemshop: ${primeiro.field}`);
    return res.status(422).json({
      success:      false,
      status:       422,
      field:        primeiro.field,
      details:      erros.map(e => e.details).join(' | '),
      sent_payload: payloadFinal,
    });
  }

  // ── 12. Auditoria final — último checkpoint antes do POST ────────────────
  //  Roda APÓS handle resolvido (§9) e validações básicas (§10).
  //  Corrige silenciosamente o que pode: description longa, images excedentes.
  //  Rejeita o que não tem como corrigir: values fora de options, cap inválido.

  console.log('==============================');
  console.log('[AUDITORIA FINAL NUVEMSHOP]');
  console.log('handle:',   payloadFinal.handle);
  console.log('options:',  JSON.stringify(payloadFinal.options,  null, 2));
  console.log('variants:', JSON.stringify(payloadFinal.variants, null, 2));
  console.log('images:',   JSON.stringify(payloadFinal.images,   null, 2));
  console.log('==============================');

  {
    const auditErros = [];

    // ── A. variants.values ⊆ options[0].values ─────────────────────────────
    //  A Nuvemshop exige que cada value de cada variant exista em options[0].values.
    //  Se não existir → 422 "Variant values should match option values".
    const optValues0 = (payloadFinal.options?.[0]?.values || []).map(s => String(s).trim());
    if (optValues0.length > 0 && Array.isArray(payloadFinal.variants)) {
      payloadFinal.variants.forEach((v, i) => {
        (v.values || []).forEach(val => {
          if (!optValues0.includes(String(val).trim())) {
            auditErros.push(
              `variants[${i}].values contém "${val}" que não existe em options[0].values ` +
              `(${optValues0.join(', ')})`
            );
          }
        });
      });
    }

    // ── B. compare_at_price > price em cada variant ─────────────────────────
    //  A Nuvemshop recusa compare_at_price quando não é maior que price.
    //  Corrigir silenciosamente: remover o campo se a condição não for satisfeita.
    if (Array.isArray(payloadFinal.variants)) {
      payloadFinal.variants = payloadFinal.variants.map((v, i) => {
        if (v.compare_at_price !== undefined) {
          const cap   = parseFloat(String(v.compare_at_price).replace(',', '.')) || 0;
          const price = parseFloat(String(v.price || 0).replace(',', '.'))       || 0;
          if (cap <= price) {
            console.warn(
              `[AUDITORIA] variants[${i}].compare_at_price (${cap}) ` +
              `não é maior que price (${price}) — removido para evitar 422`
            );
            const vCorrigida = { ...v };
            delete vCorrigida.compare_at_price;
            return vCorrigida;
          }
        }
        return v;
      });
    }

    // ── C. images — máx 10, sem duplicadas, só https ───────────────────────
    if (Array.isArray(payloadFinal.images)) {
      const seenSrc = new Set();
      const imagesFiltradas = [];
      for (const im of payloadFinal.images) {
        const src = (im.src || '').trim();
        if (!src.startsWith('https')) {
          console.warn(`[AUDITORIA] image ignorada (não é https): ${src.substring(0, 80)}`);
          continue;
        }
        if (seenSrc.has(src)) {
          console.warn(`[AUDITORIA] image duplicada removida: ${src.substring(0, 80)}`);
          continue;
        }
        seenSrc.add(src);
        imagesFiltradas.push(im);
        if (imagesFiltradas.length === 10) break;   // máx 10
      }
      if (imagesFiltradas.length !== (payloadFinal.images || []).length) {
        console.log(
          `[AUDITORIA] images: ${(payloadFinal.images || []).length} → ` +
          `${imagesFiltradas.length} (após filtro)`
        );
      }
      payloadFinal.images = imagesFiltradas;
    }

    // ── D. handle — máx 255 caracteres ─────────────────────────────────────
    if (payloadFinal.handle?.pt && payloadFinal.handle.pt.length > 255) {
      auditErros.push(
        `handle.pt tem ${payloadFinal.handle.pt.length} caracteres (máx 255): ` +
        `"${payloadFinal.handle.pt.substring(0, 60)}..."`
      );
    }

    // ── E. description — cortar automaticamente se > 5000 caracteres ───────
    if (payloadFinal.description?.pt && payloadFinal.description.pt.length > 5000) {
      const antes = payloadFinal.description.pt.length;
      payloadFinal.description = { pt: payloadFinal.description.pt.substring(0, 5000) };
      console.warn(`[AUDITORIA] description.pt cortada: ${antes} → 5000 caracteres`);
    }

    // ── Resultado da auditoria ──────────────────────────────────────────────
    if (auditErros.length > 0) {
      console.error('[AUDITORIA] ❌ Falha na validação final:', auditErros);
      return res.status(422).json({
        success:        false,
        field_rejected: 'local_validation',
        details:        auditErros.join(' | '),
        description:    '❌ Auditoria local: ' + auditErros.join(' | '),
        message:        auditErros[0],
        error:          'local_validation_failed',
        sent_payload:   payloadFinal,
      });
    }

    console.log('[AUDITORIA] ✅ Payload aprovado — enviando para Nuvemshop');
  }

  // ── 13. Enviar para a Nuvemshop — CREATE ou UPDATE ───────────────────────
  //  produtoExistenteId !== null → PUT /products/{id}   (atualizar)
  //  produtoExistenteId === null → POST /products        (criar)

  const isUpdate    = produtoExistenteId !== null;
  const nuvemUrl    = isUpdate
    ? `https://api.nuvemshop.com.br/v1/${storeId}/products/${produtoExistenteId}`
    : `https://api.nuvemshop.com.br/v1/${storeId}/products`;
  const nuvemMethod = isUpdate ? 'PUT' : 'POST';

  console.log(`[API] ${nuvemMethod} → ${nuvemUrl}`);

  let nuvemResp;
  try {
    nuvemResp = await fetch(nuvemUrl, {
      method:  nuvemMethod,
      headers: {
        'Content-Type':   'application/json',
        'Authentication': `bearer ${token}`,
        'User-Agent':     'TorcidaPro/2.0 (https://torcidapro.com)',
      },
      body: JSON.stringify(payloadFinal),
    });
  } catch (networkErr) {
    console.error('[API] ❌ Erro de rede:', networkErr.message);
    return res.status(502).json({
      success: false,
      error:   'Erro de rede ao conectar à Nuvemshop: ' + networkErr.message,
    });
  }

  // ── 14. Ler resposta como texto primeiro ──────────────────────────────────
  //  A Nuvemshop às vezes retorna HTML de erro em vez de JSON.
  //  Sempre capturar .text() antes de tentar .json().
  const rawText = await nuvemResp.text();
  console.log('[API] RESPOSTA NUVEMSHOP status:', nuvemResp.status);
  console.log('[API] RESPOSTA NUVEMSHOP raw:', rawText.substring(0, 1000));

  let nuvemData = {};
  try {
    nuvemData = JSON.parse(rawText);
  } catch (_) {
    nuvemData = { _rawText: rawText };
  }
  console.log('[API] RESPOSTA NUVEMSHOP JSON:', JSON.stringify(nuvemData, null, 2));

  // ── 15. Tratar erro (422 e outros) ────────────────────────────────────────
  if (!nuvemResp.ok) {

    // ── 12a. Extrair campo rejeitado ─────────────────────────────────────────
    //
    //  A Nuvemshop retorna 422 em três formatos distintos:
    //
    //  Formato A (mais comum):
    //    { "code": 422, "message": "Unprocessable Entity",
    //      "description": { "handle": ["has already been taken"], "variants": ["is invalid"] } }
    //
    //  Formato B:
    //    { "error": "invalid_attribute", "invalid_attribute": "name" }
    //
    //  Formato C (erros em array):
    //    { "errors": [{ "field": "variants[0].values", "message": "..." }] }
    //
    //  Prioridade de extração: description-object > invalid_attribute > errors[0] > field > texto

    let fieldRejected  = 'desconhecido';
    let apiMessage     = '';
    let allFieldErrors = {};   // campo → [mensagens]

    // Formato A — description é um objeto { campo: [mensagens] }
    if (nuvemData.description && typeof nuvemData.description === 'object' && !Array.isArray(nuvemData.description)) {
      allFieldErrors  = nuvemData.description;
      const firstKey  = Object.keys(allFieldErrors)[0];
      fieldRejected   = firstKey || 'desconhecido';
      const msgs      = allFieldErrors[firstKey];
      apiMessage      = Array.isArray(msgs) ? msgs.join(', ') : String(msgs || '');
    }
    // Formato B — invalid_attribute
    else if (nuvemData.invalid_attribute) {
      fieldRejected = nuvemData.invalid_attribute;
      apiMessage    = nuvemData.error || nuvemData.message || '';
    }
    // Formato C — errors array
    else if (Array.isArray(nuvemData.errors) && nuvemData.errors.length > 0) {
      const firstErr = nuvemData.errors[0];
      fieldRejected  = firstErr.field || firstErr.attribute || 'desconhecido';
      apiMessage     = firstErr.message || firstErr.detail || '';
      nuvemData.errors.forEach(e => {
        allFieldErrors[e.field || 'geral'] = [e.message || ''];
      });
    }
    // Fallback — campo livre ou texto puro
    else {
      fieldRejected = nuvemData.field || 'desconhecido';
      apiMessage    =
        (typeof nuvemData.description === 'string' ? nuvemData.description : '') ||
        nuvemData.message ||
        nuvemData.error   ||
        rawText.substring(0, 400);
    }

    // ── 12b. Mapear campo rejeitado → valor enviado ───────────────────────────
    //  Campos monitorados especialmente: handle, variants, options, images,
    //  compare_at_price, tags, name, description, seo_title
    const fieldValueMap = {
      handle:          payloadFinal.handle,
      name:            payloadFinal.name,
      description:     payloadFinal.description,
      tags:            payloadFinal.tags,
      seo_title:       payloadFinal.seo_title,
      seo_description: payloadFinal.seo_description,
      variants:        payloadFinal.variants,
      options:         payloadFinal.options,
      images:          payloadFinal.images,
      published:       payloadFinal.published,
      // compare_at_price vive dentro de variants
      compare_at_price: (payloadFinal.variants || []).map((v, i) => ({
        [`variants[${i}]`]: v.compare_at_price ?? '(omitido)',
      })),
    };

    // Valor enviado para o campo rejeitado
    const invalidValue = fieldValueMap[fieldRejected] ?? '(campo não mapeado)';

    // ── 12c. Logs obrigatórios — visíveis no console do Vercel ───────────────
    console.error('══════════════════════════════════════════════');
    console.error(`[NUVEMSHOP 422] Campo: ${fieldRejected}`);
    console.error(`[NUVEMSHOP 422] Motivo: ${apiMessage}`);
    console.error(`[NUVEMSHOP 422] Valor enviado:`, JSON.stringify(invalidValue, null, 2));

    // Log detalhado de todos os campos com erro (Formato A)
    if (Object.keys(allFieldErrors).length > 0) {
      console.error('[NUVEMSHOP 422] Todos os campos rejeitados:');
      Object.entries(allFieldErrors).forEach(([campo, msgs]) => {
        const val = fieldValueMap[campo] ?? '(não mapeado)';
        console.error(`  • ${campo}: ${JSON.stringify(msgs)} → valor enviado: ${JSON.stringify(val)}`);
      });
    }

    // Log detalhado de cada variant (campo mais comum de 422)
    if (Array.isArray(payloadFinal.variants)) {
      console.error('[NUVEMSHOP 422] Variants enviadas:');
      payloadFinal.variants.forEach((v, i) => {
        console.error(`  variants[${i}]:`, JSON.stringify(v));
      });
    }

    // Log detalhado de cada image
    if (Array.isArray(payloadFinal.images)) {
      console.error('[NUVEMSHOP 422] Images enviadas:');
      payloadFinal.images.forEach((im, i) => {
        console.error(`  images[${i}]:`, JSON.stringify(im));
      });
    }

    console.error('[NUVEMSHOP 422] Payload completo:', JSON.stringify(payloadFinal, null, 2));
    console.error('══════════════════════════════════════════════');

    // ── 12d. Montar mensagem legível para a UI ────────────────────────────────
    //  Todos os callers leem: result.description || result.error || result.message
    //  A mensagem deve ser clara o suficiente para aparecer nos elementos de UI
    //  sem que o frontend precise mudar.
    const uiMessage = [
      `❌ Campo rejeitado: ${fieldRejected}`,
      apiMessage ? `Motivo: ${apiMessage}` : null,
      // Valor compacto (máx 120 chars para caber em toast)
      `Valor: ${JSON.stringify(invalidValue).substring(0, 120)}`,
    ].filter(Boolean).join(' | ');

    // gpPublicar tenta JSON.parse(raw.indexOf('{')):
    // embutir objeto JSON na description para o painel gp-error-body renderizar
    const descriptionRich = `${uiMessage} ${JSON.stringify({
      campo:      fieldRejected,
      motivo:     apiMessage,
      todos:      allFieldErrors,
    })}`;

    // ── 12e. Retornar para o frontend ─────────────────────────────────────────
    return res.status(nuvemResp.status).json({
      // Campos que os callers existentes leem — OBRIGATÓRIOS para UI funcionar
      success:     false,
      description: descriptionRich,        // lido por: pip, nsPublish, handlePublish
      message:     uiMessage,              // fallback
      error:       uiMessage,              // fallback

      // Campos novos — para diagnóstico avançado e DevTools
      status:         nuvemResp.status,
      field_rejected: fieldRejected,
      invalid_value:  invalidValue,
      api_message:    apiMessage,
      all_errors:     allFieldErrors,
      sent_payload:   payloadFinal,
    });
  }

  // ── 16. Sucesso ───────────────────────────────────────────────────────────
  const productId = nuvemData.id || produtoExistenteId;
  const mode      = isUpdate ? 'updated' : 'created';
  console.log(`[API] ✅ Produto ${mode === 'updated' ? 'atualizado' : 'criado'} com sucesso. ID: ${productId}`);

  return res.status(200).json({
    success:    true,
    mode,                    // "created" | "updated" — lido pelo frontend
    product_id: productId,
    product:    nuvemData,
  });
}
