#!/usr/bin/env node
// SillyTavern <-> Claude Code cloud bridge.
//
// Exposes an OpenAI-compatible API (/v1/models, /v1/chat/completions) and
// answers each request by running `claude -p --cloud`, which executes the
// turn in a Claude Code cloud session (billed to your cloud-session usage /
// credits rather than local Claude Code usage).
//
// No dependencies: Node 18+ only.

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const config = {
  host: process.env.BRIDGE_HOST || '127.0.0.1',
  port: parseInt(process.env.BRIDGE_PORT || '5055', 10),
  apiKey: process.env.BRIDGE_API_KEY || '',
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  extraArgs: splitArgs(process.env.CLAUDE_EXTRA_ARGS || ''),
  timeoutMs: parseInt(process.env.BRIDGE_TIMEOUT_MS || String(15 * 60 * 1000), 10),
  maxConcurrent: Math.max(1, parseInt(process.env.BRIDGE_MAX_CONCURRENT || '1', 10)),
  sessionName: process.env.BRIDGE_SESSION_NAME || 'SillyTavern',
  // Cloud sessions can sync the folder they are started from, so start them
  // from an empty folder by default instead of wherever the bridge runs.
  workdir: process.env.BRIDGE_WORKDIR || path.join(os.tmpdir(), 'st-cloud-bridge'),
  modelId: process.env.BRIDGE_MODEL_ID || 'claude-cloud',
  debug: process.env.BRIDGE_DEBUG === '1',
};

function splitArgs(s) {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^["']|["']$/g, ''));
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function debug(...args) {
  if (config.debug) log('[debug]', ...args);
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

const ROLE_LABELS = { system: 'SYSTEM', user: 'USER', assistant: 'ASSISTANT' };

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part && part.type === 'text' ? part.text : ''))
      .join('');
  }
  return content == null ? '' : String(content);
}

// The cloud session runs Claude Code's own agent, so the whole SillyTavern
// request is packed into one task with instructions to answer as a plain
// chat-completion backend.
function buildPrompt(messages, opts) {
  const system = [];
  const turns = [];
  for (const m of messages) {
    const text = contentToText(m.content);
    if (!text.trim()) continue;
    if (m.role === 'system' && turns.length === 0) {
      system.push(text);
    } else {
      const label = ROLE_LABELS[m.role] || String(m.role).toUpperCase();
      const name = m.name ? ` (${m.name})` : '';
      turns.push(`<${label}${name}>\n${text}\n</${label}>`);
    }
  }

  // A trailing assistant message is a prefill: the reply must continue it.
  let prefill = '';
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') {
    prefill = contentToText(last.content);
    turns.pop();
  }

  const parts = [
    'You are being used as the text-generation backend for SillyTavern, a chat and',
    'roleplay front end. This is not a coding task.',
    '- Do not use any tools, do not read or write files, do not run commands, do not commit or push.',
    '- Follow the instructions in <INSTRUCTIONS> as your system prompt.',
    '- Read the conversation in <CONVERSATION> and write ONLY the next ASSISTANT message.',
    '- Output the message text itself: no tags, no preamble, no commentary, no code fences around it.',
  ];
  if (opts.maxTokens) parts.push(`- Keep the reply under roughly ${opts.maxTokens} tokens.`);
  if (opts.stop && opts.stop.length) {
    parts.push(`- Stop before writing any of these sequences: ${opts.stop.map((s) => JSON.stringify(s)).join(', ')}.`);
  }
  if (prefill) {
    parts.push('- Your reply must CONTINUE the text in <PREFILL>. Output only the continuation, without repeating it.');
  }
  parts.push('', '<INSTRUCTIONS>', system.join('\n\n') || '(none)', '</INSTRUCTIONS>');
  parts.push('', '<CONVERSATION>', turns.join('\n\n'), '</CONVERSATION>');
  if (prefill) parts.push('', '<PREFILL>', prefill, '</PREFILL>');
  return { prompt: parts.join('\n'), prefill };
}

function cleanReply(text, stop) {
  let out = String(text || '').trim();
  const fence = out.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) out = fence[1].trim();
  out = out.replace(/^<ASSISTANT[^>]*>\s*/i, '').replace(/\s*<\/ASSISTANT>$/i, '');
  for (const s of stop || []) {
    if (!s) continue;
    const i = out.indexOf(s);
    if (i !== -1) out = out.slice(0, i);
  }
  return out.trimEnd();
}

// ---------------------------------------------------------------------------
// Running `claude -p --cloud`
// ---------------------------------------------------------------------------

let running = 0;
const waiting = [];

function acquire() {
  if (running < config.maxConcurrent) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

function parseCliOutput(stdout) {
  const trimmed = stdout.trim();
  // --output-format json prints one result object; tolerate stray lines.
  const candidates = [trimmed, ...trimmed.split('\n').reverse()];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === 'object') {
        if (obj.is_error || (obj.subtype && obj.subtype !== 'success')) {
          throw new Error(obj.result || obj.error || `cloud session ended with ${obj.subtype}`);
        }
        if (typeof obj.result === 'string') return { text: obj.result, sessionId: obj.session_id };
      }
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  return { text: trimmed, sessionId: null };
}

function runCloudTurn(prompt, signal) {
  fs.mkdirSync(config.workdir, { recursive: true });
  const args = ['-p', '--output-format', 'json', '-n', config.sessionName, ...config.extraArgs, '--cloud'];
  debug('spawn', config.claudeBin, args.join(' '));

  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, args, {
      cwd: config.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      err ? reject(err) : resolve(value);
    };
    const kill = () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error(`cloud session did not answer within ${Math.round(config.timeoutMs / 1000)}s`));
    }, config.timeoutMs);
    const onAbort = () => {
      kill();
      finish(new Error('request cancelled by client'));
    };
    if (signal) signal.addEventListener('abort', onAbort);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      debug('claude stderr:', String(d).trim());
    });
    child.on('error', (e) =>
      finish(new Error(`could not start "${config.claudeBin}": ${e.message}. Set CLAUDE_BIN to the claude CLI path.`)),
    );
    child.on('close', (code) => {
      if (code !== 0) {
        const detail = (stderr.trim() || stdout.trim()).split('\n').slice(-5).join('\n');
        return finish(new Error(`claude exited with code ${code}: ${detail}`));
      }
      try {
        finish(null, parseCliOutput(stdout));
      } catch (e) {
        finish(e);
      }
    });

    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...cors() });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message, type: 'bridge_error' } });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!config.apiKey) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${config.apiKey}` || req.headers['x-api-key'] === config.apiKey;
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) return sendError(res, 400, '"messages" must be a non-empty array');

  const stop = body.stop == null ? [] : [].concat(body.stop);
  const { prompt } = buildPrompt(messages, { maxTokens: body.max_tokens, stop });
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || config.modelId;
  const stream = Boolean(body.stream);

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let keepAlive = null;
  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...cors(),
    });
    // Cloud turns take a while; SSE comments keep proxies and ST from timing out.
    keepAlive = setInterval(() => res.write(': waiting for cloud session\n\n'), 15000);
  }

  const started = Date.now();
  log(`request ${id}: ${messages.length} messages, ${prompt.length} chars${stream ? ', streaming' : ''}`);

  await acquire();
  let result;
  try {
    if (controller.signal.aborted) throw new Error('request cancelled by client');
    result = await runCloudTurn(prompt, controller.signal);
  } catch (e) {
    log(`request ${id} failed: ${e.message}`);
    if (keepAlive) clearInterval(keepAlive);
    if (stream) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'bridge_error' } })}\n\n`);
        res.end();
      }
      return;
    }
    return sendError(res, 502, e.message);
  } finally {
    release();
  }

  const text = cleanReply(result.text, stop);
  log(`request ${id} done in ${((Date.now() - started) / 1000).toFixed(1)}s` +
    (result.sessionId ? ` (session ${result.sessionId})` : ''));
  debug('reply:', text);

  if (stream) {
    clearInterval(keepAlive);
    const chunk = (delta, finish) => ({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: text }, null))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  sendJson(res, 200, {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0].replace(/\/+$/, '');
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors());
      return res.end();
    }
    if (req.method === 'GET' && (url === '' || url === '/health')) {
      return sendJson(res, 200, { ok: true, running, queued: waiting.length });
    }
    if (!authorized(req)) return sendError(res, 401, 'invalid API key');
    if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
      return sendJson(res, 200, {
        object: 'list',
        data: [{ id: config.modelId, object: 'model', created: 0, owned_by: 'claude-cloud-bridge' }],
      });
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
      return await handleChat(req, res);
    }
    sendError(res, 404, `no route for ${req.method} ${url || '/'}`);
  } catch (e) {
    log('error:', e.message);
    if (!res.headersSent) sendError(res, 400, e.message);
    else res.end();
  }
});

if (require.main === module) {
  server.listen(config.port, config.host, () => {
    log(`Claude cloud bridge listening on http://${config.host}:${config.port}/v1`);
    log(`claude binary: ${config.claudeBin}  |  session workdir: ${config.workdir}`);
  });
}

module.exports = { buildPrompt, cleanReply, parseCliOutput, server, config };
