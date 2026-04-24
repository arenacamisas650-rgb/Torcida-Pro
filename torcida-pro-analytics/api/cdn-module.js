// ═══════════════════════════════════════════════════════════════════════════
// TORCIDA PRO — MÓDULO CDN (Cloudinary + Nuvemshop)
// Cole este bloco no index.html, dentro de <script>, substituindo as funções
// listarImagensAuto(), montarURLs(), agruparImagens() e _cdnMontarProduto().
// ═══════════════════════════════════════════════════════════════════════════

// ─── Constante de configuração ───────────────────────────────────────────────
// Definida como var para não dar conflito se já existir no escopo global.
var CDN_PASTA_PADRAO = 'camisas'; // Pasta no Cloudinary — mude se precisar

// ─── 1. LISTAR IMAGENS via /api/listar-cdn ──────────────────────────────────
/**
 * Retorna array de URLs públicas do Cloudinary.
 * Usa /api/listar-cdn (nunca arquivos locais ou index.json).
 * Lança erro claro se a resposta não for JSON válido.
 */
async function listarImagensAuto() {
  const pasta = document.getElementById('cdnPasta')?.value?.trim() || CDN_PASTA_PADRAO;
  const url   = `/api/listar-cdn?pasta=${encodeURIComponent(pasta)}&max=500`;

  CDN.log(`🌐 Buscando imagens — /api/listar-cdn?pasta=${pasta}`, 'info', '🔍');
  console.log('[CDN] Chamando:', url);

  let resp;
  try {
    resp = await fetch(url);
  } catch (e) {
    throw new Error('Falha de rede ao chamar /api/listar-cdn: ' + e.message);
  }

  // Checar Content-Type antes de parsear — evita "Unexpected token <"
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const txt = await resp.text();
    console.error('[CDN] Resposta não-JSON:', txt.slice(0, 300));
    throw new Error(
      `API retornou ${resp.status} com Content-Type "${ct}" — esperado JSON. ` +
      'Verifique se a Vercel Function está deployada corretamente.'
    );
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    throw new Error('Resposta inválida de /api/listar-cdn (não é JSON): ' + e.message);
  }

  if (!resp.ok || data.success === false) {
    throw new Error(data.error || `Erro HTTP ${resp.status} em /api/listar-cdn`);
  }

  const files = data.files || [];
  CDN.log(`✅ ${files.length} imagem(ns) encontrada(s) no Cloudinary.`, 'ok', '✅');

  if (files.length === 0) {
    throw new Error(
      'Nenhuma imagem encontrada no Cloudinary. ' +
      `Verifique se a pasta "${pasta}" existe e tem imagens.`
    );
  }

  // files já são URLs completas — retornar direto
  return files;
}

// ─── 2. MONTAR URLs ─────────────────────────────────────────────────────────
/**
 * Com Cloudinary, as URLs já vêm prontas de listarImagensAuto().
 * Esta função existe para compatibilidade com o código existente.
 * Apenas retorna o array sem modificações.
 */
function montarURLs(lista) {
  return lista; // URLs já completas vindas do Cloudinary
}

// ─── 3. AGRUPAR IMAGENS ─────────────────────────────────────────────────────
/**
 * Sufixos reconhecidos como ângulos de um produto.
 * Ordem define a posição das imagens (frente = capa).
 */
var _CDN_SUFIXOS = ['frente', 'front', 'costas', 'back', 'detalhe', 'detail', 'lateral', 'side', 'zoom'];

/**
 * Extrai o nome base de uma URL Cloudinary.
 * Ex: ".../camisas/camisa_barcelona_frente.jpg" → "camisa_barcelona"
 * Ex: ".../camisas/camisa-real-madrid_costas.jpg" → "camisa-real-madrid"
 */
function _extrairBase(url) {
  var partes  = url.split('/');
  var arquivo = partes[partes.length - 1];
  var semExt  = arquivo.replace(/\.[^.]+$/, '');

  // Tenta separador _
  var sub = semExt.split('_');
  if (sub.length >= 2 && _CDN_SUFIXOS.indexOf(sub[sub.length - 1].toLowerCase()) !== -1) {
    return sub.slice(0, -1).join('_');
  }
  // Tenta separador -
  var dash = semExt.split('-');
  if (dash.length >= 2 && _CDN_SUFIXOS.indexOf(dash[dash.length - 1].toLowerCase()) !== -1) {
    return dash.slice(0, -1).join('-');
  }
  return semExt; // Sem sufixo → nome inteiro
}

function _extrairSufixo(url) {
  var partes  = url.split('/');
  var arquivo = partes[partes.length - 1];
  var semExt  = arquivo.replace(/\.[^.]+$/, '');

  var sub = semExt.split('_');
  var ult = sub[sub.length - 1].toLowerCase();
  if (_CDN_SUFIXOS.indexOf(ult) !== -1) return ult;

  var dash = semExt.split('-');
  ult = dash[dash.length - 1].toLowerCase();
  if (_CDN_SUFIXOS.indexOf(ult) !== -1) return ult;

  return '';
}

/**
 * Agrupa URLs por produto e ordena imagens (frente primeiro).
 * Retorna: { "camisa_barcelona": ["url_frente", "url_costas", ...], ... }
 */
function agruparImagens(urls) {
  var grupos = {};

  urls.forEach(function(url) {
    var base = _extrairBase(url);
    if (!grupos[base]) grupos[base] = [];
    grupos[base].push(url);
  });

  // Ordenar imagens dentro de cada grupo
  Object.keys(grupos).forEach(function(base) {
    grupos[base].sort(function(a, b) {
      var sa = _CDN_SUFIXOS.indexOf(_extrairSufixo(a));
      var sb = _CDN_SUFIXOS.indexOf(_extrairSufixo(b));
      return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb);
    });
  });

  return grupos;
}

// ─── 4. MONTAR PRODUTO ───────────────────────────────────────────────────────
/**
 * Converte base + imagens → estrutura de produto Nuvemshop.
 * Lê preço e tamanhos dos inputs do formulário.
 */
function _cdnMontarProduto(base, imagens, idx) {
  // Preço — tenta ler do campo do formulário
  var precoEl = document.getElementById('cdnPreco') || document.getElementById('precoPadrao');
  var preco   = precoEl ? (parseFloat(precoEl.value) || 0) : 0;

  // Tamanhos — tenta ler do campo, senão usa padrão
  var tamEl   = document.getElementById('cdnTamanhos');
  var tamStr  = tamEl ? (tamEl.value || 'P,M,G,GG') : 'P,M,G,GG';
  var tamanhos = tamStr.split(',').map(function(t){ return t.trim().toUpperCase(); }).filter(Boolean);
  if (!tamanhos.length) tamanhos = ['P', 'M', 'G', 'GG'];

  // Título legível
  var titulo = base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, function(c){ return c.toUpperCase(); })
    .trim();

  // Handle slug
  var handle = base.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  var variants = tamanhos.map(function(tam) {
    return {
      values:           [tam],
      price:            preco.toFixed(2),
      stock:            100,
      stock_management: true,
      sku:              handle + '-' + tam.toLowerCase(),
    };
  });

  return {
    // Campos para a API Nuvemshop
    name:        titulo,
    handle:      handle,
    description: titulo + ' — qualidade premium, tamanhos ' + tamanhos[0] + ' ao ' + tamanhos[tamanhos.length-1] + '.',
    images:      imagens,   // URLs completas do Cloudinary
    variants,
    published:   true,
    // Campos internos para exibição
    title:       titulo,
    _base:       base,
    _imagemCapa: imagens[0] || '',
    _totalImgs:  imagens.length,
    preco,
  };
}

// ─── 5. PUBLICAR PRODUTO NA NUVEMSHOP ────────────────────────────────────────
/**
 * Publica um produto na Nuvemshop em 2 passos:
 *   1. POST /api/create-product  → cria o produto
 *   2. POST /api/upload-image × N → vincula cada imagem
 *
 * @param {Object} produto — saída de _cdnMontarProduto()
 * @returns {Object} { product_id, product }
 */
async function publicarProduto(produto) {
  // Pega token do campo do formulário ou do localStorage
  var tokenEl = document.getElementById('nsToken') || document.getElementById('apiToken');
  var token   = tokenEl ? tokenEl.value.trim() : (localStorage.getItem('ns_token') || '');

  // Monta payload para create-product
  var payload = {
    produto: {
      name:        produto.name || produto.title,
      handle:      produto.handle,
      description: produto.description,
      variants:    produto.variants,
      options:     Array.isArray(produto.variants) && produto.variants.length > 0
        ? [{
            name: { pt: 'Tamanho' },
            values: [...new Set(produto.variants
              .map(v => String((v.values || v.value || v.option1 || '').trim()).toUpperCase())
              .filter(Boolean))]
              .map(v => ({ pt: v })),
          }]
        : undefined,
      published:   true,
    },
  };
  if (token) payload.token = token;

  // ── STEP A: Criar produto ──────────────────────────────────────────────────
  var criarResp = await fetch('/api/create-product', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      ...(token ? { 'Authorization': 'bearer ' + token } : {}),
    },
    body: JSON.stringify(payload),
  });

  var criarCt = criarResp.headers.get('content-type') || '';
  if (!criarCt.includes('application/json')) {
    var txt = await criarResp.text();
    throw new Error('create-product retornou não-JSON (' + criarResp.status + '): ' + txt.slice(0, 200));
  }

  var criarData = await criarResp.json();
  if (!criarResp.ok) {
    throw new Error(criarData.error || 'Erro ' + criarResp.status + ' ao criar produto');
  }

  var productId = criarData.product_id;
  console.log('[CDN] ✅ Produto criado id=' + productId + ' — vinculando imagens...');

  // ── STEP B: Vincular imagens ───────────────────────────────────────────────
  var imagens = produto.images || [];
  for (var i = 0; i < imagens.length; i++) {
    try {
      await fetch('/api/upload-image', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          ...(token ? { 'Authorization': 'bearer ' + token } : {}),
        },
        body: JSON.stringify({
          product_id: productId,
          src:        imagens[i],
          position:   i + 1,
          alt:        (produto.name || produto.title) + ' — ' + (i + 1),
        }),
      });
    } catch (e) {
      console.warn('[CDN] Aviso: erro ao vincular imagem ' + (i+1) + ':', e.message);
    }
  }

  return criarData;
}
