/*
 * HOP Chat — shared plumbing for the visitor pages: the chat page (chat.js)
 * and the search-answers panel (answer.js). Loaded before either.
 *
 * HopChatCommon.create(cfg, opts) returns the visitor token, API and
 * server-sent-event helpers, the safe Markdown renderer, DOM/icon helpers and
 * the theme, bound to one chat app. Plain DOM, no dependencies.
 *
 * opts: { embedded, locale, traceToken }
 */
(function () {
  'use strict';

  window.HopChatCommon = {
    create: function (cfg, opts) {
      opts = opts || {};
      var embedded = !!opts.embedded;
      var locale = opts.locale || '';
      // Set only by the admin Test tab. With it, replies also carry trace events,
      // which are handed to the admin page (same origin only) for its agent log.
      var traceToken = opts.traceToken || '';

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
      return postStream('/conversations/' + conversationId + '/messages', { content: content, locale: locale }, handlers);
    }

    /* POST and read the server-sent events streamed back. Resolves when a final
       event (message / error / skip) has arrived; rejects if the stream ends first. */
    function postStream(path, body, handlers) {
      var headers = { 'Content-Type': 'application/json', 'X-Visitor-Token': token, Accept: 'text/event-stream' };
      if (traceToken) headers['X-Hop-Trace'] = traceToken;
      return fetch(cfg.apiBase + path, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
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
          if (event === 'message' || event === 'error' || event === 'skip') finished = true;
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
    function applyTheme(accent) {
      var hex = /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#011627';
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
    }


      return {
        token: token,
        store: store,
        load: load,
        api: api,
        streamMessage: streamMessage,
        postStream: postStream,
        reportTrace: reportTrace,
        esc: esc,
        markdown: markdown,
        el: el,
        icon: icon,
        iconButton: iconButton,
        relativeTime: relativeTime,
        applyTheme: applyTheme,
      };
    },
  };
})();
