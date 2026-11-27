import * as vscode from 'vscode';
import type { Disposable } from './disposable';
import type { QtHelpUrl } from '../core/library/qthelpUrl';
import type { Appearance } from '../shared/protocol';
import { SECTION, readConfig } from './config';
import { DocViewer, type OpenOptions, type ViewerServices, type ViewerSettings } from './docViewer';
import type { FilterService } from './filterService';
import type { LibraryService } from './libraryService';
import type { PageService } from './pageService';
import { webviewResourceRoots } from './webviewHtml';

export const DOC_VIEW_TYPE = 'qchReader.docView';
const ZOOM_KEY = 'qchReader.zoom';

class Settings implements ViewerSettings, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<{ readonly appearanceChanged: boolean }>();
  private readonly subscription: vscode.Disposable;
  private appearanceValue: Appearance = readConfig().appearance;
  public readonly onDidChange = this.emitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SECTION}.appearance`)) {
        const next = readConfig().appearance;
        if (next !== this.appearanceValue) {
          this.appearanceValue = next;
          this.emitter.fire({ appearanceChanged: true });
        }
      }
    });
  }

  public get zoom(): number {
    return this.context.globalState.get<number>(ZOOM_KEY) ?? 1;
  }

  public get appearance(): Appearance {
    return this.appearanceValue;
  }

  public setZoom(zoom: number): void {
    const clamped = Math.round(Math.min(3, Math.max(0.5, zoom)) * 100) / 100;
    void this.context.globalState.update(ZOOM_KEY, clamped).then(() => {
      this.emitter.fire({ appearanceChanged: false });
    });
  }

  public async toggleAppearance(): Promise<void> {
    const next: Appearance = this.appearanceValue === 'themed' ? 'original' : 'themed';
    await vscode.workspace
      .getConfiguration(SECTION)
      .update('appearance', next, vscode.ConfigurationTarget.Global);
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

export interface PanelManagerDependencies {
  readonly context: vscode.ExtensionContext;
  readonly library: LibraryService;
  readonly filters: FilterService;
  readonly pages: PageService;
  readonly log: vscode.LogOutputChannel;
  revealInContents(url: QtHelpUrl): Promise<void>;
  searchText(text: string): Promise<void>;
}

/** Creates, tracks and restores documentation viewers. */
export class DocPanelManager implements vscode.Disposable, vscode.WebviewPanelSerializer {
  private readonly viewers = new Set<DocViewer>();
  private lastActive: DocViewer | undefined;
  private focusedViewer: DocViewer | undefined;
  private readonly settings: Settings;
  private readonly services: ViewerServices;
  private readonly disposables: Disposable[] = [];

  public constructor(private readonly deps: PanelManagerDependencies) {
    this.settings = new Settings(deps.context);
    this.services = {
      extensionUri: deps.context.extensionUri,
      library: deps.library,
      filters: deps.filters,
      pages: deps.pages,
      settings: this.settings,
      log: deps.log,
      open: async (url, options) => this.open(url, options),
      revealInContents: async (url) => deps.revealInContents(url),
      searchText: async (text) => deps.searchText(text),
      setFocused: (viewer, focused) => {
        this.setFocused(viewer, focused);
      },
    };
    this.disposables.push(
      this.settings,
      vscode.window.registerWebviewPanelSerializer(DOC_VIEW_TYPE, this),
    );
  }

  public get settingsValue(): ViewerSettings {
    return this.settings;
  }

  /** The most recently active viewer that is still open. */
  public get active(): DocViewer | undefined {
    if (this.lastActive && this.viewers.has(this.lastActive)) {
      return this.lastActive;
    }
    return [...this.viewers].at(-1);
  }

  /** Opens a URL, reusing the last active viewer unless a new panel is requested. */
  public async open(url: string, options: OpenOptions = {}): Promise<void> {
    const target = options.newPanel ? undefined : this.active;
    if (target) {
      target.panel.reveal(target.panel.viewColumn, options.preserveFocus ?? false);
      await target.navigate(url, { highlights: options.highlights ?? [] });
      return;
    }
    const column =
      options.side || readConfig().openPagesIn === 'beside'
        ? vscode.ViewColumn.Beside
        : vscode.ViewColumn.Active;
    const panel = vscode.window.createWebviewPanel(
      DOC_VIEW_TYPE,
      'Documentation',
      { viewColumn: column, preserveFocus: options.preserveFocus ?? false },
      {
        enableScripts: true,
        enableFindWidget: false,
        retainContextWhenHidden: false,
        localResourceRoots: webviewResourceRoots(this.deps.context.extensionUri),
      },
    );
    const viewer = this.attach(panel, false);
    await viewer.navigate(url, { highlights: options.highlights ?? [] });
  }

  /** Wraps a webview panel (new, restored or a custom editor) in a viewer. */
  public attach(panel: vscode.WebviewPanel, isEditor: boolean): DocViewer {
    const viewer = new DocViewer(panel, this.services, isEditor);
    this.viewers.add(viewer);
    this.lastActive = viewer;
    const updateActive = (): void => {
      if (panel.active) {
        this.lastActive = viewer;
      }
      void vscode.commands.executeCommand(
        'setContext',
        'qchReader.viewerActive',
        [...this.viewers].some((v) => v.panel.active),
      );
    };
    updateActive();
    const viewStateSubscription = panel.onDidChangeViewState(updateActive);
    viewer.onDidDispose(() => {
      viewStateSubscription.dispose();
      this.viewers.delete(viewer);
      if (this.focusedViewer === viewer) {
        this.setFocused(viewer, false);
      }
      updateActive();
    });
    return viewer;
  }

  private setFocused(viewer: DocViewer, focused: boolean): void {
    if (focused) {
      this.focusedViewer = viewer;
      this.lastActive = viewer;
    } else if (this.focusedViewer === viewer) {
      this.focusedViewer = undefined;
    }
    void vscode.commands.executeCommand(
      'setContext',
      'qchReader.viewerFocused',
      this.focusedViewer !== undefined,
    );
  }

  /** The viewer keyboard commands should act on. */
  public get commandTarget(): DocViewer | undefined {
    return (
      this.focusedViewer ?? [...this.viewers].find((viewer) => viewer.panel.active) ?? this.active
    );
  }

  public async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const viewer = this.attach(panel, false);
    const url = DocViewer.restoreUrl(state);
    await this.deps.library.whenReady();
    if (url) {
      const scrollY =
        typeof state === 'object' &&
        state !== null &&
        'scrollY' in state &&
        typeof state.scrollY === 'number'
          ? state.scrollY
          : undefined;
      await viewer.navigate(url, scrollY === undefined ? {} : { scrollY });
    } else {
      await viewer.home();
    }
  }

  public dispose(): void {
    for (const viewer of this.viewers) {
      viewer.dispose();
    }
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
