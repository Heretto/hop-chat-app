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

  var C = window.HopChatCommon.create(cfg, {
    embedded: embedded,
    locale: locale,
    // Set only by the admin Test tab: replies then carry trace events for its agent log.
    traceToken: params.get('trace') || '',
  });
  var token = C.token, store = C.store, load = C.load, api = C.api, streamMessage = C.streamMessage;
  var reportTrace = C.reportTrace, markdown = C.markdown, el = C.el, icon = C.icon, iconButton = C.iconButton;
  var relativeTime = C.relativeTime;
  var CURRENT_KEY = 'hop-chat:' + cfg.publicId + ':conversation';
  C.applyTheme(A.accent_color);

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
