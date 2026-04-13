# LM Studio Mobile Connection (MVP)

Microaplicação para usar um modelo local do **LM Studio** no celular em outra rede, via **ngrok** (ou similar).

## Objetivo

Permitir que um celular (fora da sua rede local) converse com um LLM rodando na sua máquina.

## Arquitetura

1. **LM Studio** roda localmente com API HTTP habilitada (porta `1234` por padrão).
2. **Node relay** roda localmente (porta `8787`) e faz proxy para o LM Studio.
3. **ngrok** (ou Cloudflare Tunnel) expõe o relay para internet com URL HTTPS.
4. O **cliente web móvel** acessa o relay e envia mensagens de chat.

```
Celular -> URL pública (ngrok) -> Relay Node -> LM Studio local (/v1/chat/completions)
```

O relay também consulta `GET /v1/models` do LM Studio para listar modelos disponíveis e permitir seleção no cliente.

## Pré-requisitos

- LM Studio instalado
- Node.js 18+
- ngrok (ou equivalente)

## 1) Configurar LM Studio

No LM Studio:

- Carregue o modelo desejado.
- Ative o servidor local (API).
- Confira endpoint local:

```bash
curl http://127.0.0.1:1234/v1/models
```

Se responder JSON, está ok.

## 2) Rodar o relay

```bash
npm install
LM_STUDIO_BASE_URL=http://127.0.0.1:1234 \
LM_MODEL=nome-do-modelo \
npm start
```

O relay sobe em `http://127.0.0.1:8787`.

## 3) Expor via ngrok

```bash
ngrok http 8787
```

Anote a URL HTTPS gerada, por exemplo:

`https://abc123.ngrok-free.app`

## 4) Abrir no celular

No celular, abra:

`https://abc123.ngrok-free.app`

Digite mensagens e envie.

## Configurações

Variáveis de ambiente:

- `PORT` (default `8787`)
- `LM_STUDIO_BASE_URL` (default `http://127.0.0.1:1234`)
- `LM_MODEL` (obrigatório para chat funcionar)
- `SYSTEM_PROMPT` (opcional)
- `MAX_TOKENS` (default `512`)
- `TEMPERATURE` (default `0.7`)

## Endpoints do relay

- `GET /` → interface web
- `GET /health` → status do relay
- `GET /api/models` → lista modelos disponíveis (via LM Studio)
- `POST /api/chat` → envia mensagem usando o modelo selecionado (ou `LM_MODEL` padrão)

## Segurança (importante)

Este MVP é para desenvolvimento. Para uso real:

- Adicione autenticação no relay (token/JWT).
- Restrinja origem (CORS) e rate limit.
- Não exponha o LM Studio diretamente sem proxy.
- Desligue o túnel quando não estiver usando.

## Próximos passos sugeridos

- Histórico de conversa persistente.
- Streaming de tokens.
- Modo PWA para "instalar" no celular.
- Login simples por PIN.
