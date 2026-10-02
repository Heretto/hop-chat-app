// The search-answers panel (answer.js) and its portal loader (search-embed.js), in jsdom against a fake API.
//   cd backend/tests/widget_js && npm ci && npm test
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STATIC = fileURLToPath(new URL('../../app/widget/static/', import.meta.url));
const answerJs = fs.readFileSync(STATIC + 'common.js', 'utf8') + '\n' + fs.readFileSync(STATIC + 'answer.js', 'utf8');
const loaderJs = fs.readFileSync(STATIC + 'search-embed.js', 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const appearance = { title: 'Acme Help', subtitle: '', welcome_message: '', input_placeholder: '', suggested_prompts: [],
  accent_color: '#011627', position: 'right', show_sources: true };
const cfg = { publicId: 'abc', apiBase: '/api/v1/public/chat/abc', appearance, search: { heading: 'AI answer' } };
const html = `<!doctype html><html><body><div id="hop-answer"></div><script type="application/json" id="hop-chat-config">${JSON.stringify(cfg)}</script></body></html>`;

function sse(events) {
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
const msg = (role, content, extra = {}) => ({ id: Math.random().toString(36).slice(2), role, content, sources: [], options: [], created_at: '', ...extra });

/** Load the panel with a scripted /search reply. Returns the window, the requests, and what it told the host. */
async function panel(query, searchReply, { session, extraFetch } = {}) {
  const calls = [];
  const dom = new JSDOM(html, { url: `http://chat.test/a/abc?embed=1&q=${encodeURIComponent(query)}&page=${encodeURIComponent('https://docs.acme.com/search?q=x')}`, runScripts: 'outside-only' });
  const w = dom.window;
  if (session) for (const [k, v] of Object.entries(session)) w.sessionStorage.setItem(k, v);
  w.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body), headers: opts.headers || {} });
    const path = url.replace('/api/v1/public/chat/abc', '');
    if (path === '/search') return sse(searchReply);
    if (extraFetch) { const r = await extraFetch(path, opts); if (r) return r; }
    return json({ detail: 'nope' }, 404);
  };
  Object.defineProperty(w, 'crypto', { value: webcrypto });
  w.TextDecoder = TextDecoder;
  const host = [];
  Object.defineProperty(w, 'parent', { value: { postMessage: (m) => host.push(m) } });
  w.eval(answerJs);
  await sleep(60);
  return { w, doc: w.document, calls, host };
}
const lastVisible = host => [...host].reverse().find(m => m.type === 'hop-answer:visible');

// ── keyword search: never shows, cached for the session ──
{
  const { doc, calls, host, w } = await panel('api tokens', [['skip', { reason: 'keywords' }]]);
  assert.equal(doc.getElementById('hop-answer').hidden, true);
  assert.equal(lastVisible(host).visible, false);
  assert.equal(calls[0].body.query, 'api tokens');
  assert.equal(calls[0].body.origin, 'https://docs.acme.com/search?q=x');
  assert.equal(w.sessionStorage.getItem('hop-answer:abc:api tokens'), '{"skip":true}');
  assert.equal(host[0].type, 'hop-answer:ready');
  console.log('skip: ok');
}

// ── an answer, then a follow-up chat ──
{
  const followUp = async (path, opts) => {
    if (path === '/conversations/c1/messages') {
      return sse([['accepted', msg('user', JSON.parse(opts.body).content)], ['status', { label: 'Searching the docs' }],
                  ['message', msg('assistant', 'Also check **SSO**.')]]);
    }
  };
  const { doc, calls, host, w } = await panel('How do I reset my password?', [
    ['started', { conversation_id: 'c1', query: 'How do I reset my password?' }],
    ['status', { label: 'Searching the docs for “reset password”' }],
    ['message', msg('assistant', 'Open **Settings** and choose *Reset*.\n<img src=x onerror=alert(1)>', {
      kind: 'answer', conversation_id: 'c1', sources: [{ title: 'Passwords', path: 'p', url: 'https://docs.acme.com/p' }] })],
  ], { extraFetch: followUp });
  assert.equal(lastVisible(host).visible, true);
  const msgs = [...doc.querySelectorAll('.msg')];
  assert.equal(msgs.length, 1, 'the search itself is not repeated as a bubble');
  assert.ok(msgs[0].querySelector('strong'));
  assert.equal(msgs[0].querySelector('img'), null, 'raw HTML is escaped');
  const source = doc.querySelector('a.source');
  assert.equal(source.getAttribute('href'), 'https://docs.acme.com/p');
  assert.equal(source.getAttribute('target'), '_top', 'sources open in the portal itself');
  assert.equal(doc.querySelector('.heading').textContent, 'AI answer');
  assert.equal(doc.querySelector('form.composer').hidden, false);
  assert.equal(doc.querySelector('textarea').placeholder, 'Ask a follow-up…');
  assert.equal(doc.querySelector('.full-chat').hidden, false);
  assert.equal(w.localStorage.getItem('hop-chat:abc:conversation'), 'c1', '"Open in chat" lands on this conversation');
  assert.deepEqual(JSON.parse(w.sessionStorage.getItem('hop-answer:abc:how do i reset my password?')), { conversationId: 'c1', kind: 'answer' });
  assert.ok(host.some(m => m.type === 'hop-answer:size'));

  const ta = doc.querySelector('textarea');
  ta.value = 'And for SSO users?';
  doc.querySelector('form.composer').dispatchEvent(new w.Event('submit', { cancelable: true }));
  await sleep(60);
  const post = calls.find(c => c.url.endsWith('/conversations/c1/messages'));
  assert.equal(post.body.content, 'And for SSO users?');
  assert.deepEqual([...doc.querySelectorAll('.msg')].map(m => m.className), ['msg assistant', 'msg user', 'msg assistant']);
  console.log('answer + follow-up: ok');
}

// ── unsure: a follow-up question with one-click options ──
{
  const pick = async (path, opts) => {
    if (path === '/conversations/c2/messages') return sse([['accepted', msg('user', 'A PDF')], ['message', msg('assistant', 'Run the PDF scenario.')]]);
  };
  const { doc, calls } = await panel('how do I publish', [
    ['started', { conversation_id: 'c2', query: 'how do I publish' }],
    ['message', msg('assistant', 'What are you publishing to?', { kind: 'clarify', options: ['The portal', 'A PDF'], conversation_id: 'c2' })],
  ], { extraFetch: pick });
  assert.equal(doc.querySelector('textarea').placeholder, 'Your answer…');
  const chips = [...doc.querySelectorAll('.chip')];
  assert.deepEqual(chips.map(c => c.textContent), ['The portal', 'A PDF']);
  chips[1].click();
  await sleep(60);
  assert.equal(calls.find(c => c.url.endsWith('/conversations/c2/messages')).body.content, 'A PDF');
  assert.equal(doc.querySelectorAll('.chip').length, 0, 'options disappear once answered');
  console.log('clarify: ok');
}

// ── reload of the same search reuses the conversation instead of asking again ──
{
  const stored = { id: 'c3', title: 'q', message_count: 2, created_at: '', messages: [msg('user', 'how do I start?'), msg('assistant', 'Install it.')] };
  const { doc, calls } = await panel('how do I start?', [['skip', {}]], {
    session: { 'hop-answer:abc:how do i start?': JSON.stringify({ conversationId: 'c3', kind: 'answer' }) },
    extraFetch: async (path) => (path === '/conversations/c3' ? json(stored) : null),
  });
  assert.ok(!calls.some(c => c.url.endsWith('/search')), 'no new search');
  assert.equal(doc.querySelector('.msg.assistant .body').textContent, 'Install it.');
  console.log('session cache: ok');
}

// ── errors step aside quietly ──
{
  const { doc, host } = await panel('how do I start?', [['started', { conversation_id: 'c4' }], ['error', { content: 'nope' }]]);
  assert.equal(lastVisible(host).visible, false);
  assert.equal(doc.getElementById('hop-answer').hidden, true);
  console.log('error: ok');
}

// ── the portal loader ──
{
  const portal = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
    url: 'https://docs.acme.com/search?q=how%20do%20I%20start', runScripts: 'outside-only' });
  const pw = portal.window;
  const lcfg = { publicId: 'abc', origin: 'http://chat.test', title: 'AI answer', params: ['query', 'q'],
                 mountSelector: '[data-hop-answer]', mountPosition: 'prepend' };
  const wrap = `(function(){var HOP_SEARCH_CONFIG=${JSON.stringify(lcfg)};\n${loaderJs}\n})();`;
  pw.eval(wrap);
  pw.eval(wrap); // a second include is a no-op
  await sleep(50);
  assert.equal(pw.document.querySelector('[data-hop-answers]'), null, 'waits for the mount point');

  // The SPA renders its results later.
  const results = pw.document.createElement('div');
  results.setAttribute('data-hop-answer', '');
  results.innerHTML = '<ol class="results"><li>Result</li></ol>';
  pw.document.getElementById('app').appendChild(results);
  await sleep(500);
  const hostEl = pw.document.querySelectorAll('[data-hop-answers="abc"]');
  assert.equal(hostEl.length, 1);
  assert.equal(results.firstElementChild, hostEl[0], 'prepended inside the mount point');
  const frame = hostEl[0].querySelector('iframe');
  assert.ok(frame.src.startsWith('http://chat.test/a/abc?embed=1&q=how%20do%20I%20start&page='), frame.src);
  assert.equal(hostEl[0].style.display, 'none', 'hidden until the panel has something to show');

  // Messages: from the frame's origin they apply; from anywhere else they are ignored.
  const send = (data, origin) => pw.dispatchEvent(new pw.MessageEvent('message', { data, origin, source: frame.contentWindow }));
  send({ type: 'hop-answer:visible', visible: true }, 'https://evil.test');
  assert.equal(hostEl[0].style.display, 'none');
  send({ type: 'hop-answer:ready' }, 'http://chat.test');
  send({ type: 'hop-answer:visible', visible: true }, 'http://chat.test');
  send({ type: 'hop-answer:size', height: 312 }, 'http://chat.test');
  assert.equal(hostEl[0].style.display, 'block');
  assert.equal(frame.style.height, '312px');

  // A new search in the SPA: the ready frame is told, not reloaded.
  const told = [];
  frame.contentWindow.postMessage = (m, target) => told.push({ m, target });
  const srcBefore = frame.src;
  pw.history.pushState({}, '', '/search?query=api%20tokens');
  await sleep(500);
  assert.equal(frame.src, srcBefore);
  // JSON round-trip: objects from the jsdom realm have a different prototype.
  assert.deepEqual(JSON.parse(JSON.stringify(told.at(-1))), { m: { type: 'hop-answer:query', query: 'api tokens' }, target: 'http://chat.test' });

  // Hash-routed portals.
  pw.history.pushState({}, '', '/#/search?q=what%20is%20a%20map');
  await sleep(500);
  assert.equal(told.at(-1).m.query, 'what is a map');

  // The JS API takes over from the URL, and can hand back.
  pw.HopAnswers.search('how do I publish?');
  assert.equal(told.at(-1).m.query, 'how do I publish?');
  await sleep(500);
  assert.equal(told.at(-1).m.query, 'how do I publish?', 'URL polling does not override a manual search');
  pw.HopAnswers.clear();
  assert.equal(told.at(-1).m.query, '');
  pw.HopAnswers.auto();
  assert.equal(told.at(-1).m.query, 'what is a map');
  console.log('loader: ok');
  pw.close();
}
process.exit(0); // the loader's poll timer would otherwise keep node alive
