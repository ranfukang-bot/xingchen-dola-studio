(() => {
  'use strict';
  if (window.__WANWAN_DOLA_DURATION_REQUEST_PATCH_SCHEDULED__) return;
  window.__WANWAN_DOLA_DURATION_REQUEST_PATCH_SCHEDULED__ = true;

  const installAfterPageLoad = () => {
    if (window.__WANWAN_DOLA_DURATION_REQUEST_PATCH__) return;
    window.__WANWAN_DOLA_DURATION_REQUEST_PATCH__ = true;

  const DURATION_KEYS = {
    15: 'intl_doubao_enable_15s_v1',
    30: 'intl_doubao_enable_30s_v1'
  };
  const MENU_MARK = 'data-wanwan-dola-duration-menu';
  let lastKnownModelTarget = 0;

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, '').replace(/[✓✔√]/g, '').trim();
  }

  function textOf(element) {
    return cleanText(element?.innerText || element?.textContent || '');
  }

  function visible(element) {
    if (!element || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 2 && rect.height > 2;
  }

  function selectedModelText() {
    const control = document.querySelector(
      '[data-input-engine-actionbar-control-key="video-model"], ' +
      '[data-input-engine-actionbar-control-key="model"]'
    );
    return textOf(control);
  }

  function modelTargetDuration() {
    const text = selectedModelText();
    if (/2\.5|seedance[^\d]*2[^\d]*5/i.test(text)) lastKnownModelTarget = 30;
    else if (/2\.0|seedance[^\d]*2[^\d]*0|seedance[^\d]*fast/i.test(text)) lastKnownModelTarget = 15;
    return lastKnownModelTarget;
  }

  function selectedDuration() {
    const target = modelTargetDuration();
    return target && localStorage.getItem(DURATION_KEYS[target]) === '1' ? target : 0;
  }

  function notifyNativeState() {
    try {
      window.chrome?.webview?.postMessage({
        type: 'DOLA_DURATION_ENHANCEMENT_STATE',
        s15: localStorage.getItem(DURATION_KEYS[15]) === '1',
        s30: localStorage.getItem(DURATION_KEYS[30]) === '1'
      });
    } catch (_) {}
  }

  function saveEnhancedDuration(seconds) {
    const value = Number(seconds);
    if (value !== 15 && value !== 30) return;
    localStorage.setItem(DURATION_KEYS[value], '1');
    localStorage.setItem(DURATION_KEYS[value === 15 ? 30 : 15], '0');
    notifyNativeState();
  }

  function saveNativeDuration(seconds) {
    const value = Number(seconds);
    localStorage.setItem(DURATION_KEYS[15], value === 15 ? '1' : '0');
    localStorage.setItem(DURATION_KEYS[30], '0');
    notifyNativeState();
  }

  function requestUrl(input) {
    return typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input || '');
  }

  function isVideoCompletionEndpoint(input) {
    try {
      const url = new URL(requestUrl(input), location.href);
      const host = url.hostname.replace(/^www\./i, '').toLowerCase();
      const supported = host === 'dola.com' || host.endsWith('.dola.com') ||
        host === 'doubao.com' || host.endsWith('.doubao.com');
      return supported && /\/chat\/completion\/?$/i.test(url.pathname);
    } catch (_) {
      return false;
    }
  }

  function patchAbilityParam(raw, target) {
    if (typeof raw === 'string') {
      let parsed;
      try { parsed = JSON.parse(raw); } catch (_) { return { changed: false, value: raw }; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { changed: false, value: raw };
      }
      parsed.duration = target;
      return { changed: true, value: JSON.stringify(parsed) };
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      raw.duration = target;
      return { changed: true, value: raw };
    }
    return { changed: false, value: raw };
  }

  function patchVideoAbility(node, target, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12) return false;
    let changed = false;
    if (!Array.isArray(node) && Number(node.ability_type) === 17 &&
        Object.prototype.hasOwnProperty.call(node, 'ability_param')) {
      const result = patchAbilityParam(node.ability_param, target);
      if (result.changed) {
        node.ability_param = result.value;
        changed = true;
      }
    }
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const child of values) {
      if (child && typeof child === 'object' && patchVideoAbility(child, target, depth + 1)) {
        changed = true;
      }
    }
    return changed;
  }

  function patchBody(body, url = '') {
    const target = selectedDuration();
    if (!target || typeof body !== 'string' || !body.trim()) return body;
    if (!isVideoCompletionEndpoint(url)) return body;
    let payload;
    try { payload = JSON.parse(body); } catch (_) { return body; }
    return patchVideoAbility(payload, target) ? JSON.stringify(payload) : body;
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function patchedFetch(input, init = {}) {
      const url = requestUrl(input);
      if (init && typeof init.body === 'string') {
        const body = patchBody(init.body, url);
        if (body !== init.body) init = { ...init, body };
      }
      return nativeFetch.call(this, input, init);
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  if (typeof nativeOpen === 'function') {
    XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__wanwanDolaRequestUrl = requestUrl(url);
      return nativeOpen.apply(this, arguments);
    };
  }
  if (typeof nativeSend === 'function') {
    XMLHttpRequest.prototype.send = function patchedSend(body) {
      return nativeSend.call(this, patchBody(body, this.__wanwanDolaRequestUrl || ''));
    };
  }

  function exactDuration(element) {
    const match = textOf(element).match(/^(5|10|15|30)(s|秒)$/i);
    return match ? Number(match[1]) : 0;
  }

  function findDurationMenuRoot() {
    const candidates = Array.from(document.querySelectorAll(
      '[role="menu"], [role="listbox"], [data-slot*="dropdown-menu"], [class*="popover"], [class*="dropdown"], div'
    )).filter(element => element && !element.closest('[data-wanwan-duration-panel]') && visible(element))
      .filter(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 70 || rect.width > 520 || rect.height < 40 || rect.height > 520) return false;
        const text = textOf(element);
        const hasNativeDurations = /5(s|秒)/i.test(text) && /10(s|秒)/i.test(text);
        const wholeToolbar = /Seedance|比例|参考图|模型|Model|Fast/i.test(text) && rect.width > 360;
        return hasNativeDurations && !wholeToolbar;
      }).sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      });
    return candidates[0] || null;
  }

  function replaceDurationLabel(element, target) {
    const replace = value => String(value || '').replace(/(?:5|10|15|30)(s|秒)/ig, target + 's');
    try {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let changed = false;
      while (walker.nextNode()) {
        const next = replace(walker.currentNode.nodeValue);
        if (next !== walker.currentNode.nodeValue) {
          walker.currentNode.nodeValue = next;
          changed = true;
        }
      }
      if (changed) return;
    } catch (_) {}
    element.textContent = target + 's';
  }

  function checkMarks(item) {
    return Array.from(item?.querySelectorAll?.('svg') || []);
  }

  function setSelected(item, selected) {
    item?.setAttribute?.('aria-selected', selected ? 'true' : 'false');
    if (selected) item?.setAttribute?.('data-state', 'checked');
    else item?.removeAttribute?.('data-state');
    for (const mark of checkMarks(item)) mark.style.visibility = selected ? 'visible' : 'hidden';
  }

  function menuOptions(root) {
    return Array.from(root?.querySelectorAll?.('[role="menuitem"], [role="option"], li, button, div') || [])
      .filter(element => element !== root && visible(element) && exactDuration(element) > 0);
  }

  function syncSelection(root, target = modelTargetDuration()) {
    if (!root) return;
    const force = target > 0 && selectedDuration() === target;
    for (const item of menuOptions(root)) {
      const value = exactDuration(item);
      if (force) setSelected(item, value === target);
      else if ((value === 15 || value === 30) && item.getAttribute(MENU_MARK) === String(value) && value !== target) {
        setSelected(item, false);
      }
    }
  }

  function isInsideDurationMenu(element, menu) {
    if (!element) return false;
    if (menu?.contains(element)) return true;
    return !!element.closest?.(
      '[role="menu"], [role="listbox"], ' +
      '[data-slot="dropdown-menu-content"], [data-slot="select-content"], ' +
      '[data-slot="popover-content"]'
    );
  }

  function findDurationTriggers(menu) {
    const candidates = new Set();
    const selectors = [
      '[data-input-engine-actionbar-control-key="video-duration"]',
      '[data-input-engine-actionbar-control-key="duration"]',
      '[data-input-engine-actionbar-control-key*="duration"]',
      'button',
      '[role="button"]',
      '[aria-haspopup="menu"]',
      '[aria-haspopup="listbox"]',
      '[data-slot$="-trigger"]'
    ];
    for (const element of document.querySelectorAll(selectors.join(', '))) {
      const trigger = element.closest?.('button, [role="button"], [aria-haspopup], [data-slot$="-trigger"]') || element;
      if (!visible(trigger) || isInsideDurationMenu(trigger, menu)) continue;
      const rect = trigger.getBoundingClientRect();
      if (rect.width < 28 || rect.width > 220 || rect.height < 20 || rect.height > 90) continue;
      if (!/^(5|10|15|30)(s|秒)$/i.test(textOf(trigger))) continue;
      candidates.add(trigger);
    }
    return Array.from(candidates);
  }

  function clearToolbar() {
    if (!document.body) return;
    for (const trigger of findDurationTriggers(findDurationMenuRoot())) {
      const enhanced = Number(trigger.getAttribute('data-wanwan-enhanced-duration') || 0);
      const current = exactDuration(trigger);
      const original = Number(trigger.getAttribute('data-wanwan-original-duration') || 0);
      if (enhanced && current === enhanced && original && original !== enhanced) {
        replaceDurationLabel(trigger, original);
      }
      trigger.removeAttribute('data-wanwan-enhanced-duration');
      trigger.removeAttribute('data-wanwan-original-duration');
      trigger.removeAttribute('data-wanwan-duration-boost');
    }
  }

  function updateToolbar(seconds) {
    if (!document.body || !(seconds === 15 || seconds === 30)) return;
    const menu = findDurationMenuRoot();
    const triggers = findDurationTriggers(menu);
    for (const trigger of triggers) {
      const current = exactDuration(trigger);
      if (current && current !== seconds && !trigger.getAttribute('data-wanwan-original-duration')) {
        trigger.setAttribute('data-wanwan-original-duration', String(current));
      }
      if (current !== seconds) replaceDurationLabel(trigger, seconds);
      trigger.setAttribute('data-wanwan-enhanced-duration', String(seconds));
      trigger.removeAttribute('data-wanwan-duration-boost');
    }
  }

  function holdToolbar(seconds) {
    for (const delay of [0, 50, 120, 300]) {
      setTimeout(() => {
        if (selectedDuration() === seconds) updateToolbar(seconds);
        else clearToolbar();
      }, delay);
    }
  }

  function syncModelAvailability(root) {
    const allow15 = modelTargetDuration() !== 30;
    for (const item of menuOptions(root)) {
      if (exactDuration(item) !== 15 || item.hasAttribute(MENU_MARK)) continue;
      item.style.display = allow15 ? '' : 'none';
      if (!allow15) item.setAttribute('aria-hidden', 'true');
      else item.removeAttribute('aria-hidden');
    }
    if (!allow15 && localStorage.getItem(DURATION_KEYS[15]) === '1') {
      localStorage.setItem(DURATION_KEYS[15], '0');
      notifyNativeState();
    }
  }

  function injectDurationOption() {
    const root = findDurationMenuRoot();
    if (!root) return;
    const target = selectedDuration();
    syncModelAvailability(root);
    let options = menuOptions(root).filter(item => visible(item));
    if (!options.length) return;
    for (const item of options) {
      const injected = Number(item.getAttribute(MENU_MARK) || 0);
      if ((injected === 15 || injected === 30) && injected !== target) item.remove();
    }
    options = menuOptions(root).filter(item => visible(item));
    if (target && !options.some(item => exactDuration(item) === target)) {
      const template = options.find(item => exactDuration(item) === 10) || options[0];
      if (!template?.parentElement) return;
      const clone = template.cloneNode(true);
      clone.removeAttribute('aria-selected');
      clone.removeAttribute('data-state');
      clone.setAttribute(MENU_MARK, String(target));
      clone.setAttribute('aria-selected', 'false');
      clone.classList.add('wanwan-duration-option');
      replaceDurationLabel(clone, target);
      for (const mark of checkMarks(clone)) mark.style.visibility = 'hidden';
      clone.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        saveEnhancedDuration(target);
        syncSelection(root, target);
        holdToolbar(target);
        setTimeout(() => {
          try {
            const options = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', options));
            document.dispatchEvent(new KeyboardEvent('keydown', options));
            document.dispatchEvent(new KeyboardEvent('keyup', options));
          } catch (_) {}
        }, 60);
      }, true);
      template.parentElement.appendChild(clone);
    }
    for (const item of menuOptions(root)) {
      const value = exactDuration(item);
      if ((value === 5 || value === 10 || (value === 15 && modelTargetDuration() !== 30)) &&
          !item.hasAttribute(MENU_MARK) &&
          !item.hasAttribute('data-wanwan-native-duration')) {
        item.setAttribute('data-wanwan-native-duration', String(value));
        item.addEventListener('click', () => {
          saveNativeDuration(value);
          syncSelection(root);
          clearToolbar();
          setTimeout(clearToolbar, 50);
          setTimeout(clearToolbar, 120);
          setTimeout(clearToolbar, 300);
        }, true);
      }
    }
    syncSelection(root, target);
  }

  function syncModelDurationState() {
    if (modelTargetDuration() !== 30) return;
    if (localStorage.getItem(DURATION_KEYS[15]) === '1') {
      localStorage.setItem(DURATION_KEYS[15], '0');
      notifyNativeState();
    }
    for (const trigger of findDurationTriggers(null)) {
      if (exactDuration(trigger) === 15) {
        replaceDurationLabel(trigger, 10);
        trigger.removeAttribute('data-wanwan-enhanced-duration');
        trigger.removeAttribute('data-wanwan-original-duration');
      }
    }
  }

  function enhance() {
    syncModelDurationState();
    injectDurationOption();
    const target = selectedDuration();
    if (target) updateToolbar(target);
    else clearToolbar();
  }

  let toolbarSyncPending = false;
  function scheduleToolbarSync() {
    if (toolbarSyncPending) return;
    toolbarSyncPending = true;
    setTimeout(() => {
      toolbarSyncPending = false;
      injectDurationOption();
      const target = selectedDuration();
      if (target) updateToolbar(target);
      else clearToolbar();
    }, 40);
  }

  const style = document.createElement('style');
  style.textContent = [
    '.wanwan-duration-option{margin-left:6px!important}'
  ].join('');
  (document.documentElement || document.head)?.appendChild(style);
  window.addEventListener('wanwan-duration-enhancement-changed', event => {
    const seconds = Number(event?.detail?.seconds || 0);
    const enabled = event?.detail?.enabled !== false;
    if (!enabled && (seconds === 15 || seconds === 30)) clearToolbar();
    enhance();
    notifyNativeState();
  });
  enhance();
  notifyNativeState();
  try {
    new MutationObserver(scheduleToolbarSync).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true
    });
  } catch (_) {}
  setInterval(enhance, 700);
  setInterval(scheduleToolbarSync, 250);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installAfterPageLoad, { once: true });
  } else {
    setTimeout(installAfterPageLoad, 0);
  }
})();
