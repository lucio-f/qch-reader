import * as vscode from 'vscode';
import { formatQtHelpUrl } from '../core/library/qthelpUrl';
import type { DocPanelManager } from './docPanelManager';
import type { LibraryService } from './libraryService';

export const QCH_EDITOR_VIEW_TYPE = 'qchReader.qchEditor';

/** Opens .qch files from the Explorer directly in the documentation viewer. */
export class QchEditorProvider implements vscode.CustomReadonlyEditorProvider {
  public constructor(
    private readonly library: LibraryService,
    private readonly panels: DocPanelManager,
  ) {}

  public static register(library: LibraryService, panels: DocPanelManager): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      QCH_EDITOR_VIEW_TYPE,
      new QchEditorProvider(library, panels),
      {
        supportsMultipleEditorsPerDocument: true,
        webviewOptions: { enableFindWidget: false, retainContextWhenHidden: false },
      },
    );
  }

  public openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const viewer = this.panels.attach(panel, true);
    const file = await this.library.include(document.uri);
    if (!file) {
      await viewer.navigate(`qch-info:${document.uri.toString()}`);
      void vscode.window.showErrorMessage(
        `${document.uri.fsPath} is not a valid Qt Compressed Help file. See the QCH Reader log for details.`,
      );
      return;
    }
    const home = this.library.current.homePage(file);
    await viewer.navigate(home ? formatQtHelpUrl(home) : `qch-info:${file.namespace}`);
  }
}
