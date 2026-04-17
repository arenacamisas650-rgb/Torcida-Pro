// api/aiRouter.js — Vercel Function + Módulo reutilizável
// ═══════════════════════════════════════════════════════════════════════════
// CAMADA CENTRAL DE IA — Torcida Pro Analytics
// Provedor principal : OpenRouter (https://openrouter.ai)
// Formato            : OpenAI-compatible (chat/completions)
// Uso como rota HTTP : POST /api/ai-router  ← chamado pelo frontend
// Uso como módulo    : import { callAI } from './aiRouter.js'  ← outros functions
// ═══════════════════════════════════════════════════════════════════════════

// ── Constantes ───────────────────────────────────────────────────────────────

const OR_ENDPOINT  = 'https://openrouter.ai/api/v1/chat/completions';
const OR_SITE_URL  = 'https://torcidapro.com.br';
const OR_APP_TITLE = 'Torcida Pro Analytics';

// ── Catálogo de modelos disponíveis ─────────────────────────────────────────
//    Usado para validação de entrada e seleção automática de fallback.
const MODELS = {
  // Modelos primários
  'anthropic/claude-sonnet-4-5':        { tier: 1, alias: ['claude', 'sonnet', 'default'] },
  'anthropic/claude-opus-4-5':          { tier: 1, alias: ['opus', 'pipeline'] },
  'anthropic/claude-3.5-sonnet':        { tier: 1, alias: ['claude-3.5'] },
  // Fallback rápido (baixo custo)
  'openai/gpt-4o-mini':                 { tier: 2, alias: ['gpt-mini', 'fast', 'fallback'] },
  // Fallback de custo zero / open-source
  'meta-llama/llama-3.1-70b-instruct':  { tier: 3, alias: ['llama', 'llama-70b'] },
  'qwen/qwen2.5-coder':                 { tier: 3, alias: ['qwen', 'coder'] },
};

// Sequência de fallback: se o modelo primário falhar, tenta estes na ordem
const FALLBACK_CHAIN = [
  'openai/gpt-4o-mini',
  'meta-llama/llama-3.1-70b-instruct',
];

// Modelo padrão quando nenhum é especificado
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-5';

// ── Erros que justificam fallback imediato ────────────────────────────────────
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// ═══════════════════════════════════════════════════════════════════════════
// LOGGER ESTRUTURADO
// Todos os eventos de IA são emitidos por aqui para facilitar
// rastreamento em Vercel Logs / Datadog / etc.
// ═══════════════════════════════════════════════════════════════════════════

function aiLog(level, data) {
  const entry = {
    ts:       new Date().toISOString(),
    service:  'ai-router',
    level,
    ...data,
  };
  if (level === 'error') {
    console.error('[AI]', JSON.stringify(entry));
  } else {
    console.log('[AI]', JSON.stringify(entry));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FUNÇÃO CORE — callAI
// ═══════════════════════════════════════════════════════════════════════════
// Parâmetros:
//   model      {string}   — modelo desejado (ex: 'anthropic/claude-3.5-sonnet')
//                           Aceita aliases definidos em MODELS (ex: 'sonnet', 'fast')
//   messages   {Array}    — array OpenAI [{role, content}]
//   system     {string}   — system prompt (opcional; inserido como primeira mensagem)
//   maxTokens  {number}   — max_tokens (padrão: 1000)
//   temperature{number}   — temperatura (padrão: 0.7)
//   noFallback {boolean}  — desabilita fallback automático (padrão: false)
// Retorna:
//   { text, model, latency, status, usage }
// Lança:
//   Error se todos os modelos falharem
// ═══════════════════════════════════════════════════════════════════════════
export async function callAI({
  model      = DEFAULT_MODEL,
  messages,
  system     = null,
  maxTokens  = 1000,
  temperature = 0.7,
  noFallback = false,
} = {}) {

  // ── Validação básica ─────────────────────────────────────────────────────
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    throw new Error('[callAI] "messages" é obrigatório e deve ser um array não-vazio.');
  }

  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) {
    aiLog('error', { event: 'no_api_key' });
    throw new Error('[callAI] OPENROUTER_API_KEY não configurada nas variáveis de ambiente.');
  }

  // ── Resolver alias de modelo ─────────────────────────────────────────────
  const resolvedModel = resolveModel(model);

  // ── Montar lista de modelos a tentar (primário + fallback) ───────────────
  const modelsToTry = noFallback
    ? [resolvedModel]
    : [resolvedModel, ...FALLBACK_CHAIN.filter(m => m !== resolvedModel)];

  // ── Montar array de mensagens com system prompt opcional ─────────────────
  const fullMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  // ── Tentar cada modelo em sequência ─────────────────────────────────────
  let lastError = null;

  for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
    const currentModel = modelsToTry[attempt];
    const isFallback   = attempt > 0;

    if (isFallback) {
      aiLog('warn', {
        event:         'fallback_attempt',
        original_model: resolvedModel,
        fallback_model: currentModel,
        attempt,
        reason:         lastError?.message || 'erro anterior',
      });
    }

    const t0 = Date.now();

    try {
      const response = await fetch(OR_ENDPOINT, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer':  OR_SITE_URL,
          'X-Title':       OR_APP_TITLE,
        },
        body: JSON.stringify({
          model:       currentModel,
          messages:    fullMessages,
          max_tokens:  maxTokens,
          temperature,
        }),
      });

      const latency = Date.now() - t0;

      // ── Tratar erro HTTP ───────────────────────────────────────────────
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        const errMsg  = errBody?.error?.message || `HTTP ${response.status}`;

        aiLog('error', {
          event:   'request_failed',
          model:   currentModel,
          status:  response.status,
          latency,
          error:   errMsg,
          retrying: RETRYABLE_STATUSES.has(response.status) && !noFallback,
        });

        lastError = new Error(errMsg);
        lastError.status = response.status;

        // Só faz fallback para status retryable
        if (RETRYABLE_STATUSES.has(response.status)) continue;

        // Status 4xx não-retryable (ex: 400 bad request, 401): falha imediata
        throw lastError;
      }

      // ── Resposta OK ────────────────────────────────────────────────────
      const data  = await response.json();
      const text  = data?.choices?.[0]?.message?.content || '';
      const usage = data?.usage || null;

      aiLog('info', {
        event:        'request_success',
        model:        currentModel,
        status:       response.status,
        latency,
        is_fallback:  isFallback,
        input_tokens:  usage?.prompt_tokens     || null,
        output_tokens: usage?.completion_tokens || null,
      });

      return { text, model: currentModel, latency, status: response.status, usage };

    } catch (err) {
      const latency = Date.now() - t0;

      // Erro de rede (fetch falhou completamente)
      if (!err.status) {
        aiLog('error', {
          event:   'network_error',
          model:   currentModel,
          latency,
          error:   err.message,
          retrying: !noFallback && attempt < modelsToTry.length - 1,
        });
        lastError = err;
        continue; // tenta próximo modelo
      }

      // Erro HTTP já logado acima — apenas relança se não for retryable
      throw err;
    }
  }

  // Todos os modelos falharam
  aiLog('error', {
    event:          'all_models_failed',
    models_tried:   modelsToTry,
    last_error:     lastError?.message,
  });
  throw lastError || new Error('[callAI] Todos os modelos falharam.');
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS EXPORTADOS
// Wrappers com assinaturas convenientes para os demais modules
// ═══════════════════════════════════════════════════════════════════════════

/** Gera texto simples a partir de um prompt string */
export async function callAIText(prompt, { model, maxTokens, system } = {}) {
  const res = await callAI({
    model,
    maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.text;
}

/** Gera e parseia JSON diretamente; lança erro se JSON inválido */
export async function callAIJSON(prompt, { model, maxTokens, system } = {}) {
  const jsonSystem = [
    system,
    'Responda APENAS com JSON válido. Sem markdown, sem texto fora do JSON.',
  ].filter(Boolean).join('\n');

  const res  = await callAI({
    model,
    maxTokens: maxTokens || 1200,
    system: jsonSystem,
    messages: [{ role: 'user', content: prompt }],
  });

  const clean = res.text.replace(/```json|```/g, '').trim();
  try {
    return { data: JSON.parse(clean), model: res.model, latency: res.latency };
  } catch (e) {
    aiLog('error', { event: 'json_parse_failed', raw: clean.slice(0, 200) });
    throw new Error('[callAIJSON] IA retornou JSON inválido: ' + e.message);
  }
}

/** Resolve alias de modelo para ID completo */
export function resolveModel(input = DEFAULT_MODEL) {
  if (MODELS[input]) return input; // já é um ID válido
  // Procura por alias
  for (const [id, cfg] of Object.entries(MODELS)) {
    if (cfg.alias.includes(input.toLowerCase())) return id;
  }
  aiLog('warn', { event: 'unknown_model', input, fallback: DEFAULT_MODEL });
  return DEFAULT_MODEL; // retorna padrão se não reconhecer
}

/** Lista todos os modelos disponíveis */
export function listModels() {
  return Object.entries(MODELS).map(([id, cfg]) => ({ id, tier: cfg.tier, alias: cfg.alias }));
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP HANDLER — Vercel Function (rota /api/ai-router)
// ═══════════════════════════════════════════════════════════════════════════
// Permite que o frontend chame /api/ai-router via POST sem expor a API key.
//
// Body esperado:
// {
//   "model":      "anthropic/claude-3.5-sonnet",  // opcional
//   "messages":   [{ "role": "user", "content": "..." }],
//   "system":     "Você é...",                     // opcional
//   "maxTokens":  1000,                            // opcional
//   "temperature": 0.7,                            // opcional
//   "returnJSON": true                             // opcional: parseia JSON automaticamente
// }
//
// Resposta de sucesso (200):
// { "text": "...", "model": "...", "latency": 342, "usage": {...} }
//
// Resposta de erro (4xx/5xx):
// { "error": "mensagem", "code": "ERR_CODE" }
// ═══════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method Not Allowed', code: 'ERR_METHOD' });

  // ── Parse do body ─────────────────────────────────────────────────────────
  const {
    model,
    messages,
    system,
    maxTokens,
    temperature,
    returnJSON = false,
    noFallback = false,
  } = req.body || {};

  // ── Validação de entrada ─────────────────────────────────────────────────
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: 'Campo "messages" é obrigatório e deve ser um array não-vazio.',
      code:  'ERR_MISSING_MESSAGES',
    });
  }

  // Validação básica de cada mensagem
  for (const msg of messages) {
    if (!msg.role || !msg.content) {
      return res.status(400).json({
        error: 'Cada mensagem deve ter "role" e "content".',
        code:  'ERR_INVALID_MESSAGE',
      });
    }
    if (!['user', 'assistant', 'system'].includes(msg.role)) {
      return res.status(400).json({
        error: `Role inválido: "${msg.role}". Use: user, assistant ou system.`,
        code:  'ERR_INVALID_ROLE',
      });
    }
  }

  // ── Executar chamada de IA ─────────────────────────────────────────────────
  try {
    const result = await callAI({
      model,
      messages,
      system,
      maxTokens,
      temperature,
      noFallback,
    });

    // ── Retorno com JSON parseado (se solicitado) ──────────────────────────
    if (returnJSON) {
      const clean = result.text.replace(/```json|```/g, '').trim();
      try {
        const parsed = JSON.parse(clean);
        return res.status(200).json({ ...result, json: parsed });
      } catch (e) {
        // Não conseguiu parsear — retorna texto mesmo
        return res.status(200).json({ ...result, json_parse_error: e.message });
      }
    }

    return res.status(200).json(result);

  } catch (err) {
    const httpStatus = err.status && err.status >= 400 && err.status < 600
      ? err.status
      : 502;

    // Classificar o código de erro
    let code = 'ERR_AI_FAILED';
    if (err.message.includes('OPENROUTER_API_KEY')) code = 'ERR_NO_API_KEY';
    if (httpStatus === 401)                          code = 'ERR_UNAUTHORIZED';
    if (httpStatus === 429)                          code = 'ERR_RATE_LIMIT';

    return res.status(httpStatus).json({ error: err.message, code });
  }
}
