/* CookNest Books open engine, browser side (docs/proposals/books-engine.md).
 *
 * The book is a list of blocks (a fixed page, a pair of fixed pages, a
 * recipe); every block starts on a new page and is laid out on its own by
 * Vivliostyle (window.vivliostyle, dist/vivliostyle.js), then kept in a cache
 * keyed by its HTML (which carries content, theme, options, language and the
 * engine version). The book is the blocks' pages joined in order: page
 * numbers and the index numbers are written at the end, which is cheap.
 * The same file runs in the user's browser (live preview) and in headless
 * Chromium on the server (print PDF), so both lay out the same way.
 *
 *   var r = CookNestBookEngine.createBookRenderer({ endpoint: "/books-design/engine", key: k,
 *            theme: "herencia", options: {}, lang: "ca", mode: "preview" });
 *   r.on("page-ready", fn); r.on("book-ready", fn);
 *   r.setBook({ bookId: "abc" });          // or { book: {...}, recipes: {...} }
 *   r.updateRecipe("rid", { title: "..." });
 *   r.getPageCount(); r.renderPage(3, element);
 */
(function (global) {
  "use strict";

  var ENGINE_VERSION = "open-6";
  // Layout can differ between browser engines: cached pages are per family
  // (the server's Chromium shares Chrome's and Edge's).
  var FAMILY = (function () {
    var ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    return /Firefox\//.test(ua) ? "gecko" : /Chrome\/|Chromium\//.test(ua) ? "blink" : /AppleWebKit\//.test(ua) ? "webkit" : "other";
  })();
  // Page numbers are laid out as 9100, 9101, ... and written at the end.
  var SENTINEL = 9100;
  // The book's title in a recipe's running head is laid out as this word and
  // written at the end too: a new title then lays out no recipe again.
  var TITLE = "Cnbooktitlemark";

  function apostrophes(s) {
    return s.replace(/([A-Za-z\u00C0-\u00FF])'([A-Za-z\u00C0-\u00FF])/g, "$1\u2019$2");
  }

  /** The forms a title takes in a template's HTML (escaped, with typographic apostrophes), longest first. */
  function titleForms(title) {
    if (!title || title.trim().length < 3) return [];
    var esc = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    var out = [];
    [esc, apostrophes(esc), title, apostrophes(title), esc.replace(/'/g, "&#39;")].forEach(function (f) {
      if (out.indexOf(f) < 0) out.push(f);
    });
    return out.sort(function (a, b) { return b.length - a.length; });
  }

  function writeTitle(pageEls, title) {
    var shown = apostrophes(title);
    pageEls.forEach(function (el) {
      var walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue.indexOf(TITLE) >= 0) node.nodeValue = node.nodeValue.split(TITLE).join(shown);
      }
    });
  }

  // ---------------------------------------------------------------- helpers

  function hash(str) {
    // FNV-1a, 52 bits, enough for a cache key.
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
      h2 ^= c; h2 = Math.imul(h2, 2246822519) >>> 0;
    }
    return h1.toString(16) + h2.toString(16);
  }

  function now() {
    return (global.performance && performance.now()) || Date.now();
  }

  function Emitter() {
    this.listeners = {};
  }
  Emitter.prototype.on = function (type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
    return this;
  };
  Emitter.prototype.off = function (type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter(function (f) { return f !== fn; });
  };
  Emitter.prototype.emit = function (type, payload) {
    (this.listeners[type] || []).slice().forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  };

  // Prince-only CSS the open engine reads differently. target-counter needs
  // the anchors in the same document; blocks are laid out apart, so the
  // engine writes the page numbers into data attributes (fillIndexNumbers).
  function openCss(css) {
    return css.replace(/target-counter\(\s*attr\(\s*href\s*\)\s*,\s*page\s*(?:,\s*([a-z-]+)\s*)?\)/g, function (_, style) {
      return style === "decimal-leading-zero" ? "attr(data-oe-page2)" : "attr(data-oe-page)";
    });
  }

  // Vivliostyle ignores text-transform on ::first-letter (Essencial
  // capitalizes every ingredient that way): the engine writes the capital.
  function firstLetterSelectors(css) {
    var out = [];
    css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/([^{}]+?)(?:::|:)first-letter\s*\{[^}]*text-transform\s*:\s*uppercase/g, function (m, sel) {
      sel.split(",").forEach(function (x) { x = x.trim(); if (x && x.indexOf("::") < 0) out.push(x); });
      return m;
    });
    return out;
  }

  function capitalizeFirstLetters(html, selectors, hostDoc) {
    if (!selectors.length) return html;
    var tpl = hostDoc.createElement("template");
    tpl.innerHTML = html;
    var changed = false;
    selectors.forEach(function (sel) {
      var els;
      try { els = tpl.content.querySelectorAll(sel); } catch (e) { return; }
      Array.prototype.forEach.call(els, function (el) {
        var walker = hostDoc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        var node;
        while ((node = walker.nextNode())) {
          var i = node.nodeValue.search(/\S/);
          if (i < 0) continue;
          var up = node.nodeValue.charAt(i).toLocaleUpperCase();
          if (up !== node.nodeValue.charAt(i)) {
            node.nodeValue = node.nodeValue.slice(0, i) + up + node.nodeValue.slice(i + 1);
            changed = true;
          }
          break;
        }
      });
    });
    return changed ? tpl.innerHTML : html;
  }

  function folioFormat(css) {
    return /counter\(\s*page\s*,\s*decimal-leading-zero\s*\)/.test(css) ? "pad2" : "decimal";
  }

  function formatFolio(n, format) {
    return format === "pad2" && n >= 0 && n < 10 ? "0" + n : String(n);
  }

  function blockDocument(head, body, side, extraCss) {
    // A block that opens on a left page gets a throwaway first page.
    var skip = side === "left" ? '<div class="oe-skip" style="height:1px;margin:0;padding:0"></div>' : "";
    var first = side === "left" ? SENTINEL - 1 : SENTINEL;
    return (
      '<!DOCTYPE html><html lang="' + head.language + '"><head><meta charset="utf-8"><style>' + head.css + "</style>" +
      "<style>@page :first{counter-reset:page " + (first - 1) + "}</style>" +
      (extraCss ? "<style>" + extraCss + "</style>" : "") + "</head>" +
      '<body class="' + head.bodyClass + '">' + skip + body + "</body></html>"
    );
  }

  // --------------------------------------------------- scripts (pre-pass)

  // Some themes measure text with a script before the page layout (EuroPDF
  // runs them in Chrome before Prince). They run here in a hidden frame,
  // with the fonts loaded, and the resulting DOM is what gets laid out.
  // info.complete: the scripts said they were done (not cut by a wait).
  function runScripts(html, hostDoc, info) {
    return new Promise(function (resolve) {
      var frame = hostDoc.createElement("iframe");
      frame.setAttribute("aria-hidden", "true");
      frame.style.cssText = "position:absolute;left:-30000px;top:0;width:1000px;height:1000px;border:0;visibility:hidden";
      var shim = "<script>window.EuroPDF={};</script>";
      frame.srcdoc = html.replace(/<head>/i, function (m) { return m + shim; });
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        var out;
        try {
          var d = frame.contentDocument;
          d.querySelectorAll("script").forEach(function (s) { s.remove(); });
          out = "<!DOCTYPE html>" + d.documentElement.outerHTML;
        } catch (e) {
          out = html;
          if (info) info.complete = false;
        }
        frame.remove();
        resolve(out);
      }
      frame.onload = function () {
        var w = frame.contentWindow;
        var started = Date.now();
        var fonts = w.document.fonts ? w.document.fonts.ready : Promise.resolve();
        fonts.then(function () {
          (function poll() {
            var ready = true;
            try {
              if (w.EuroPDF && typeof w.EuroPDF.readyToRender === "function") ready = !!w.EuroPDF.readyToRender();
            } catch (e) {}
            if (ready && info) info.complete = true;
            if (ready || Date.now() - started > 45000) finish();
            else setTimeout(poll, 20);
          })();
        });
      };
      hostDoc.body.appendChild(frame);
      // Generous: on a busy machine a theme's script can take long, and one
      // cut short gives a wrong layout (the waits above end as soon as it is done).
      setTimeout(finish, 90000);
    });
  }

  // ------------------------------------------------------------ Paginator

  /** One Vivliostyle viewer laying out one document at a time. */
  function Paginator(hostDoc) {
    this.doc = hostDoc || document;
    this.viewport = this.doc.createElement("div");
    this.viewport.setAttribute("aria-hidden", "true");
    this.viewport.className = "oe-viewport";
    this.viewport.style.cssText = "position:absolute;left:-40000px;top:0;width:1200px;height:1200px;overflow:hidden";
    this.doc.body.appendChild(this.viewport);
    this.viewer = new global.vivliostyle.CoreViewer(
      { viewportElement: this.viewport, window: this.doc.defaultView },
      { renderAllPages: true, pageViewMode: "singlePage", autoResize: false, zoom: 1, fitToScreen: false }
    );
    this.queue = Promise.resolve();
    this.urls = [];
  }

  /**
   * Lays out one HTML document. Returns detached page elements (the
   * Vivliostyle page containers, styles inline) and, for a measure
   * document, where its end marker sits on the last page (0 to 1).
   */
  // One document at a time; a renderer made with `background: true` (the live
  // book's prefetch of other designs) waits while any other job is waiting,
  // so the book on screen never queues behind it for more than the job in hand.
  Paginator.prototype.layout = function (html, background) {
    var self = this;
    return new Promise(function (resolve, reject) {
      (background ? self.low || (self.low = []) : self.high || (self.high = [])).push({ html: html, resolve: resolve, reject: reject });
      self._pump();
    });
  };
  Paginator.prototype._pump = function () {
    var self = this;
    if (this.busy) return;
    var next = (this.high && this.high.shift()) || (this.low && this.low.shift());
    if (!next) return;
    this.busy = true;
    this._layout(next.html).then(next.resolve, next.reject).then(function () {
      self.busy = false;
      self._pump();
    });
  };

  Paginator.prototype._layout = function (html) {
    var self = this;
    var t0 = now();
    var url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    this.urls.push(url);
    while (this.urls.length > 4) URL.revokeObjectURL(this.urls.shift());
    return new Promise(function (resolve, reject) {
      var viewer = self.viewer;
      var settled = false;
      function onState() {
        if (viewer.readyState !== "complete" || settled) return;
        settled = true;
        cleanup();
        try {
          var tv = now();
          var out = self._harvest(t0);
          out.vivMs = Math.round(tv - t0);
          out.harvestMs = Math.round(now() - tv);
          resolve(out);
        } catch (e) {
          reject(e);
        }
      }
      function onError(payload) {
        var c = payload && payload.content;
        console.warn("[book-engine] vivliostyle:", c && (c.error || (c.messages || []).join(" ")));
      }
      function cleanup() {
        viewer.removeListener("readystatechange", onState);
        viewer.removeListener("error", onError);
      }
      viewer.addListener("readystatechange", onState);
      viewer.addListener("error", onError);
      viewer.loadDocument({ url: url });
      setTimeout(function () {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("layout timed out"));
        }
      }, 180000);
    });
  };

  Paginator.prototype._harvest = function (t0) {
    var containers = Array.prototype.slice.call(this.viewport.querySelectorAll("[data-vivliostyle-page-container]"));
    containers.forEach(function (c) { c.style.display = "block"; });
    var fill = null;
    var end = this.viewport.querySelector(".measure-end span");
    if (end && containers.length) {
      var last = containers[containers.length - 1];
      var box = last.getBoundingClientRect();
      var bleed = last.querySelector("[data-vivliostyle-bleed-box]");
      var pad = bleed ? parseFloat(bleed.style.paddingTop) || 0 : 0;
      var r = end.getBoundingClientRect();
      var h = box.height - 2 * pad;
      if (h > 0 && last.contains(end)) fill = Math.min(1, Math.max(0, (r.top - box.top - pad) / h));
    }
    var overflow = containers.map(overflowsArea).map(function (o, i) { return o ? i : -1; }).filter(function (i) { return i >= 0; });
    // Vivliostyle sets variables on its viewer (--viv-layoutUnitAdj, used
    // in every font-size it writes); the copies carry them.
    var vivVars = [];
    for (var a = containers[0] && containers[0].parentElement; a && a !== this.viewport.parentElement; a = a.parentElement) {
      for (var k = 0; k < a.style.length; k++) {
        var name = a.style[k];
        if (name.indexOf("--viv-") === 0) vivVars.push([name, a.style.getPropertyValue(name)]);
      }
    }
    var pages = containers.map(function (c) {
      var clone = c.cloneNode(true);
      vivVars.forEach(function (v) { clone.style.setProperty(v[0], v[1]); });
      clone.removeAttribute("data-vivliostyle-page-index");
      clone.removeAttribute("data-vivliostyle-spine-index");
      clone.style.display = "block";
      clone.style.visibility = "visible";
      // Vivliostyle maps font families to its own names (Fnt_N); the clone
      // uses the theme's names, which the host document loads.
      fixSvgRefs(clone);
      clone.querySelectorAll("[style*='Fnt_']").forEach(function (el) {
        el.style.fontFamily = el.style.fontFamily.replace(/Fnt_\d+,\s*/g, "");
      });
      return clone;
    });
    return { pages: pages, fill: fill, overflow: overflow, ms: Math.round(now() - t0) };
  };

  var URL_ATTRS = ["fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end"];

  /**
   * Vivliostyle points SVG references (fill="url(#tile)") at an anchor it
   * adds inside the target instead of at the target, so patterns, gradients
   * and clips paint nothing. Point them back at the element itself.
   */
  function fixSvgRefs(root) {
    var byViv = {};
    root.querySelectorAll("svg [data-vivliostyle-id]").forEach(function (el) {
      if (el.id) byViv[el.getAttribute("data-vivliostyle-id")] = el.id;
    });
    if (!Object.keys(byViv).length) return;
    root.querySelectorAll("svg *").forEach(function (el) {
      URL_ATTRS.forEach(function (name) {
        var v = el.getAttribute(name);
        if (!v || v.indexOf("viv-id-") < 0) return;
        el.setAttribute(name, v.replace(/url\(\s*["']?#([^"')]+)["']?\s*\)/g, function (m, id) {
          return byViv[id] ? "url(#" + byViv[id] + ")" : m;
        }));
      });
      ["href", "xlink:href"].forEach(function (name) {
        var v = el.getAttribute(name);
        if (v && v.charAt(0) === "#" && byViv[v.slice(1)]) el.setAttribute(name, "#" + byViv[v.slice(1)]);
      });
    });
  }

  /** SVG ids made unique on one page of the book (the same block can print twice, a viewer can hold copies). */
  function uniqueSvgIds(root, suffix) {
    var map = {};
    root.querySelectorAll("svg [id]").forEach(function (el) {
      var id = el.id;
      map[id] = id + "--" + suffix;
      el.id = map[id];
    });
    if (!Object.keys(map).length) return;
    root.querySelectorAll("svg *").forEach(function (el) {
      URL_ATTRS.forEach(function (name) {
        var v = el.getAttribute(name);
        if (!v || v.indexOf("url(") < 0) return;
        el.setAttribute(name, v.replace(/url\(\s*["']?#([^"')]+)["']?\s*\)/g, function (m, id) {
          return map[id] ? "url(#" + map[id] + ")" : m;
        }));
      });
      ["href", "xlink:href"].forEach(function (name) {
        var v = el.getAttribute(name);
        if (v && v.charAt(0) === "#" && map[v.slice(1)]) el.setAttribute(name, "#" + map[v.slice(1)]);
      });
    });
  }

  /**
   * True when visible text runs below the page area (content Vivliostyle
   * could not break, like a box that does not fragment): Prince would have
   * pushed it to a new page; here it would be cut. Text clipped on purpose by
   * an overflow-hidden ancestor, or under 2 px (running-head holders), is not counted.
   */
  function overflowsArea(container) {
    var area = container.querySelector("[data-vivliostyle-page-area]");
    if (!area) return false;
    var limit = area.getBoundingClientRect().bottom + 2;
    var doc = container.ownerDocument;
    var walker = doc.createTreeWalker(area, NodeFilter.SHOW_TEXT);
    var node;
    var range = doc.createRange();
    while ((node = walker.nextNode())) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      var el = node.parentElement;
      if (!el) continue;
      // Position first (cheap); styles only for the few below the area.
      range.selectNodeContents(node);
      var r = range.getBoundingClientRect();
      if (!r.height || r.bottom <= limit) continue;
      var cs = doc.defaultView.getComputedStyle(el);
      if (cs.visibility === "hidden" || parseFloat(cs.fontSize) < 2 || cs.display === "none") continue;
      var clipped = false;
      for (var a = el; a && a !== area; a = a.parentElement) {
        var as = doc.defaultView.getComputedStyle(a);
        if (as.overflow !== "visible" || as.overflowY !== "visible") {
          if (a.getBoundingClientRect().bottom < r.top + 1) { clipped = true; break; }
        }
      }
      if (!clipped) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- cache

  function BlockCache(limit) {
    this.limit = limit || 800;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }
  BlockCache.prototype.get = function (key) {
    var v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
      this.hits++;
    } else this.misses++;
    return v;
  };
  BlockCache.prototype.set = function (key, value) {
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  };

  // ------------------------------------------------------- page numbering

  /** Writes the real page number over the sentinel numbers of a block's pages. */
  function writeFolios(pageEls, firstFolio, firstSentinel, format) {
    pageEls.forEach(function (el) {
      var walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        if (!/9[0-3]\d\d/.test(node.nodeValue)) continue;
        node.nodeValue = node.nodeValue.replace(/(^|[^\d])(9[0-3]\d\d)(?!\d)/g, function (m, pre, num) {
          var j = Number(num) - firstSentinel;
          if (j < 0 || j > 40) return m;
          return pre + formatFolio(firstFolio + j, format);
        });
      }
    });
  }

  /** Index pages: the page of every anchor they link to, as data attributes. */
  function fillIndexNumbers(html, anchors, format) {
    // Any element with href="#anchor" (Pati puts it on a <span>).
    return html.replace(/<(\w+)\b([^>]*?)href="#([\w-]+)"/g, function (m, tag, attrs, id) {
      var n = anchors[id];
      if (n == null) return m;
      return "<" + tag + attrs + 'data-oe-page="' + n + '" data-oe-page2="' + formatFolio(n, "pad2") + '" href="#' + id + '"';
    });
  }

  // ------------------------------------------------------------- renderer

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data && data.error ? data.error : "HTTP " + res.status);
        return data;
      });
    });
  }

  var shared = { paginator: null, cache: new BlockCache(1200), fontCss: {} };

  function paginator(hostDoc) {
    if (!shared.paginator) shared.paginator = new Paginator(hostDoc);
    return shared.paginator;
  }

  // The theme's @font-face rules in the host document, so cloned pages
  // (which name the theme's families) draw with the same files.
  function ensureFonts(hostDoc, css) {
    var faces = css.match(/@font-face\s*\{[^}]*\}/g) || [];
    var key = hash(faces.join(""));
    if (shared.fontCss[key]) return;
    shared.fontCss[key] = true;
    var style = hostDoc.createElement("style");
    style.setAttribute("data-oe-fonts", key);
    style.textContent = faces.join("\n");
    hostDoc.head.appendChild(style);
  }

  /**
   * @param {{endpoint: string, key?: string, theme: string, options?: object, lang?: string,
   *          mode?: "preview"|"print", document?: Document, coverType?: "soft"|"hard"}} config
   */
  function createBookRenderer(config) {
    var cfg = Object.assign({ options: {}, mode: "preview" }, config || {});
    var hostDoc = cfg.document || document;
    var events = new Emitter();
    var state = {
      partial: null,
      spec: null,
      overrides: {},
      build: 0,
      pages: [],
      blocks: [],
      summary: null,
      content: null,
      timings: null,
      busy: null,
      head: null,
    };

    function url(path) {
      return cfg.endpoint + path + (cfg.key ? (path.indexOf("?") >= 0 ? "&" : "?") + "k=" + encodeURIComponent(cfg.key) : "");
    }

    function request() {
      return {
        spec: state.spec,
        overrides: state.overrides,
        theme: cfg.theme,
        options: cfg.options,
        lang: cfg.lang,
        mode: cfg.mode,
      };
    }

    /** Measures the recipes the server has no measure for, fit by fit. */
    function measure(missing, build) {
      var results = [];
      var pending = missing.slice();
      var fit = 0;
      function round() {
        if (!pending.length || build !== state.build) return Promise.resolve();
        return postJson(url("/measure"), Object.assign(request(), { recipeIds: pending, fit: fit })).then(function (res) {
          var head = { css: res.css, bodyClass: res.bodyClass, language: res.language };
          var next = [];
          var chain = Promise.resolve();
          res.docs.forEach(function (d) {
            // Each recipe has its own fits (a layout the person chose for it): the server says when this was its last.
            var last = typeof d.last === "boolean" ? d.last : res.last;
            chain = chain.then(function () {
              if (build !== state.build) return;
              if (d.reject && !last) {
                next.push(d.recipeId);
                return;
              }
              var html = blockDocument(head, d.body, "right");
              return layoutCached(html, /<script/i.test(d.body)).then(function (out) {
                var count = out.count;
                // Text cut at the foot of a page: this fit does not fit.
                if (out.overflow && out.overflow.length && !last) count = Math.max(count, d.fitPages + 1);
                if (count <= d.fitPages || last) {
                  results.push({
                    recipeId: d.recipeId,
                    hash: d.hash,
                    span: Math.min(Math.max(count, 1), count > d.fitPages ? 4 : 2),
                    fit: d.fit,
                    fill: out.fill,
                    overflow: count > d.fitPages,
                  });
                } else next.push(d.recipeId);
                events.emit("measure-progress", { measured: results.length, total: missing.length });
              });
            });
          });
          return chain.then(function () {
            pending = next;
            fit++;
            return round();
          });
        });
      }
      return round().then(function () {
        if (build !== state.build) return;
        return postJson(url("/measured"), Object.assign(request(), { results: results }));
      });
    }

    /** A document laid out, from the cache when its HTML was laid out before. */
    function cacheKey(html) {
      return ENGINE_VERSION + "-" + FAMILY + "-" + hash(html);
    }

    function layoutCached(html, scripts) {
      var key = cacheKey(html);
      var hit = shared.cache.get(key);
      if (hit) return Promise.resolve(Object.assign({ cached: true }, hit));
      var prep = scripts ? runScripts(html, hostDoc) : Promise.resolve(html);
      return prep
        .then(function (doc) { return paginator(hostDoc).layout(doc, cfg.background === true); })
        .then(function (out) {
          var pages = out.pages;
          var skipped = /class="oe-skip"/.test(html);
          if (skipped) pages = pages.slice(1);
          var over = (out.overflow || []).map(function (i) { return skipped ? i - 1 : i; }).filter(function (i) { return i >= 0; });
          var value = { pages: pages, count: pages.length, fill: out.fill, overflow: over, ms: out.ms, vivMs: out.vivMs, harvestMs: out.harvestMs };
          shared.cache.set(key, value);
          fresh[key] = value;
          return Object.assign({ cached: false }, value);
        });
    }

    // Runs the theme's scripts once over every block (scripts stripped and
    // the first one added at the end), then gives each block its processed
    // HTML. Cached by the whole document.
    var prepassCache = new BlockCache(8);
    // Pages laid out in this page since the last upload to the server's cache.
    var fresh = {};

    /** Pages the server already has (laid out before, here or in another browser of the same family). */
    function fetchCached(keys) {
      var missing = keys.filter(function (k) { return !shared.cache.map.has(k); });
      if (!missing.length || cfg.serverCache === false) return Promise.resolve(0);
      return postJson(url("/pages-get"), { keys: missing })
        .then(function (res) {
          var n = 0;
          Object.keys(res.found || {}).forEach(function (k) {
            var tpl = hostDoc.createElement("template");
            tpl.innerHTML = res.found[k].pages.join("");
            var pages = Array.prototype.slice.call(tpl.content.children);
            shared.cache.set(k, { pages: pages, count: pages.length, fill: res.found[k].fill, overflow: res.found[k].overflow || [], ms: 0 });
            n++;
          });
          return n;
        })
        .catch(function () { return 0; });
    }

    /** A theme scripts' result over a whole book, from the server (null when it has none). */
    function fetchPrepass(key) {
      if (cfg.serverCache === false) return Promise.resolve(null);
      return postJson(url("/prepass-get"), { key: key })
        .then(function (res) { return res && res.found && typeof res.found === "object" ? res.found : null; })
        .catch(function () { return null; });
    }

    function putPrepass(key, byBlock) {
      if (cfg.serverCache === false) return;
      postJson(url("/prepass-put"), { key: key, blocks: byBlock }).catch(function () {});
    }

    function uploadFresh() {
      var keys = Object.keys(fresh);
      if (!keys.length || cfg.serverCache === false) return Promise.resolve();
      var body = {};
      keys.forEach(function (k) {
        body[k] = { fill: fresh[k].fill, overflow: fresh[k].overflow || [], pages: fresh[k].pages.map(function (el) { return el.outerHTML; }) };
      });
      fresh = {};
      return postJson(url("/pages-put"), { entries: body }).catch(function () {});
    }
    // A recipe as a theme script whose scope is "fixed" sees it: its page
    // sections, empty but for the elements the script reads (scope.keep).
    // shallow: the kept elements without their content (their attributes are what is read).
    function stubOf(html, keep, shallow) {
      var tpl = hostDoc.createElement("template");
      tpl.innerHTML = html;
      var out = [];
      Array.prototype.forEach.call(tpl.content.children, function (el) {
        if (!/^section$/i.test(el.tagName)) return;
        var shell = el.cloneNode(false);
        keep.forEach(function (sel) {
          el.querySelectorAll(sel).forEach(function (k) { shell.appendChild(k.cloneNode(!shallow)); });
        });
        out.push(shell.outerHTML);
      });
      return out.join("");
    }

    // Recipes as the theme scripts last left them, by their own HTML.
    var processed = new BlockCache(3000);

    function prepassBook(head, blocks, scope, stats) {
      var t0 = now();
      var scripts = [];
      // scope "neighbors" (Pati): the scripts read each recipe and its
      // neighbor, and the fixed pages read the recipes' photos. Only the
      // recipes that changed (and the ones next to them) run again in full;
      // the others are stubs and keep the HTML they had.
      var local = scope && scope.scope === "neighbors";
      var stripped = {};
      blocks.forEach(function (b) {
        stripped[b.index] = b.html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, function (m, src) {
          if (scripts.indexOf(src) < 0) scripts.push(src);
          return "";
        });
      });
      // full: laid out with the scripts this time; take: whose result is kept.
      // A changed recipe and the ones next to it are kept; one more on each
      // side runs too, so a neighbor paired with that one comes out the same.
      var full = {};
      var take = {};
      var css = hash(head.css) + ":";
      // A recipe as the scripts left it depends on the recipes beside it too
      // (CookNest pairs a left and a right page): its key is its HTML and theirs.
      var pkey = {};
      var recipes = blocks.filter(function (b) { return b.type === "recipe"; });
      recipes.forEach(function (b, k) {
        var prev = recipes[k - 1], next = recipes[k + 1];
        pkey[b.index] = css + (prev ? hash(prev.html) : "") + ":" + (next ? hash(next.html) : "") + ":" + b.html;
      });
      if (local) {
        recipes.forEach(function (b, k) {
          if (processed.map.has(pkey[b.index])) return;
          for (var d = -2; d <= 2; d++) {
            var r = recipes[k + d];
            if (!r) continue;
            full[r.index] = true;
            if (d >= -1 && d <= 1) take[r.index] = true;
          }
        });
      }
      var body = blocks
        .map(function (b) {
          var html = stripped[b.index];
          if (local && b.type === "recipe" && !full[b.index]) {
            // scope.reuse (CookNest with sections): an unchanged recipe goes in as
            // the scripts last left it, reduced to the elements they read
            // (scope.reuse, without content) and marked oe-stub, so a script that
            // reads other recipes (a section opener's photo) still finds what
            // they came to, and lays out only the recipes that changed.
            var kept = scope.reuse && processed.get(pkey[b.index]);
            html = kept ? stubOf(kept, scope.reuse, true).replace(/<section( id="[^"]*")? class="page /g, '<section$1 class="page oe-stub ') : stubOf(html, scope.keep || []);
          }
          return html.replace(/<section( id="[^"]*")? class="page /g, function (m, id) {
            return "<section" + (id || "") + ' data-oe-block="' + b.index + '" class="page ';
          });
        })
        .join("\n");
      var doc =
        '<!DOCTYPE html><html lang="' + head.language + '"><head><meta charset="utf-8"><style>' + head.css + "</style></head>" +
        '<body class="' + head.bodyClass + '">' + body + scripts.map(function (s) { return "<script>" + s + "</script>"; }).join("") + "</body></html>";
      var key = hash(doc);
      var hit = prepassCache.get(key);
      // A book's first layout here (nothing processed yet) asks the server
      // for this whole document's result first: a book seen before, here or in
      // another browser of the same family, does not run the scripts again.
      var first = !processed.map.size;
      var skey = ENGINE_VERSION + "-" + FAMILY + "-" + key;
      var run = hit
        ? Promise.resolve(hit)
        : (first ? fetchPrepass(skey) : Promise.resolve(null)).then(function (found) {
            if (found) {
              if (stats) stats.prepassFromServer = true;
              prepassCache.set(key, found);
              return found;
            }
            var ran = {};
            return runScripts(doc, hostDoc, ran).then(function (out) {
              var parsed = new DOMParser().parseFromString(out, "text/html");
              var byBlock = {};
              Array.prototype.forEach.call(parsed.body.children, function (el) {
                var i = el.getAttribute("data-oe-block");
                if (i == null) return;
                el.removeAttribute("data-oe-block");
                (byBlock[i] = byBlock[i] || []).push(el.outerHTML);
              });
              prepassCache.set(key, byBlock);
              if (first && ran.complete) putPrepass(skey, byBlock);
              return byBlock;
            });
          });
      return run.then(function (byBlock) {
        blocks.forEach(function (b) {
          var original = b.html;
          if (local && b.type === "recipe" && (!full[b.index] || (!take[b.index] && processed.map.has(pkey[b.index])))) b.html = processed.get(pkey[b.index]) || stripped[b.index];
          else if (byBlock[b.index]) b.html = byBlock[b.index].join("\n");
          if (b.type === "recipe") processed.set(pkey[b.index], b.html);
        });
        return Math.round(now() - t0);
      });
    }

    function makeBook(build, res) {
      var t0 = now();
      var head = { css: openCss(res.css), bodyClass: res.bodyClass, language: res.language };
      ensureFonts(hostDoc, head.css);
      var format = folioFormat(res.css);
      var forms = titleForms(res.bookTitle || "");
      var blocks = res.blocks.map(function (b, i) {
        var block = Object.assign({ index: i }, b);
        if (b.type === "recipe" && forms.length) {
          var html = b.html;
          forms.forEach(function (f) { html = html.split(f).join(TITLE); });
          if (html !== b.html) {
            block.html = html;
            block.titled = true;
          }
        }
        return block;
      });
      var stats = { laidOut: 0, cached: 0, ms: 0, firstPageMs: null };
      // The page number of each block's first page, from the expected spans;
      // corrected once the real pages are known.
      var includeCovers = res.mode !== "print";
      function folioOf(pageIndex) {
        return includeCovers ? pageIndex : pageIndex + 1;
      }
      var results = new Array(blocks.length);
      // dedication: a book without sections prints its contents on page 1 (with the title and the dedication).
      var indexTypes = { index: 1, section_index: 1, section_cover: 1, dedication: 1 };
      var linked = function (b) { return indexTypes[b.type] && /href="#/.test(b.html); };
      var order = blocks.filter(function (b) { return !linked(b); }).concat(blocks.filter(linked));
      // Theme scripts look at the whole book (a run of pages to write in, the
      // section a page falls in): they run once over every block, as EuroPDF
      // runs them over the whole document, and the result is split again.
      var chain = /<script/i.test(res.blocks.map(function (b) { return b.html; }).join("")) ? prepassBook(head, blocks, res.scripts, stats).then(function (ms) { stats.prepassMs = ms; }) : Promise.resolve();
      // The blocks the server has laid out before: the first few at once (the
      // cover shows soon), the rest in one request while those are laid out.
      var rest = null;
      chain = chain.then(function () {
        var keys = blocks.filter(function (b) { return !linked(b); }).map(function (b) { return cacheKey(docOf(b, b.html)); });
        return fetchCached(keys.slice(0, 3)).then(function (n) {
          stats.fromServer = n;
          rest = fetchCached(keys.slice(3)).then(function (m) { stats.fromServer += m; });
        });
      });
      var capitals = firstLetterSelectors(res.css);
      function docOf(b, html) {
        html = capitalizeFirstLetters(html, capitals, hostDoc);
        // Style rules a recipe writes for other pages (Herència sends a
        // section's photo to its opener) reach the fixed pages too.
        return blockDocument(head, html, b.side, b.type === "recipe" ? "" : bookStyles());
      }
      order.forEach(function (b) {
        chain = chain.then(function () {
          if (build !== state.build) return;
          var html = b.html;
          if (linked(b)) html = fillIndexNumbers(html, anchorPages(), format);
          var doc = docOf(b, html);
          var go = linked(b) ? fetchCached([cacheKey(doc)]) : b.index < 3 || !rest ? Promise.resolve() : rest;
          return go.then(function () { return layoutCached(doc, false); }).then(function (out) {
            if (build !== state.build) return;
            if (out.cached) stats.cached++;
            else {
              stats.laidOut++;
              stats.vivMs = (stats.vivMs || 0) + (out.vivMs || 0);
              stats.harvestMs = (stats.harvestMs || 0) + (out.harvestMs || 0);
            }
            results[b.index] = { block: b, out: out, sentinel: SENTINEL, key: cacheKey(doc) };
            if (out.overflow && out.overflow.length) {
              stats.overflow = (stats.overflow || []).concat([{ block: b.index, type: b.type, recipeId: b.recipeId || null, pages: out.overflow }]);
              console.warn("[book-engine] block " + b.index + " (" + b.type + ") has text below the page area on page(s) " + out.overflow.join(", "));
            }
            if (out.count !== b.pages) {
              console.warn("[book-engine] block " + b.index + " (" + b.type + ") expected " + b.pages + " pages, laid out " + out.count);
            }
            if (stats.firstPageMs == null && b.index === 0) stats.firstPageMs = Math.round(now() - t0);
            events.emit("page-ready", { block: b.index, type: b.type, recipeId: b.recipeId || null, pages: out.count, cached: out.cached });
          });
        });
      });

      var stylesMemo = null;
      function bookStyles() {
        if (stylesMemo == null) {
          stylesMemo = blocks
            .filter(function (b) { return b.type === "recipe"; })
            .map(function (b) {
              var out = [];
              b.html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, function (m, css) { out.push(css); return m; });
              return out.join("\n");
            })
            .join("\n");
        }
        return stylesMemo;
      }

      function anchorPages() {
        // Page numbers of the anchors (recipes, sections), from what is laid out so far
        // and the expected spans for the rest.
        var map = {};
        var p = 0;
        blocks.forEach(function (b) {
          var r = results[b.index];
          if (b.anchor) map[b.anchor] = folioOf(p);
          p += r ? r.out.count : b.pages;
        });
        return map;
      }

      // The pages of the blocks laid out so far, from the first one on (a
      // viewer shows the book growing on a first load).
      state.partial = function () {
        var prefix = [];
        for (var i = 0; i < results.length && results[i]; i++) prefix.push(results[i]);
        return join(prefix);
      };

      function join(list) {
        // Real page numbers over the sentinels.
        var pages = [];
        list.forEach(function (r) {
          var first = pages.length;
          var els = r.out.pages.map(function (el) { return el.cloneNode(true); });
          writeFolios(els, folioOf(first), r.sentinel, format);
          if (r.block.titled) writeTitle(els, res.bookTitle);
          els.forEach(function (el, j) { uniqueSvgIds(el, "p" + (first + j)); });
          els.forEach(function (el, j) {
            var n = first + j;
            el.setAttribute("data-oe-page", String(n));
            pages.push({
              index: n,
              folio: folioOf(n),
              side: includeCovers ? (n === 0 ? "right" : n % 2 === 1 ? "right" : "left") : n % 2 === 0 ? "right" : "left",
              block: r.block.index,
              type: r.block.type,
              recipeId: r.block.recipeId || null,
              key: r.key + ":" + j + (r.block.titled ? ":" + hash(res.bookTitle) : ""),
              element: el,
            });
          });
        });
        return pages;
      }

      return chain.then(function () {
        if (build !== state.build) return null;
        uploadFresh();
        state.partial = null;
        var pages = join(results);
        stats.ms = Math.round(now() - t0);
        return { pages: pages, stats: stats, head: head };
      });
    }

    function build() {
      var my = ++state.build;
      var t0 = now();
      var timings = { started: Date.now() };
      events.emit("build-start", { build: my });
      var run = postJson(url("/book"), request())
        .then(function (res) {
          if (my !== state.build) return null;
          if (res.status === "measure") {
            timings.measureMissing = res.missing.length;
            var tm = now();
            return measure(res.missing, my).then(function () {
              timings.measureMs = Math.round(now() - tm);
              if (my !== state.build) return null;
              return postJson(url("/book"), request());
            });
          }
          return res;
        })
        .then(function (res) {
          if (!res || my !== state.build) return null;
          if (res.status !== "ready") throw new Error("the server could not lay out the book: " + (res.error || res.status));
          state.summary = res.summary;
          state.content = res.content || null;
          state.blocks = res.blocks;
          timings.serverMs = Math.round(now() - t0);
          return makeBook(my, res);
        })
        .then(function (book) {
          if (!book || my !== state.build) return null;
          state.pages = book.pages;
          state.head = book.head;
          timings.layout = book.stats;
          timings.totalMs = Math.round(now() - t0);
          state.timings = timings;
          var info = {
            pages: state.pages.length,
            interiorPages: state.pages.length - (cfg.mode === "print" ? 0 : 2),
            summary: state.summary,
            timings: timings,
            cache: { hits: shared.cache.hits, misses: shared.cache.misses, size: shared.cache.map.size },
          };
          events.emit("book-ready", info);
          return info;
        })
        .catch(function (e) {
          events.emit("error", { message: String(e && e.message ? e.message : e) });
          throw e;
        });
      state.busy = run;
      return run;
    }

    var api = {
      on: function (t, fn) { events.on(t, fn); return api; },
      off: function (t, fn) { events.off(t, fn); return api; },
      /** spec: {bookId} for a stored book, or {book, recipes} for one held by the client. */
      setBook: function (spec) {
        state.spec = spec;
        state.overrides = {};
        return build();
      },
      /** Replaces a recipe's data (the fields of a recipes/{id} document) and lays the book out again. */
      updateRecipe: function (id, data) {
        state.overrides[id] = data;
        return build();
      },
      setDesign: function (theme, options) {
        cfg.theme = theme;
        cfg.options = options || {};
        return build();
      },
      refresh: function () { return build(); },
      /** The book, the design or both at once (a live editor), laid out again once. */
      update: function (next) {
        if (next.spec) state.spec = next.spec;
        // A recipe's fields as a form has them, before they are saved (N9); {} clears them.
        if (next.overrides) state.overrides = next.overrides;
        if (next.theme) cfg.theme = next.theme;
        if (next.options) cfg.options = next.options;
        return build();
      },
      getDesign: function () { return { theme: cfg.theme, options: cfg.options }; },
      /** Only measures the recipes the server has no measure for (no layout of the book). */
      // opts.limit: at most that many recipes this time (a server measuring in
      // the background goes a few at a time); missing: how many had none.
      measureBook: function (spec, opts) {
        state.spec = spec;
        var my = ++state.build;
        var limit = (opts && opts.limit) || 0;
        return postJson(url("/book"), request()).then(function (res) {
          if (res.status !== "measure") return { measured: 0, missing: 0 };
          var some = limit > 0 ? res.missing.slice(0, limit) : res.missing;
          return measure(some, my).then(function () { return { measured: some.length, missing: res.missing.length }; });
        });
      },
      ready: function () { return state.busy || Promise.resolve(null); },
      getPageCount: function () { return state.pages.length; },
      /** While a book is laid out: the pages of its first blocks done so far (null when none is in progress). */
      getPartialPages: function () { return state.partial ? state.partial() : null; },
      getPages: function () { return state.pages; },
      getSummary: function () { return state.summary; },
      getContent: function () { return state.content; },
      getTimings: function () { return state.timings; },
      /** Puts a copy of page i in el, scaled to el's width (or opts.width px). */
      renderPage: function (i, el, opts) {
        var page = state.pages[i];
        if (!page) return null;
        var copy = page.element.cloneNode(true);
        var w = parseFloat(copy.style.width) || 816;
        var target = (opts && opts.width) || el.clientWidth || w;
        var scale = target / w;
        el.innerHTML = "";
        var box = hostDoc.createElement("div");
        box.style.cssText = "position:relative;overflow:hidden;width:" + w * scale + "px;height:" + (parseFloat(copy.style.height) || w) * scale + "px";
        copy.style.transformOrigin = "0 0";
        copy.style.transform = "scale(" + scale + ")";
        copy.style.position = "absolute";
        copy.style.left = "0";
        copy.style.top = "0";
        box.appendChild(copy);
        el.appendChild(box);
        return box;
      },
      /** Every page in el, one after the other (print, and simple viewers). */
      mount: function (el) {
        el.innerHTML = "";
        state.pages.forEach(function (p) {
          el.appendChild(p.element);
        });
      },
      /** Instant color change: CSS variables on every page, before the new layout arrives. */
      previewVars: function (vars) {
        state.pages.forEach(function (p) {
          var box = p.element.querySelector("[data-vivliostyle-page-box]") || p.element;
          Object.keys(vars || {}).forEach(function (k) { box.style.setProperty(k, vars[k]); });
        });
      },
      cacheStats: function () { return { hits: shared.cache.hits, misses: shared.cache.misses, size: shared.cache.map.size }; },
    };
    return api;
  }

  /** Lays out one whole document (a cover spread) and returns its pages. */
  function layoutDocument(html, opts) {
    var hostDoc = (opts && opts.document) || document;
    var scripts = /<script/i.test(html);
    var prep = scripts ? runScripts(html, hostDoc) : Promise.resolve(html);
    return prep.then(function (doc) {
      var css = (doc.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || "";
      ensureFonts(hostDoc, css);
      return paginator(hostDoc).layout(doc);
    });
  }

  global.CookNestBookEngine = {
    version: ENGINE_VERSION,
    createBookRenderer: createBookRenderer,
    layoutDocument: layoutDocument,
    _internal: {
      forget: function (pred) { Array.from(shared.cache.map.keys()).forEach(function (k) { if (pred(k)) shared.cache.map.delete(k); }); },
      hash: hash, openCss: openCss, blockDocument: blockDocument, writeFolios: writeFolios, fillIndexNumbers: fillIndexNumbers },
  };
})(typeof window !== "undefined" ? window : this);
