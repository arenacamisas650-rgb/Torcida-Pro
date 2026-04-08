// lib/agrupar-produtos.js — Utilitário de agrupamento de imagens
// Pode ser importado por qualquer Vercel Function ou usado inline no frontend
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sufixos reconhecidos como ângulos/vistas de um produto.
 * Ordem importa: _frente vira imagem principal (índice 0).
 */
const SUFIXOS_ORDEM = ['frente', 'costas', 'detalhe', 'lateral', 'zoom', 'side', 'back', 'front'];

/**
 * Extrai o "nome base" de uma URL ou filename.
 * Ex: "https://res.cloudinary.com/.../camisa_barcelona_frente.jpg"
 *     → "camisa_barcelona"
 *
 * Ex: "camisa-real-madrid_costas.jpg"
 *     → "camisa-real-madrid"
 */
export function extrairBase(urlOuNome) {
  // Pega só o filename sem extensão
  const partes  = urlOuNome.split('/');
  const arquivo = partes[partes.length - 1];
  const semExt  = arquivo.replace(/\.[^.]+$/, '');

  // Remove sufixo de ângulo (separado por _ ou -)
  // Tenta por _ primeiro (mais comum: camisa_barcelona_frente)
  const partesSub = semExt.split('_');

  if (partesSub.length >= 2) {
    const ultimo = partesSub[partesSub.length - 1].toLowerCase();
    if (SUFIXOS_ORDEM.includes(ultimo)) {
      return partesSub.slice(0, -1).join('_');
    }
  }

  // Tenta por - (camisa-barcelona-frente)
  const partesDash = semExt.split('-');
  if (partesDash.length >= 2) {
    const ultimo = partesDash[partesDash.length - 1].toLowerCase();
    if (SUFIXOS_ORDEM.includes(ultimo)) {
      return partesDash.slice(0, -1).join('-');
    }
  }

  // Sem sufixo reconhecido → nome inteiro é a base
  return semExt;
}

/**
 * Extrai o sufixo de ângulo de uma URL ou filename.
 * Retorna '' se não houver sufixo reconhecido.
 */
export function extrairSufixo(urlOuNome) {
  const partes  = urlOuNome.split('/');
  const arquivo = partes[partes.length - 1];
  const semExt  = arquivo.replace(/\.[^.]+$/, '');

  const testar = (lista, sep) => {
    const sub = semExt.split(sep);
    if (sub.length < 2) return null;
    const ult = sub[sub.length - 1].toLowerCase();
    return SUFIXOS_ORDEM.includes(ult) ? ult : null;
  };

  return testar(semExt, '_') || testar(semExt, '-') || '';
}

/**
 * Agrupa uma lista de URLs por produto.
 * Retorna objeto: { "camisa_barcelona": ["url_frente", "url_costas", ...], ... }
 * Imagens sem sufixo reconhecido ficam num grupo próprio (o nome inteiro).
 * Dentro de cada grupo, ordena: frente → costas → detalhe → resto.
 *
 * @param {string[]} urls — lista de URLs do Cloudinary
 * @returns {Object.<string, string[]>}
 */
export function agruparProdutos(urls) {
  const grupos = {};

  for (const url of urls) {
    const base = extrairBase(url);
    if (!grupos[base]) grupos[base] = [];
    grupos[base].push(url);
  }

  // Ordenar imagens dentro de cada grupo conforme SUFIXOS_ORDEM
  for (const base of Object.keys(grupos)) {
    grupos[base].sort((a, b) => {
      const sa = SUFIXOS_ORDEM.indexOf(extrairSufixo(a));
      const sb = SUFIXOS_ORDEM.indexOf(extrairSufixo(b));
      const ia = sa === -1 ? 99 : sa;
      const ib = sb === -1 ? 99 : sb;
      return ia - ib;
    });
  }

  return grupos;
}

/**
 * Converte um nome-base em título de produto legível.
 * Ex: "camisa_barcelona" → "Camisa Barcelona"
 *     "camisa-real-madrid" → "Camisa Real Madrid"
 */
export function baseParaTitulo(base) {
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

/**
 * Monta a estrutura completa de produto pronta para a Nuvemshop.
 *
 * @param {string}   base   — nome-base do produto
 * @param {string[]} imagens — URLs ordenadas
 * @param {Object}   [opts]  — opções opcionais
 * @param {number}   [opts.preco=0]
 * @param {string[]} [opts.tamanhos=["P","M","G","GG"]]
 * @param {number}   [opts.estoque=100]
 * @returns {Object}
 */
export function montarProduto(base, imagens, opts = {}) {
  const {
    preco    = 0,
    tamanhos = ['P', 'M', 'G', 'GG'],
    estoque  = 100,
  } = opts;

  const titulo = baseParaTitulo(base);

  const variants = tamanhos.map(tam => ({
    values:           [tam],
    price:            preco.toFixed(2),
    stock:            estoque,
    stock_management: true,
    sku:              `${base}-${tam.toLowerCase()}`,
  }));

  return {
    name:        titulo,
    handle:      base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-'),
    description: `${titulo} — qualidade premium, tamanhos P ao GG.`,
    images:      imagens,
    variants,
    // Campos extras para exibição no frontend
    _base:       base,
    _imagemCapa: imagens[0] || '',
    _totalImgs:  imagens.length,
    preco,
  };
}
