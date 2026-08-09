/** Stable hue from a string, so a domain always gets the same colour block. */
export function hueOf(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/** Letter shown inside the colour block: first char of the most significant label. */
export function initialOf(hostname: string): string {
  const labels = hostname.split('.').filter(Boolean);
  const label = labels.length > 1 ? labels[labels.length - 2] : labels[0];
  const char = (label ?? hostname).charAt(0);
  return char ? char.toUpperCase() : '?';
}

/**
 * Chrome's local favicon cache — zero storage, zero network request, and crucially
 * zero leak of the reading list to third parties. Absent on Firefox, where the
 * <img> simply fails to load and the colour block underneath stays visible.
 */
export function faviconUrl(pageUrl: string, size = 32): string | null {
  try {
    // Every context this runs in is an extension page, so `location.origin` is
    // already `chrome-extension://<id>` — no need to hardcode the scheme.
    const url = new URL('/_favicon/', location.origin);
    url.searchParams.set('pageUrl', pageUrl);
    url.searchParams.set('size', String(size));
    return url.toString();
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatShortDate(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatFullDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatPercent(percent: number): string {
  return `${Math.round(percent * 100)}%`;
}

/** Compact `domain/path` for the second line of a row. */
export function shortLocation(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname === '/' ? '' : u.pathname;
    return host + path + (u.search ? u.search : '');
  } catch {
    return rawUrl;
  }
}
