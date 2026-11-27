// Generates the test fixtures: two small Qt help projects compiled into .qch files with Qt's
// own `qhelpgenerator`, so the tests exercise files produced by the real tool.
//
// Usage: node scripts/build-fixtures.mjs [path/to/qhelpgenerator]
// (defaults to $QHELPGENERATOR, then /usr/lib/qt6/libexec/qhelpgenerator, then the PATH)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'test', 'fixtures');
const generator =
  process.argv[2] ??
  process.env.QHELPGENERATOR ??
  ['/usr/lib/qt6/libexec/qhelpgenerator', '/usr/lib/qt5/bin/qhelpgenerator'].find((p) =>
    existsSync(p),
  ) ??
  'qhelpgenerator';

/** Deterministic pseudo-random bytes (xorshift32), so fixtures are reproducible. */
function randomBytes(length, seed) {
  const bytes = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    bytes[i] = x & 0xff;
  }
  return bytes;
}

const words = [
  'widget',
  'gadget',
  'layout',
  'signal',
  'property',
  'render',
  'thread',
  'buffer',
  'palette',
  'event',
  'model',
  'view',
  'delegate',
  'resource',
  'shader',
  'texture',
  'anchor',
  'binding',
];

function sentence(seed, count) {
  const out = [];
  let x = seed;
  for (let i = 0; i < count; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(words[x % words.length]);
  }
  return out.join(' ');
}

function page(title, body, { css = 'style/style.css', script = true } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title} | Alpha 1.0</title>
  <link rel="stylesheet" type="text/css" href="${css}" />
${script ? '  <script type="text/javascript">document.title = "changed";</script>\n' : ''}</head>
<body class="alpha-page">
<div class="navigationbar"><ul><li><a href="index.html">Alpha</a></li><li>${title}</li></ul></div>
${body}
<div class="footer"><p>Copyright boilerplate footer text.</p></div>
</body>
</html>
`;
}

const alphaFiles = {
  'index.html': page(
    'Alpha Manual',
    `<h1 class="title">Alpha Manual</h1>
<p>Welcome to the <b>Alpha</b> toolkit. Read <a href="start.html">Getting Started</a> first.</p>
<p><img src="images/logo.png" alt="Alpha logo" onerror="alert(1)"></p>
<iframe src="https://example.com"></iframe>`,
  ),
  'start.html': page(
    'Getting Started',
    `<h1 class="title">Getting Started</h1>
<h2 id="install">Installing</h2>
<p>Install the toolkit and create your first <a href="widget.html">Widget</a>.</p>
<h2 id="first-steps">First Steps</h2>
<p>Implicitly shared classes make copying cheap. Use <code>Widget::paint()</code> to draw.</p>
<p>External: <a href="https://www.qt.io/" target="_blank">Qt website</a>, <a href="javascript:alert(1)">bad</a>.</p>`,
  ),
  'api.html': page(
    'API Reference',
    `<h1 class="title">API Reference</h1>
<ul><li><a href="widget.html">Widget</a></li><li><a href="gadget.html">Gadget</a></li></ul>`,
  ),
  'widget.html': page(
    'Widget Class',
    `<h1 class="title">Widget Class</h1>
<p>The Widget class is the base of all visual elements. <a href="#details">More...</a></p>
<h2 id="details">Detailed Description</h2>
<p>A widget paints itself. See also the <a href="../beta/beta-index.html#intro">Beta introduction</a>
and <a href="qthelp://org.example.beta.200/beta/guide.html">the Beta guide</a>.</p>
<h3 class="fn" id="paint"><span class="type">void</span> Widget::<span class="name">paint</span>(<span class="type">Painter</span> *<i>painter</i>)</h3>
<p>Paints the widget using <i>painter</i>. This function is called whenever the widget needs repainting.</p>
<p>Second paragraph about painting.</p>
<pre class="cpp"><span class="type">Widget</span> w; w.paint(&amp;p); <span class="comment">// draw</span></pre>
<h3 class="fn" id="resize"><span class="type">void</span> Widget::<span class="name">resize</span>(<span class="type">int</span> <i>w</i>, <span class="type">int</span> <i>h</i>)</h3>
<p>Resizes the widget to <i>w</i> &times; <i>h</i> pixels.</p>
<a name="legacy-anchor"></a><h3>Legacy anchor</h3><p>Anchor declared with a name attribute.</p>`,
  ),
  'gadget.html': page(
    'Gadget Class',
    `<h1 class="title">Gadget Class</h1>
<p>The Gadget class is a lightweight helper without painting. It also has a paint method.</p>
<h3 class="fn" id="paint">void Gadget::paint()</h3><p>Gadget painting is a no-op.</p>`,
  ),
  'unicode.html': page(
    'Ünïcödé Pägé',
    `<h1 class="title">Ünïcödé Pägé</h1><p>Résumé naïve café — “quoted” text and 日本語.</p>`,
  ),
  'big.html': page(
    'Big Page',
    `<h1 class="title">Big Page</h1>
${Array.from({ length: 400 }, (_, i) => `<p id="p${i}">Paragraph ${i}: ${sentence(i + 1, 40)}.</p>`).join('\n')}
<p>The very last paragraph mentions zeppelin exactly once.</p>`,
  ),
  'style/style.css': `body { background: url(../images/bg.png) repeat-x; color: #222; }
html, body { margin: 0; }
.navigationbar { font-size: 12px; }
@media print { body { color: black; } }
`,
};

const betaFiles = {
  'beta-index.html': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Beta Home</title></head>
<body><h1>Beta Home</h1><h2 id="intro">Introduction</h2><p>Beta extends Alpha with zeppelin support.</p>
<p>Back to <a href="../alpha/widget.html#paint">Widget::paint</a>.</p></body></html>
`,
  'guide.html': `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Beta Guide</title></head>
<body><h1>Beta Guide</h1><p>A guide about gadget rendering and signal handling.</p></body></html>
`,
};

const methodKeywords = Array.from(
  { length: 450 },
  (_, i) =>
    `      <keyword name="method${i}" id="Widget::method${i}" ref="widget.html#method${i}"/>`,
).join('\n');

const alphaQhp = `<?xml version="1.0" encoding="UTF-8"?>
<QtHelpProject version="1.0">
  <namespace>org.example.alpha.100</namespace>
  <virtualFolder>alpha</virtualFolder>
  <metaData name="version" value="1.0.0"/>
  <metaData name="author" value="QCH Reader tests"/>
  <customFilter name="Alpha 1.0">
    <filterAttribute>alpha</filterAttribute>
    <filterAttribute>1.0</filterAttribute>
  </customFilter>
  <filterSection>
    <filterAttribute>alpha</filterAttribute>
    <filterAttribute>1.0</filterAttribute>
    <toc>
      <section title="Alpha Manual" ref="index.html">
        <section title="Getting Started" ref="start.html">
          <section title="Installing" ref="start.html#install"/>
          <section title="First Steps" ref="start.html#first-steps"/>
        </section>
        <section title="API Reference" ref="api.html">
          <section title="Widget" ref="widget.html"/>
          <section title="Gadget" ref="gadget.html"/>
        </section>
        <section title="Ünïcödé Pägé" ref="unicode.html"/>
        <section title="Big Page" ref="big.html"/>
      </section>
    </toc>
    <keywords>
      <keyword name="Widget" id="Widget" ref="widget.html"/>
      <keyword name="paint" id="Widget::paint" ref="widget.html#paint"/>
      <keyword name="resize" id="Widget::resize" ref="widget.html#resize"/>
      <keyword name="Gadget" id="Gadget" ref="gadget.html"/>
      <keyword name="paint" id="Gadget::paint" ref="gadget.html#paint"/>
      <keyword name="Getting Started" ref="start.html"/>
${methodKeywords}
    </keywords>
    <files>
${Object.keys(alphaFiles)
  .map((file) => `      <file>${file}</file>`)
  .join('\n')}
      <file>images/logo.png</file>
      <file>images/bg.png</file>
    </files>
  </filterSection>
  <filterSection>
    <filterAttribute>alpha</filterAttribute>
    <filterAttribute>extra</filterAttribute>
    <toc>
      <section title="Extra Section" ref="api.html"/>
    </toc>
  </filterSection>
</QtHelpProject>
`;

const betaQhp = `<?xml version="1.0" encoding="UTF-8"?>
<QtHelpProject version="1.0">
  <namespace>org.example.beta.200</namespace>
  <virtualFolder>beta</virtualFolder>
  <metaData name="version" value="2.0.0"/>
  <filterSection>
    <toc>
      <section title="Beta" ref="beta-index.html">
        <section title="Introduction" ref="beta-index.html#intro"/>
        <section title="Guide" ref="guide.html"/>
      </section>
    </toc>
    <keywords>
      <keyword name="Beta" id="Beta" ref="beta-index.html"/>
      <keyword name="paint" id="Beta::paint" ref="guide.html"/>
    </keywords>
    <files>
      <file>beta-index.html</file>
      <file>guide.html</file>
    </files>
  </filterSection>
</QtHelpProject>
`;

async function writeProject(directory, qhpName, qhp, files, binaries = {}) {
  for (const [name, content] of Object.entries({ ...files, ...binaries })) {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await writeFile(path.join(directory, qhpName), qhp);
}

const work = await mkdtemp(path.join(tmpdir(), 'qch-fixtures-'));
try {
  await mkdir(output, { recursive: true });
  const alphaDir = path.join(work, 'alpha');
  const betaDir = path.join(work, 'beta');
  await writeProject(alphaDir, 'alpha.qhp', alphaQhp, alphaFiles, {
    // Incompressible data larger than a page forces overflow page chains.
    'images/logo.png': randomBytes(24 * 1024, 42),
    'images/bg.png': randomBytes(300, 7),
  });
  await writeProject(betaDir, 'beta.qhp', betaQhp, betaFiles);
  for (const [dir, name] of [
    [alphaDir, 'alpha'],
    [betaDir, 'beta'],
  ]) {
    const target = path.join(output, `${name}.qch`);
    await rm(target, { force: true });
    execFileSync(generator, [path.join(dir, `${name}.qhp`), '-o', target], { stdio: 'inherit' });
    console.log(`wrote ${path.relative(root, target)}`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
