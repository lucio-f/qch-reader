const MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  svgz: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  css: 'text/css',
  js: 'text/javascript',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  txt: 'text/plain',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};

export function mimeTypeForPath(path: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

export function isImagePath(path: string): boolean {
  return mimeTypeForPath(path).startsWith('image/');
}

export function toDataUri(data: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64')}`;
}
