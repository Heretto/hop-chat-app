/*
 * HOP Chat — search answers panel (/a/{publicId}).
 *
 * Framed by the search-answers loader inside a docs portal's search results.
 * For each search it asks the server whether the search is a question; the
 * server answers it, asks a follow-up question, or says to stay hidden. The
 * visitor can reply right here, which continues as an ordinary chat — more
 * searching and reading — in the same conversation.
 *
 * Talks to the host page only through postMessage:
 *   out: hop-answer:ready, hop-answer:visible {visible}, hop-answer:size {height}
 *   in:  hop-answer:query {query}
 */
(function () {
  'use strict';

  var cfg = JSON.parse(document.getElementById('hop-chat-config').textContent);
  var A = cfg.appearance;
  var S = cfg.search;
  var params = new URLSearchParams(location.search);
  var embedded = params.get('embed') === '1';
  var pageUrl = (params.get('page') || (embedded ? document.referrer : '') || '').slice(0, 500);
  var locale = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  // The admin tester passes cache=0 so trying a search twice really runs it twice.
  var useCache = params.get('cache') !== '0';

  var C = window.HopChatCommon.create(cfg, {
    embedded: embedded,
    locale: locale,
    traceToken: params.get('trace') || '',
  });
  var el = C.el, icon = C.icon, markdown = C.markdown;
  C.applyTheme(A.accent_color);

  // ── Host page messaging ─────────────────────────────────────────────────────
  function toHost(message) {
    if (parent !== window) parent.postMessage(message, '*'); // carries no visitor data
  }
  var visible = false;
  function setVisible(on) {
    visible = on;
    root.hidden = !on;
    toHost({ type: 'hop-answer:visible', visible: on });
    reportSize();
  }
  function reportSize() {
    toHost({ type: 'hop-answer:size', height: visible ? Math.ceil(root.getBoundingClientRect().height) + 2 : 0 });
  }

  // ── Per-session cache: a reload or "back" to the same search reuses the result ──
  function cacheKey(query) {
    return 'hop-answer:' + cfg.publicId + ':' + query.toLowerCase().replace(/\s+/g, ' ').trim();
  }
  function cacheGet(query) {
    if (!useCache) return null;
    try { return JSON.parse(sessionStorage.getItem(cacheKey(query)) || 'null'); } catch (e) { return null; }
  }
  function cacheSet(query, value) {
    if (!useCache) return;
    try { sessionStorage.setItem(cacheKey(query), JSON.stringify(value)); } catch (e) { /* no storage */ }
  }

  // ── DOM ────────────────────────────────────────────────────────────────────
  var root = document.getElementById('hop-answer');
  root.hidden = true;

  var spark = el('span', { class: 'spark', 'aria-hidden': 'true' });
  spark.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2l1.8 5.6L19.5 9l-5.7 1.6L12 16l-1.8-5.4L4.5 9l5.7-1.4L12 2zm6.5 11l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9.9-2.6z"/></svg>';
  var headingEl = el('span', { class: 'heading', text: S.heading || 'AI answer' });
  var fullChat = el('a', { class: 'full-chat', href: '/c/' + encodeURIComponent(cfg.publicId), target: '_blank', rel: 'noopener', text: 'Open in chat' });
  fullChat.hidden = true;
  var dismiss = C.iconButton('close', 'Hide this answer', function () { setVisible(false); });
  var header = el('div', { class: 'panel-header' }, [spark, headingEl, el('span', { class: 'spacer' }), fullChat, dismiss]);

  var thread = el('div', { class: 'thread', role: 'log', 'aria-live': 'polite' });
  var input = el('textarea', { rows: '1', 'aria-label': 'Reply', maxlength: '4000' });
  var sendBtn = el('button', { type: 'submit', class: 'send', 'aria-label': 'Send' }, [icon('send')]);
  var form = el('form', { class: 'composer' }, [input, sendBtn]);
  form.hidden = true;
  var notice = el('div', { class: 'notice', text: 'AI-generated from the documentation — it may contain mistakes.' });

  root.appendChild(header);
  root.appendChild(thread);
  root.appendChild(form);
  root.appendChild(notice);

  if (window.ResizeObserver) new ResizeObserver(reportSize).observe(root);

  // ── State ──────────────────────────────────────────────────────────────────
  var state = { query: '', conversation: null, run: 0, sending: false };

  function sourcesBlock(sources) {
    if (!A.show_sources || !sources || !sources.length) return null;
    return el('div', { class: 'sources' }, [el('span', { class: 'sources-label', text: 'Sources' })].concat(
      sources.map(function (s) {
        return s.url
          ? el('a', { class: 'source', href: s.url, target: '_top', text: s.title })
          : el('span', { class: 'source', text: s.title });
      })
    ));
  }

  function optionChips(message, isLast) {
    if (!isLast || !message.options || !message.options.length) return null;
    return el('div', { class: 'options' }, message.options.map(function (o) {
      return el('button', { type: 'button', class: 'chip', text: o, onclick: function () { send(o); } });
    }));
  }

  function render(working) {
    thread.textContent = '';
    var msgs = (state.conversation && state.conversation.messages) || [];
    // The first visitor message is the search itself, already on screen in the portal.
    var shown = msgs.slice(1);
    shown.forEach(function (m, i) {
      var body = el('div', { class: 'body' });
      if (m.role === 'assistant') body.innerHTML = markdown(m.content);
      else body.textContent = m.content;
      thread.appendChild(el('div', { class: 'msg ' + m.role + (m.failed ? ' failed' : '') }, [
        body,
        m.role === 'assistant' ? sourcesBlock(m.sources) : null,
        m.role === 'assistant' ? optionChips(m, i === shown.length - 1 && !working) : null,
      ]));
    });
    if (working) thread.appendChild(working.node);

    var clarifying = state.kind === 'clarify' && shown.length === 1;
    input.placeholder = clarifying ? 'Your answer…' : 'Ask a follow-up…';
    form.hidden = !state.conversation || !!working;
    fullChat.hidden = !state.conversation;
    thread.scrollTop = thread.scrollHeight;
    reportSize();
  }

  function workingIndicator(text) {
    var label = el('span', { class: 'status-label', text: text });
    var node = el('div', { class: 'msg assistant working' }, [
      el('div', { class: 'body' }, [el('span', { class: 'dots', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]), label]),
    ]);
    return { node: node, label: label };
  }

  function rememberForChat(conversationId) {
    // "Open in chat" lands on this conversation: the chat page reads the same key.
    C.store('hop-chat:' + cfg.publicId + ':conversation', conversationId);
  }

  // ── Running a search ────────────────────────────────────────────────────────
  function search(query) {
    query = (query || '').replace(/\s+/g, ' ').trim();
    var run = ++state.run;
    state.query = query;
    state.conversation = null;
    state.kind = null;
    if (!query) { setVisible(false); return; }

    var cached = cacheGet(query);
    if (cached && cached.skip) { setVisible(false); return; }
    if (cached && cached.conversationId) {
      C.api('GET', '/conversations/' + cached.conversationId).then(function (c) {
        if (run !== state.run) return;
        state.conversation = c;
        state.kind = cached.kind;
        rememberForChat(c.id);
        setVisible(true);
        render();
      }).catch(function () { if (run === state.run) fresh(query, run); });
      return;
    }
    fresh(query, run);
  }

  function fresh(query, run) {
    var working = workingIndicator('Looking for an answer');
    C.postStream('/search', { query: query, locale: locale, origin: pageUrl || null }, {
      started: function (s) {
        if (run !== state.run) return;
        state.conversation = { id: s.conversation_id, messages: [{ role: 'user', content: query }] };
        setVisible(true);
        render(working);
      },
      status: function (s) { working.label.textContent = s.label; },
      trace: C.reportTrace,
      message: function (m) {
        if (run !== state.run) return;
        state.kind = m.kind;
        state.conversation.messages.push(m);
        cacheSet(query, { conversationId: m.conversation_id, kind: m.kind });
        rememberForChat(m.conversation_id);
        render();
      },
      skip: function (s) {
        if (run !== state.run) return;
        // Keyword searches and non-questions stay skipped; "unavailable" may be fixed any minute.
        if (s.reason !== 'unavailable') cacheSet(query, { skip: true });
        setVisible(false);
      },
      // A search page is no place for an error message: step aside quietly.
      error: function () { if (run === state.run) setVisible(false); },
    }).catch(function () { if (run === state.run) setVisible(false); });
  }

  // ── Continuing the conversation ─────────────────────────────────────────────
  function send(text) {
    var content = (text || '').trim();
    var conversation = state.conversation;
    if (!content || state.sending || !conversation) return;
    input.value = '';
    autosize();
    state.sending = true;
    var run = state.run;
    var working = workingIndicator('Thinking');
    conversation.messages.push({ role: 'user', content: content });
    render(working);

    C.streamMessage(conversation.id, content, {
      accepted: function (m) { conversation.messages[conversation.messages.length - 1] = m; },
      status: function (s) { working.label.textContent = s.label; },
      trace: C.reportTrace,
      message: function (m) { conversation.messages.push(m); },
      error: function (m) {
        conversation.messages.push({ role: 'assistant', content: m.content || 'Sorry — something went wrong.', failed: true, sources: [] });
      },
    }).catch(function (err) {
      conversation.messages.push({
        role: 'assistant', failed: true, sources: [],
        content: err && err.status === 429
          ? 'You are sending messages too quickly. Please wait a moment and try again.'
          : 'Could not reach the chat service. Please try again.',
      });
    }).then(function () {
      state.sending = false;
      if (run === state.run) render();
      input.focus();
    });
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
  });
  input.addEventListener('input', autosize);

  window.addEventListener('message', function (e) {
    if (e.source !== parent || !e.data || e.data.type !== 'hop-answer:query') return;
    if (typeof e.data.query === 'string' && e.data.query !== state.query) search(e.data.query);
  });

  toHost({ type: 'hop-answer:ready' });
  search(params.get('q') || '');
})();
