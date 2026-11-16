/** Local names and IP addresses are usually dev servers without TLS, so they default to http. */
const LOCAL_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[::1\])(:\d{1,5})?([/?#].*)?$/i;
const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?([/?#].*)?$/i;

/** What the address field means: `{ url }` to load, or `{ error }` for text that isn't an address. */
export function toUrl(text) {
  const t = String(text ?? '').trim();
  if (!t) return { error: 'Type an address, such as example.com or localhost:3000.' };
  if (t.toLowerCase() === 'about:blank') return { url: 'about:blank' };
  if (/^https?:\/\//i.test(t)) return parsed(t);
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(t)) return { error: `Browser panes only open http and https addresses, not "${t}".` };
  if (LOCAL_HOST.test(t)) return parsed(`http://${t}`);
  if (BARE_HOST.test(t)) return parsed(`https://${t}`);
  return { error: `"${t}" is not a web address.` };
}

function parsed(candidate) {
  try {
    return { url: new URL(candidate).href };
  } catch {
    return { error: `"${candidate}" is not a web address.` };
  }
}
