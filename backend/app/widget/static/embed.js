/*
 * HOP Chat embed loader.
 *
 * Served as /embed/{publicId}.js, wrapped in a closure that defines
 * HOP_CHAT_CONFIG = { publicId, origin, title, accentColor, position }.
 *
 * Draws a launcher bubble on the host page inside a shadow root (so neither
 * page's CSS leaks into the other) and, on first open, loads the chat page
 * (/c/{publicId}?embed=1) in an iframe. The iframe is the whole chat: its own
 * origin, storage and CSP, isolated from the host page.
 *
 * Host pages can drive it: HopChat.open(), HopChat.close(), HopChat.toggle().
 * With several chats on one page, HopChat.apps[publicId] addresses each.
 */
var cfg = HOP_CHAT_CONFIG;
var registry = (window.HopChat = window.HopChat || { apps: {} });
registry.apps = registry.apps || {};
if (registry.apps[cfg.publicId]) return;

function luminance(hex) {
  var n = parseInt(hex.slice(1), 16);
  var c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

var accent = /^#[0-9a-f]{6}$/i.test(cfg.accentColor) ? cfg.accentColor : '#011627';
var onAccent = luminance(accent) > 0.45 ? '#15181e' : '#ffffff';
var side = cfg.position === 'left' ? 'left' : 'right';

var ICON_CHAT =
  '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/><path d="M8.5 10.5h7M8.5 13.5h4.5"/></svg>';
var ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

var host = document.createElement('div');
host.setAttribute('data-hop-chat', cfg.publicId);
var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

var style = document.createElement('style');
style.textContent =
  ':host{all:initial}' +
  '.launcher{position:fixed;bottom:20px;' + side + ':20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;' +
  'background:' + accent + ';color:' + onAccent + ';display:flex;align-items:center;justify-content:center;' +
  'box-shadow:0 4px 14px rgba(0,0,0,.18),0 1px 3px rgba(0,0,0,.12);transition:transform .15s ease}' +
  '.launcher:hover{transform:scale(1.05)}' +
  '.launcher:focus-visible{outline:3px solid rgba(55,214,196,.6);outline-offset:3px}' +
  '.panel{position:fixed;bottom:88px;' + side + ':20px;z-index:2147483000;width:400px;height:640px;' +
  'max-width:calc(100vw - 40px);max-height:calc(100vh - 108px);border-radius:12px;overflow:hidden;background:#fff;' +
  'border:1px solid rgba(0,0,0,.08);box-shadow:0 12px 40px rgba(0,0,0,.18);opacity:0;transform:translateY(8px);' +
  'pointer-events:none;visibility:hidden;transition:opacity .16s ease,transform .16s ease,visibility 0s linear .16s}' +
  '.panel.open{opacity:1;transform:none;pointer-events:auto;visibility:visible;transition:opacity .16s ease,transform .16s ease}' +
  '.panel iframe{border:0;width:100%;height:100%;display:block}' +
  '@media (max-width:480px){.panel{inset:0;width:100%;height:100%;max-width:none;max-height:none;border-radius:0;border:0}' +
  '.panel.open ~ .launcher{display:none}}' +
  '@media (prefers-reduced-motion:reduce){.panel,.launcher{transition:none}}';

var panel = document.createElement('div');
panel.className = 'panel';
panel.setAttribute('role', 'dialog');
panel.setAttribute('aria-label', cfg.title || 'Chat');

var launcher = document.createElement('button');
launcher.type = 'button';
launcher.className = 'launcher';
launcher.setAttribute('aria-haspopup', 'dialog');

root.appendChild(style);
root.appendChild(panel);
root.appendChild(launcher);

var iframe = null;
var isOpen = false;

function render() {
  launcher.innerHTML = isOpen ? ICON_CLOSE : ICON_CHAT;
  launcher.setAttribute('aria-expanded', String(isOpen));
  launcher.setAttribute('aria-label', isOpen ? 'Close chat' : 'Open chat: ' + (cfg.title || 'Chat'));
  panel.classList.toggle('open', isOpen);
}

function ensureFrame() {
  if (iframe) return;
  iframe = document.createElement('iframe');
  iframe.title = cfg.title || 'Chat';
  iframe.setAttribute('allow', 'clipboard-write');
  iframe.src =
    cfg.origin + '/c/' + encodeURIComponent(cfg.publicId) +
    '?embed=1&page=' + encodeURIComponent(location.href.slice(0, 500));
  panel.appendChild(iframe);
}

function post(type) {
  if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: type }, cfg.origin);
}

function open() {
  ensureFrame();
  isOpen = true;
  render();
  post('hop-chat:opened');
}
function close() {
  isOpen = false;
  render();
  launcher.focus();
}
function toggle() {
  isOpen ? close() : open();
}

launcher.addEventListener('click', toggle);
document.addEventListener('keydown', function (e) {
  if (isOpen && e.key === 'Escape') close();
});
window.addEventListener('message', function (e) {
  if (!iframe || e.source !== iframe.contentWindow || e.origin !== cfg.origin) return;
  var data = e.data || {};
  if (data.type === 'hop-chat:close') close();
  if (data.type === 'hop-chat:ready' && isOpen) post('hop-chat:opened');
});

render();

function mount() {
  document.body.appendChild(host);
}
if (document.body) mount();
else document.addEventListener('DOMContentLoaded', mount);

var api = { open: open, close: close, toggle: toggle };
registry.apps[cfg.publicId] = api;
registry.open = open;
registry.close = close;
registry.toggle = toggle;
