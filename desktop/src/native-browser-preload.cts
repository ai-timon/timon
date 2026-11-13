// A browser page can request a prompt; it receives no IPC object or other host capability.
const { contextBridge, ipcRenderer, webFrame } = require('electron') as typeof import('electron');

// The window.chrome shim of native-browser-chrome-shim.ts, again in the main frame: DevTools'
// copy runs in every frame, this one covers a document Electron gives a new window.chrome after
// it, and a popup's first document that DevTools reached too late. The shim is idempotent. A
// sandboxed preload can require nothing but `electron`: native-browser-preload.test.ts compares the copies.
const CHROME_SHIM_SOURCE = String.raw`(() => {
  if (!window.chrome || typeof window.chrome !== 'object') window.chrome = {};
  const chrome = window.chrome;
  if (chrome.loadTimes && chrome.csi && chrome.app) return;
  const natives = new WeakMap();
  const native = (holder, name) => { natives.set(holder[name], 'function ' + name + '() { [native code] }'); return holder[name]; };
  if (!chrome.loadTimes) chrome.loadTimes = native({ loadTimes() {
    const now = Date.now() / 1000;
    return { commitLoadTime: now, connectionInfo: 'h2', finishDocumentLoadTime: now, finishLoadTime: now,
      firstPaintAfterLoadTime: 0, firstPaintTime: now, navigationType: 'Other', npnNegotiatedProtocol: 'h2',
      requestTime: now, startLoadTime: now, wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true,
      wasNpnNegotiated: true };
  } }, 'loadTimes');
  if (!chrome.csi) chrome.csi = native({ csi() {
    return { onloadT: Date.now(), pageT: performance.now(), startE: Date.now(), tran: 15 };
  } }, 'csi');
  if (!chrome.app) {
    const methods = {
      getDetails() { return null; },
      getIsInstalled() { return false; },
      runningState() { return 'cannot_run'; },
    };
    chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: native(methods, 'getDetails'),
      getIsInstalled: native(methods, 'getIsInstalled'),
      runningState: native(methods, 'runningState'),
    };
  }
  const toString = new Proxy(Function.prototype.toString, {
    apply(target, self, args) {
      const known = natives.get(self);
      return known === undefined ? Reflect.apply(target, self, args) : known;
    },
  });
  natives.set(toString, 'function toString() { [native code] }');
  Function.prototype.toString = toString;
})();`;
try { void webFrame.executeJavaScript(CHROME_SHIM_SOURCE).catch(() => {}); } catch { /* Never break the page. */ }
contextBridge.exposeInMainWorld('__timonNativePrompt', (message: string, defaultPrompt: string): string | null =>
  ipcRenderer.sendSync('timon:native-browser-prompt', message, defaultPrompt));

// Recorder (TODO #461), then annotator (TODO #468). They live in this isolated world, so the page
// sees neither the listeners nor the channel and cannot forge a step or a pick: what it dispatches
// itself arrives with isTrusted=false.
// A sandboxed preload can require nothing but `electron`, so the secret rule is copied from
// native-browser-recorder.ts; native-browser-preload.test.ts compares the two.
(() => {
  const SECRET_TYPES = ['password'];
  const SECRET_AUTOCOMPLETE = new RegExp('(?:^|\\s)(?:current-password|new-password|one-time-code|cc-number|cc-csc)(?:\\s|$)', 'i');
  const BUTTON_TYPES = ['button', 'submit', 'reset', 'image'];
  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[role=option],[role=switch]';
  // A "show password" toggle turns the field into text before `change`: remember what was secret.
  const everSecret = new WeakSet<Element>();
  let recording = false;
  try { recording = ipcRenderer.sendSync('timon:record-state') === true; } catch { /* Never break the page. */ }
  ipcRenderer.on('timon:record-toggle', (_event: unknown, active: unknown) => { recording = active === true; });

  const lower = (value: unknown) => String(value ?? '').toLowerCase();
  const attribute = (element: Element, name: string) => element.getAttribute(name) ?? '';
  const quoted = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;
  const typeOf = (element: Element) => lower((element as HTMLInputElement).type);
  const isSecret = (element: Element) => everSecret.has(element)
    || SECRET_TYPES.includes(typeOf(element)) || SECRET_AUTOCOMPLETE.test(attribute(element, 'autocomplete'));
  // A rich-text editor holds what the user typed: its text is a value, not a label.
  const isEditable = (element: Element) => (element as HTMLElement).isContentEditable === true
    || /^(textbox|searchbox|combobox)$/.test(attribute(element, 'role'));
  const markSecret = (element: Element) => {
    if (SECRET_TYPES.includes(typeOf(element)) || SECRET_AUTOCOMPLETE.test(attribute(element, 'autocomplete'))) everSecret.add(element);
  };

  // CSS path: id, else a stable attribute hook, else nth-of-type, up to the nearest id or the root.
  const cssPath = (start: Element) => {
    const parts: string[] = [];
    for (let element: Element | null = start; element && parts.length < 12; element = element.parentElement) {
      let part = element.nodeName.toLowerCase();
      if (element.id) { parts.unshift(`${part}#${CSS.escape(element.id)}`); break; }
      const hook = attribute(element, 'data-testid') || attribute(element, 'data-test-id');
      const name = attribute(element, 'name');
      const label = attribute(element, 'aria-label');
      if (hook) part += `[data-testid=${quoted(hook)}]`;
      else if (name) part += `[name=${quoted(name)}]`;
      else if (label) part += `[aria-label=${quoted(label)}]`;
      else {
        let nth = 1;
        for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
          if (sibling.nodeName === element.nodeName) nth++;
        }
        if (nth > 1 || element.nextElementSibling) part += `:nth-of-type(${nth})`;
      }
      parts.unshift(part);
    }
    return parts.join(' > ').slice(0, 500);
  };

  const roleOf = (element: Element) => {
    const explicit = attribute(element, 'role');
    if (explicit) return explicit.split(/\s+/)[0]!;
    const tag = element.nodeName.toLowerCase();
    const type = typeOf(element);
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || (tag === 'input' && BUTTON_TYPES.includes(type))) return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') return type === 'checkbox' || type === 'radio' ? type : type === 'file' ? '' : 'textbox';
    return '';
  };

  // Accessible name from what the page shows about the element; a field's value is never one of them.
  const nameOf = (element: Element) => {
    const labelled = attribute(element, 'aria-labelledby').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    const labels = (element as HTMLInputElement).labels;
    const fieldLike = isEditable(element)
      || (/^(input|select|textarea)$/.test(element.nodeName.toLowerCase()) && !BUTTON_TYPES.includes(typeOf(element)));
    const name = attribute(element, 'aria-label') || labelled || (labels && labels[0] ? labels[0].textContent ?? '' : '')
      || attribute(element, 'placeholder') || attribute(element, 'title') || attribute(element, 'alt')
      || (fieldLike ? '' : (element as HTMLElement).innerText ?? '');
    return name.replace(/\s+/g, ' ').trim().slice(0, 120);
  };

  // Visible label of a clicked element. A filled field's value is never read: it would copy what was typed.
  const clickText = (element: Element) => {
    const tag = element.nodeName.toLowerCase();
    if (tag === 'input') return BUTTON_TYPES.includes(typeOf(element)) && !isSecret(element) ? String((element as HTMLInputElement).value ?? '') : '';
    if (tag === 'textarea' || tag === 'select' || isSecret(element) || isEditable(element)) return '';
    return String((element as HTMLElement).innerText ?? '');
  };

  const describe = (element: Element) => ({
    selector: cssPath(element), tag: element.nodeName.toLowerCase(), inputType: typeOf(element),
    autocomplete: attribute(element, 'autocomplete').slice(0, 256), role: roleOf(element), name: nameOf(element),
  });
  const targetOf = (event: Event) => {
    const first = event.composedPath()[0];
    return first instanceof Element ? first : null;
  };
  const send = (payload: Record<string, unknown>) => {
    try { ipcRenderer.send('timon:record-event', payload); } catch { /* Never break the page. */ }
  };

  window.addEventListener('input', (event) => {
    const target = targetOf(event);
    if (target) markSecret(target);
  }, true);
  window.addEventListener('click', (event) => {
    if (!recording || !event.isTrusted) return;
    const target = targetOf(event);
    if (!target) return;
    const element = target.closest(INTERACTIVE) ?? target;
    send({ type: 'click', ...describe(element), text: clickText(element).replace(/\s+/g, ' ').trim().slice(0, 120) });
  }, true);
  window.addEventListener('change', (event) => {
    if (!recording || !event.isTrusted) return;
    const element = targetOf(event);
    if (!element || !/^(input|select|textarea)$/.test(element.nodeName.toLowerCase())) return;
    const field = (attribute(element, 'name') || element.id || attribute(element, 'aria-label') || attribute(element, 'placeholder')).slice(0, 64);
    const base = { type: 'input', ...describe(element), field };
    // The value of a secret field is never read: only a placeholder crosses the channel.
    if (isSecret(element)) { send({ ...base, value: `{SECRET:${field.replace(/[{}]/g, '') || typeOf(element) || 'secret'}}` }); return; }
    const type = typeOf(element);
    if (type === 'file') { send(base); return; }
    if (type === 'checkbox' || type === 'radio') { send({ ...base, value: (element as HTMLInputElement).checked ? 'checked' : 'unchecked' }); return; }
    if (element instanceof HTMLSelectElement) {
      send({ ...base, value: element.value.slice(0, 500), text: (element.selectedOptions[0]?.textContent ?? '').trim().slice(0, 120) });
      return;
    }
    send({ ...base, value: String((element as HTMLInputElement).value ?? '').slice(0, 500) });
  }, true);
  window.addEventListener('keydown', (event) => {
    if (!recording || !event.isTrusted || event.key !== 'Enter' || event.isComposing) return;
    const target = targetOf(event);
    send({ type: 'enter', ...(target ? { selector: cssPath(target), tag: target.nodeName.toLowerCase(), inputType: typeOf(target) } : {}) });
  }, true);

  // Annotator (TODO #468). While the user annotates, every pointer gesture stops here, before any
  // listener of the page: no click, no focus, no menu reaches it. The listener sits on `window` in
  // capture with `passive: false`, or Chromium makes touchstart passive and the default still runs.
  // A prevented pointerdown suppresses mousedown/mouseup, yet click, auxclick (right button too),
  // dblclick and contextmenu still arrive: all of them are swallowed. Only isTrusted input counts.
  // The engine masks what is sent here again (native-browser-annotator.ts).
  const SWALLOWED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu',
    'touchstart', 'touchmove', 'touchend', 'touchcancel'];
  const STRIPPED = 'script,style,noscript,template,iframe,object,embed';
  const OUTER_HTML_MAX = 8 * 1024;
  const OUTER_HTML_MAX_ELEMENTS = 2_000;
  const TRUNCATED_MARK = '<!--timon:truncated-->';
  let annotating = false;
  let hovered: Element | null = null;
  let hoverAt = 0;
  let pickedAt = 0;
  try { annotating = ipcRenderer.sendSync('timon:annotate-state') === true; } catch { /* Never break the page. */ }
  ipcRenderer.on('timon:annotate-toggle', (_event: unknown, active: unknown) => { annotating = active === true; hovered = null; });
  const annotate = (payload: Record<string, unknown>) => {
    try { ipcRenderer.send('timon:annotate-event', payload); } catch { /* Never break the page. */ }
  };
  const box = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };

  // Absolute only: an element under a shadow root gets none rather than a path that finds another one.
  const xpathOf = (start: Element) => {
    const parts: string[] = [];
    let element: Element | null = start;
    for (; element && parts.length < 64; element = element.parentElement) {
      let index = 1;
      for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.nodeName === element.nodeName) index++;
      }
      parts.unshift(`${element.nodeName.toLowerCase()}[${index}]`);
      if (element === document.documentElement) return `/${parts.join('/')}`.slice(0, 500);
    }
    return '';
  };

  // The element's markup without what a page should not hand over: code, styles, field values.
  const outerHtmlOf = (element: Element) => {
    const whole = element.getElementsByTagName('*').length <= OUTER_HTML_MAX_ELEMENTS;
    const clone = element.cloneNode(whole) as Element;
    for (const child of [...clone.querySelectorAll(STRIPPED)]) child.remove();
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const name of node.getAttributeNames()) {
        if (name === 'value' || name === 'srcdoc' || name.startsWith('on')) node.removeAttribute(name);
      }
      const editable = node.getAttribute('contenteditable');
      if (node.nodeName === 'TEXTAREA' || (editable !== null && editable !== 'false')) node.textContent = '';
    }
    const html = clone.outerHTML;
    return html.length > OUTER_HTML_MAX || !whole ? `${html.slice(0, OUTER_HTML_MAX)}${TRUNCATED_MARK}` : html;
  };

  const pickOf = (element: Element, x: number, y: number) => {
    const secret = isSecret(element);
    return {
      type: 'pick', point: { x, y }, ...describe(element), xpath: xpathOf(element), id: element.id.slice(0, 128),
      classes: [...element.classList].slice(0, 20), secret, editable: isEditable(element),
      text: clickText(element).replace(/\s+/g, ' ').trim().slice(0, 300), rect: box(element),
      viewport: { width: window.innerWidth, height: window.innerHeight }, scroll: { x: window.scrollX, y: window.scrollY },
      outerHtml: secret ? '' : outerHtmlOf(element),
    };
  };

  const swallow = (event: Event) => {
    if (!annotating || !event.isTrusted) return;
    event.stopImmediatePropagation();
    if (event.cancelable) event.preventDefault();
    const target = targetOf(event);
    if (!target) return;
    let point: { x: number; y: number } | null = null;
    if (event.type === 'click' && (event as MouseEvent).button === 0 && (event as MouseEvent).detail <= 1) {
      // A click from the keyboard (Enter on a focused button) has no position: point at the element.
      const mouse = event as MouseEvent;
      const rect = box(target);
      point = mouse.detail === 0 ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } : { x: mouse.clientX, y: mouse.clientY };
    } else if (event.type === 'touchend') {
      const touch = (event as TouchEvent).changedTouches[0];
      if (touch) point = { x: touch.clientX, y: touch.clientY };
    }
    // Touch emulation turns one mouse click into touch events and a click: one pick, not two.
    if (!point || Date.now() - pickedAt < 400) return;
    pickedAt = Date.now();
    annotate({ ...pickOf(target, point.x, point.y), anchor: remember(target) });
  };
  for (const type of SWALLOWED) window.addEventListener(type, swallow, { capture: true, passive: false });

  // Anchors (TODO #481): the bubble and the pins of Timon sit over the page in views of their own,
  // so their element's rectangle is reported as the page moves it. An anchor names an element this
  // preload picked; the page sees neither the names nor the reports. At most ~30 reports a second.
  const ANCHORS_MAX = 64;
  const anchors = new Map<string, WeakRef<Element>>();
  let anchorCount = 0;
  let followed: string[] = [];
  let reportQueued = false;
  let reportedAt = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let resized: ResizeObserver | null = null;
  const remember = (element: Element) => {
    const anchor = `a${++anchorCount}`;
    anchors.set(anchor, new WeakRef(element));
    for (const key of anchors.keys()) {
      if (anchors.size <= ANCHORS_MAX) break;
      if (!followed.includes(key)) anchors.delete(key);
    }
    return anchor;
  };
  const report = () => {
    reportQueued = false;
    reportedAt = Date.now();
    if (!annotating || !followed.length) return;
    annotate({ type: 'rects', rects: followed.map((anchor) => {
      const element = anchors.get(anchor)?.deref();
      return { anchor, rect: element && element.isConnected ? box(element) : null };
    }) });
  };
  const follow = () => {
    if (!annotating || !followed.length || reportQueued) return;
    reportQueued = true;
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (run: () => void) => setTimeout(run, 16);
    frame(() => {
      const wait = 32 - (Date.now() - reportedAt);
      if (wait > 0) setTimeout(report, wait); else report();
    });
  };
  window.addEventListener('scroll', follow, { capture: true, passive: true });
  window.addEventListener('resize', follow, { capture: true, passive: true });
  ipcRenderer.on('timon:annotate-track', (_event: unknown, list: unknown) => {
    followed = Array.isArray(list) ? list.filter((anchor): anchor is string => typeof anchor === 'string' && anchors.has(anchor)).slice(0, 21) : [];
    resized?.disconnect();
    resized = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (!followed.length) return;
    // A layout change that moves no scroller (an expanding list, a late image) is caught by these.
    if (typeof ResizeObserver === 'function') {
      resized = new ResizeObserver(follow);
      for (const anchor of followed) { const element = anchors.get(anchor)?.deref(); if (element) resized.observe(element); }
    }
    heartbeat = setInterval(follow, 1000);
    follow();
  });

  // Hover feeds the host's highlight: one message per element entered, at most every 50 ms.
  window.addEventListener('pointermove', (event) => {
    if (!annotating || !event.isTrusted) return;
    const target = targetOf(event);
    const now = Date.now();
    if (!target || target === hovered || now - hoverAt < 50) return;
    hovered = target;
    hoverAt = now;
    annotate({ type: 'hover', tag: target.nodeName.toLowerCase(), rect: box(target) });
  }, { capture: true, passive: true });

  // Escape leaves annotate mode; the page sees neither its keydown nor its keyup.
  const escape = (event: KeyboardEvent) => {
    if (!annotating || !event.isTrusted || event.key !== 'Escape') return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (event.type === 'keydown') annotate({ type: 'exit', reason: 'escape' });
  };
  window.addEventListener('keydown', escape, { capture: true, passive: false });
  window.addEventListener('keyup', escape, { capture: true, passive: false });

  // The PWA points at a video of the page: the main process relays its point here.
  ipcRenderer.on('timon:annotate-pick-at', (_event: unknown, request: unknown) => {
    if (!annotating || !request || typeof request !== 'object') return;
    const { requestId, x, y, preview } = request as Record<string, unknown>;
    if (typeof requestId !== 'string' || typeof x !== 'number' || typeof y !== 'number') return;
    const found = document.elementFromPoint(x, y);
    if (!found) { annotate({ type: 'miss', requestId }); return; }
    if (preview === true) annotate({ type: 'hover', requestId, tag: found.nodeName.toLowerCase(), rect: box(found) });
    // Remembered like a click in the view: the PWA's pin follows its element as the page scrolls.
    else annotate({ ...pickOf(found, x, y), requestId, anchor: remember(found) });
  });
})();
