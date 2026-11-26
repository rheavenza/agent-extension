/**
 * Functions injected into the user's tabs with chrome.scripting.executeScript.
 * They are serialized, so each one must be fully self-contained: no imports, no outer variables.
 * They run with the page's origin, so the browser attaches the user's session cookies on its own.
 */

export interface InPageResponse {
  ok: boolean;
  status: number;
  text: string;
  hasToken: boolean;
  url: string;
}

/** ServiceNow REST call (MAIN world, so it can read window.g_ck). */
export async function snowFetchInPage(
  path: string,
  method: string,
  body: string | null,
  accept: string | null = null,
): Promise<InPageResponse> {
  const w = window as unknown as Record<string, any>;
  let token: string | undefined = typeof w.g_ck === 'string' ? w.g_ck : undefined;
  if (!token) {
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const t = (f.contentWindow as any)?.g_ck;
        if (typeof t === 'string' && t) {
          token = t;
          break;
        }
      } catch {
        /* cross-origin frame */
      }
    }
  }
  if (!token) {
    for (const s of Array.from(document.scripts)) {
      const m = /g_ck\s*=\s*['"]([^'"]+)['"]/.exec(s.textContent ?? '');
      if (m) {
        token = m[1];
        break;
      }
    }
  }
  // Attachment downloads (/file) must accept any type; everything else is JSON.
  const headers: Record<string, string> = { Accept: accept ?? 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['X-UserToken'] = token;
  const res = await fetch(path, { method, headers, body: body ?? undefined, credentials: 'same-origin' });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text: text.slice(0, 3_000_000), hasToken: !!token, url: res.url };
}

/** Splunk Web splunkd proxy call (ISOLATED world, reading the CSRF cookie). */
export async function splunkFetchInPage(
  path: string,
  method: string,
  form: Record<string, string> | null,
): Promise<InPageResponse> {
  const cookies = document.cookie.split(';').map((c) => c.trim());
  const port = location.port || (location.protocol === 'https:' ? '443' : '80');
  const csrf =
    cookies.find((c) => c.startsWith(`splunkweb_csrf_token_${port}=`)) ??
    cookies.find((c) => c.startsWith('splunkweb_csrf_token_'));
  const token = csrf ? decodeURIComponent(csrf.slice(csrf.indexOf('=') + 1)) : undefined;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (token) headers['X-Splunk-Form-Key'] = token;
  let body: URLSearchParams | undefined;
  if (form) {
    body = new URLSearchParams(form);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await fetch(path, { method, headers, body, credentials: 'same-origin' });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text: text.slice(0, 5_000_000), hasToken: !!token, url: res.url };
}

/** Visible text of the page, including open shadow roots and same-origin iframes. */
export function pageTextInPage(maxChars: number): { title: string; url: string; text: string; truncated: boolean } {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS']);
  const BLOCK = /^(DIV|P|LI|TR|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|TABLE|UL|OL|BR|LABEL|TEXTAREA|PRE)$/;
  const chunks: string[] = [];
  let size = 0;
  const push = (s: string) => {
    if (size > maxChars) return;
    chunks.push(s);
    size += s.length;
  };
  const visible = (el: Element) => {
    const view = el.ownerDocument.defaultView;
    if (!view) return true;
    const cs = view.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const walk = (node: Node) => {
    if (size > maxChars) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent?.replace(/\s+/g, ' ').trim();
      if (t) push(t + ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (SKIP.has(el.tagName.toUpperCase()) || !visible(el)) return;
      if (el instanceof HTMLInputElement && el.type !== 'hidden' && el.type !== 'password' && el.value) {
        const label = el.getAttribute('aria-label') || el.name || el.id;
        push(`[${label}: ${el.value}] `);
      }
      if (el instanceof HTMLTextAreaElement && el.value) push(`[${el.getAttribute('aria-label') || el.name || el.id}: ${el.value}]\n`);
      if (el instanceof HTMLSelectElement) {
        const opt = el.selectedOptions[0];
        if (opt) push(`[${el.getAttribute('aria-label') || el.name || el.id}: ${opt.text}] `);
      }
      if (el instanceof HTMLIFrameElement) {
        try {
          if (el.contentDocument?.body) walk(el.contentDocument.body);
        } catch {
          /* cross-origin */
        }
        return;
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
    for (const child of Array.from(node.childNodes)) walk(child);
    if (node.nodeType === Node.ELEMENT_NODE && BLOCK.test((node as Element).tagName)) push('\n');
  };
  walk(document.body);
  const text = chunks.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return { title: document.title, url: location.href, text: text.slice(0, maxChars), truncated: size > maxChars };
}
