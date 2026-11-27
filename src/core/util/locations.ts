import * as path from 'node:path';

export interface NamedFolder {
  readonly name: string;
  /** Absolute file system path. */
  readonly path: string;
}

export interface LocationContext {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** All workspace folders, for `${workspaceFolder:name}`. */
  readonly workspaceFolders: readonly NamedFolder[];
  /** Folders `${workspaceFolder}` stands for (one result per folder). */
  readonly defaultFolders: readonly string[];
  /** Directories relative paths are resolved against (one result per directory). */
  readonly relativeTo: readonly string[];
  /** Path implementation (injectable so Windows behavior can be tested anywhere). */
  readonly pathApi?: path.PlatformPath;
}

const FOLDER_VARIABLE = /\$\{workspaceFolder(?::([^}]+))?\}/g;

/**
 * Expands a configured documentation location into absolute paths.
 *
 * Supported: `~`, `${userHome}`, `${env:NAME}`, `${workspaceFolder}` (every folder in
 * `defaultFolders`), `${workspaceFolder:name}` (the folder with that name) and paths relative
 * to the settings file they are written in (`relativeTo`). Unknown folder names and empty
 * results expand to nothing.
 */
export function expandLocation(value: string, context: LocationContext): string[] {
  const api = context.pathApi ?? path;
  let text = value
    .trim()
    .replace(/^~(?=$|[\\/])/, context.home)
    .replaceAll('${userHome}', context.home)
    .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => context.env[name] ?? '');
  if (text === '') {
    return [];
  }

  // Named folders expand to exactly one path; an unknown name means the location is unusable.
  const folderPath = (name: string): string | undefined =>
    context.workspaceFolders.find((candidate) => candidate.name === name)?.path;
  for (const match of text.matchAll(FOLDER_VARIABLE)) {
    const name = match[1];
    if (name !== undefined && folderPath(name) === undefined) {
      return [];
    }
  }
  text = text.replace(FOLDER_VARIABLE, (match, name: string | undefined) =>
    name === undefined ? match : (folderPath(name) ?? ''),
  );

  const candidates = text.includes('${workspaceFolder}')
    ? context.defaultFolders.map((folder) => text.replaceAll('${workspaceFolder}', folder))
    : [text];
  const results = new Set<string>();
  for (const candidate of candidates) {
    if (api.isAbsolute(candidate)) {
      results.add(api.normalize(candidate));
    } else {
      for (const base of context.relativeTo) {
        results.add(api.resolve(base, candidate));
      }
    }
  }
  return [...results];
}

function isInside(parent: string, child: string, api: path.PlatformPath): string | undefined {
  const relative = api.relative(parent, child);
  if (relative === '') {
    return '.';
  }
  if (relative.startsWith('..') || api.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(api.sep).join('/');
}

export interface PortableTarget {
  readonly home: string;
  /** Directory relative paths in the target settings file are resolved against. */
  readonly relativeTo?: string | undefined;
  /** Workspace folders that can be referenced as `${workspaceFolder:name}`. */
  readonly namedFolders?: readonly NamedFolder[];
  readonly pathApi?: path.PlatformPath;
}

/**
 * Chooses how to store an absolute path in a settings file so that it keeps working on other
 * machines: relative to the settings file's base directory, inside a named workspace folder,
 * under the home directory (`~/…`), or absolute as a last resort.
 */
export function portableLocation(
  absolute: string,
  target: PortableTarget,
): { value: string; portable: boolean } {
  const api = target.pathApi ?? path;
  if (target.relativeTo !== undefined) {
    const relative = isInside(target.relativeTo, absolute, api);
    if (relative !== undefined) {
      return { value: relative, portable: true };
    }
  }
  for (const folder of target.namedFolders ?? []) {
    const relative = isInside(folder.path, absolute, api);
    if (relative !== undefined) {
      const suffix = relative === '.' ? '' : `/${relative}`;
      return { value: `\${workspaceFolder:${folder.name}}${suffix}`, portable: true };
    }
  }
  const underHome = isInside(target.home, absolute, api);
  if (underHome !== undefined && underHome !== '.') {
    return { value: `~/${underHome}`, portable: true };
  }
  return { value: absolute, portable: false };
}
