/*
 * HOP Chat search-answers loader.
 *
 * Served as /embed/{publicId}/search-answers.js, wrapped in a closure that
 * defines HOP_SEARCH_CONFIG = { publicId, origin, title, params, mountSelector,
 * mountPosition }.
 *
 * Add it to a docs portal's search page. It finds the mount point
 * (mountSelector, e.g. <div data-hop-answer>), reads the search terms from the
 * URL (any of `params`, in the query string or a #/route?query), and shows the
 * answer panel (/a/{publicId}) there in an iframe that sizes itself to its
 * content and stays collapsed unless there is something worth showing.
 *
 * Portals are often single-page apps, so the URL and the mount point are
 * re-checked as the visitor searches again, without a page load. Portals that
 * keep the query out of the URL can drive it directly:
 *
 *   HopAnswers.search('how do I publish a map?');
 *   HopAnswers.clear();
 */
var cfg = HOP_SEARCH_CONFIG;
var registry = (window.HopAnswers = window.HopAnswers || { apps: {} });
registry.apps = registry.apps || {};
if (registry.apps[cfg.publicId]) return;

var POLL_MS = 400;
var host = document.createElement('div');
host.setAttribute('data-hop-answers', cfg.publicId);
host.style.cssText = 'display:none;width:100%;margin:0 0 16px 0;';
var iframe = null;
var ready = false;
var loadedQuery = null; // the query the iframe was last loaded with or told about
var srcQuery = null;    // the query in the iframe's URL, i.e. what it starts with
var current = '';
var manual = false;

function queryFromUrl() {
  var sources = [location.search];
  var hash = location.hash || '';
  var q = hash.indexOf('?');
  if (q !== -1) sources.push(hash.slice(q));
  for (var s = 0; s < sources.length; s++) {
    var params = new URLSearchParams(sources[s]);
    for (var i = 0; i < cfg.params.length; i++) {
      var value = params.get(cfg.params[i]);
      if (value && value.trim()) return value.trim();
    }
  }
  return '';
}

function mount() {
  if (host.isConnected) return true;
  var target = document.querySelector(cfg.mountSelector);
  if (!target) return false;
  switch (cfg.mountPosition) {
    case 'before': target.parentNode.insertBefore(host, target); break;
    case 'after': target.parentNode.insertBefore(host, target.nextSibling); break;
    case 'append': target.appendChild(host); break;
    default: target.insertBefore(host, target.firstChild);
  }
  // Re-inserting an iframe reloads it, so it is ready again only when it says so.
  ready = false;
  loadedQuery = null;
  return true;
}

function frameUrl(query) {
  return cfg.origin + '/a/' + encodeURIComponent(cfg.publicId) +
    '?embed=1&q=' + encodeURIComponent(query) + '&page=' + encodeURIComponent(location.href.slice(0, 500));
}

function apply() {
  if (!mount()) return; // try again on the next tick: the results may not be rendered yet
  if (!current) {
    host.style.display = 'none';
    if (iframe && ready) post({ type: 'hop-answer:query', query: '' });
    loadedQuery = '';
    return;
  }
  if (loadedQuery === current) return;
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.title = cfg.title || 'AI answer';
    iframe.setAttribute('scrolling', 'no');
    iframe.style.cssText = 'display:block;width:100%;height:0;border:0;background:transparent;color-scheme:normal;';
    host.appendChild(iframe);
  }
  if (ready) {
    post({ type: 'hop-answer:query', query: current });
  } else {
    iframe.src = frameUrl(current);
    srcQuery = current;
  }
  loadedQuery = current;
}

function post(message) {
  if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage(message, cfg.origin);
}

window.addEventListener('message', function (e) {
  if (!iframe || e.source !== iframe.contentWindow || e.origin !== cfg.origin) return;
  var data = e.data || {};
  if (data.type === 'hop-answer:ready') {
    ready = true;
    // The frame started with srcQuery; catch up if the search moved on while it loaded.
    if (current !== srcQuery) {
      post({ type: 'hop-answer:query', query: current });
      loadedQuery = current;
    }
  } else if (data.type === 'hop-answer:visible') {
    host.style.display = data.visible ? 'block' : 'none';
  } else if (data.type === 'hop-answer:size' && typeof data.height === 'number') {
    iframe.style.height = Math.max(0, Math.min(data.height, 2000)) + 'px';
  }
});

function tick() {
  if (!manual) current = queryFromUrl();
  apply();
}

registry.apps[cfg.publicId] = {
  search: function (query) { manual = true; current = String(query || '').trim(); apply(); },
  clear: function () { manual = true; current = ''; apply(); },
  // Hand control back to the URL.
  auto: function () { manual = false; tick(); },
};
registry.search = registry.apps[cfg.publicId].search;
registry.clear = registry.apps[cfg.publicId].clear;
registry.auto = registry.apps[cfg.publicId].auto;

tick();
setInterval(tick, POLL_MS);
