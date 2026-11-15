// SPDX-License-Identifier: GPL-3.0-or-later

const SELECTOR = 'form#fm1 input[name="token"]';
const WATCH_ATTRIBUTES = [
  'type', 'autocomplete', 'inputmode', 'class', 'name', 'id',
  'enterkeyhint', 'autocapitalize', 'spellcheck',
];
// Bail out if a page script repeatedly reverts our attribute changes.
const REPAIR_LIMIT = 30;
const REPAIR_WINDOW = 2000;

export function startOtpFix(version: string): () => void {
  let observer: MutationObserver | undefined;
  let stopped = false;
  const repairs: number[] = [];

  function halt(): void {
    stopped = true;
    observer?.disconnect();
    document.removeEventListener('DOMContentLoaded', start);
    document.removeEventListener('readystatechange', start);
    window.removeEventListener('load', start);
  }

  function overloaded(): boolean {
    const now = Date.now();
    while (repairs.length && now - repairs[0] > REPAIR_WINDOW) repairs.shift();
    repairs.push(now);
    return repairs.length > REPAIR_LIMIT;
  }

  function patch(input: HTMLInputElement): void {
    if (stopped) return;
    let repaired = false;
    if (input.type !== 'text') {
      input.type = 'text';
      repaired = true;
    }
    const attributes = {
      autocomplete: 'one-time-code',
      inputmode: 'numeric',
      enterkeyhint: 'done',
      autocapitalize: 'none',
    };
    for (const [name, value] of Object.entries(attributes)) {
      if (input.getAttribute(name) !== value) {
        input.setAttribute(name, value);
        repaired = true;
      }
    }
    if (input.spellcheck) {
      input.spellcheck = false;
      repaired = true;
    }
    if (input.classList.contains('pwd')) {
      input.classList.remove('pwd');
      repaired = true;
    }
    const label = input.closest('label.mdc-text-field');
    if (label?.classList.contains('caps-check')) {
      label.classList.remove('caps-check');
      repaired = true;
    }
    if (repaired && overloaded()) {
      halt();
      return;
    }
    // Scope to the token field container so we don't hide a password field's reveal button.
    const field = input.closest('section.cas-field') || input.closest('.form-group') || label;
    const reveal = field?.querySelector<HTMLButtonElement>('.reveal-password');
    if (reveal) {
      reveal.disabled = true;
      reveal.tabIndex = -1;
      reveal.setAttribute('aria-hidden', 'true');
      reveal.style.setProperty('display', 'none', 'important');
    }
    field?.querySelectorAll<HTMLElement>('.mdc-text-field-helper-line, .mdc-text-field-helper-text').forEach(helper => {
      if (/caps\s*lock/i.test(helper.textContent || '')) {
        helper.setAttribute('aria-hidden', 'true');
        helper.style.setProperty('display', 'none', 'important');
      }
    });
    if (input.dataset.sisLoginFixVersion !== version) {
      input.dataset.sisLoginFixVersion = version;
    }
  }

  function scan(root: Document | Element): void {
    if (stopped) return;
    if (root instanceof HTMLInputElement && root.matches(SELECTOR)) patch(root);
    root.querySelectorAll<HTMLInputElement>(SELECTOR).forEach(patch);
  }

  function start(): void {
    if (stopped) return;
    scan(document);
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof Element) {
          scan(record.target);
          if (record.attributeName === 'class') {
            const field = record.target.closest('section.cas-field, .form-group, label.mdc-text-field');
            if (field && field !== record.target) scan(field);
          }
        }
        if (record.type === 'childList') {
          record.addedNodes.forEach(node => {
            if (node instanceof Element) scan(node);
          });
          if (record.target instanceof Element) {
            const field = record.target.closest('section.cas-field, .form-group, label.mdc-text-field, form#fm1');
            if (field) scan(field);
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCH_ATTRIBUTES,
    });
  }

  start();
  document.addEventListener('DOMContentLoaded', start, { once: true });
  if (!document.documentElement) document.addEventListener('readystatechange', start, { once: true });
  window.addEventListener('load', start, { once: true });
  return halt;
}
