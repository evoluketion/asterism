/** Local names and IP addresses are usually dev servers without TLS, so they default to http. */
const LOCAL_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[::1\])(:\d{1,5})?([/?#].*)?$/i;
const BARE_HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?([/?#].*)?$/i;
/** Schemes a page could be opened with but browser panes refuse; any other text with a colon is a search. */
const REFUSED_SCHEME = /^(about|blob|chrome|chrome-extension|data|devtools|file|filesystem|ftp|javascript|view-source|ws|wss):/i;

/** The page a new browser pane opens on. */
export const HOME_URL = 'https://www.google.com/';

/** What the address field means: `{ url }` to load, or `{ error }`. Text that isn't an address is searched on Google. */
export function toUrl(text) {
  const t = String(text ?? '').trim();
  if (!t) return { error: 'Type an address or something to search for.' };
  if (t.toLowerCase() === 'about:blank') return { url: 'about:blank' };
  if (/^https?:\/\//i.test(t)) return parsed(t);
  if (REFUSED_SCHEME.test(t)) return { error: `Browser panes only open http and https addresses, not "${t}".` };
  if (!/\s/.test(t) && LOCAL_HOST.test(t)) return parsed(`http://${t}`);
  if (!/\s/.test(t) && BARE_HOST.test(t)) return parsed(`https://${t}`);
  return { url: `https://www.google.com/search?q=${encodeURIComponent(t)}` };
}

function parsed(candidate) {
  try {
    return { url: new URL(candidate).href };
  } catch {
    return { error: `"${candidate}" is not a web address.` };
  }
}
