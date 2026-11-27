import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Appearance } from '../shared/protocol';

export const SECTION = 'qchReader';
const DEFAULT_HOVER_LANGUAGES = ['cpp', 'c', 'qml', 'python'];

export interface UserFilterSetting {
  readonly name: string;
  readonly components?: readonly string[];
  readonly versions?: readonly string[];
  readonly attributes?: readonly string[];
}

export interface ReaderConfig {
  readonly folders: readonly string[];
  readonly recursive: boolean;
  readonly includeWorkspaceFiles: boolean;
  readonly appearance: Appearance;
  readonly openPagesIn: 'active' | 'beside';
  readonly fullTextEnabled: boolean;
  readonly indexOnStartup: boolean;
  readonly maxResults: number;
  readonly filters: readonly UserFilterSetting[];
  readonly hoverEnabled: boolean;
  readonly hoverLanguages: readonly string[];
  readonly documentLinksEnabled: boolean;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function userFilters(value: unknown): UserFilterSetting[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const filters: UserFilterSetting[] = [];
  for (const item of value as unknown[]) {
    if (
      typeof item === 'object' &&
      item !== null &&
      'name' in item &&
      typeof item.name === 'string'
    ) {
      const record = item as Record<string, unknown>;
      filters.push({
        name: item.name,
        components: stringArray(record['components']),
        versions: stringArray(record['versions']),
        attributes: stringArray(record['attributes']),
      });
    }
  }
  return filters;
}

export function readConfig(): ReaderConfig {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    folders: stringArray(config.get('folders')),
    recursive: config.get('recursive', true),
    includeWorkspaceFiles: config.get('includeWorkspaceFiles', true),
    appearance: config.get('appearance') === 'original' ? 'original' : 'themed',
    openPagesIn: config.get('openPagesIn') === 'beside' ? 'beside' : 'active',
    fullTextEnabled: config.get('fullTextSearch.enabled', true),
    indexOnStartup: config.get('fullTextSearch.indexOnStartup', true),
    maxResults: Math.min(5000, Math.max(20, config.get('search.maxResults', 300))),
    filters: userFilters(config.get('filters')),
    hoverEnabled: config.get('hover.enabled', true),
    hoverLanguages: stringArray(config.get('hover.languages', DEFAULT_HOVER_LANGUAGES)),
    documentLinksEnabled: config.get('documentLinks.enabled', true),
  };
}

/**
 * Expands `~`, `${userHome}`, `${env:NAME}` and `${workspaceFolder}` (once per workspace
 * folder) in a configured path. Relative paths are resolved against each workspace folder.
 */
export function expandConfiguredPath(value: string): string[] {
  const workspaceFolders = (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => folder.uri.fsPath);
  let expanded = value
    .trim()
    .replace(/^~(?=$|[\\/])/, homedir())
    .replaceAll('${userHome}', homedir())
    .replace(/\$\{env:([^}]+)\}/g, (_match, name: string) => process.env[name] ?? '');
  if (expanded === '') {
    return [];
  }
  if (expanded.includes('${workspaceFolder}')) {
    return workspaceFolders.map((folder) =>
      path.normalize(expanded.replaceAll('${workspaceFolder}', folder)),
    );
  }
  if (!path.isAbsolute(expanded)) {
    return workspaceFolders.map((folder) => path.resolve(folder, expanded));
  }
  expanded = path.normalize(expanded);
  return [expanded];
}
