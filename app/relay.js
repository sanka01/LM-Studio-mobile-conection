const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const LM_STUDIO_BASE_URL = process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234';
const LM_MODEL = process.env.LM_MODEL || '';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'Você é um assistente útil e objetivo.';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 512);
const TEMPERATURE = Number(process.env.TEMPERATURE || 0.7);

const indexPath = path.join(__dirname, 'web', 'index.html');

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
}

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function parseJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function fetchModelsFromLmStudio() {
  const response = await fetch(`${LM_STUDIO_BASE_URL}/v1/models`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  });

  const payload = await response.json();
  if (!response.ok) {
    const error = new Error('Falha ao buscar modelos do LM Studio.');
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  const models = Array.isArray(payload?.data)
    ? payload.data
        .map((m) => m?.id)
        .filter((id) => typeof id === 'string' && id.trim().length > 0)
    : [];

  return {
    models,
    raw: payload
  };
}

async function streamChatFromLmStudio(res, selectedModel, userMessage) {
  const upstreamResponse = await fetch(`${LM_STUDIO_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: selectedModel,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ],
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      stream: true
    })
  });

  if (!upstreamResponse.ok) {
    const details = await upstreamResponse.text();
    writeSseEvent(res, 'error', {
      error: 'Erro do LM Studio.',
      details,
      status: upstreamResponse.status
    });
    return res.end();
  }

  if (!upstreamResponse.body) {
    writeSseEvent(res, 'error', { error: 'Resposta sem stream no servidor upstream.' });
    return res.end();
  }

  const decoder = new TextDecoder('utf8');
  let buffer = '';
  let answer = '';

  for await (const chunk of upstreamResponse.body) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('data:')) continue;

      const payloadText = line.slice(5).trim();
      if (payloadText === '[DONE]') {
        writeSseEvent(res, 'done', { answer });
        return res.end();
      }

      try {
        const parsed = JSON.parse(payloadText);
        const delta =
          parsed?.choices?.[0]?.delta?.content ||
          parsed?.choices?.[0]?.text ||
          '';

        if (delta) {
          answer += delta;
          writeSseEvent(res, 'token', { token: delta, answer });
        }
      } catch {
        // ignora chunks de heartbeat/parciais inválidos
      }
    }
  }

  if (buffer.trim()) {
    try {
      const line = buffer.trim();
      if (line.startsWith('data:')) {
        const payloadText = line.slice(5).trim();
        if (payloadText !== '[DONE]') {
          const parsed = JSON.parse(payloadText);
          const delta = parsed?.choices?.[0]?.delta?.content || '';
          if (delta) {
            answer += delta;
            writeSseEvent(res, 'token', { token: delta, answer });
          }
        }
      }
    } catch {
      // ignora payload final inválido
    }
  }

  writeSseEvent(res, 'done', { answer });
  return res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/') {
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (error) {
      return sendJson(res, 500, { error: 'Falha ao carregar página web.', details: error.message });
    }
  }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { status: 'ok', lmStudio: LM_STUDIO_BASE_URL, modelConfigured: Boolean(LM_MODEL) });
  }

  if (req.method === 'GET' && req.url === '/api/models') {
    try {
      const modelData = await fetchModelsFromLmStudio();
      return sendJson(res, 200, {
        models: modelData.models,
        defaultModel: LM_MODEL || null
      });
    } catch (error) {
      return sendJson(res, error.status || 500, {
        error: 'Não foi possível listar modelos do LM Studio.',
        details: error.payload || error.message
      });
    }
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const body = await parseJsonBody(req);
      const selectedModel = String(body.model || LM_MODEL || '').trim();

      if (!selectedModel) {
        return sendJson(res, 400, { error: 'Defina LM_MODEL antes de iniciar o servidor.' });
      }

      const userMessage = String(body.message || '').trim();

      if (!userMessage) {
        return sendJson(res, 400, { error: 'Mensagem vazia.' });
      }

      const upstreamResponse = await fetch(`${LM_STUDIO_BASE_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage }
          ],
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          stream: false
        })
      });

      const payload = await upstreamResponse.json();

      if (!upstreamResponse.ok) {
        return sendJson(res, upstreamResponse.status, {
          error: 'Erro do LM Studio.',
          details: payload
        });
      }

      const answer = payload?.choices?.[0]?.message?.content || '';
      return sendJson(res, 200, { answer, raw: payload });
    } catch (error) {
      return sendJson(res, 500, { error: 'Falha ao processar requisição.', details: error.message });
    }
  }

  if (req.method === 'POST' && req.url === '/api/chat/stream') {
    try {
      const body = await parseJsonBody(req);
      const selectedModel = String(body.model || LM_MODEL || '').trim();
      const userMessage = String(body.message || '').trim();

      if (!selectedModel) {
        sendSseHeaders(res);
        writeSseEvent(res, 'error', { error: 'Defina LM_MODEL antes de iniciar o servidor.' });
        return res.end();
      }

      if (!userMessage) {
        sendSseHeaders(res);
        writeSseEvent(res, 'error', { error: 'Mensagem vazia.' });
        return res.end();
      }

      sendSseHeaders(res);
      writeSseEvent(res, 'started', { model: selectedModel });
      return streamChatFromLmStudio(res, selectedModel, userMessage);
    } catch (error) {
      sendSseHeaders(res);
      writeSseEvent(res, 'error', { error: 'Falha ao processar streaming.', details: error.message });
      return res.end();
    }
  }

  return sendJson(res, 404, { error: 'Rota não encontrada.' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Relay rodando em http://0.0.0.0:${PORT}`);
  console.log(`LM Studio base URL: ${LM_STUDIO_BASE_URL}`);
  console.log(`LM model padrão: ${LM_MODEL || '(não definido)'}`);
});
