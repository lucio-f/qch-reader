import * as vscode from 'vscode';
import type { Disposable } from './disposable';
import {
  type DocumentFilter,
  FilterMatcher,
  NO_FILTER,
  collectDeclaredFilters,
  compareVersions,
} from '../core/library/filters';
import { SECTION, type UserFilterSetting, readConfig } from './config';
import type { LibraryService } from './libraryService';

const STATE_KEY = 'qchReader.activeFilter';

interface FilterPickItem extends vscode.QuickPickItem {
  readonly filter?: DocumentFilter;
  readonly action?: 'create';
  readonly userFilter?: string;
}

function userFilterToDocumentFilter(setting: UserFilterSetting): DocumentFilter {
  return {
    id: `user:${setting.name}`,
    label: setting.name,
    components: setting.components ?? [],
    versions: setting.versions ?? [],
    attributes: setting.attributes ?? [],
  };
}

function describeFilter(filter: DocumentFilter): string {
  const parts: string[] = [];
  if (filter.components.length > 0) {
    parts.push(`components: ${filter.components.join(', ')}`);
  }
  if (filter.versions.length > 0) {
    parts.push(`versions: ${filter.versions.join(', ')}`);
  }
  if (filter.attributes.length > 0) {
    parts.push(`attributes: ${filter.attributes.join(', ')}`);
  }
  return parts.join(' · ');
}

/** Holds the active documentation filter and lets the user choose or create filters. */
export class FilterService implements vscode.Disposable {
  private activeId: string;
  private active: DocumentFilter = NO_FILTER;
  private currentMatcher = new FilterMatcher(NO_FILTER);
  private readonly emitter = new vscode.EventEmitter<DocumentFilter>();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly disposables: Disposable[];

  public readonly onDidChange = this.emitter.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly library: LibraryService,
  ) {
    this.activeId = context.workspaceState.get<string>(STATE_KEY) ?? NO_FILTER.id;
    this.statusItem = vscode.window.createStatusBarItem(
      'qchReader.filter',
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusItem.name = 'QCH Documentation Filter';
    this.statusItem.command = 'qchReader.selectFilter';
    this.disposables = [
      this.emitter,
      this.statusItem,
      library.onDidChange(() => {
        this.resolveActive();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(`${SECTION}.filters`)) {
          this.resolveActive();
        }
      }),
    ];
    this.resolveActive();
  }

  public get filter(): DocumentFilter {
    return this.active;
  }

  public get matcher(): FilterMatcher {
    return this.currentMatcher;
  }

  /** All filters currently available, grouped for the picker. */
  public available(): {
    declared: DocumentFilter[];
    user: DocumentFilter[];
    components: DocumentFilter[];
    versions: DocumentFilter[];
  } {
    const documents = this.library.current.documents;
    const components = [...new Set(documents.flatMap((d) => d.folders))].sort();
    const versions = [...new Set(documents.map((d) => d.version).filter((v) => v !== ''))].sort(
      (a, b) => compareVersions(b, a),
    );
    return {
      declared: collectDeclaredFilters(documents),
      user: readConfig().filters.map(userFilterToDocumentFilter),
      components: components.map((component) => ({
        id: `component:${component}`,
        label: component,
        components: [component],
        versions: [],
        attributes: [],
      })),
      versions: versions.map((version) => ({
        id: `version:${version}`,
        label: `Version ${version}`,
        components: [],
        versions: [version],
        attributes: [],
      })),
    };
  }

  private findFilter(id: string): DocumentFilter | undefined {
    if (id === NO_FILTER.id) {
      return NO_FILTER;
    }
    const groups = this.available();
    return [...groups.user, ...groups.declared, ...groups.components, ...groups.versions].find(
      (filter) => filter.id === id,
    );
  }

  private resolveActive(): void {
    // Keep the stored id even if it is temporarily unavailable (e.g. while loading).
    const filter =
      this.library.loading && this.library.current.isEmpty
        ? undefined
        : this.findFilter(this.activeId);
    this.apply(filter ?? NO_FILTER, false);
  }

  public async select(filter: DocumentFilter): Promise<void> {
    this.activeId = filter.id;
    await this.context.workspaceState.update(STATE_KEY, filter.id);
    this.apply(filter, true);
  }

  private apply(filter: DocumentFilter, force: boolean): void {
    const changed =
      force ||
      filter.id !== this.active.id ||
      describeFilter(filter) !== describeFilter(this.active);
    this.active = filter;
    if (changed) {
      this.currentMatcher = new FilterMatcher(filter);
    }
    this.updateStatus();
    if (changed) {
      this.emitter.fire(filter);
    }
  }

  private updateStatus(): void {
    if (this.library.current.isEmpty) {
      this.statusItem.hide();
      return;
    }
    const filtered = this.active.id !== NO_FILTER.id;
    this.statusItem.text = `$(filter${filtered ? '-filled' : ''}) ${filtered ? this.active.label : 'All Docs'}`;
    this.statusItem.tooltip = new vscode.MarkdownString(
      `**Documentation filter:** ${this.active.label}${filtered ? `\n\n${describeFilter(this.active)}` : ''}\n\nClick to change.`,
    );
    this.statusItem.show();
  }

  /** Shows the filter picker. */
  public async pick(): Promise<void> {
    const groups = this.available();
    const item = (filter: DocumentFilter, detail?: string): FilterPickItem => ({
      label: `${filter.id === this.active.id ? '$(check) ' : ''}${filter.label}`,
      description: detail ?? describeFilter(filter),
      filter,
    });
    const separator = (label: string): FilterPickItem => ({
      label,
      kind: vscode.QuickPickItemKind.Separator,
    });
    const items: FilterPickItem[] = [item(NO_FILTER, 'Show every loaded document')];
    if (groups.user.length > 0) {
      items.push(separator('Your filters'));
      items.push(
        ...groups.user.map((filter) => ({
          ...item(filter),
          userFilter: filter.label,
          buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete filter' }],
        })),
      );
    }
    if (groups.declared.length > 0) {
      items.push(separator('Defined by the documentation'));
      items.push(...groups.declared.map((filter) => item(filter)));
    }
    if (groups.components.length > 1) {
      items.push(separator('Components'));
      items.push(...groups.components.map((filter) => item(filter, '')));
    }
    if (groups.versions.length > 1) {
      items.push(separator('Versions'));
      items.push(...groups.versions.map((filter) => item(filter, '')));
    }
    items.push(separator(''), { label: '$(add) Create Filter…', action: 'create' });

    const quickPick = vscode.window.createQuickPick<FilterPickItem>();
    quickPick.title = 'Documentation Filter';
    quickPick.placeholder = 'Choose which documentation is shown in the contents, index and search';
    quickPick.items = items;
    quickPick.matchOnDescription = true;
    const current = items.find((candidate) => candidate.filter?.id === this.active.id);
    if (current) {
      quickPick.activeItems = [current];
    }
    const selection = await new Promise<FilterPickItem | undefined>((resolve) => {
      quickPick.onDidAccept(() => {
        resolve(quickPick.selectedItems[0]);
        quickPick.hide();
      });
      quickPick.onDidHide(() => {
        resolve(undefined);
      });
      quickPick.onDidTriggerItemButton(async ({ item: target }) => {
        if (target.userFilter !== undefined) {
          await this.deleteUserFilter(target.userFilter);
          quickPick.items = quickPick.items.filter((candidate) => candidate !== target);
        }
      });
      quickPick.show();
    });
    quickPick.dispose();
    if (selection?.action === 'create') {
      await this.create();
    } else if (selection?.filter) {
      await this.select(selection.filter);
    }
  }

  /** Guides the user through creating a filter that is stored in the user settings. */
  public async create(): Promise<void> {
    const documents = this.library.current.documents;
    if (documents.length === 0) {
      void vscode.window.showInformationMessage(
        'Load some documentation before creating a filter.',
      );
      return;
    }
    const groups = this.available();
    const componentTitles = new Map<string, string[]>();
    for (const document of documents) {
      for (const folder of document.folders) {
        componentTitles.set(folder, [
          ...(componentTitles.get(folder) ?? []),
          `${document.title} ${document.version}`.trim(),
        ]);
      }
    }
    const components = await vscode.window.showQuickPick(
      groups.components.map((filter) => ({
        label: filter.label,
        description: [...new Set(componentTitles.get(filter.label) ?? [])].join(', '),
      })),
      {
        title: 'Create Filter (1/3): Components',
        placeHolder: 'Select the components to include (none selected = all)',
        canPickMany: true,
      },
    );
    if (!components) {
      return;
    }
    let versions: readonly vscode.QuickPickItem[] = [];
    if (groups.versions.length > 1) {
      const picked = await vscode.window.showQuickPick(
        groups.versions.map((filter) => ({ label: filter.versions[0] ?? '' })),
        {
          title: 'Create Filter (2/3): Versions',
          placeHolder: 'Select the versions to include (none selected = all)',
          canPickMany: true,
        },
      );
      if (!picked) {
        return;
      }
      versions = picked;
    }
    const existing = new Set(groups.user.map((filter) => filter.label));
    const name = await vscode.window.showInputBox({
      title: 'Create Filter (3/3): Name',
      prompt: 'Name of the new filter',
      value: components.map((c) => c.label).join(' + ') || 'My Filter',
      validateInput: (value) =>
        value.trim() === ''
          ? 'Enter a name'
          : existing.has(value.trim())
            ? 'A filter with this name already exists'
            : undefined,
    });
    if (!name) {
      return;
    }
    const setting: UserFilterSetting = {
      name: name.trim(),
      components: components.map((c) => c.label),
      versions: versions.map((v) => v.label),
    };
    const config = vscode.workspace.getConfiguration(SECTION);
    const current = config.inspect<unknown[]>('filters')?.globalValue ?? [];
    await config.update('filters', [...current, setting], vscode.ConfigurationTarget.Global);
    await this.select(userFilterToDocumentFilter(setting));
  }

  private async deleteUserFilter(name: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const inspected = config.inspect<unknown[]>('filters');
    const matches = (value: unknown): boolean =>
      typeof value === 'object' && value !== null && 'name' in value && value.name === name;
    if (inspected?.workspaceValue?.some(matches)) {
      await config.update(
        'filters',
        inspected.workspaceValue.filter((v) => !matches(v)),
        vscode.ConfigurationTarget.Workspace,
      );
    }
    if (inspected?.globalValue?.some(matches)) {
      await config.update(
        'filters',
        inspected.globalValue.filter((v) => !matches(v)),
        vscode.ConfigurationTarget.Global,
      );
    }
    if (this.active.id === `user:${name}`) {
      await this.select(NO_FILTER);
    }
  }

  public dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
