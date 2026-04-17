// api/aiAgent.js — Vercel Function + Motor de IA Autônomo
// ═══════════════════════════════════════════════════════════════════════════════
// CAMADA DE INTELIGÊNCIA — Torcida Pro Analytics
//
// RESPONSABILIDADES:
//   1. Detectar automaticamente o tipo de tarefa a partir de qualquer input
//   2. Rotear cada tarefa para o modelo mais adequado (aiTaskRouter)
//   3. Executar pipeline completo de criação de produto (createProductPipeline)
//   4. Orquestrar tudo via aiAgent — entrada única, saída estruturada
//
// DEPENDÊNCIA:
//   Importa callAI, callAIText, callAIJSON de ./aiRouter.js
//   (deve estar em api/aiRouter.js no mesmo projeto Vercel)
//
// COMO PLUGAR NO create-product.js:
//   import { createProductPipeline } from './aiAgent.js';
//   const produto = await createProductPipeline("camisa brasil 2026 streetwear");
//   // produto.name, produto.description, produto.handle, etc.
//
// ROTA HTTP:
//   POST /api/ai-agent
//   Body: { "input": "crie uma camisa do brasil 2026 streetwear" }
//
// ═══════════════════════════════════════════════════════════════════════════════

import { callAI, callAIText, callAIJSON } from './aiRouter.js';

// ──────────────────────────────────────────────────────────────────────────────
// TIPOS DE TAREFA
// ──────────────────────────────────────────────────────────────────────────────

export const TASK_TYPES = {
  PRODUCT_CREATE:      'product_create',
  PRODUCT_DESCRIPTION: 'product_description',
  SEO_TITLE:           'seo_title',
  IMAGE_PROMPT:        'image_prompt',
  GENERAL:             'general',
};

// ──────────────────────────────────────────────────────────────────────────────
// MAPEAMENTO DE TAREFAS → MODELOS
// Cada tarefa usa o modelo mais custo-efetivo para aquela função específica.
// ──────────────────────────────────────────────────────────────────────────────

const TASK_MODEL_MAP = {
  [TASK_TYPES.PRODUCT_CREATE]:      'anthropic/claude-3.5-sonnet',   // raciocínio + criatividade
  [TASK_TYPES.PRODUCT_DESCRIPTION]: 'openai/gpt-4o-mini',            // geração de texto rápida
  [TASK_TYPES.SEO_TITLE]:           'meta-llama/llama-3.1-70b-instruct', // bom em otimização
  [TASK_TYPES.IMAGE_PROMPT]:        'qwen/qwen2.5-coder',            // estruturado e técnico
  [TASK_TYPES.GENERAL]:             'anthropic/claude-3.5-sonnet',   // padrão para casos gerais
};

// Fallback por tarefa: se o modelo primário falhar, tenta estes na ordem
const TASK_FALLBACK_MAP = {
  [TASK_TYPES.PRODUCT_CREATE]:      ['openai/gpt-4o-mini', 'meta-llama/llama-3.1-70b-instruct'],
  [TASK_TYPES.PRODUCT_DESCRIPTION]: ['meta-llama/llama-3.1-70b-instruct', 'anthropic/claude-3.5-sonnet'],
  [TASK_TYPES.SEO_TITLE]:           ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'],
  [TASK_TYPES.IMAGE_PROMPT]:        ['openai/gpt-4o-mini', 'meta-llama/llama-3.1-70b-instruct'],
  [TASK_TYPES.GENERAL]:             ['openai/gpt-4o-mini', 'meta-llama/llama-3.1-70b-instruct'],
};

// ──────────────────────────────────────────────────────────────────────────────
// LOGGER ESTRUTURADO
// ──────────────────────────────────────────────────────────────────────────────

function agentLog(level, data) {
  const entry = { ts: new Date().toISOString(), service: 'ai-agent', level, ...data };
  level === 'error' ? console.error('[AGENT]', JSON.stringify(entry)) : console.log('[AGENT]', JSON.stringify(entry));
}

// ══════════════════════════════════════════════════════════════════════════════
// FUNCIONALIDADE 1 — DETECÇÃO DE TAREFA
// Usa heurísticas de palavras-chave primeiro (rápido, sem custo de API).
// Se o input for ambíguo, usa IA leve para classificar.
// ══════════════════════════════════════════════════════════════════════════════

// Mapa de palavras-chave por tipo de tarefa (heurística rápida)
const TASK_KEYWORDS = {
  [TASK_TYPES.PRODUCT_CREATE]: [
    'crie', 'criar', 'gere', 'gerar', 'novo produto', 'cadastrar', 'produto novo',
    'camisa', 'camiseta', 'jersey', 'uniforme', 'roupa', 'vestuário',
    'adicionar produto', 'lançar', 'publicar produto',
  ],
  [TASK_TYPES.PRODUCT_DESCRIPTION]: [
    'descrição', 'descreva', 'descrever', 'descricao', 'description',
    'texto do produto', 'detalhe', 'apresente', 'conte sobre',
    'escreva sobre', 'explique o produto',
  ],
  [TASK_TYPES.SEO_TITLE]: [
    'seo', 'título seo', 'meta title', 'title tag', 'otimização',
    'google', 'busca', 'ranquear', 'posicionamento', 'meta description',
    'keywords', 'palavras-chave', 'indexar',
  ],
  [TASK_TYPES.IMAGE_PROMPT]: [
    'prompt de imagem', 'imagem', 'foto', 'visual', 'ilustração',
    'midjourney', 'dall-e', 'stable diffusion', 'gere imagem',
    'prompt para', 'imagen', 'render', 'photo prompt',
  ],
};

/**
 * Detecta o tipo de tarefa a partir do input do usuário.
 * Estratégia: keywords primeiro (rápido) → IA se ambíguo.
 *
 * @param {string} input — texto do usuário
 * @param {boolean} useAI — usar IA como fallback de classificação (padrão: true)
 * @returns {Promise<{ task: string, confidence: 'high'|'medium'|'low', method: string }>}
 */
export async function detectTask(input, useAI = true) {
  const t0          = Date.now();
  const normalized  = input.toLowerCase().trim();

  // ── Pontuação por tipo ────────────────────────────────────────────────────
  const scores = Object.fromEntries(Object.values(TASK_TYPES).map(t => [t, 0]));

  for (const [taskType, keywords] of Object.entries(TASK_KEYWORDS)) {
    for (const kw of keywords) {
      if (normalized.includes(kw)) scores[taskType] += kw.split(' ').length; // palavras compostas valem mais
    }
  }

  // Encontrar o tipo com maior pontuação
  const [bestTask, bestScore] = Object.entries(scores).reduce(
    (best, curr) => curr[1] > best[1] ? curr : best,
    [TASK_TYPES.GENERAL, 0]
  );

  const secondBest = Object.entries(scores)
    .filter(([t]) => t !== bestTask)
    .reduce((b, c) => c[1] > b[1] ? c : b, [TASK_TYPES.GENERAL, 0]);

  // Alta confiança: score ≥ 2 e claramente superior ao segundo
  if (bestScore >= 2 && bestScore > secondBest[1] + 1) {
    agentLog('info', { event: 'task_detected', task: bestTask, method: 'keywords', confidence: 'high', score: bestScore, latency: Date.now() - t0 });
    return { task: bestTask, confidence: 'high', method: 'keywords' };
  }

  // Confiança média: algum match mas ambíguo
  if (bestScore >= 1 && !useAI) {
    agentLog('info', { event: 'task_detected', task: bestTask, method: 'keywords', confidence: 'medium', score: bestScore, latency: Date.now() - t0 });
    return { task: bestTask, confidence: 'medium', method: 'keywords' };
  }

  // ── Fallback: classificação por IA (modelo rápido e barato) ──────────────
  if (useAI) {
    try {
      const classifyPrompt = `Classifique o seguinte input em UMA das categorias abaixo. Responda APENAS com o nome da categoria, sem explicação.

CATEGORIAS:
- product_create: criar um produto novo, gerar produto, cadastrar camisa/roupa
- product_description: escrever ou melhorar descrição de produto existente
- seo_title: criar título SEO, meta title, otimizar para buscadores
- image_prompt: gerar prompt de imagem para IA (Midjourney, DALL-E, etc)
- general: qualquer outra coisa

INPUT DO USUÁRIO: "${input}"

CATEGORIA:`;

      const res = await callAI({
        model:      'openai/gpt-4o-mini',
        maxTokens:  10,
        temperature: 0,
        messages:   [{ role: 'user', content: classifyPrompt }],
      });

      const aiTask = res.text.trim().toLowerCase().replace(/[^a-z_]/g, '');
      const validTask = Object.values(TASK_TYPES).includes(aiTask) ? aiTask : TASK_TYPES.GENERAL;

      agentLog('info', { event: 'task_detected', task: validTask, method: 'ai_classification', confidence: 'high', latency: Date.now() - t0 });
      return { task: validTask, confidence: 'high', method: 'ai_classification' };

    } catch (e) {
      agentLog('warn', { event: 'task_detection_ai_failed', error: e.message, fallback: TASK_TYPES.GENERAL });
    }
  }

  // Fallback final: general
  agentLog('info', { event: 'task_detected', task: TASK_TYPES.GENERAL, method: 'default_fallback', confidence: 'low', latency: Date.now() - t0 });
  return { task: TASK_TYPES.GENERAL, confidence: 'low', method: 'default_fallback' };
}

// ══════════════════════════════════════════════════════════════════════════════
// FUNCIONALIDADE 2 — AI TASK ROUTER
// Recebe input + task type → chama o modelo correto → retorna texto
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Roteador central de tarefas.
 * Detecta automaticamente a tarefa se não fornecida,
 * e chama o modelo mais adequado com fallback automático.
 *
 * @param {string}  input      — prompt ou instrução do usuário
 * @param {string}  [taskType] — força um tipo de tarefa (opcional)
 * @param {string}  [system]   — system prompt adicional (opcional)
 * @param {number}  [maxTokens]
 * @returns {Promise<{ text, task, model, latency, fallback_used }>}
 */
export async function aiTaskRouter(input, { taskType, system, maxTokens } = {}) {
  const t0 = Date.now();

  // 1. Detectar tarefa
  const detected   = taskType
    ? { task: taskType, confidence: 'forced', method: 'explicit' }
    : await detectTask(input);
  const task        = detected.task;

  // 2. Selecionar modelo primário e fallbacks para esta tarefa
  const primaryModel  = TASK_MODEL_MAP[task]      || TASK_MODEL_MAP[TASK_TYPES.GENERAL];
  const fallbackModels = TASK_FALLBACK_MAP[task]  || TASK_FALLBACK_MAP[TASK_TYPES.GENERAL];
  const modelsToTry    = [primaryModel, ...fallbackModels];

  agentLog('info', { event: 'routing_task', task, model: primaryModel, confidence: detected.confidence, method: detected.method });

  // 3. Tentar modelos em sequência
  let lastError   = null;
  let fallbackUsed = false;

  for (let i = 0; i < modelsToTry.length; i++) {
    const model      = modelsToTry[i];
    const isRetry    = i > 0;
    if (isRetry) {
      fallbackUsed = true;
      agentLog('warn', { event: 'task_router_fallback', task, original: primaryModel, trying: model, attempt: i });
    }

    try {
      const result = await callAI({
        model,
        system,
        maxTokens: maxTokens || 1500,
        messages:  [{ role: 'user', content: input }],
        noFallback: true, // fallback gerenciado aqui
      });

      const totalLatency = Date.now() - t0;
      agentLog('info', { event: 'task_router_success', task, model, latency: totalLatency, fallback_used: fallbackUsed });

      return { text: result.text, task, model, latency: totalLatency, fallback_used: fallbackUsed };

    } catch (err) {
      lastError = err;
      agentLog('error', { event: 'task_router_model_failed', task, model, error: err.message, retrying: i < modelsToTry.length - 1 });
    }
  }

  agentLog('error', { event: 'task_router_all_failed', task, models_tried: modelsToTry, error: lastError?.message });
  throw lastError || new Error(`[aiTaskRouter] Todos os modelos falharam para task: ${task}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// FUNCIONALIDADE 3 — STEPS DO PIPELINE
// Cada step é uma função assíncrona isolada e independente.
// Steps 2-5 rodam em paralelo (Promise.all) após o step 1.
// ══════════════════════════════════════════════════════════════════════════════

const SYSTEM_ECOMMERCE = `Você é especialista em e-commerce de camisas de futebol e streetwear no Brasil.
Escreva em português brasileiro. Seja direto, comercial e persuasivo.
Siga rigorosamente o formato solicitado.`;

// Step 1 — Nome do produto
async function stepGenerateName(input) {
  const prompt = `Com base nesta descrição, gere o nome comercial do produto para e-commerce.

DESCRIÇÃO: "${input}"

REGRAS:
- Máximo 10 palavras
- Inclua: [Tipo] [Clube/Seleção] [Temporada] [Versão] [Marca se informada] [Cor se informada]
- Exemplo: "Camisa Brasil 2026 Home Torcedor Nike Verde e Amarela"
- Retorne APENAS o nome, sem aspas, sem explicação

NOME DO PRODUTO:`;

  const t0  = Date.now();
  const res = await callAI({
    model:      TASK_MODEL_MAP[TASK_TYPES.PRODUCT_CREATE],
    system:     SYSTEM_ECOMMERCE,
    maxTokens:  60,
    temperature: 0.7,
    messages:   [{ role: 'user', content: prompt }],
  });
  agentLog('info', { event: 'step_done', step: 'name', model: res.model, latency: Date.now() - t0 });
  return res.text.trim().replace(/^["']|["']$/g, '');
}

// Step 2 — Descrição HTML do produto
async function stepGenerateDescription(name, input) {
  const prompt = `Escreva uma descrição HTML completa e profissional para o produto de e-commerce abaixo.

PRODUTO: ${name}
CONTEXTO ADICIONAL: ${input}

ESTRUTURA OBRIGATÓRIA:
<h2>[Nome do produto]</h2>
<p>[Parágrafo emocional de venda — 2-3 frases. Paixão pelo clube + qualidade]</p>
<h3>⚽ Detalhes do Produto</h3>
<ul>
  <li>Modelo [Torcedor/Jogador] — [definição breve]</li>
  <li>Tecido de alta qualidade com tecnologia DryFit</li>
  <li>Acabamento premium idêntico ao profissional</li>
  <li>Disponível nos tamanhos PP, P, M, G, GG</li>
</ul>
<h3>📦 Entrega para Todo o Brasil</h3>
<ul>
  <li>Prazo: 5 a 12 dias úteis após confirmação</li>
  <li>Rastreamento em tempo real por e-mail e WhatsApp</li>
  <li>Embalagem reforçada para máxima proteção</li>
</ul>
<h3>🔥 Por Que Escolher a Nossa?</h3>
<p>[Argumento de escassez/urgência + garantia + confiança. 2-3 frases persuasivas]</p>

Retorne APENAS o HTML, sem texto fora das tags.`;

  const t0  = Date.now();
  const res = await callAI({
    model:      TASK_MODEL_MAP[TASK_TYPES.PRODUCT_DESCRIPTION],
    system:     SYSTEM_ECOMMERCE,
    maxTokens:  800,
    temperature: 0.7,
    messages:   [{ role: 'user', content: prompt }],
  });
  agentLog('info', { event: 'step_done', step: 'description', model: res.model, latency: Date.now() - t0 });
  return res.text.trim();
}

// Step 3 — SEO Title + Meta Description
async function stepGenerateSEO(name, input) {
  const prompt = `Gere o SEO title e a meta description para o produto abaixo.

PRODUTO: ${name}
CONTEXTO: ${input}

REGRAS SEO TITLE:
- 50-60 caracteres
- Inclua palavras-chave de busca: "comprar", nome do clube, "oficial", temporada
- Exemplo: "Comprar Camisa Brasil 2026 Home Oficial | Torcida Pro"

REGRAS META DESCRIPTION:
- 140-155 caracteres
- Persuasiva, com chamada para ação e palavra-chave
- Exemplo: "Camisa Brasil 2026 Home com envio rápido. Qualidade oficial, frete grátis acima R$200. Peça já!"

Retorne APENAS JSON válido:
{
  "seo_title": "...",
  "seo_description": "..."
}`;

  const t0  = Date.now();
  const res = await callAI({
    model:      TASK_MODEL_MAP[TASK_TYPES.SEO_TITLE],
    system:     SYSTEM_ECOMMERCE,
    maxTokens:  200,
    temperature: 0.4,
    messages:   [{ role: 'user', content: prompt }],
  });
  agentLog('info', { event: 'step_done', step: 'seo', model: res.model, latency: Date.now() - t0 });

  try {
    return JSON.parse(res.text.replace(/```json|```/g, '').trim());
  } catch {
    // Fallback: parse manual se JSON quebrado
    const titleMatch = res.text.match(/"seo_title"\s*:\s*"([^"]+)"/);
    const descMatch  = res.text.match(/"seo_description"\s*:\s*"([^"]+)"/);
    return {
      seo_title:       titleMatch?.[1] || name,
      seo_description: descMatch?.[1]  || `Compre ${name} com entrega rápida para todo o Brasil.`,
    };
  }
}

// Step 4 — Prompt de Imagem para IA
async function stepGenerateImagePrompt(name, input) {
  const prompt = `Gere um prompt detalhado em inglês para geração de imagem de produto (Midjourney/DALL-E/Stable Diffusion).

PRODUTO: ${name}
CONTEXTO: ${input}

ESTRUTURA DO PROMPT:
[descrição do produto] + [estilo visual] + [iluminação] + [fundo] + [qualidade]

EXEMPLO:
"Brazil national football jersey 2026, streetwear style, vibrant green and yellow colors, clean white studio background, professional product photography, 8k resolution, sharp focus, commercial lighting"

REGRAS:
- Em inglês
- Máximo 150 palavras
- Focado em product shot comercial
- Inclua: cores, estilo, fundo, qualidade

Retorne APENAS o prompt de imagem, sem explicação.`;

  const t0  = Date.now();
  const res = await callAI({
    model:      TASK_MODEL_MAP[TASK_TYPES.IMAGE_PROMPT],
    system:     'You are an expert at writing image generation prompts for e-commerce products.',
    maxTokens:  200,
    temperature: 0.8,
    messages:   [{ role: 'user', content: prompt }],
  });
  agentLog('info', { event: 'step_done', step: 'image_prompt', model: res.model, latency: Date.now() - t0 });
  return res.text.trim().replace(/^["']|["']$/g, '');
}

// Step 5 — Tags para e-commerce
async function stepGenerateTags(name, input) {
  const prompt = `Gere 10 tags/palavras-chave para o produto abaixo, ideais para SEO e e-commerce.

PRODUTO: ${name}
CONTEXTO: ${input}

FORMATO: array JSON com strings em minúsculo sem acento
EXEMPLO: ["camisa flamengo","futebol","roupa esportiva","2026","torcedor","streetwear","uniforme","camisa time","brasil","esporte"]

Retorne APENAS o array JSON.`;

  const t0  = Date.now();
  const res = await callAI({
    model:      TASK_MODEL_MAP[TASK_TYPES.SEO_TITLE], // mesmo modelo do SEO
    system:     SYSTEM_ECOMMERCE,
    maxTokens:  150,
    temperature: 0.5,
    messages:   [{ role: 'user', content: prompt }],
  });
  agentLog('info', { event: 'step_done', step: 'tags', model: res.model, latency: Date.now() - t0 });

  try {
    const arr = JSON.parse(res.text.replace(/```json|```/g, '').trim());
    return Array.isArray(arr) ? arr.slice(0, 10) : [];
  } catch {
    return res.text.match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, '')) || [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS INTERNOS
// ──────────────────────────────────────────────────────────────────────────────

/** Transforma um nome em slug/handle compatível com Nuvemshop */
function toHandle(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .substring(0, 100);
}

/** Executa uma promise com timeout; resolve com fallback se expirar */
function withTimeout(promise, ms, fallback) {
  const timeout = new Promise(resolve => setTimeout(() => resolve({ _timeout: true, value: fallback }), ms));
  return Promise.race([
    promise.then(v => ({ _timeout: false, value: v })),
    timeout,
  ]);
}

// ══════════════════════════════════════════════════════════════════════════════
// FUNCIONALIDADE 4 — PIPELINE DE PRODUTO AUTOMÁTICO
// Executa todos os steps e retorna objeto Nuvemshop-compatible.
// Steps 2-5 rodam em paralelo para minimizar latência total.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Pipeline completo de criação de produto.
 * Input: qualquer descrição livre do produto.
 * Output: objeto Nuvemshop-compatible com todos os campos gerados.
 *
 * @param {string} input — ex: "crie uma camisa do Brasil 2026 estilo streetwear"
 * @param {object} [opts]
 * @param {string} [opts.preco]         — preço sugerido (ex: "R$ 189,90")
 * @param {boolean}[opts.skipImagePrompt] — pular geração de image prompt
 * @param {number} [opts.stepTimeoutMs] — timeout por step em ms (padrão: 30000)
 * @returns {Promise<NuvemshopProduct>}
 */
export async function createProductPipeline(input, opts = {}) {
  const { preco = null, skipImagePrompt = false, stepTimeoutMs = 30000 } = opts;
  const pipelineStart = Date.now();
  const stepsMeta     = [];

  agentLog('info', { event: 'pipeline_start', input: input.substring(0, 100) });

  // ── STEP 1: Nome (obrigatório — os outros dependem dele) ─────────────────
  let productName;
  try {
    const t0 = Date.now();
    productName = await stepGenerateName(input);
    stepsMeta.push({ step: 'name', ok: true, latency: Date.now() - t0 });
  } catch (err) {
    agentLog('error', { event: 'pipeline_step_failed', step: 'name', error: err.message });
    throw new Error(`[Pipeline] Falha no step "name": ${err.message}`);
  }

  agentLog('info', { event: 'pipeline_step_done', step: 'name', value: productName });

  // ── STEPS 2-5: Paralelos (não dependem uns dos outros, só do nome) ────────
  const parallelSteps = [
    withTimeout(stepGenerateDescription(productName, input), stepTimeoutMs, '<p>Descrição em breve.</p>'),
    withTimeout(stepGenerateSEO(productName, input),         stepTimeoutMs, { seo_title: productName, seo_description: '' }),
    withTimeout(stepGenerateTags(productName, input),        stepTimeoutMs, []),
    skipImagePrompt
      ? Promise.resolve({ _timeout: false, value: '' })
      : withTimeout(stepGenerateImagePrompt(productName, input), stepTimeoutMs, ''),
  ];

  const [descResult, seoResult, tagsResult, imgPromptResult] = await Promise.all(parallelSteps);

  // Registrar resultado de cada step paralelo
  const parallelNames = ['description', 'seo', 'tags', 'image_prompt'];
  [descResult, seoResult, tagsResult, imgPromptResult].forEach((r, i) => {
    if (r._timeout) {
      agentLog('warn', { event: 'pipeline_step_timeout', step: parallelNames[i], timeout_ms: stepTimeoutMs });
    }
    stepsMeta.push({ step: parallelNames[i], ok: !r._timeout, timedOut: r._timeout });
  });

  const description  = descResult.value;
  const seo          = seoResult.value;
  const tags         = tagsResult.value;
  const image_prompt = imgPromptResult.value;

  const totalLatency = Date.now() - pipelineStart;

  agentLog('info', {
    event:         'pipeline_complete',
    total_latency:  totalLatency,
    steps_ok:       stepsMeta.filter(s => s.ok).length,
    steps_total:    stepsMeta.length,
  });

  // ── Montar objeto Nuvemshop-compatible ───────────────────────────────────
  const product = {
    // Campos principais
    name:            { pt: productName },
    description:     { pt: description },
    handle:          { pt: toHandle(productName) },

    // SEO
    seo_title:       seo.seo_title       || productName,
    seo_description: seo.seo_description || '',

    // Extras
    tags:            Array.isArray(tags) ? tags.join(',') : '',
    image_prompt,            // não enviado para Nuvemshop, mas útil para geração de imagem
    published:       true,

    // Preço (se fornecido no contexto)
    ...(preco ? { preco_sugerido: preco } : {}),

    // Metadados do pipeline (não enviados para Nuvemshop)
    _pipeline_meta: {
      input:         input.substring(0, 200),
      total_latency: totalLatency,
      steps:         stepsMeta,
      generated_at:  new Date().toISOString(),
    },
  };

  return product;
}

// ══════════════════════════════════════════════════════════════════════════════
// FUNCIONALIDADE 5 — AGENTE PRINCIPAL (aiAgent)
// Ponto de entrada único para qualquer input do usuário.
// Detecta a intenção, executa o pipeline ou uma tarefa específica.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Agente de IA principal — orquestra detecção + execução.
 *
 * @param {string}  input    — qualquer input do usuário
 * @param {object}  [opts]
 * @param {string}  [opts.forceTask]       — força tipo de tarefa (ignora detecção)
 * @param {string}  [opts.system]          — system prompt extra
 * @param {number}  [opts.maxTokens]
 * @param {boolean} [opts.fullPipeline]    — força pipeline completo mesmo se task != product_create
 * @param {string}  [opts.preco]           — preço sugerido (para pipeline de produto)
 * @returns {Promise<AgentResult>}
 */
export async function aiAgent(input, opts = {}) {
  const { forceTask, system, maxTokens, fullPipeline = false, preco } = opts;
  const t0 = Date.now();

  if (!input || typeof input !== 'string' || !input.trim()) {
    throw new Error('[aiAgent] Input inválido: forneça um texto não-vazio.');
  }

  agentLog('info', { event: 'agent_start', input: input.substring(0, 120), force_task: forceTask || null });

  // ── Detectar intenção ─────────────────────────────────────────────────────
  const detection = forceTask
    ? { task: forceTask, confidence: 'forced', method: 'explicit' }
    : await detectTask(input);

  const { task } = detection;

  agentLog('info', { event: 'agent_routing', task, confidence: detection.confidence, method: detection.method });

  // ── Executar pipeline completo se for criação de produto ─────────────────
  if (task === TASK_TYPES.PRODUCT_CREATE || fullPipeline) {
    const product = await createProductPipeline(input, { preco });
    return {
      type:    'product',
      task,
      product,
      text:    null,
      latency: Date.now() - t0,
      detection,
    };
  }

  // ── Para tarefas simples: executa via task router ─────────────────────────
  const result = await aiTaskRouter(input, { taskType: task, system, maxTokens });

  return {
    type:     'text',
    task,
    product:  null,
    text:     result.text,
    model:    result.model,
    latency:  Date.now() - t0,
    fallback_used: result.fallback_used,
    detection,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// HTTP HANDLER — Vercel Function (rota /api/ai-agent)
// ══════════════════════════════════════════════════════════════════════════════
//
// Body esperado:
// {
//   "input":      "crie uma camisa do Brasil 2026 estilo streetwear",
//   "task":       "product_create",   // opcional — força tipo de tarefa
//   "preco":      "R$ 189,90",        // opcional
//   "system":     "...",              // opcional
//   "maxTokens":  1500,               // opcional
//   "fullPipeline": false             // opcional
// }
//
// Resposta 200 — produto:
// { "type": "product", "task": "product_create", "product": { name, description, handle, ... } }
//
// Resposta 200 — texto:
// { "type": "text", "task": "seo_title", "text": "...", "model": "..." }
//
// Resposta 4xx/5xx:
// { "error": "...", "code": "ERR_CODE" }
// ══════════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method Not Allowed', code: 'ERR_METHOD' });

  const { input, task, preco, system, maxTokens, fullPipeline } = req.body || {};

  // Validação
  if (!input || typeof input !== 'string' || !input.trim()) {
    return res.status(400).json({ error: 'Campo "input" é obrigatório.', code: 'ERR_MISSING_INPUT' });
  }
  if (input.trim().length < 5) {
    return res.status(400).json({ error: 'Input muito curto (mínimo 5 caracteres).', code: 'ERR_INPUT_TOO_SHORT' });
  }

  try {
    const result = await aiAgent(input.trim(), {
      forceTask:    task       || null,
      preco:        preco      || null,
      system:       system     || null,
      maxTokens:    maxTokens  || null,
      fullPipeline: !!fullPipeline,
    });

    return res.status(200).json(result);

  } catch (err) {
    const httpStatus = err.status && err.status >= 400 ? err.status : 502;

    let code = 'ERR_AGENT_FAILED';
    if (err.message.includes('OPENROUTER_API_KEY')) code = 'ERR_NO_API_KEY';
    if (httpStatus === 429)                          code = 'ERR_RATE_LIMIT';
    if (err.message.includes('Pipeline'))           code = 'ERR_PIPELINE_FAILED';

    agentLog('error', { event: 'handler_error', error: err.message, code, status: httpStatus });
    return res.status(httpStatus).json({ error: err.message, code });
  }
}
