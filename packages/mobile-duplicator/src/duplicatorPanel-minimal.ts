/**
 * MINIMAL TEST VERSION - Mobile Duplicator Webview Panel
 */

import * as vscode from 'vscode';

export class DuplicatorPanel {
    public static currentPanel: DuplicatorPanel | undefined;
    public static readonly viewType = 'mobileDuplicator';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri): DuplicatorPanel {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (DuplicatorPanel.currentPanel) {
            DuplicatorPanel.currentPanel._panel.reveal(column);
            return DuplicatorPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            DuplicatorPanel.viewType, 'Mobile Duplicator',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        DuplicatorPanel.currentPanel = new DuplicatorPanel(panel, extensionUri);
        return DuplicatorPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtml();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose(): void {
        DuplicatorPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    private _getHtml(): string {
        const h: string[] = [];
        h.push('<!DOCTYPE html>');
        h.push('<html lang="en">');
        h.push('<head>');
        h.push('<meta charset="UTF-8">');
        h.push('<meta name="viewport" content="width=device-width,initial-scale=1.0">');
        h.push('<style>');
        h.push('body{font-family:var(--vscode-font-family);padding:20px;}');
        h.push('h1{color:var(--vscode-foreground);}');
        h.push('</style>');
        h.push('</head>');
        h.push('<body>');
        h.push('<h1>Mobile Duplicator Test</h1>');
        h.push('<p>If you can see this, the basic webview works.</p>');
        h.push('</body>');
        h.push('</html>');
        return h.join('\n');
    }
}
