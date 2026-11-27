import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export interface WebviewShellOptions {
  readonly title: string;
  /** Script and stylesheet bundle name under dist/webview (e.g. `docView`). */
  readonly bundle: string;
  readonly body: string;
  /** Allow images from https: (documentation may reference remote images). */
  readonly remoteImages?: boolean;
}

export function webviewResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'dist')];
}

/** Builds the HTML of a webview with a strict, nonce-based content security policy. */
export function webviewShell(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  options: WebviewShellOptions,
): string {
  const nonce = randomBytes(18).toString('base64');
  const asset = (...segments: string[]): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', ...segments)).toString();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:${options.remoteImages ? ' https:' : ''}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${options.title}</title>
<link rel="stylesheet" href="${asset('media', 'codicons', 'codicon.css')}">
<link rel="stylesheet" href="${asset('webview', `${options.bundle}.css`)}">
</head>
<body>
${options.body}
<script nonce="${nonce}" src="${asset('webview', `${options.bundle}.js`)}"></script>
</body>
</html>`;
}
