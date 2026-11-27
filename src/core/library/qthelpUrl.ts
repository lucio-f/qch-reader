/** A parsed `qthelp://<namespace>/<virtual folder>/<path>#<fragment>` URL. */
export interface QtHelpUrl {
  readonly namespace: string;
  /** Decoded path including the virtual folder, without leading slash: `qtcore/qstring.html`. */
  readonly path: string;
  /** Decoded fragment without `#`, or empty. */
  readonly fragment: string;
}

export type ResolvedReference =
  | { readonly kind: 'qthelp'; readonly url: QtHelpUrl }
  | { readonly kind: 'fragment'; readonly fragment: string }
  | { readonly kind: 'external'; readonly href: string }
  | { readonly kind: 'unsupported'; readonly href: string };

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto', 'ftp', 'ftps', 'news', 'irc']);

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Resolves `.`/`..` segments and removes empty ones. */
export function normalizeSegments(segments: readonly string[]): string[] {
  const result: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      result.pop();
    } else {
      result.push(segment);
    }
  }
  return result;
}

function splitFragment(text: string): [path: string, fragment: string] {
  const hash = text.indexOf('#');
  const withoutFragment = hash < 0 ? text : text.slice(0, hash);
  const fragment = hash < 0 ? '' : safeDecode(text.slice(hash + 1));
  const query = withoutFragment.indexOf('?');
  return [query < 0 ? withoutFragment : withoutFragment.slice(0, query), fragment];
}

export function parseQtHelpUrl(text: string): QtHelpUrl | undefined {
  const match = /^qthelp:\/\/([^/?#]*)(.*)$/i.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const namespace = safeDecode(match[1] ?? '');
  const [rawPath, fragment] = splitFragment(match[2] ?? '');
  const path = normalizeSegments(rawPath.split('/').map(safeDecode)).join('/');
  if (!namespace) {
    return undefined;
  }
  return { namespace, path, fragment };
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/%2B/gi, '+').replace(/%40/g, '@'))
    .join('/');
}

export function formatQtHelpUrl(url: QtHelpUrl, includeFragment = true): string {
  const base = `qthelp://${url.namespace}/${encodePath(url.path)}`;
  return includeFragment && url.fragment ? `${base}#${encodeURIComponent(url.fragment)}` : base;
}

/** The URL without its fragment, usable as a cache or lookup key. */
export function pageKey(url: QtHelpUrl): string {
  return `${url.namespace}/${url.path}`;
}

export function withFragment(url: QtHelpUrl, fragment: string): QtHelpUrl {
  return { namespace: url.namespace, path: url.path, fragment };
}

/** Builds the URL of a file stored in a namespace's virtual folder. */
export function makeQtHelpUrl(namespace: string, folder: string, reference: string): QtHelpUrl {
  const [path, fragment] = splitFragment(reference);
  const segments = normalizeSegments([...folder.split('/'), ...path.split('/').map(safeDecode)]);
  return { namespace, path: segments.join('/'), fragment };
}

/** Splits a URL path into the virtual folder and the path within it. */
export function splitVirtualFolder(path: string): [folder: string, file: string] {
  const slash = path.indexOf('/');
  return slash < 0 ? ['', path] : [path.slice(0, slash), path.slice(slash + 1)];
}

/**
 * Resolves a reference found in a page (link, image, stylesheet) against the page URL,
 * using the same rules a browser applies to hierarchical URLs.
 */
export function resolveReference(base: QtHelpUrl, reference: string): ResolvedReference {
  const ref = reference.trim();
  if (ref === '') {
    return { kind: 'fragment', fragment: base.fragment };
  }
  if (ref.startsWith('#')) {
    return { kind: 'fragment', fragment: safeDecode(ref.slice(1)) };
  }
  const scheme = SCHEME.exec(ref)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    if (scheme === 'qthelp') {
      const url = parseQtHelpUrl(ref);
      return url ? { kind: 'qthelp', url } : { kind: 'unsupported', href: ref };
    }
    if (EXTERNAL_SCHEMES.has(scheme)) {
      return { kind: 'external', href: ref };
    }
    return { kind: 'unsupported', href: ref };
  }
  if (ref.startsWith('//')) {
    return { kind: 'external', href: `https:${ref}` };
  }
  const [path, fragment] = splitFragment(ref);
  const decoded = path.split('/').map(safeDecode);
  if (path === '') {
    // Query-only reference, e.g. "?x=1": stays on the same page.
    return { kind: 'qthelp', url: withFragment(base, fragment) };
  }
  const segments = path.startsWith('/')
    ? normalizeSegments(decoded)
    : normalizeSegments([...base.path.split('/').slice(0, -1), ...decoded]);
  return { kind: 'qthelp', url: { namespace: base.namespace, path: segments.join('/'), fragment } };
}
