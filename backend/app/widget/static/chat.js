/*
 * HOP Chat — the visitor-facing chat page (/c/{publicId}).
 *
 * Runs standalone (the chat app's unique URL) or framed by the embed loader
 * (?embed=1). Plain DOM, no dependencies: it has to load fast on someone
 * else's website.
 *
 * Visitor identity is a random token kept in localStorage and sent as
 * X-Visitor-Token; the server stores only its hash and scopes every
 * conversation to it. That is what makes "previous conversations" work
 * without an account.
 */
(function () {
  'use strict';

  var cfg = JSON.parse(document.getElementById('hop-chat-config').textContent);
  var A = cfg.appearance;
  var params = new URLSearchParams(location.search);
  var embedded = params.get('embed') === '1';
  var pageUrl = (params.get('page') || (embedded ? document.referrer : location.href) || '').slice(0, 500);
  var locale = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  // Set only by the admin Test tab. With it, replies also carry trace events,
  // which are handed to the admin page (same origin only) for its agent log.
  var traceToken = params.get('trace') || '';

  function reportTrace(event) {
    if (!traceToken || parent === window) return;
    parent.postMessage({ type: 'hop-chat:trace', event: event }, location.origin);
  }

  // ── storage (may be unavailable: private windows, blocked third-party storage) ──
  var memory = {};
  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {
      if (value === null) delete memory[key];
      else memory[key] = value;
    }
  }
  function load(key) {
    try {
      var v = localStorage.getItem(key);
      if (v !== null) return v;
    } catch (e) { /* fall through */ }
    return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
  }

  function newToken() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  var TOKEN_KEY = 'hop-chat:visitor';
  var CURRENT_KEY = 'hop-chat:' + cfg.publicId + ':conversation';
  var token = load(TOKEN_KEY);
  if (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    token = newToken();
    store(TOKEN_KEY, token);
  }

  // ── API ─────────────────────────────────────────────────────────────────────
  function api(method, path, body) {
    return fetch(cfg.apiBase + path, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-Visitor-Token': token },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  /* POST a message and read the server-sent events it streams back. */
  function streamMessage(conversationId, content, handlers) {
    var headers = { 'Content-Type': 'application/json', 'X-Visitor-Token': token, Accept: 'text/event-stream' };
    if (traceToken) headers['X-Hop-Trace'] = traceToken;
    return fetch(cfg.apiBase + '/conversations/' + conversationId + '/messages', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ content: content, locale: locale }),
      credentials: 'omit',
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var finished = false;
      function dispatch(block) {
        var event = 'message';
        var data = '';
        block.split('\n').forEach(function (line) {
          if (line.indexOf('event:') === 0) event = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
        });
        if (!data) return;
        var payload;
        try { payload = JSON.parse(data); } catch (e) { return; }
        if (event === 'message' || event === 'error') finished = true;
        if (handlers[event]) handlers[event](payload);
      }
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            if (buffer.trim()) dispatch(buffer);
            if (!finished) throw new Error('stream ended early');
            return;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          var parts = buffer.split('\n\n');
          buffer = parts.pop();
          parts.forEach(dispatch);
          return pump();
        });
      }
      return pump();
    });
  }

  // ── Markdown (small, safe subset: escape first, then add known tags only) ──
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safeUrl(escapedUrl) {
    var raw = escapedUrl.replace(/&amp;/g, '&');
    return /^(https?:|mailto:)/i.test(raw) ? escapedUrl : null;
  }
  function inline(text) {
    var codes = [];
    var s = esc(text).replace(/`([^`]+)`/g, function (_, c) {
      codes.push('<code>' + c + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      var u = safeUrl(url);
      return u ? '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (m, pre, url) {
      return pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return codes[+i]; });
  }
  function markdown(src) {
    var lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {
        var code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      var h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        var level = Math.min(h[1].length + 2, 6);
        out.push('<h' + level + '>' + inline(h[2]) + '</h' + level + '>');
        i++;
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        var ordered = /^\s*\d+[.)]\s+/.test(line);
        var items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          var item = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
            item += ' ' + lines[i].trim();
            i++;
          }
          items.push('<li>' + inline(item) + '</li>');
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (/^\s*>/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push('<blockquote>' + inline(quote.join(' ')) + '</blockquote>');
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      var para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*([-*+]|\d+[.)])\s+|\s*>)/.test(lines[i])) para.push(lines[i++]);
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('');
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────────
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.indexOf('on') === 0) node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  var ICONS = {
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    send: '<path d="M5 12h13M13 6l6 6-6 6"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/>',
  };
  function icon(name) {
    var span = el('span', { class: 'icon', 'aria-hidden': 'true' });
    span.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
    return span;
  }
  function iconButton(name, label, onclick) {
    return el('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label, onclick: onclick }, [icon(name)]);
  }
  function relativeTime(iso) {
    var d = new Date(iso);
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' h ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  // ── Theme ──────────────────────────────────────────────────────────────────
  (function theme() {
    var hex = /^#[0-9a-f]{6}$/i.test(A.accent_color) ? A.accent_color : '#011627';
    var n = parseInt(hex.slice(1), 16);
    var lum = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    var L = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
    var s = document.documentElement.style;
    s.setProperty('--accent', hex);
    s.setProperty('--on-accent', L > 0.45 ? '#15181e' : '#ffffff');
    document.documentElement.classList.toggle('embedded', embedded);
  })();

  // ── State & rendering ──────────────────────────────────────────────────────
  var state = {
    available: true,
    view: 'chat', // 'chat' | 'history'
    conversation: null, // {id, title, messages}
    sending: false,
  };

  var app = document.getElementById('hop-chat');
  var headerTitle = el('div', { class: 'title', text: A.title });
  var headerSub = el('div', { class: 'subtitle', text: A.subtitle || '' });
  var backBtn = iconButton('back', 'Back to chat', function () { showChat(); });
  backBtn.hidden = true;
  var actions = el('div', { class: 'actions' }, [
    iconButton('history', 'Previous conversations', function () { showHistory(); }),
    iconButton('plus', 'New conversation', function () { newConversation(); }),
    embedded ? iconButton('close', 'Close chat', function () { parent.postMessage({ type: 'hop-chat:close' }, '*'); }) : null,
  ]);
  var header = el('header', { class: 'header' }, [backBtn, el('div', { class: 'heading' }, [headerTitle, headerSub]), actions]);

  var messagesEl = el('div', { class: 'messages', role: 'log', 'aria-label': 'Conversation' });
  var historyEl = el('div', { class: 'history' });
  historyEl.hidden = true;

  var input = el('textarea', { rows: '1', placeholder: A.input_placeholder || 'Ask a question…', 'aria-label': 'Your question', maxlength: '4000' });
  var sendBtn = el('button', { type: 'submit', class: 'send', 'aria-label': 'Send' }, [icon('send')]);
  var form = el('form', { class: 'composer' }, [input, sendBtn]);
  var notice = el('div', { class: 'notice', text: 'Answers are AI-generated from our documentation and may contain mistakes.' });
  var footer = el('footer', { class: 'footer' }, [form, notice]);

  app.appendChild(header);
  app.appendChild(messagesEl);
  app.appendChild(historyEl);
  app.appendChild(footer);

  function scrollToEnd() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function sourcesBlock(sources) {
    if (!A.show_sources || !sources || !sources.length) return null;
    var list = el('ul', {}, sources.map(function (s) {
      var item = s.url
        ? el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.title })
        : el('span', { text: s.title });
      return el('li', {}, [item]);
    }));
    return el('details', { class: 'sources' }, [el('summary', { text: sources.length === 1 ? '1 source' : sources.length + ' sources' }), list]);
  }

  function bubble(message) {
    var body = el('div', { class: 'body' });
    if (message.role === 'assistant') body.innerHTML = markdown(message.content);
    else body.textContent = message.content;
    var row = el('div', { class: 'msg ' + message.role + (message.failed ? ' failed' : '') }, [body, message.role === 'assistant' ? sourcesBlock(message.sources) : null]);
    return row;
  }

  function welcome() {
    var nodes = [];
    if (A.welcome_message) nodes.push(bubble({ role: 'assistant', content: A.welcome_message }));
    if (A.suggested_prompts && A.suggested_prompts.length) {
      nodes.push(el('div', { class: 'suggestions' }, A.suggested_prompts.map(function (p) {
        return el('button', { type: 'button', class: 'chip', text: p, onclick: function () { send(p); } });
      })));
    }
    return nodes;
  }

  function renderMessages() {
    messagesEl.textContent = '';
    if (!state.available) {
      messagesEl.appendChild(el('div', { class: 'empty', text: 'This chat is not available right now. Please check back later.' }));
      return;
    }
    var msgs = (state.conversation && state.conversation.messages) || [];
    if (!msgs.length) welcome().forEach(function (n) { messagesEl.appendChild(n); });
    msgs.forEach(function (m) { messagesEl.appendChild(bubble(m)); });
    scrollToEnd();
  }

  function setSending(on) {
    state.sending = on;
    sendBtn.disabled = on || !state.available;
    input.disabled = !state.available;
    form.classList.toggle('busy', on);
  }

  function typingIndicator() {
    var label = el('span', { class: 'status-label', text: 'Thinking' });
    var node = el('div', { class: 'msg assistant typing' }, [
      el('div', { class: 'body' }, [el('span', { class: 'dots', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]), label]),
    ]);
    return { node: node, label: label };
  }

  function showChat() {
    state.view = 'chat';
    historyEl.hidden = true;
    messagesEl.hidden = false;
    footer.hidden = false;
    backBtn.hidden = true;
    actions.hidden = false;
    headerTitle.textContent = A.title;
    headerSub.textContent = A.subtitle || '';
    renderMessages();
    focusInput();
  }

  function showHistory() {
    state.view = 'history';
    messagesEl.hidden = true;
    footer.hidden = true;
    historyEl.hidden = false;
    backBtn.hidden = false;
    actions.hidden = true;
    headerTitle.textContent = 'Previous conversations';
    headerSub.textContent = '';
    historyEl.textContent = '';
    historyEl.appendChild(el('div', { class: 'empty', text: 'Loading…' }));
    api('GET', '/conversations').then(function (items) {
      historyEl.textContent = '';
      historyEl.appendChild(el('button', { type: 'button', class: 'new-conv', onclick: function () { newConversation(); } }, [icon('plus'), el('span', { text: 'New conversation' })]));
      if (!items.length) {
        historyEl.appendChild(el('div', { class: 'empty', text: 'No previous conversations yet.' }));
        return;
      }
      var list = el('ul', { class: 'conv-list' });
      items.forEach(function (c) {
        var current = state.conversation && state.conversation.id === c.id;
        var openBtn = el('button', { type: 'button', class: 'conv-open', onclick: function () { openConversation(c.id); } }, [
          el('span', { class: 'conv-title', text: c.title }),
          el('span', { class: 'conv-meta', text: relativeTime(c.updated_at || c.created_at) + ' · ' + c.message_count + ' messages' + (current ? ' · current' : '') }),
        ]);
        var del = iconButton('trash', 'Delete conversation', function () {
          if (del.dataset.confirm !== '1') {
            del.dataset.confirm = '1';
            del.classList.add('confirm');
            del.setAttribute('aria-label', 'Click again to delete');
            del.title = 'Click again to delete';
            return;
          }
          api('DELETE', '/conversations/' + c.id).then(function () {
            if (current) {
              state.conversation = null;
              store(CURRENT_KEY, null);
            }
            showHistory();
          });
        });
        list.appendChild(el('li', {}, [openBtn, del]));
      });
      historyEl.appendChild(list);
    }).catch(function () {
      historyEl.textContent = '';
      historyEl.appendChild(el('div', { class: 'empty', text: 'Could not load previous conversations.' }));
    });
  }

  function openConversation(id) {
    return api('GET', '/conversations/' + id).then(function (c) {
      if (!state.conversation || state.conversation.id !== c.id) {
        reportTrace({ type: 'conversation.open', title: c.title, messages: c.message_count });
      }
      state.conversation = c;
      store(CURRENT_KEY, c.id);
      showChat();
    }).catch(function (err) {
      if (err.status === 404) {
        store(CURRENT_KEY, null);
        state.conversation = null;
      }
      showChat();
    });
  }

  function newConversation() {
    if (state.conversation) reportTrace({ type: 'conversation.new' });
    state.conversation = null;
    store(CURRENT_KEY, null);
    showChat();
  }

  function ensureConversation() {
    if (state.conversation) return Promise.resolve(state.conversation);
    return api('POST', '/conversations', { origin: pageUrl || null, locale: locale || null }).then(function (c) {
      state.conversation = c;
      store(CURRENT_KEY, c.id);
      return c;
    });
  }

  function send(text) {
    var content = (text || '').trim();
    if (!content || state.sending || !state.available) return;
    input.value = '';
    autosize();
    setSending(true);

    var optimistic = { role: 'user', content: content };
    var typing = typingIndicator();
    var suggestions = messagesEl.querySelector('.suggestions');
    if (suggestions) suggestions.remove();
    messagesEl.appendChild(bubble(optimistic));
    messagesEl.appendChild(typing.node);
    scrollToEnd();

    ensureConversation().then(function (conversation) {
      return streamMessage(conversation.id, content, {
        accepted: function (m) { conversation.messages.push(m); },
        status: function (s) { typing.label.textContent = s.label; },
        trace: reportTrace,
        message: function (m) { conversation.messages.push(m); },
        error: function (m) {
          if (m.id) conversation.messages.push(Object.assign({ failed: true }, m));
          else conversation.messages.push({ role: 'assistant', content: m.content || 'Sorry — something went wrong.', failed: true });
        },
      });
    }).then(function () {
      setSending(false);
      renderMessages();
      focusInput();
    }).catch(function (err) {
      setSending(false);
      typing.node.remove();
      reportTrace({ type: 'run.error', message: 'The reply stream failed in the browser: ' + (err && err.message || err) });
      var msg = err && err.status === 429
        ? 'You are sending messages too quickly. Please wait a moment and try again.'
        : 'Could not reach the chat service. Check your connection and try again.';
      var retry = el('button', { type: 'button', class: 'retry', text: 'Retry', onclick: function () { row.remove(); userRow.remove(); send(content); } });
      var userRow = messagesEl.lastElementChild;
      var row = el('div', { class: 'msg assistant failed' }, [el('div', { class: 'body' }, [el('p', { text: msg }), retry])]);
      messagesEl.appendChild(row);
      scrollToEnd();
      // The message may have been stored even though the stream failed; resync.
      if (state.conversation) {
        var id = state.conversation.id;
        api('GET', '/conversations/' + id).then(function (c) {
          var stored = c.messages.some(function (m) { return m.role === 'user' && m.content === content; });
          if (stored) { state.conversation = c; }
        }).catch(function () {});
      }
    });
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  function focusInput() {
    if (state.view === 'chat' && !input.disabled && (!embedded || document.hasFocus())) {
      try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    send(input.value);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  input.addEventListener('input', autosize);

  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    if (e.data && e.data.type === 'hop-chat:opened') setTimeout(function () { input.focus(); }, 50);
  });
  window.addEventListener('keydown', function (e) {
    if (embedded && e.key === 'Escape') parent.postMessage({ type: 'hop-chat:close' }, '*');
  });

  // ── Boot ────────────────────────────────────────────────────────────────────
  setSending(false);
  renderMessages();
  api('GET', '/config').then(function (c) {
    state.available = c.available;
    setSending(false);
    var current = load(CURRENT_KEY);
    if (current && c.available) return openConversation(current);
    renderMessages();
  }).catch(function () {
    state.available = false;
    setSending(false);
    renderMessages();
  }).then(function () {
    if (embedded) parent.postMessage({ type: 'hop-chat:ready' }, '*');
  });
})();
