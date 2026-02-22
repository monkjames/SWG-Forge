/**
 * Mobile Duplicator Webview Panel - Rebuilt using Object Creator pattern
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { scanMobiles, loadObjectTemplatePath, loadAppearancePath, type ScanPaths, type MobileEntry } from './mobileScanner';
import { duplicateMobile, type DuplicateConfig, type DuplicatePaths } from './mobileDuplicator';

export class DuplicatorPanel {
    public static currentPanel: DuplicatorPanel | undefined;
    public static readonly viewType = 'mobileDuplicator';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _mobiles: MobileEntry[] = [];

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
        this._panel.webview.onDidReceiveMessage(m => this._handleMessage(m), null, this._disposables);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose(): void {
        DuplicatorPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    private _handleMessage(msg: any): void {
        switch (msg.type) {
            case 'ready': this._sendInit(); break;
            case 'test': this._panel.webview.postMessage({ type: 'testReply', message: 'Backend is working!' }); break;
        }
    }

    private _sendInit(): void {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                this._panel.webview.postMessage({ type: 'error', message: 'No workspace folder' });
                return;
            }
            const config = vscode.workspace.getConfiguration('swgForge');
            const scriptsPath = path.join(workspaceRoot, config.get<string>('serverScriptsPath', 'infinity4.0.0/MMOCoreORB/bin/scripts'));
            const customScriptsPath = path.join(scriptsPath, config.get<string>('customScriptsFolder', 'custom_scripts'));
            const treWorking = path.join(workspaceRoot, config.get<string>('tre.workingPath', 'tre/working'));
            const treInfinity = path.join(workspaceRoot, config.get<string>('tre.referencePath', 'tre/infinity'));
            const treVanilla = path.join(workspaceRoot, config.get<string>('tre.vanillaPath', 'tre/vanilla'));

            const scanPaths: ScanPaths = { scriptsPath, customScriptsPath, treWorking, treInfinity, treVanilla };
            this._mobiles = scanMobiles(scanPaths);
            
            const customMobiles = this._mobiles.filter(m => m.isCustom).map((m, i) => ({ ...m, index: i }));
            const vanillaMobiles = this._mobiles.filter(m => !m.isCustom).map((m, i) => ({ ...m, index: i + customMobiles.length }));

            this._panel.webview.postMessage({ type: 'init', customMobiles, vanillaMobiles });
        } catch (err: any) {
            this._panel.webview.postMessage({ type: 'error', message: err.message || String(err) });
        }
    }

    private _getHtml(): string {
        const h: string[] = [];
        h.push('<!DOCTYPE html><html><head><meta charset="UTF-8">');
        h.push('<style>');
        h.push('body{font-family:var(--vscode-font-family);padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}');
        h.push('button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:8px 16px;cursor:pointer;margin:8px}');
        h.push('#status{margin-top:16px;padding:12px;background:var(--vscode-editor-inactiveSelectionBackground)}');
        h.push('</style>');
        h.push('</head><body>');
        h.push('<h1>Mobile Duplicator - Stage 1 Test</h1>');
        h.push('<p>Testing incremental rebuild with Object Creator pattern</p>');
        h.push('<button id="testBtn">Send Test Message</button>');
        h.push('<div id="status">Waiting...</div>');
        h.push('<script>');
        h.push('var vscode=acquireVsCodeApi();');
        h.push('document.getElementById("testBtn").onclick=function(){');
        h.push('  vscode.postMessage({type:"test"});');
        h.push('  document.getElementById("status").textContent="Sent test message...";');
        h.push('};');
        h.push('window.addEventListener("message",function(e){');
        h.push('  var msg=e.data;');
        h.push('  if(msg.type==="testReply"){');
        h.push('    document.getElementById("status").textContent="SUCCESS: "+msg.message;');
        h.push('  }');
        h.push('  if(msg.type==="init"){');
        h.push('    document.getElementById("status").textContent="Loaded "+msg.customMobiles.length+" custom + "+msg.vanillaMobiles.length+" vanilla mobiles";');
        h.push('  }');
        h.push('});');
        h.push('vscode.postMessage({type:"ready"});');
        h.push('<\/script></body></html>');
        return h.join('\n');
    }
}
