// Bundles the extension host code, the indexing worker and the webview scripts with esbuild.
import { context } from 'esbuild';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');
const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');

/** Loads `import css from './file.css?inline'` as a string. */
const inlineCssPlugin = {
  name: 'inline-css',
  setup(build) {
    build.onResolve({ filter: /\.css\?inline$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?inline$/, '')),
      namespace: 'inline-css',
    }));
    build.onLoad({ filter: /.*/, namespace: 'inline-css' }, async (args) => ({
      contents: await readFile(args.path, 'utf8'),
      loader: 'text',
      watchFiles: [args.path],
    }));
  },
};

/** Reports build results in a format the TypeScript problem matcher understands. */
const reporterPlugin = {
  name: 'reporter',
  setup(build) {
    build.onEnd((result) => {
      for (const { text, location } of [...result.errors, ...result.warnings]) {
        if (location) {
          console.error(`${location.file}:${location.line}:${location.column}: ${text}`);
        } else {
          console.error(text);
        }
      }
      if (watch) {
        console.log(`[build] finished with ${result.errors.length} error(s)`);
      }
    });
  },
};

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  sourcesContent: false,
  legalComments: 'none',
  logLevel: 'silent',
  plugins: [inlineCssPlugin, reporterPlugin],
};

const builds = [
  {
    ...common,
    entryPoints: {
      extension: 'src/extension.ts',
      indexWorker: 'src/workers/indexWorker.ts',
    },
    outdir: dist,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: [
      { in: 'src/webview/docView/main.ts', out: 'docView' },
      { in: 'src/webview/docView/docView.css', out: 'docView' },
      { in: 'src/webview/searchView/main.ts', out: 'searchView' },
      { in: 'src/webview/searchView/searchView.css', out: 'searchView' },
    ],
    outdir: path.join(dist, 'webview'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
  },
];

async function copyAssets() {
  const codicons = path.join(root, 'node_modules', '@vscode', 'codicons', 'dist');
  const target = path.join(dist, 'media', 'codicons');
  await mkdir(target, { recursive: true });
  await Promise.all(
    ['codicon.css', 'codicon.ttf'].map((file) =>
      copyFile(path.join(codicons, file), path.join(target, file)),
    ),
  );
}

await rm(dist, { recursive: true, force: true });
await copyAssets();
const contexts = await Promise.all(builds.map((options) => context(options)));
if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('[build] watching for changes…');
} else {
  const results = await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  if (results.some((result) => result.errors.length > 0)) {
    process.exitCode = 1;
  }
}
