/** Named character references commonly found in generated documentation. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200c',
  zwj: '\u200d',
  shy: '\u00ad',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  minus: '\u2212',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  bull: '\u2022',
  middot: '\u00b7',
  times: '\u00d7',
  divide: '\u00f7',
  plusmn: '\u00b1',
  deg: '\u00b0',
  micro: '\u00b5',
  para: '\u00b6',
  sect: '\u00a7',
  dagger: '\u2020',
  Dagger: '\u2021',
  permil: '\u2030',
  prime: '\u2032',
  Prime: '\u2033',
  larr: '\u2190',
  uarr: '\u2191',
  rarr: '\u2192',
  darr: '\u2193',
  harr: '\u2194',
  lArr: '\u21d0',
  rArr: '\u21d2',
  hArr: '\u21d4',
  le: '\u2264',
  ge: '\u2265',
  ne: '\u2260',
  asymp: '\u2248',
  equiv: '\u2261',
  infin: '\u221e',
  sum: '\u2211',
  prod: '\u220f',
  radic: '\u221a',
  part: '\u2202',
  isin: '\u2208',
  notin: '\u2209',
  and: '\u2227',
  or: '\u2228',
  cap: '\u2229',
  cup: '\u222a',
  sub: '\u2282',
  sup: '\u2283',
  forall: '\u2200',
  exist: '\u2203',
  empty: '\u2205',
  nabla: '\u2207',
  lowast: '\u2217',
  sdot: '\u22c5',
  lceil: '\u2308',
  rceil: '\u2309',
  lfloor: '\u230a',
  rfloor: '\u230b',
  lang: '\u2329',
  rang: '\u232a',
  euro: '\u20ac',
  pound: '\u00a3',
  yen: '\u00a5',
  cent: '\u00a2',
  curren: '\u00a4',
  iexcl: '\u00a1',
  iquest: '\u00bf',
  ordf: '\u00aa',
  ordm: '\u00ba',
  sup1: '\u00b9',
  sup2: '\u00b2',
  sup3: '\u00b3',
  frac14: '\u00bc',
  frac12: '\u00bd',
  frac34: '\u00be',
  not: '\u00ac',
  macr: '\u00af',
  acute: '\u00b4',
  cedil: '\u00b8',
  uml: '\u00a8',
  brvbar: '\u00a6',
  alpha: '\u03b1',
  beta: '\u03b2',
  gamma: '\u03b3',
  delta: '\u03b4',
  epsilon: '\u03b5',
  lambda: '\u03bb',
  mu: '\u03bc',
  pi: '\u03c0',
  sigma: '\u03c3',
  tau: '\u03c4',
  phi: '\u03c6',
  omega: '\u03c9',
  Delta: '\u0394',
  Sigma: '\u03a3',
  Omega: '\u03a9',
  auml: '\u00e4',
  ouml: '\u00f6',
  uuml: '\u00fc',
  Auml: '\u00c4',
  Ouml: '\u00d6',
  Uuml: '\u00dc',
  szlig: '\u00df',
  eacute: '\u00e9',
  egrave: '\u00e8',
  ecirc: '\u00ea',
  aacute: '\u00e1',
  agrave: '\u00e0',
  acirc: '\u00e2',
  aring: '\u00e5',
  ccedil: '\u00e7',
  iacute: '\u00ed',
  oacute: '\u00f3',
  uacute: '\u00fa',
  ntilde: '\u00f1',
  oslash: '\u00f8',
  aelig: '\u00e6',
  Eacute: '\u00c9',
};

const ENTITY = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);?/g;

function fromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return '\ufffd';
  }
  return code === 0 ? '\ufffd' : String.fromCodePoint(code);
}

/** Decodes HTML character references. Unknown named references are kept verbatim. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) {
    return text;
  }
  return text.replace(ENTITY, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      return fromCodePoint(Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
