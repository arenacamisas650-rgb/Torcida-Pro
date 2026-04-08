# Torcida Pro — Guia Completo: Cloudinary + Vercel + Nuvemshop

## 📁 Estrutura de Arquivos

```
seu-projeto/
├── api/
│   ├── create-product.js    ← sem alteração
│   ├── delete-products.js   ← sem alteração
│   ├── get-products.js      ← sem alteração
│   ├── get-store.js         ← sem alteração
│   ├── listar-cdn.js        ← SUBSTITUIR pelo arquivo corrigido
│   ├── shopify-proxy.js     ← sem alteração
│   ├── update-product.js    ← sem alteração
│   └── upload-image.js      ← SUBSTITUIR pelo arquivo corrigido
├── lib/
│   └── agrupar-produtos.js  ← NOVO (opcional, já integrado no frontend)
├── index.html               ← substituir funções CDN conforme cdn-module.js
└── vercel.json
```

---

## ⚙️ vercel.json

```json
{
  "functions": {
    "api/*.js": {
      "memory": 512,
      "maxDuration": 30
    }
  }
}
```

---

## 🔑 Variáveis de Ambiente (Vercel Dashboard)

Acesse: **Vercel → Project → Settings → Environment Variables**

| Variável                  | Valor                        | Onde pegar                        |
|---------------------------|------------------------------|-----------------------------------|
| `CLOUDINARY_CLOUD_NAME`   | `meu-cloud`                  | Cloudinary Dashboard → Cloud Name |
| `CLOUDINARY_API_KEY`      | `123456789012345`            | Cloudinary Dashboard → API Key    |
| `CLOUDINARY_API_SECRET`   | `AbCdEfGhIjKlMnOpQrStUvWxYz` | Cloudinary Dashboard → API Secret |
| `NS_STORE_ID`             | `7475657`                    | URL do admin Nuvemshop            |
| `NS_TOKEN`                | `seu-token-nuvemshop`        | Nuvemshop → Parceiros → Apps      |

---

## 🖼️ Como fazer upload no Cloudinary

### Passo 1 — Crie uma conta
Acesse https://cloudinary.com e crie conta gratuita.
O plano free suporta 25GB de armazenamento — suficiente para centenas de produtos.

### Passo 2 — Crie uma pasta chamada `camisas`
No painel Cloudinary:
- Clique em **Media Library**
- Clique em **New Folder** → nomeie `camisas`

### Passo 3 — Converta de nomes corretos ANTES do upload

**Regra de nomenclatura (crítica!):**
```
{nome-do-produto}_{angulo}.{ext}

Exemplos corretos:
  camisa_barcelona_frente.jpg       ← imagem principal/capa
  camisa_barcelona_costas.jpg
  camisa_barcelona_detalhe.jpg
  camisa-real-madrid_frente.jpg
  camisa-psg_frente.jpg
  camisa-psg_costas.jpg
```

**Ângulos reconhecidos** (em ordem de prioridade):
`frente` → `front` → `costas` → `back` → `detalhe` → `detail` → `lateral` → `side` → `zoom`

**Regras:**
- Use `_` para separar nome do ângulo
- Use `-` para separar palavras dentro do nome do produto
- Sem acentos, sem espaços, sem caracteres especiais
- Sempre minúsculas

### Passo 4 — Upload em lote
- No painel Cloudinary: **Media Library → camisas → Upload**
- Arraste todos os arquivos de uma vez
- O Cloudinary preserva os nomes dos arquivos

---

## 🔗 Como o agrupamento funciona

Dado este conjunto de arquivos no Cloudinary:
```
camisas/camisa_barcelona_frente.jpg
camisas/camisa_barcelona_costas.jpg
camisas/camisa_barcelona_detalhe.jpg
camisas/camisa-real-madrid_frente.jpg
camisas/camisa-real-madrid_costas.jpg
camisas/camisa-psg_frente.jpg
```

O sistema gera automaticamente:
```json
{
  "camisa_barcelona": [
    "https://res.cloudinary.com/.../camisa_barcelona_frente.jpg",
    "https://res.cloudinary.com/.../camisa_barcelona_costas.jpg",
    "https://res.cloudinary.com/.../camisa_barcelona_detalhe.jpg"
  ],
  "camisa-real-madrid": [
    "https://res.cloudinary.com/.../camisa-real-madrid_frente.jpg",
    "https://res.cloudinary.com/.../camisa-real-madrid_costas.jpg"
  ],
  "camisa-psg": [
    "https://res.cloudinary.com/.../camisa-psg_frente.jpg"
  ]
}
```

E cria 3 produtos na Nuvemshop, cada um com suas imagens ordenadas.

---

## 🔄 Fluxo completo do sistema

```
1. Você faz upload das imagens no Cloudinary (pasta camisas/)
         ↓
2. Clica "Importar e Publicar" no painel Torcida Pro
         ↓
3. Frontend chama GET /api/listar-cdn?pasta=camisas
         ↓
4. listar-cdn.js consulta Cloudinary Admin API
   → retorna JSON: { success: true, files: ["https://...jpg", ...] }
         ↓
5. Frontend agrupa por nome-base (agruparImagens)
         ↓
6. Gera estrutura de produto (_cdnMontarProduto)
         ↓
7. POST /api/create-product → cria produto na Nuvemshop
         ↓
8. POST /api/upload-image × N → vincula cada imagem ao produto
         ↓
9. Produto publicado! ✅
```

---

## 🚀 Como rodar localmente

```bash
# Instalar Vercel CLI
npm i -g vercel

# Na pasta do projeto
vercel dev

# Acessar
open http://localhost:3000
```

Crie `.env.local` com:
```
CLOUDINARY_CLOUD_NAME=seu-cloud
CLOUDINARY_API_KEY=sua-key
CLOUDINARY_API_SECRET=seu-secret
NS_STORE_ID=7475657
NS_TOKEN=seu-token
```

---

## 🛠️ Como aplicar no index.html

1. Abra `index.html`
2. Localize as funções: `listarImagensAuto`, `montarURLs`, `agruparImagens`, `_cdnMontarProduto`, `publicarProduto`
3. Substitua **todas** por o conteúdo de `cdn-module.js`
4. Adicione no HTML do painel CDN, se não existir:
```html
<input id="cdnPasta" value="camisas" placeholder="Pasta no Cloudinary">
<input id="cdnPreco" type="number" value="0" placeholder="Preço base">
<input id="cdnTamanhos" value="P,M,G,GG" placeholder="Tamanhos separados por vírgula">
<input id="nsToken" type="text" placeholder="Token Nuvemshop">
```

---

## ❓ Erros comuns e soluções

| Erro | Causa | Solução |
|------|-------|---------|
| `Unexpected token '<'` | listar-cdn retorna HTML (404/500) | Verifique o deploy da Vercel Function |
| `Nenhuma imagem encontrada` | Pasta errada ou vazia no Cloudinary | Confirme o nome da pasta |
| `Variáveis Cloudinary não configuradas` | Env vars faltando | Adicione no painel Vercel |
| `422` no create-product | Handle duplicado | O sistema deleta e recria automaticamente |
| `401 Token ausente` | Token Nuvemshop não informado | Preencha o campo nsToken ou configure NS_TOKEN |
