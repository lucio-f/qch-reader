import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type NamedFolder, expandLocation, portableLocation } from '../core/util/locations';
import { SECTION } from './config';

/** Which settings file a documentation location comes from. */
export type LocationScope = 'user' | 'workspace' | 'folder';

export interface ConfiguredLocation {
  /** The value as written in the settings. */
  readonly value: string;
  readonly scope: LocationScope;
  readonly folder?: vscode.WorkspaceFolder;
  /** Absolute paths the value expands to. */
  readonly paths: readonly string[];
}

export interface CollectedLocations {
  readonly locations: readonly ConfiguredLocation[];
  /** Workspace or folder entries ignored because the workspace is not trusted. */
  readonly ignoredUntrusted: number;
}

interface SettingsTarget {
  readonly scope: LocationScope;
  readonly folder?: vscode.WorkspaceFolder;
  readonly label: string;
  readonly description: string;
  readonly openCommand: string;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [];
}

function fileFolders(): vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
}

function namedFolders(folders: readonly vscode.WorkspaceFolder[]): NamedFolder[] {
  return folders.map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
}

/** True when folder-level settings exist separately from workspace settings (multi-root). */
function hasWorkspaceFile(): boolean {
  return vscode.workspace.workspaceFile !== undefined;
}

/** Directories that relative paths in workspace-level settings are resolved against. */
function workspaceSettingsBase(folders: readonly vscode.WorkspaceFolder[]): string[] {
  const file = vscode.workspace.workspaceFile;
  if (file?.scheme === 'file') {
    return [path.dirname(file.fsPath)];
  }
  return folders.map((folder) => folder.uri.fsPath);
}

export function scopeLabel(location: {
  readonly scope: LocationScope;
  readonly folder?: vscode.WorkspaceFolder | undefined;
}): string {
  switch (location.scope) {
    case 'user':
      return 'user settings';
    case 'workspace':
      return 'workspace settings';
    case 'folder':
      return `folder settings of ${location.folder?.name ?? '?'}`;
  }
}

/**
 * Collects the documentation locations configured at every level — user settings, workspace
 * settings and (in multi-root workspaces) the settings of each folder. Unlike a plain
 * `getConfiguration().get()`, the levels are combined, so locations committed with a project
 * add to the ones in your user settings. Relative paths are resolved against the settings
 * file they appear in.
 */
export function collectLocations(): CollectedLocations {
  const folders = fileFolders();
  const folderPaths = folders.map((folder) => folder.uri.fsPath);
  const base = { home: homedir(), env: process.env, workspaceFolders: namedFolders(folders) };
  const inspected = vscode.workspace.getConfiguration(SECTION).inspect<unknown>('folders');
  const trusted = vscode.workspace.isTrusted;
  const locations: ConfiguredLocation[] = [];
  let ignoredUntrusted = 0;

  for (const value of stringArray(inspected?.globalValue)) {
    locations.push({
      value,
      scope: 'user',
      paths: expandLocation(value, {
        ...base,
        defaultFolders: folderPaths,
        relativeTo: folderPaths,
      }),
    });
  }

  const workspaceValues = stringArray(inspected?.workspaceValue);
  if (trusted) {
    const relativeTo = workspaceSettingsBase(folders);
    for (const value of workspaceValues) {
      locations.push({
        value,
        scope: 'workspace',
        paths: expandLocation(value, { ...base, defaultFolders: folderPaths, relativeTo }),
      });
    }
  } else {
    ignoredUntrusted += workspaceValues.length;
  }

  if (hasWorkspaceFile()) {
    for (const folder of folders) {
      const values = stringArray(
        vscode.workspace.getConfiguration(SECTION, folder.uri).inspect<unknown>('folders')
          ?.workspaceFolderValue,
      );
      if (!trusted) {
        ignoredUntrusted += values.length;
        continue;
      }
      const own = [folder.uri.fsPath];
      for (const value of values) {
        locations.push({
          value,
          scope: 'folder',
          folder,
          paths: expandLocation(value, { ...base, defaultFolders: own, relativeTo: own }),
        });
      }
    }
  }
  return { locations, ignoredUntrusted };
}

function settingsTargets(): SettingsTarget[] {
  const targets: SettingsTarget[] = [];
  const folders = fileFolders();
  if (folders.length > 0) {
    const workspaceFile = vscode.workspace.workspaceFile;
    targets.push({
      scope: 'workspace',
      label: '$(repo) Workspace Settings',
      description:
        workspaceFile?.scheme === 'file'
          ? `${path.basename(workspaceFile.fsPath)} — commit it to share with your team`
          : hasWorkspaceFile()
            ? 'untitled workspace'
            : '.vscode/settings.json — commit it to share with your team',
      openCommand: 'workbench.action.openWorkspaceSettingsFile',
    });
    if (hasWorkspaceFile()) {
      for (const folder of folders) {
        targets.push({
          scope: 'folder',
          folder,
          label: `$(folder) ${folder.name}`,
          description: 'Folder settings: .vscode/settings.json — commit it to share',
          openCommand: 'workbench.action.openFolderSettingsFile',
        });
      }
    }
  }
  targets.push({
    scope: 'user',
    label: '$(account) User Settings',
    description: 'Only for you, in every workspace',
    openCommand: 'workbench.action.openSettingsJson',
  });
  return targets;
}

function configurationFor(target: {
  readonly folder?: vscode.WorkspaceFolder | undefined;
}): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION, target.folder?.uri);
}

function configurationTarget(scope: LocationScope): vscode.ConfigurationTarget {
  switch (scope) {
    case 'user':
      return vscode.ConfigurationTarget.Global;
    case 'workspace':
      return vscode.ConfigurationTarget.Workspace;
    case 'folder':
      return vscode.ConfigurationTarget.WorkspaceFolder;
  }
}

function currentValues(target: SettingsTarget): string[] {
  const inspected = configurationFor(target).inspect<unknown>('folders');
  switch (target.scope) {
    case 'user':
      return stringArray(inspected?.globalValue);
    case 'workspace':
      return stringArray(inspected?.workspaceValue);
    case 'folder':
      return stringArray(inspected?.workspaceFolderValue);
  }
}

/** How a picked path is written into the target settings file. */
function storedValue(
  target: SettingsTarget,
  absolute: string,
): { value: string; portable: boolean } {
  const home = homedir();
  const folders = fileFolders();
  switch (target.scope) {
    case 'user':
      return portableLocation(absolute, { home });
    case 'folder':
      return portableLocation(absolute, { home, relativeTo: target.folder?.uri.fsPath });
    case 'workspace': {
      const workspaceFile = vscode.workspace.workspaceFile;
      if (!hasWorkspaceFile()) {
        return portableLocation(absolute, { home, relativeTo: folders[0]?.uri.fsPath });
      }
      return portableLocation(absolute, {
        home,
        relativeTo:
          workspaceFile?.scheme === 'file' ? path.dirname(workspaceFile.fsPath) : undefined,
        namedFolders: namedFolders(folders),
      });
    }
  }
}

/** "Add Documentation Folder…": pick folders or files and the settings file to store them in. */
export async function addDocumentationLocations(): Promise<void> {
  const folders = fileFolders();
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: true,
    canSelectMany: true,
    filters: { 'Qt Compressed Help': ['qch'] },
    openLabel: 'Add Documentation',
    title: 'Add Folders or .qch Files',
    ...(folders[0] ? { defaultUri: folders[0].uri } : {}),
  });
  if (!picked || picked.length === 0) {
    return;
  }

  let targets = settingsTargets();
  // Suggest the most specific shared settings file: the deepest folder containing every pick.
  const contains = (folder: string, file: string): boolean => {
    const relative = path.relative(folder, file);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const containing = targets
    .filter(
      (target) =>
        target.scope === 'folder' &&
        target.folder !== undefined &&
        picked.every((uri) => contains(target.folder?.uri.fsPath ?? '', uri.fsPath)),
    )
    .sort((a, b) => (b.folder?.uri.fsPath.length ?? 0) - (a.folder?.uri.fsPath.length ?? 0))[0];
  if (containing) {
    targets = [containing, ...targets.filter((target) => target !== containing)];
  }
  let target = targets[0];
  if (targets.length > 1) {
    const choice = await vscode.window.showQuickPick(
      targets.map((candidate) => ({
        label: candidate.label,
        description: candidate.description,
        target: candidate,
      })),
      {
        title: 'Save the Documentation Locations In…',
        placeHolder: 'Workspace and folder settings live in the project and can be committed',
      },
    );
    if (!choice) {
      return;
    }
    target = choice.target;
  }
  if (!target) {
    return;
  }

  const current = currentValues(target);
  const stored = picked.map((uri) => storedValue(target, uri.fsPath));
  const additions = stored.filter(
    (entry, index) =>
      !current.includes(entry.value) && stored.findIndex((e) => e.value === entry.value) === index,
  );
  if (additions.length === 0) {
    void vscode.window.showInformationMessage(`Already listed in the ${scopeLabel(target)}.`);
    return;
  }
  await configurationFor(target).update(
    'folders',
    [...current, ...additions.map((entry) => entry.value)],
    configurationTarget(target.scope),
  );

  const notes: string[] = [];
  const absolute = additions.filter((entry) => !entry.portable).map((entry) => entry.value);
  if (target.scope !== 'user' && absolute.length > 0) {
    notes.push(
      `${absolute.join(', ')} is outside the workspace and your home folder, so it was saved as an absolute path that may not exist on other machines.`,
    );
  }
  if (target.scope !== 'user' && !vscode.workspace.isTrusted) {
    notes.push('They will be used once you trust this workspace.');
  }
  const message =
    `Added ${additions.map((entry) => `"${entry.value}"`).join(', ')} to the ${scopeLabel(target)}. ${notes.join(' ')}`.trim();
  const show =
    absolute.length > 0 && target.scope !== 'user'
      ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;
  const action = await show(message, 'Open Settings File');
  if (action) {
    await vscode.commands.executeCommand(target.openCommand);
  }
}

/** "Remove Documentation Folder…": lists the locations of every settings file. */
export async function removeDocumentationLocations(): Promise<void> {
  const items = settingsTargets().flatMap((target) =>
    currentValues(target).map((value) => ({
      label: value,
      description: scopeLabel(target),
      target,
    })),
  );
  if (items.length === 0) {
    void vscode.window.showInformationMessage('No documentation locations are configured.');
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Remove Documentation Locations',
    placeHolder: 'Select the locations to remove',
  });
  if (!picked || picked.length === 0) {
    return;
  }
  for (const target of new Set(picked.map((item) => item.target))) {
    const removed = new Set(
      picked.filter((item) => item.target === target).map((item) => item.label),
    );
    await configurationFor(target).update(
      'folders',
      currentValues(target).filter((value) => !removed.has(value)),
      configurationTarget(target.scope),
    );
  }
}
