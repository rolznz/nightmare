#!/usr/bin/env node
/*
 * nightmare — a minimal agentic harness for local / sovereign AI.
 * One bash tool, a tiny system prompt, files as memory, zero dependencies.
 * Node >= 18 (uses global fetch). No npm install required.
 *
 * usage:
 *   node nightmare.js setup [baseUrl]     onboarding
 *   node nightmare.js chat                interactive REPL
 *   node nightmare.js run "<prompt>"      one-shot
 *   node nightmare.js task add "<prompt>"  queue a subagent task
 *   node nightmare.js task list
 *   node nightmare.js task run <id>
 *   node nightmare.js daemon              24/7 bridge + web UI
 *   node nightmare.js models
 *   node nightmare.js status
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');

const VERSION = '0.1.0';
const STATE = path.join(process.cwd(), '.nightmare');
const CFG = path.join(STATE, 'config.json');
const SESSIONS = path.join(STATE, 'sessions');
const TASKS = path.join(STATE, 'tasks');
const LOGS = path.join(STATE, 'logs');
const UI_PATH = path.join(__dirname, 'ui', 'index.html');

/* ------------------------------------------------------------------ *
 * System prompt — kept tiny on purpose. All other policy lives in     *
 * checklists/ (read just-in-time via bash) and .nightmare/ files.     *
 * ------------------------------------------------------------------ */
const SYSTEM = [
  "You are a focused agent on the user's own machine, powered by a local model. One tool: bash.",
  'To run a command, reply with a single fenced block:',
  '```bash',
  'command',
  '```',
  'Then stop. The next message starts with "OUTPUT:" and ends with the exit code.',
  'Chain as many command turns as needed. When done, give the final answer in plain text with no bash block.',
  'Be terse. Limit output (head -50, grep -m 20, tail). Never cat files over ~200 lines.',
  'Before coding/debugging work, read the matching checklist first: ls checklists/ && cat checklists/coding.md',
].join('\n');

/* ------------------------------ util ------------------------------ */
function ensureDirs() {
  for (const d of [STATE, SESSIONS, TASKS, LOGS]) fs.mkdirSync(d, { recursive: true });
}
function die(msg) {
  console.error('error: ' + msg);
  process.exit(1);
}
function loadConfig() {
  if (!fs.existsSync(CFG)) die('no config yet — run: node nightmare.js setup');
  return JSON.parse(fs.readFileSync(CFG, 'utf8'));
}
function loadConfigSafe() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return {}; }
}
function saveConfig(cfg) { ensureDirs(); fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2)); }
function log(kind, data) {
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.appendFileSync(path.join(LOGS, 'agent.log'), JSON.stringify({ t: new Date().toISOString(), kind, ...data }) + '\n');
  } catch {}
}
function truncate(s, n) {
  if (s.length <= n) return s;
  const head = Math.floor(n * 0.7), tail = Math.floor(n * 0.3);
  return s.slice(0, head) + '\n…[truncated ' + (s.length - n) + ' chars]…\n' + s.slice(-tail);
}
function splitFlags(args) {
  const pos = [], flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(0, eq).slice(2)] = a.slice(eq + 1);
      else flags[a.slice(2)] = (i + 1 < args.length && !args[i + 1].startsWith('--')) ? args[++i] : 'true';
    } else pos.push(a);
  }
  return { pos, flags };
}

/* -------------------------- LLM client ----------------------------- */
function normalizeUrl(u) {
  u = u.trim().replace(/\/+$/, '');
  if (!/\/v\d+$/i.test(u)) u += '/v1';
  return u;
}
async function apiFetch(cfg, p, { body, timeoutMs } = {}) {
  const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: 'Bearer ' + cfg.apiKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs || cfg.timeoutMs || 300000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + cfg.baseUrl + p + ': ' + (await res.text().catch(() => '')).slice(0, 300));
  return res;
}
async function listModels(cfg) {
  const res = await apiFetch(cfg, '/models', { timeoutMs: 8000 });
  const j = await res.json();
  return (j.data || []).map(m => m.id || m.name).sort();
}
/* Streaming chat completion with JSON-response fallback. */
async function chat(cfg, messages, { onDelta, timeoutMs } = {}) {
  const res = await apiFetch(cfg, '/chat/completions', {
    body: {
      model: cfg.model,
      messages,
      temperature: cfg.temperature ?? 0.2,
      stream: true,
      ...(cfg.maxTokens ? { max_tokens: cfg.maxTokens } : {}),
    },
    timeoutMs,
  });
  const ct = (res.headers.get('content-type') || '');
  if (ct.includes('application/json')) {
    const j = await res.json();
    return (j.choices?.[0]?.message?.content ?? '');
  }
  let full = '', buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const d = JSON.parse(data).choices?.[0]?.delta?.content;
        if (d) { full += d; onDelta && onDelta(d); }
      } catch {}
    }
  }
  return full;
}

/* ------------------------- the one tool --------------------------- */
const BASH_RE = /```(?:bash|sh|shell)[ \t]*\r?\n([\s\S]*?)```/g;
function extractBash(text) {
  const out = [];
  let m;
  BASH_RE.lastIndex = 0;
  while ((m = BASH_RE.exec(text))) out.push(m[1].trim());
  return out;
}
function runCommand(cmd, { timeoutMs = 300000 } = {}) {
  return new Promise(resolve => {
    const p = spawn('sh', ['-c', cmd], { cwd: process.cwd(), env: process.env });
    let out = '', capped = false, timedOut = false;
    const to = setTimeout(() => { timedOut = true; try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', d => { if (out.length < 200000) out += d; else capped = true; });
    p.stderr.on('data', d => { if (out.length < 200000) out += d; else capped = true; });
    p.on('close', code => { clearTimeout(to); resolve({ code: code ?? 124, out: capped ? out + '\n…[output capped at 200KB]' : out, timedOut }); });
    p.on('error', e => { clearTimeout(to); resolve({ code: -1, out: out + '\n(spawn error: ' + e.message + ')', timedOut: false }); });
  });
}

/* --------------------------- sessions ----------------------------- */
function newSession(name) {
  const id = name || 's-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return { id, createdAt: new Date().toISOString(), messages: [] };
}
function saveSession(s) {
  ensureDirs();
  fs.writeFileSync(path.join(SESSIONS, s.id + '.json'), JSON.stringify(s, null, 1));
}
function loadSession(id) {
  const p = path.join(SESSIONS, id + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
/* resume = most recently touched chat session (run/task sessions are ephemeral) */
function latestSession() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS).filter(f => f.endsWith('.json') && !/^run-/.test(f) && !/^task-/.test(f));
  } catch { return null; }
  if (!files.length) return null;
  const ranked = files.map(f => ({ f, m: fs.statSync(path.join(SESSIONS, f)).mtimeMs })).sort((a, b) => b.m - a.m);
  return loadSession(ranked[0].f.slice(0, -5));
}
function sessionChars(s) { return s.messages.reduce((n, m) => n + String(m.content).length, 0); }
async function compactSession(cfg, s, emit) {
  emit?.({ type: 'info', text: 'compacting session…' });
  const convo = s.messages.map(m => m.role.toUpperCase() + ': ' + String(m.content)).join('\n\n').slice(0, 30000);
  const brief = await chat(cfg, [
    { role: 'system', content: 'Compress the agent conversation below into a factual brief: goal, actions taken, current state, open items, important file paths. Max 120 words. No preamble.' },
    { role: 'user', content: convo },
  ], { timeoutMs: 120000 });
  const keep = s.messages.slice(-4);
  s.messages = [
    { role: 'user', content: 'CONTEXT BRIEF (compacted earlier):\n' + brief },
    { role: 'assistant', content: '(brief acknowledged — continuing.)' },
    ...keep,
  ];
  saveSession(s);
  emit?.({ type: 'info', text: 'compacted to a ' + brief.length + ' char brief' });
}

/* ---------------------------- the loop ---------------------------- */
async function runLoop(cfg, session, userText, emit) {
  log('turn_start', { id: session.id, text: userText.slice(0, 200) });
  session.messages.push({ role: 'user', content: userText });
  saveSession(session);
  let final = '', lastAssistant = '', emptyStreak = 0;
  const recent = [];
  for (let i = 1; i <= (cfg.maxIterations || 30); i++) {
    emit?.({ type: 'turn', i });
    const chars = sessionChars(session);
    if (chars > (cfg.contextWarnChars || 60000) && i > 1 && !session._compacted) {
      try { await compactSession(cfg, session, emit); session._compacted = true; }
      catch (e) { emit?.({ type: 'info', text: 'compact failed: ' + e.message }); }
    }
    let text = '';
    try {
      text = await chat(cfg, [{ role: 'system', content: SYSTEM }, ...session.messages], {
        onDelta: d => emit?.({ type: 'delta', text: d }),
      });
    } catch (e) {
      log('model_error', { id: session.id, err: String(e.message || e) });
      emit?.({ type: 'error', text: 'model error: ' + (e.message || e) });
      return { ok: false, error: String(e.message || e), iterations: i };
    }
    if (!text.trim()) {
      emptyStreak++;
      if (emptyStreak > 2) { emit?.({ type: 'error', text: 'model returned no output 3× — stopping.' }); return { ok: false, error: 'empty responses', iterations: i }; }
      session.messages.push({ role: 'user', content: '(no output received. If you need to run a command, emit a bash block now; otherwise give the final answer in plain text.)' });
      saveSession(session);
      continue;
    }
    emptyStreak = 0;
    lastAssistant = text;
    session.messages.push({ role: 'assistant', content: text });
    saveSession(session);
    const blocks = extractBash(text);
    if (!blocks.length) { final = text; break; }
    for (const cmd of blocks) {
      recent.push(cmd); if (recent.length > 3) recent.shift();
      if (recent.length === 3 && recent[0] === recent[1] && recent[1] === recent[2]) {
        log('loop_stop', { id: session.id, cmd });
        emit?.({ type: 'error', text: 'same command repeated 3× — stopping to break the loop.' });
        return { ok: false, error: 'loop detected', iterations: i };
      }
      emit?.({ type: 'tool_start', cmd });
      const t0 = Date.now();
      const r = await runCommand(cmd, { timeoutMs: cfg.cmdTimeoutMs || 300000 });
      const out = truncate(r.out.replace(/\n+$/, ''), cfg.outputLimit || 8000);
      session.messages.push({ role: 'user', content: 'OUTPUT:\n' + (out || '(no output)') + '\nEXIT:' + r.code + (r.timedOut ? ' (TIMED OUT)' : '') });
      saveSession(session);
      log('tool', { id: session.id, cmd, ms: Date.now() - t0, code: r.code });
      emit?.({ type: 'tool_end', cmd, code: r.code, ms: Date.now() - t0, out: out.slice(0, 2000) });
    }
  }
  final = final || lastAssistant;
  log('turn_done', { id: session.id });
  return { ok: true, final, iterations: session.messages.filter(m => m.role === 'user').length };
}

/* ------------------------- console renderer ----------------------- */
function cliEmit(e) {
  switch (e.type) {
    case 'delta': process.stdout.write(e.text); break;
    case 'turn': if (e.i > 1) process.stdout.write('\n'); break;
    case 'tool_start': process.stdout.write('\n$ ' + e.cmd + '\n'); break;
    case 'tool_end':
      process.stdout.write(truncate(e.out || '(no output)', 2000).replace(/\n/g, '\n  '));
      process.stdout.write('\n[exit ' + e.code + (e.ms ? ', ' + e.ms + 'ms' : '') + (e.code === 0 ? '' : ' ⚠') + ']\n');
      break;
    case 'error': console.error('\nerror: ' + e.text); break;
    case 'info': console.error('\n· ' + e.text); break;
  }
}

/* ----------------------------- setup ------------------------------ */
const KNOWN_ENDPOINTS = [
  ['Ollama', 'http://127.0.0.1:11434/v1'],
  ['LM Studio', 'http://127.0.0.1:1234/v1'],
  ['llama.cpp', 'http://127.0.0.1:8080/v1'],
  ['vLLM', 'http://127.0.0.1:8000/v1'],
];
async function probeEndpoint(url) {
  try {
    const j = await (await fetch(url, { signal: AbortSignal.timeout(1500) })).json();
    const ids = (j.data || []).map(m => m.id || m.name);
    return ids.length ? ids : null;
  } catch { return null; }
}
async function cliSetup(args) {
  ensureDirs();
  const { pos, flags } = splitFlags(args);
  const interactive = process.stdin.isTTY === true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => {
    if (rl.closed) die('no interactive terminal available — pass the value as an argument');
    return new Promise(r => rl.question(q, r));
  };
  try {
    let url = pos[0];
    if (!url && interactive) url = (await ask('OpenAI-compatible base URL  (Enter = auto-detect common local servers): ')).trim();
    if (!url) {
      const found = [];
      for (const [name, u] of KNOWN_ENDPOINTS) {
        const ids = await probeEndpoint(u);
        if (ids) { found.push({ name, url: u, ids }); console.log('found: ' + name + ' at ' + u + ' (' + ids.length + ' models)'); }
      }
      if (found.length === 1) url = found[0].url;
      else if (found.length > 1) {
        found.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f.name + ' ' + f.url));
        const pick = (await ask('which one? [1-' + found.length + ']: ')).trim();
        url = found[+pick - 1]?.url;
      }
      if (!url) die('no endpoint found or given — start your model server (e.g. Ollama) and re-run, or pass the URL as an argument');
    }
    url = normalizeUrl(url);
    const key = flags.key || (flags.model ? 'local' : ((interactive ? await ask('API key [local]: ') : 'local').trim() || 'local'));
    let models = [], cfg = { baseUrl: url, apiKey: key };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { models = await listModels(cfg); break; }
      catch (e) {
        console.error('cannot reach ' + url + ' → ' + e.message);
        if (attempt < 3 && interactive) { url = normalizeUrl((await ask('try another base URL: ')).trim()); cfg = { baseUrl: url, apiKey: key }; }
      }
    }
    if (!models.length) die('no models listed by ' + url);
    let model = flags.model;
    if (model && !models.includes(model)) { console.error('note: model "' + model + '" not in the list, using it anyway'); }
    if (!model) {
      console.log('models:');
      models.forEach((m, i) => console.log('  ' + (i + 1) + '. ' + m));
      const pick = (await ask('pick a model [1-' + models.length + '] (or type an exact id): ')).trim();
      model = /^\d+$/.test(pick) ? models[+pick - 1] : pick;
      if (!models.includes(model)) console.error('note: "' + model + '" not in the list, using it anyway');
    }
    const t0 = Date.now();
    try {
      const r = await chat({ baseUrl: url, apiKey: key, model, temperature: 0, timeoutMs: 90000 }, [{ role: 'user', content: 'Reply with exactly: OK' }], {});
      console.log('ping ok in ' + (Date.now() - t0) + 'ms → ' + r.slice(0, 100));
    } catch (e) { console.warn('ping failed: ' + e.message + ' (continuing anyway)'); }
    saveConfig({ ...loadConfigSafe(), baseUrl: url, apiKey: key, model });
    console.log('\nsaved .nightmare/config.json  (model: ' + model + ' @ ' + url + ')');
    console.log('get started:   node nightmare.js chat');
    console.log('24/7 + web UI: node nightmare.js daemon   →  http://127.0.0.1:8686');
  } finally { rl.close(); }
}

/* ----------------------------- chat -------------------------------- */
async function cliChat() {
  const cfg = loadConfig();
  let sess = latestSession() || newSession();
  const isTTY = process.stdin.isTTY;
  console.log('nightmare v' + VERSION + ' · model ' + cfg.model + ' @ ' + cfg.baseUrl);
  console.log('session ' + sess.id + ' (' + sess.messages.length + ' messages) · /help for commands');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let sigints = 0;
  const queue = [];
  let draining = false, closed = false;
  const printPrompt = () => { if (isTTY) process.stdout.write('you> '); };

  async function handle(line) {
    const cmd = line.trim();
    if (!cmd) return;
    if (cmd === '/exit' || cmd === '/quit') { console.log('bye.'); process.exit(0); }
    if (cmd === '/new') { sess = newSession(); console.log('new session ' + sess.id); return; }
    if (cmd === '/help') { console.log('/new /status /model <id> /compact /tasks /exit'); return; }
    if (cmd === '/status') {
      console.log('model ' + cfg.model + ' · session ' + sess.id + ' · ' + sess.messages.length + ' msgs · ~' + Math.round(sessionChars(sess) / 4) + ' tokens');
      return;
    }
    if (cmd.startsWith('/model ')) {
      cfg.model = cmd.slice(7).trim(); saveConfig(cfg); console.log('model → ' + cfg.model); return;
    }
    if (cmd === '/compact') {
      try { await compactSession(cfg, sess, e => { if (e.type === 'info') console.log('· ' + e.text); }); }
      catch (e) { console.error('compact failed: ' + e.message); }
      return;
    }
    if (cmd === '/tasks') {
      let files = [];
      try { files = fs.readdirSync(TASKS).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(TASKS, f), 'utf8'))); } catch {}
      if (!files.length) console.log('no tasks');
      files.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).forEach(t => console.log('  ' + t.id + '  [' + t.status + ']  ' + t.title));
      return;
    }
    if (cmd.startsWith('/')) { console.log('unknown command (try /help)'); return; }
    try { await runLoop(cfg, sess, cmd, cliEmit); process.stdout.write('\n'); }
    catch (e) { console.error('\nerror: ' + e.message); }
  }

  async function pump() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      await handle(queue.shift());
      if (!closed) printPrompt();
    }
    draining = false;
    if (closed) process.exit(0);
  }

  rl.on('SIGINT', () => {
    if (process.stdout.isTTY) process.stdout.write('\n');
    if (sigints === 0) { console.log('(ctrl-c again to quit)'); sigints = 1; setTimeout(() => sigints = 0, 2000); }
    else process.exit(0);
  });
  rl.on('line', line => { queue.push(line); pump(); });
  rl.on('close', () => { closed = true; pump(); });
  printPrompt();
}

/* ------------------------------ run -------------------------------- */
async function cliRun(args) {
  const { pos, flags } = splitFlags(args);
  const promptText = pos.join(' ');
  if (!promptText) die('usage: node nightmare.js run "<prompt>" [--json] [--session <name>]');
  const cfg = loadConfig();
  const sess = flags.session ? (loadSession(flags.session) || newSession(flags.session)) : newSession('run-' + Date.now().toString(36));
  const emit = flags.json ? () => {} : cliEmit;
  const r = await runLoop(cfg, sess, promptText, emit);
  if (flags.json) console.log(JSON.stringify({ ok: r.ok, final: r.final || r.error, iterations: r.iterations }, null, 2));
  else if (!r.ok) console.error('\nstopped: ' + r.error);
  else process.stdout.write('\n');
  process.exitCode = r.ok ? 0 : 1;
}

/* ----------------------------- tasks ------------------------------- */
function readTasks() {
  let files = [];
  try { files = fs.readdirSync(TASKS).filter(f => f.endsWith('.json')); } catch {}
  return files.map(f => { try { return JSON.parse(fs.readFileSync(path.join(TASKS, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}
async function cliTask(args) {
  const [sub, ...rest] = args;
  const { pos, flags } = splitFlags(rest);
  if (sub === 'list' || !sub) {
    const tasks = readTasks().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!tasks.length) { console.log('no tasks yet — add one: node nightmare.js task add "<prompt>"'); return; }
    for (const t of tasks) console.log(t.id + '  [' + t.status + ']  ' + t.title + (t.result ? '\n      ↳ ' + t.result.slice(0, 120) : ''));
    return;
  }
  if (sub === 'add') {
    ensureDirs();
    const promptText = pos.join(' ');
    if (!promptText) die('usage: node nightmare.js task add "<prompt>" [--title <t>]');
    const t = { id: 't-' + Date.now().toString(36), title: flags.title || promptText.slice(0, 60), prompt: promptText, status: 'queued', createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(TASKS, t.id + '.json'), JSON.stringify(t, null, 2));
    log('task_add', { id: t.id, title: t.title });
    console.log('queued ' + t.id + '  (' + t.title + ')');
    console.log('run it: node nightmare.js task run ' + t.id);
    return;
  }
  if (sub === 'run') {
    const id = rest.find(a => !a.startsWith('--'));
    const p = path.join(TASKS, id + '.json');
    if (!id || !fs.existsSync(p)) die('task not found: ' + id + '  (see: node nightmare.js task list)');
    const t = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (t.status === 'running') die('task is already running');
    const cfg = loadConfig();
    t.status = 'running'; t.startedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
    const sess = newSession('task-' + t.id);
    const r = await runLoop(cfg, sess, t.prompt, cliEmit);
    t.status = r.ok ? 'done' : 'failed';
    t.result = String(r.final || r.error || '').slice(0, 2000);
    t.finishedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(t, null, 2));
    log('task_done', { id: t.id, status: t.status });
    process.stdout.write('\n— ' + t.id + ' ' + t.status + ' —\n');
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  die('unknown task command: ' + sub + '  (add | list | run)');
}

/* --------------------------- models/status ------------------------ */
async function cliModels() {
  const cfg = loadConfig();
  try {
    const models = await listModels(cfg);
    if (!models.length) console.log('no models listed');
    for (const m of models) console.log(m + (m === cfg.model ? '   ← active' : ''));
  } catch (e) { console.error('cannot reach ' + cfg.baseUrl + ': ' + e.message); process.exitCode = 1; }
}
function cliStatus() {
  const cfg = loadConfigSafe();
  console.log('nightmare v' + VERSION);
  console.log('config:  ' + (cfg.model ? cfg.model + ' @ ' + cfg.baseUrl : '(not set — run: node nightmare.js setup)'));
  const s = latestSession();
  console.log('session: ' + (s ? s.id + ' · ' + s.messages.length + ' msgs · ~' + Math.round(sessionChars(s) / 4) + ' tokens' : 'none yet'));
  const tasks = readTasks();
  const c = st => tasks.filter(t => t.status === st).length;
  console.log('tasks:   queued ' + c('queued') + ' · running ' + c('running') + ' · done ' + c('done') + ' · failed ' + c('failed'));
  console.log('state:   ' + STATE);
}

/* ----------------------------- daemon ------------------------------ */
function startBridge(cfg, { host, port }) {
  host = host || cfg.host || '127.0.0.1';
  port = port || cfg.port || 8686;
  const live = { busy: false, queue: [], clients: new Set(), session: null, startedAt: Date.now() };
  const broadcast = e => { for (const res of live.clients) { try { res.write('data: ' + JSON.stringify(e) + '\n\n'); } catch {} } };
  const json = (res, obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const readJson = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } }); });
  const taskCounts = () => {
    const t = readTasks();
    const c = st => t.filter(x => x.status === st).length;
    return { queued: c('queued'), running: c('running'), done: c('done'), failed: c('failed') };
  };
  async function pump() {
    if (live.busy) return;
    const item = live.queue.shift();
    if (!item) return;
    live.busy = true;
    broadcast({ type: 'state', busy: true });
    try {
      if (!live.session) {
        live.session = latestSession() || newSession();
        broadcast({ type: 'info', text: 'session ' + live.session.id });
      }
      await runLoop(cfg, live.session, item.text, e => { log('ui_' + e.type, e); broadcast(e); });
    } catch (e) { broadcast({ type: 'error', text: String(e.message || e) }); }
    live.busy = false;
    broadcast({ type: 'state', busy: false, queued: live.queue.length });
    if (live.queue.length) pump();
  }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    try {
      if (cfg.token) {
        const given = (req.headers.authorization || '').replace(/^Bearer /i, '') || u.searchParams.get('token') || '';
        if (given !== cfg.token && p !== '/health') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'unauthorized' })); }
      }
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(UI_PATH));
      }
      if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && p === '/health') {
        return json(res, {
          version: VERSION, model: cfg.model, baseUrl: cfg.baseUrl, busy: live.busy, queued: live.queue.length,
          uptimeSec: Math.floor((Date.now() - live.startedAt) / 1000),
          session: live.session ? { id: live.session.id, messages: live.session.messages.length } : null,
          tasks: taskCounts(),
        });
      }
      if (req.method === 'GET' && p === '/session') {
        return json(res, { id: live.session?.id || null, messages: live.session ? live.session.messages.slice(-60) : [] });
      }
      if (req.method === 'GET' && p === '/tasks') {
        const tasks = readTasks().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return json(res, tasks);
      }
      if (req.method === 'GET' && p === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
        res.write('retry: 5000\n\n');
        res.write('data: ' + JSON.stringify({ type: 'hello', model: cfg.model, session: live.session?.id || null, busy: live.busy }) + '\n\n');
        live.clients.add(res);
        req.on('close', () => live.clients.delete(res));
        return;
      }
      if (req.method === 'POST' && p === '/chat') {
        const body = await readJson(req);
        if (!body.text) return json(res, { error: 'text required' }, 400);
        live.queue.push({ text: body.text });
        broadcast({ type: 'queued', count: live.queue.length });
        setImmediate(pump);
        return json(res, { ok: true, queued: live.queue.length });
      }
      if (req.method === 'POST' && p === '/new') {
        live.session = null;
        broadcast({ type: 'info', text: 'new session' });
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && p === '/compact') {
        if (!live.session) return json(res, { error: 'no active session' }, 409);
        if (live.busy) return json(res, { error: 'busy' }, 409);
        await compactSession(cfg, live.session, broadcast);
        return json(res, { ok: true });
      }
      if (req.method === 'POST' && p === '/tasks') {
        const body = await readJson(req);
        if (!body.prompt) return json(res, { error: 'prompt required' }, 400);
        const t = { id: 't-' + Date.now().toString(36), title: body.title || String(body.prompt).slice(0, 60), prompt: body.prompt, status: 'queued', createdAt: new Date().toISOString() };
        ensureDirs();
        fs.writeFileSync(path.join(TASKS, t.id + '.json'), JSON.stringify(t, null, 2));
        log('task_add', { id: t.id, title: t.title });
        broadcast({ type: 'task', id: t.id, title: t.title });
        return json(res, { ok: true, id: t.id }, 201);
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
      log('http_error', { p, err: String(e.message || e) });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
  const hb = setInterval(() => { for (const res of live.clients) { try { res.write(': ping\n\n'); } catch {} } }, 25000);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve({
      server, live, close: () => { clearInterval(hb); for (const r of live.clients) { try { r.end(); } catch {} } server.close(); },
    }));
  });
}
async function cliDaemon(args) {
  const { flags } = splitFlags(args);
  const cfg = loadConfig();
  let bridge;
  try {
    bridge = await startBridge(cfg, { host: flags.host, port: flags.port ? +flags.port : undefined });
  } catch (e) { die('bridge: ' + e.message); }
  const host = flags.host || cfg.host || '127.0.0.1';
  const port = flags.port ? +flags.port : (cfg.port || 8686);
  console.log('nightmare daemon v' + VERSION + ' · building in the dark');
  console.log('model:   ' + cfg.model + ' @ ' + cfg.baseUrl);
  console.log('web UI:  http://' + host + ':' + port + '   (open it from any machine)');
  if (cfg.token) console.log('token:   required → append ?token=… to the URL');
  if (host === '127.0.0.1') console.log('in a VM?  ssh -N -L ' + port + ':127.0.0.1:' + port + ' user@vm   then open http://127.0.0.1:' + port);
  console.log('ctrl-c stops the daemon; queued chat messages are processed one at a time.');
  const stop = () => { console.log('\nstopping…'); bridge.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/* ------------------------------ main ------------------------------- */
function usage() {
  console.log(`nightmare — minimal agentic harness for local / sovereign AI (v${VERSION})

commands:
  setup [url] [--model <id>] [--key <k>]   onboarding: endpoint → pick a model
  chat                                    interactive chat (resumes last session)
  run "<prompt>" [--json] [--session <n>] one-shot agent run (ephemeral session)
  task add "<prompt>" [--title <t>]       queue a subagent task
  task list                               list tasks
  task run <id>                           run a task now (fresh context, prints summary)
  daemon [--port N] [--host H]            24/7 bridge + web UI (default 127.0.0.1:8686)
  models                                  list models on the configured endpoint
  status                                  config, session, tasks

state: ./.nightmare/ (config, sessions, tasks, logs) · docs: docs/`);
}
function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  switch (cmd) {
    case 'setup': return cliSetup(args.slice(1));
    case 'chat': return cliChat();
    case 'run': return cliRun(args.slice(1));
    case 'task': return cliTask(args.slice(1));
    case 'daemon': return cliDaemon(args.slice(1));
    case 'models': return cliModels();
    case 'status': return cliStatus();
    case 'version': return console.log(VERSION);
    case 'help': case undefined: case '--help': case '-h': return usage();
    default: die('unknown command: ' + cmd + '  (try: node nightmare.js help)');
  }
}
main();
