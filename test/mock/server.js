#!/usr/bin/env node
/*
 * mock OpenAI-compatible server for offline testing of nightmare
 * usage: node test/mock/server.js [port]   (default 9999)
 * behavior: first turn emits a bash tool call (echo hello-from-nightmare),
 * second turn (seeing the OUTPUT: message) answers in plain text.
 */
'use strict';
const http = require('http');
const port = process.argv[2] ? +process.argv[2] : 9999;
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    return res.end(JSON.stringify({ data: [{ id: 'mock-coder' }, { id: 'mock-tiny' }] }));
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(body); } catch { }
      const msgs = j.messages || [];
      const hasOut = msgs.some(m => m.role === 'user' && String(m.content).startsWith('OUTPUT:'));
      const content = hasOut
        ? 'Task complete. The command printed `hello-from-nightmare` as expected.'
        : 'I will verify the endpoint with a quick command.\n```bash\necho hello-from-nightmare\n```';
      if (j.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const mid = Math.ceil(content.length / 2);
        const chunks = [content.slice(0, mid), content.slice(mid)];
        let i = 0;
        (function next() {
          if (i >= chunks.length) { res.write('data: [DONE]\n\n'); return res.end(); }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] }) + '\n\n');
          setTimeout(next, 25);
        })();
      } else {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, () => console.log('mock openai server on http://127.0.0.1:' + port + '/v1  (models: mock-coder, mock-tiny)'));
