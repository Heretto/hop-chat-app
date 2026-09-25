import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

// Runs the visitor widget (chat page + embed loader) in jsdom against a fake API.
//   cd backend/tests/widget_js && npm ci && npm test
import { fileURLToPath } from 'node:url';

const STATIC = fileURLToPath(new URL('../../app/widget/static/', import.meta.url));
const chatJs = fs.readFileSync(STATIC + 'chat.js', 'utf8');
const embedJs = fs.readFileSync(STATIC + 'embed.js', 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const appearance = { title: 'Acme Help', subtitle: 'Docs', welcome_message: 'Hi **there**', input_placeholder: 'Ask…',
  suggested_prompts: ['How do I start?'], accent_color: '#79ecdd', position: 'right', show_sources: true };

function sse(events) {
  const enc = new TextEncoder();
  const text = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  // Split mid-event to exercise buffering across chunks.
  const mid = Math.floor(text.length / 2);
  return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(text.slice(0, mid))); c.enqueue(enc.encode(text.slice(mid))); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const calls = [];
const store = { conversations: [] };
async function fakeFetch(url, opts = {}) {
  calls.push({ url, method: opts.method || 'GET', headers: opts.headers, body: opts.body });
  const path = url.replace('/api/v1/public/chat/abc', '');
  const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
  if (path === '/config') return json({ available: true });
  if (path === '/conversations' && opts.method === 'POST') {
    const c = { id: 'c1', title: 'New conversation', message_count: 0, created_at: new Date().toISOString(), messages: [] };
    store.conversations.push(c); return json(c, 201);
  }
  if (path === '/conversations') return json(store.conversations.map(({ messages, ...c }) => c));
  if (path === '/conversations/c1/messages') {
    const content = JSON.parse(opts.body).content;
    const c = store.conversations[0]; c.title = content; c.message_count = 2;
    return sse([
      ['accepted', { id: 'm1', role: 'user', content, sources: [], created_at: new Date().toISOString() }],
      ['status', { label: 'Searching the docs' }],
      ['message', { id: 'm2', role: 'assistant', created_at: new Date().toISOString(),
        content: 'Steps:\n1. Install `cli`\n2. Run **init**\n\nSee [Start](https://docs.acme.com/start) or [bad](javascript:alert(1)).\n<img src=x onerror=alert(1)>',
        sources: [{ title: 'Getting started', path: 'start', url: 'https://docs.acme.com/start' }] }],
    ]);
  }
  if (path === '/conversations/c1') return json(store.conversations[0]);
  return json({ detail: 'nope' }, 404);
}

// ── chat page ──
const html = `<!doctype html><html><body><div id="hop-chat"></div><script type="application/json" id="hop-chat-config">${JSON.stringify({ publicId: 'abc', apiBase: '/api/v1/public/chat/abc', appearance })}</script></body></html>`;
const dom = new JSDOM(html, { url: 'http://chat.test/c/abc?embed=1&page=https%3A%2F%2Fwww.acme.com%2Fpricing', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.fetch = fakeFetch; Object.defineProperty(w, 'crypto', { value: webcrypto }); w.TextDecoder = TextDecoder; w.TextEncoder = TextEncoder;
const posted = []; w.parent.postMessage = (m) => posted.push(m);
w.eval(chatJs);
await sleep(50);

const doc = w.document;
assert.equal(doc.querySelector('.title').textContent, 'Acme Help');
assert.equal(doc.documentElement.style.getPropertyValue('--on-accent'), '#15181e', 'light accent gets dark text');
assert.ok(doc.querySelector('.msg.assistant .body strong'), 'welcome markdown rendered');
assert.ok(doc.querySelector('[aria-label="Close chat"]'), 'close button in embed mode');
assert.ok(posted.some(m => m.type === 'hop-chat:ready'));
const token = w.localStorage.getItem('hop-chat:visitor');
assert.match(token, /^[A-Za-z0-9_-]{43}$/);

doc.querySelector('.chip').click();
await sleep(100);
const post = calls.find(c => c.url.endsWith('/conversations') && c.method === 'POST');
assert.equal(JSON.parse(post.body).origin, 'https://www.acme.com/pricing');
assert.equal(post.headers['X-Visitor-Token'], token);
const bubbles = [...doc.querySelectorAll('.msg')].map(m => m.className);
assert.deepEqual(bubbles, ['msg user', 'msg assistant'], 'welcome replaced by exchange: ' + bubbles);
const answer = doc.querySelectorAll('.msg.assistant .body')[0];
assert.equal(answer.querySelectorAll('ol li').length, 2);
assert.equal(answer.querySelector('code').textContent, 'cli');
const links = [...answer.querySelectorAll('a')].map(a => a.getAttribute('href'));
assert.deepEqual(links, ['https://docs.acme.com/start'], 'javascript: link dropped');
assert.equal(answer.querySelector('img'), null, 'raw HTML is escaped');
assert.ok(answer.textContent.includes('<img src=x onerror=alert(1)>'));
assert.equal(doc.querySelector('.sources summary').textContent, '1 source');
assert.equal(w.localStorage.getItem('hop-chat:abc:conversation'), 'c1');

// history view
doc.querySelector('[aria-label="Previous conversations"]').click();
await sleep(50);
assert.equal(doc.querySelector('.conv-title').textContent, 'How do I start?');
doc.querySelector('.conv-open').click();
await sleep(50);
assert.equal(doc.querySelector('.history').hidden, true, 'back in the chat view');
doc.querySelector('[aria-label="Close chat"]').click();
assert.ok(posted.some(m => m.type === 'hop-chat:close'));
console.log('chat page: ok');

// ── reload restores the current conversation ──
const dom2 = new JSDOM(html, { url: 'http://chat.test/c/abc', runScripts: 'outside-only' });
const w2 = dom2.window;
w2.fetch = fakeFetch; Object.defineProperty(w2, 'crypto', { value: webcrypto }); w2.TextDecoder = TextDecoder;
w2.localStorage.setItem('hop-chat:visitor', token); w2.localStorage.setItem('hop-chat:abc:conversation', 'c1');
store.conversations[0].messages = [{ id: 'm1', role: 'user', content: 'q', sources: [], created_at: '' }, { id: 'm2', role: 'assistant', content: 'a', sources: [], created_at: '' }];
w2.eval(chatJs); await sleep(50);
assert.equal(w2.document.querySelectorAll('.msg').length, 2, 'transcript restored');
assert.equal(w2.document.querySelector('[aria-label="Close chat"]'), null, 'no close button standalone');
console.log('restore: ok');

// ── trace forwarding (admin Test tab) ──
{
  const traceCalls = [];
  const traceFetch = async (url, opts = {}) => {
    traceCalls.push({ url, headers: opts.headers || {} });
    const path = url.replace('/api/v1/public/chat/abc', '');
    const json = (b, st = 200) => new Response(JSON.stringify(b), { status: st, headers: { 'content-type': 'application/json' } });
    if (path === '/config') return json({ available: true });
    if (path === '/conversations' && opts.method === 'POST') return json({ id: 'c9', title: 'New', message_count: 0, created_at: '', messages: [] }, 201);
    if (path === '/conversations/c9/messages') return sse([
      ['accepted', { id: 'u', role: 'user', content: 'q', sources: [], created_at: '' }],
      ['trace', { type: 'turn.start', content: 'q', t_ms: 0 }],
      ['status', { label: 'Searching the docs' }],
      ['trace', { type: 'tool.call', tool: 'search_docs', args: { query: 'q' }, t_ms: 5 }],
      ['message', { id: 'a', role: 'assistant', content: 'ok', sources: [], created_at: '' }],
    ]);
    return json({}, 404);
  };
  const run = async (query) => {
    const d = new JSDOM(html, { url: 'http://chat.test/c/abc' + query, runScripts: 'outside-only' });
    const win = d.window;
    win.fetch = traceFetch; Object.defineProperty(win, 'crypto', { value: webcrypto }); win.TextDecoder = TextDecoder;
    const out = [];
    // Pretend to be framed: a distinct parent window whose postMessage we record.
    const fakeParent = { postMessage: (m, target) => out.push({ m, target }) };
    Object.defineProperty(win, 'parent', { value: fakeParent });
    win.eval(chatJs); await sleep(30);
    win.document.querySelector('.chip').click(); await sleep(80);
    return out;
  };

  traceCalls.length = 0;
  const withToken = await run('?embed=0&trace=signed.token');
  const sent = traceCalls.find(c => c.url.endsWith('/messages'));
  assert.equal(sent.headers['X-Hop-Trace'], 'signed.token');
  const forwarded = withToken.filter(x => x.m.type === 'hop-chat:trace');
  assert.deepEqual(forwarded.map(x => x.m.event.type), ['turn.start', 'tool.call']);
  assert.ok(forwarded.every(x => x.target === 'http://chat.test'), 'posted to our own origin only');

  traceCalls.length = 0;
  const without = await run('?embed=0');
  assert.equal(traceCalls.find(c => c.url.endsWith('/messages')).headers['X-Hop-Trace'], undefined);
  assert.equal(without.filter(x => x.m.type === 'hop-chat:trace').length, 0);
  console.log('trace forwarding: ok');
}

// ── embed loader ──
const host = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.acme.com/pricing', runScripts: 'outside-only' });
const hw = host.window;
const cfg = { publicId: 'abc', origin: 'http://chat.test', title: 'Acme Help', accentColor: '#011627', position: 'left' };
hw.eval(`(function(){var HOP_CHAT_CONFIG=${JSON.stringify(cfg)};\n${embedJs}\n})();`);
hw.eval(`(function(){var HOP_CHAT_CONFIG=${JSON.stringify(cfg)};\n${embedJs}\n})();`); // double include is a no-op
const hosts = hw.document.querySelectorAll('[data-hop-chat="abc"]');
assert.equal(hosts.length, 1);
const root = hosts[0].shadowRoot;
const launcher = root.querySelector('.launcher');
assert.equal(root.querySelector('iframe'), null, 'iframe is lazy');
assert.match(root.querySelector('style').textContent, /left:20px/);
launcher.click();
const frame = root.querySelector('iframe');
assert.ok(frame.src.startsWith('http://chat.test/c/abc?embed=1&page=https%3A%2F%2Fwww.acme.com%2Fpricing'));
assert.equal(launcher.getAttribute('aria-expanded'), 'true');
assert.ok(root.querySelector('.panel').classList.contains('open'));
hw.HopChat.close();
assert.equal(launcher.getAttribute('aria-expanded'), 'false');
hw.HopChat.apps.abc.toggle();
assert.equal(launcher.getAttribute('aria-expanded'), 'true');
// A close request from another origin is ignored; from the frame's origin it closes.
hw.dispatchEvent(new hw.MessageEvent('message', { data: { type: 'hop-chat:close' }, origin: 'https://evil.test', source: frame.contentWindow }));
assert.equal(launcher.getAttribute('aria-expanded'), 'true');
hw.dispatchEvent(new hw.MessageEvent('message', { data: { type: 'hop-chat:close' }, origin: 'http://chat.test', source: frame.contentWindow }));
assert.equal(launcher.getAttribute('aria-expanded'), 'false');
console.log('embed loader: ok');
