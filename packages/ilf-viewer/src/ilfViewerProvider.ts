import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseILF, serializeILF, ILFData, ILFNode } from '@swgemu/core';

class ILFDocument implements vscode.CustomDocument {
    public data: ILFData;
    constructor(public readonly uri: vscode.Uri, data: ILFData) {
        this.data = data;
    }
    public dispose(): void {}
}

export class ILFViewerProvider implements vscode.CustomEditorProvider<ILFDocument> {
    public static readonly viewType = 'ilfViewer.ilfFile';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<ILFDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private panels = new Map<string, vscode.WebviewPanel>();

    constructor(private readonly context: vscode.ExtensionContext) {}

    private isEditable(uri: vscode.Uri): boolean {
        const config = vscode.workspace.getConfiguration('swgForge.tre');
        const workingDir = config.get<string>('workingPath', 'tre/working');
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return false;
        const workingRoot = path.join(workspaceFolders[0].uri.fsPath, workingDir);
        return uri.fsPath.startsWith(workingRoot + path.sep) || uri.fsPath.startsWith(workingRoot + '/');
    }

    private getRelativeTrePath(uri: vscode.Uri): string | null {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return null;
        const root = workspaceFolders[0].uri.fsPath;
        const config = vscode.workspace.getConfiguration('swgForge.tre');
        const dirs = [
            config.get<string>('workingPath', 'tre/working'),
            config.get<string>('referencePath', 'tre/infinity'),
            config.get<string>('vanillaPath', 'tre/vanilla'),
        ];
        for (const dir of dirs) {
            const prefix = path.join(root, dir) + path.sep;
            if (uri.fsPath.startsWith(prefix)) {
                return uri.fsPath.substring(prefix.length);
            }
        }
        return null;
    }

    private async handleEditInWorking(document: ILFDocument, panel: vscode.WebviewPanel): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }
        const root = workspaceFolders[0].uri.fsPath;
        const config = vscode.workspace.getConfiguration('swgForge.tre');
        const workingDir = config.get<string>('workingPath', 'tre/working');

        const relPath = this.getRelativeTrePath(document.uri);
        if (!relPath) {
            vscode.window.showWarningMessage('Cannot determine TRE-relative path for this file');
            return;
        }

        const workingPath = path.join(root, workingDir, relPath);

        if (fs.existsSync(workingPath)) {
            // Already exists in working - just open it
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(workingPath));
            return;
        }

        // Copy from current location to working
        const destDir = path.dirname(workingPath);
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(document.uri.fsPath, workingPath);

        panel.webview.postMessage({
            type: 'toast',
            message: 'Copied to ' + workingDir + '/' + relPath
        });

        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(workingPath));
    }

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new ILFViewerProvider(context);
        return vscode.window.registerCustomEditorProvider(
            ILFViewerProvider.viewType,
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false
            }
        );
    }

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<ILFDocument> {
        const buf = fs.readFileSync(uri.fsPath);
        const data = parseILF(buf);
        return new ILFDocument(uri, data);
    }

    async resolveCustomEditor(
        document: ILFDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        this.panels.set(document.uri.toString(), webviewPanel);
        webviewPanel.onDidDispose(() => { this.panels.delete(document.uri.toString()); });

        webviewPanel.webview.options = { enableScripts: true };

        const readOnly = !this.isEditable(document.uri);

        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'ready':
                    this.sendNodes(document, webviewPanel, readOnly);
                    break;
                case 'editInWorking':
                    await this.handleEditInWorking(document, webviewPanel);
                    break;
                case 'moveNode':
                    if (readOnly) return;
                    this.applyMove(document, msg.index, msg.posX, msg.posY, msg.posZ);
                    break;
                case 'duplicateNode':
                    if (readOnly) return;
                    this.applyDuplicate(document, msg.index, webviewPanel);
                    break;
                case 'deleteNode':
                    if (readOnly) return;
                    this.applyDelete(document, msg.index, webviewPanel);
                    break;
                case 'addNode':
                    if (readOnly) return;
                    this.applyAdd(document, msg.posX, msg.posZ, msg.cellName, webviewPanel);
                    break;
                case 'updateTemplate':
                    if (readOnly) return;
                    this.applyTemplateUpdate(document, msg.index, msg.templatePath);
                    break;
                case 'updateCell':
                    if (readOnly) return;
                    this.applyCellUpdate(document, msg.index, msg.cellName, webviewPanel);
                    break;
                case 'updatePosition':
                    if (readOnly) return;
                    this.applyMove(document, msg.index, msg.posX, msg.posY, msg.posZ);
                    break;
                case 'updateRotation':
                    if (readOnly) return;
                    this.applyRotation(document, msg.index, msg.yaw, msg.pitch, msg.roll);
                    break;
            }
        });

        webviewPanel.webview.html = this.getHtml();
    }

    async saveCustomDocument(document: ILFDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        const buf = serializeILF(document.data);
        fs.writeFileSync(document.uri.fsPath, buf);
    }

    async saveCustomDocumentAs(document: ILFDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
        const buf = serializeILF(document.data);
        const dir = path.dirname(destination.fsPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(destination.fsPath, buf);
    }

    async revertCustomDocument(document: ILFDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        const buf = fs.readFileSync(document.uri.fsPath);
        document.data = parseILF(buf);
        const panel = this.panels.get(document.uri.toString());
        if (panel) { this.sendNodes(document, panel); }
    }

    async backupCustomDocument(document: ILFDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        const buf = serializeILF(document.data);
        fs.writeFileSync(context.destination.fsPath, buf);
        return { id: context.destination.toString(), delete: () => { try { fs.unlinkSync(context.destination.fsPath); } catch {} } };
    }

    private markDirty(document: ILFDocument) {
        this._onDidChangeCustomDocument.fire({ document });
    }

    private sendNodes(document: ILFDocument, panel: vscode.WebviewPanel, readOnly?: boolean): void {
        const fileName = path.basename(document.uri.fsPath);
        const nodes = document.data.nodes.map((n, i) => ({
            index: i,
            templatePath: n.templatePath,
            templateName: path.basename(n.templatePath).replace(/^shared_/, '').replace(/\.iff$/, ''),
            cellName: n.cellName,
            posX: n.posX, posY: n.posY, posZ: n.posZ,
            quatW: n.quatW, quatX: n.quatX, quatY: n.quatY, quatZ: n.quatZ,
        }));
        panel.webview.postMessage({
            type: 'data', fileName, readOnly: !!readOnly,
            nodeCount: nodes.length, cells: document.data.cells, nodes
        });
    }

    private applyMove(document: ILFDocument, index: number, posX: number, posY: number, posZ: number): void {
        const node = document.data.nodes[index];
        if (!node) return;
        node.transform[3][0] = posX; node.transform[3][1] = posY; node.transform[3][2] = posZ;
        node.posX = posX; node.posY = posY; node.posZ = posZ;
        this.markDirty(document);
    }

    private applyDuplicate(document: ILFDocument, index: number, panel: vscode.WebviewPanel): void {
        const src = document.data.nodes[index];
        if (!src) return;
        const newTransform = src.transform.map(row => row.slice());
        newTransform[3][0] += 1; newTransform[3][2] += 1;
        const newNode: ILFNode = {
            templatePath: src.templatePath, cellName: src.cellName,
            transform: newTransform,
            posX: newTransform[3][0], posY: newTransform[3][1], posZ: newTransform[3][2],
            quatW: src.quatW, quatX: src.quatX, quatY: src.quatY, quatZ: src.quatZ,
        };
        document.data.nodes.push(newNode);
        this.updateCells(document);
        this.markDirty(document);
        this.sendNodes(document, panel);
        panel.webview.postMessage({ type: 'selectIndex', index: document.data.nodes.length - 1 });
    }

    private applyDelete(document: ILFDocument, index: number, panel: vscode.WebviewPanel): void {
        if (index < 0 || index >= document.data.nodes.length) return;
        document.data.nodes.splice(index, 1);
        this.updateCells(document);
        this.markDirty(document);
        this.sendNodes(document, panel);
    }

    private applyAdd(document: ILFDocument, posX: number, posZ: number, cellName: string, panel: vscode.WebviewPanel): void {
        const newNode: ILFNode = {
            templatePath: 'object/static/structure/general/shared_placeholder.iff',
            cellName: cellName || (document.data.cells[0] || 'cell'),
            transform: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [posX, 0, posZ]],
            posX, posY: 0, posZ,
            quatW: 1, quatX: 0, quatY: 0, quatZ: 0,
        };
        document.data.nodes.push(newNode);
        this.updateCells(document);
        this.markDirty(document);
        this.sendNodes(document, panel);
        panel.webview.postMessage({ type: 'selectIndex', index: document.data.nodes.length - 1 });
    }

    private applyTemplateUpdate(document: ILFDocument, index: number, templatePath: string): void {
        const node = document.data.nodes[index];
        if (!node) return;
        node.templatePath = templatePath;
        this.markDirty(document);
    }

    private applyCellUpdate(document: ILFDocument, index: number, cellName: string, panel: vscode.WebviewPanel): void {
        const node = document.data.nodes[index];
        if (!node) return;
        node.cellName = cellName;
        this.updateCells(document);
        this.markDirty(document);
        this.sendNodes(document, panel);
    }

    private applyRotation(document: ILFDocument, index: number, yawDeg: number, pitchDeg: number, rollDeg: number): void {
        const node = document.data.nodes[index];
        if (!node) return;
        const d = Math.PI / 180;
        const cy = Math.cos(yawDeg * d / 2), sy = Math.sin(yawDeg * d / 2);
        const cp = Math.cos(pitchDeg * d / 2), sp = Math.sin(pitchDeg * d / 2);
        const cr = Math.cos(rollDeg * d / 2), sr = Math.sin(rollDeg * d / 2);
        const w = cy * cp * cr + sy * sp * sr;
        const x = cy * sp * cr + sy * cp * sr;
        const y = sy * cp * cr - cy * sp * sr;
        const z = cy * cp * sr - sy * sp * cr;
        // Quaternion to 3x3 rotation matrix
        const xx = x * x, yy = y * y, zz = z * z;
        const xy = x * y, xz = x * z, yz = y * z;
        const wx = w * x, wy = w * y, wz = w * z;
        node.transform[0] = [1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy)];
        node.transform[1] = [2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx)];
        node.transform[2] = [2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy)];
        // row 3 (position) unchanged
        node.quatW = w; node.quatX = x; node.quatY = y; node.quatZ = z;
        this.markDirty(document);
    }

    private updateCells(document: ILFDocument): void {
        const cellSet = new Set<string>();
        for (const n of document.data.nodes) cellSet.add(n.cellName);
        document.data.cells = Array.from(cellSet).sort();
    }

    // =========================================================================
    // WEBVIEW HTML
    // =========================================================================
    private getHtml(): string {
        var L: string[] = [];
        L.push('<!DOCTYPE html><html lang="en"><head>');
        L.push('<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">');
        L.push('<title>ILF Editor</title><style>');

        // === BASE STYLES ===
        L.push('* { box-sizing: border-box; margin: 0; padding: 0; }');
        L.push('body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow: hidden; height: 100vh; }');
        L.push('.layout { display: flex; flex-direction: column; height: 100vh; }');

        // === HEADER & LEGEND ===
        L.push('.header { display: flex; align-items: center; gap: 10px; padding: 5px 12px; background: var(--vscode-toolbar-background); flex-wrap: wrap; flex-shrink: 0; }');
        L.push('.header .filename { font-weight: 600; font-size: 14px; }');
        L.push('.header .badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }');
        L.push('.header .tbtn { padding: 2px 8px; font-size: 11px; border: 1px solid var(--vscode-button-secondaryBackground); background: transparent; color: var(--vscode-foreground); border-radius: 3px; cursor: pointer; }');
        L.push('.header .tbtn.active { background: var(--vscode-button-secondaryBackground); }');
        L.push('.legend { display: flex; align-items: center; gap: 8px; padding: 3px 12px; flex-wrap: wrap; flex-shrink: 0; border-bottom: 1px solid var(--vscode-panel-border); }');
        L.push('.legend-item { display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer; opacity: 1; }');
        L.push('.legend-item.hidden { opacity: 0.3; }');
        L.push('.legend-dot { width: 10px; height: 10px; border-radius: 2px; }');

        // === CANVAS AREA ===
        L.push('.main { flex: 1; position: relative; min-height: 0; overflow: hidden; }');
        L.push('canvas { display: block; width: 100%; height: 100%; }');
        L.push('.coords { position: absolute; bottom: 4px; left: 8px; font-size: 10px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); pointer-events: none; }');

        // === INSPECTOR OVERLAY ===
        L.push('.inspector { position: absolute; top: 8px; right: 8px; width: 300px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; font-size: 12px; display: none; z-index: 10; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }');
        L.push('.inspector.visible { display: block; }');
        L.push('.inspector-header { display: flex; align-items: center; margin-bottom: 8px; }');
        L.push('.inspector-header h3 { flex: 1; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
        L.push('.inspector-close { background: none; border: none; color: var(--vscode-foreground); cursor: pointer; font-size: 16px; padding: 0 4px; }');
        L.push('.insp-row { display: flex; align-items: center; padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); gap: 6px; }');
        L.push('.insp-label { width: 65px; flex-shrink: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }');
        L.push('.insp-value { flex: 1; font-family: var(--vscode-editor-font-family); word-break: break-all; overflow: hidden; }');
        L.push('.insp-input { width: 100%; padding: 2px 4px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 2px; font-size: 11px; font-family: var(--vscode-editor-font-family); }');
        L.push('.insp-pos-row { display: flex; gap: 4px; }');
        L.push('.insp-pos-row label { font-size: 10px; color: var(--vscode-descriptionForeground); }');
        L.push('.insp-pos-row input { width: 70px; }');

        // === FILTER DRAWER ===
        L.push('.filter-drawer { position: absolute; top: 0; left: 0; bottom: 0; width: 280px; background: var(--vscode-editor-background); border-right: 1px solid var(--vscode-panel-border); z-index: 10; display: none; flex-direction: column; box-shadow: 4px 0 12px rgba(0,0,0,0.2); }');
        L.push('.filter-drawer.visible { display: flex; }');
        L.push('.filter-header { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }');
        L.push('.filter-header input { width: 100%; padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px; }');
        L.push('.filter-tree { flex: 1; overflow-y: auto; padding: 4px 0; }');
        L.push('.ft-row { display: flex; align-items: center; height: 22px; padding: 0 6px; cursor: pointer; font-size: 11px; white-space: nowrap; }');
        L.push('.ft-row:hover { background: var(--vscode-list-hoverBackground); }');
        L.push('.ft-arrow { width: 14px; text-align: center; font-size: 9px; flex-shrink: 0; color: var(--vscode-foreground); }');
        L.push('.ft-check { margin-right: 4px; flex-shrink: 0; cursor: pointer; }');
        L.push('.ft-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }');
        L.push('.ft-count { color: var(--vscode-descriptionForeground); margin-left: 4px; font-size: 10px; }');

        // === CONTEXT MENU ===
        L.push('.ctx-menu { position: absolute; background: var(--vscode-menu-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border); border-radius: 4px; z-index: 20; display: none; min-width: 160px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); padding: 4px 0; }');
        L.push('.ctx-item { padding: 4px 16px; font-size: 12px; cursor: pointer; }');
        L.push('.ctx-item:hover { background: var(--vscode-list-hoverBackground); }');
        L.push('.ctx-sep { height: 1px; background: var(--vscode-panel-border); margin: 4px 0; }');

        // === TOAST ===
        L.push('.toast { position: absolute; bottom: 16px; right: 16px; padding: 8px 16px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 4px; font-size: 12px; z-index: 100; transition: opacity 0.3s; opacity: 0; pointer-events: none; }');
        L.push('.toast.visible { opacity: 1; }');

        // === READ-ONLY BAR ===
        L.push('.readonly-bar { display: none; align-items: center; gap: 10px; padding: 6px 12px; background: #b58900; color: #fff; font-size: 12px; flex-shrink: 0; }');
        L.push('.readonly-bar.visible { display: flex; }');
        L.push('.readonly-bar .ro-msg { flex: 1; }');
        L.push('.readonly-bar .ro-btn { padding: 3px 12px; background: rgba(255,255,255,0.2); color: #fff; border: 1px solid rgba(255,255,255,0.4); border-radius: 3px; cursor: pointer; font-size: 12px; }');
        L.push('.readonly-bar .ro-btn:hover { background: rgba(255,255,255,0.3); }');

        L.push('.error-msg { padding: 12px; background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); border-radius: 4px; margin: 10px; display: none; }');
        L.push('.error-msg.visible { display: block; }');
        L.push('</style></head><body>');

        // === HTML STRUCTURE ===
        L.push('<div class="layout">');
        L.push('<div class="header">');
        L.push('  <span class="filename" id="fileName">Loading...</span>');
        L.push('  <span class="badge" id="nodeCount"></span>');
        L.push('  <span class="badge" id="cellCount"></span>');
        L.push('  <button class="tbtn" id="btnFilter" title="Toggle object filter">Filter</button>');
        L.push('</div>');
        L.push('<div class="readonly-bar" id="readonlyBar"><span class="ro-msg">This file is read-only. Edit a copy in the working folder to make changes.</span><button class="ro-btn" id="btnEditWorking">Edit in Working</button></div>');
        L.push('<div class="legend" id="legend"></div>');
        L.push('<div class="error-msg" id="errorMsg"></div>');
        L.push('<div class="main" id="mainArea">');
        L.push('  <canvas id="canvas"></canvas>');
        L.push('  <div class="coords" id="coords"></div>');
        // Inspector overlay
        L.push('  <div class="inspector" id="inspector"></div>');
        // Filter drawer
        L.push('  <div class="filter-drawer" id="filterDrawer">');
        L.push('    <div class="filter-header"><input type="text" id="filterInput" placeholder="Filter templates..."></div>');
        L.push('    <div class="filter-tree" id="filterTree"></div>');
        L.push('  </div>');
        // Context menu
        L.push('  <div class="ctx-menu" id="ctxMenu"></div>');
        L.push('  <div class="toast" id="toast"></div>');
        L.push('</div>');
        L.push('</div>');

        // =================================================================
        // SCRIPT
        // =================================================================
        L.push('<script>(function() {');
        L.push('var vscodeApi = acquireVsCodeApi();');
        L.push('var canvas = document.getElementById("canvas");');
        L.push('var ctx = canvas.getContext("2d");');
        L.push('var mainArea = document.getElementById("mainArea");');
        L.push('var coordsEl = document.getElementById("coords");');
        L.push('var inspectorEl = document.getElementById("inspector");');
        L.push('var legendEl = document.getElementById("legend");');
        L.push('var filterDrawer = document.getElementById("filterDrawer");');
        L.push('var filterInput = document.getElementById("filterInput");');
        L.push('var filterTree = document.getElementById("filterTree");');
        L.push('var ctxMenu = document.getElementById("ctxMenu");');
        L.push('var toastEl = document.getElementById("toast");');
        L.push('');

        // === STATE ===
        L.push('var allNodes = [], cells = [], cellColors = {}, hiddenCells = {};');
        L.push('var selectedIdx = -1, readOnly = false;');
        L.push('var camX = 0, camZ = 0, zoom = 10;');
        L.push('var panning = false, panSX = 0, panSY = 0, panCX = 0, panCZ = 0;');
        L.push('var draggingObj = false, dragObjSX = 0, dragObjSY = 0, dragObjOrigX = 0, dragObjOrigZ = 0;');
        L.push('var hiddenTemplates = {};');
        L.push('var filterDrawerOpen = false;');
        L.push('var PALETTE = ["#4dc9f6","#f67019","#f53794","#537bc4","#acc236","#166a8f","#00a950","#58595b","#8549ba","#e6194b","#3cb44b","#ffe119","#4363d8","#f58231","#911eb4","#42d4f4","#bfef45","#fabed4"];');
        L.push('');

        // === UTILS ===
        L.push('function esc(s){var d=document.createElement("div");d.appendChild(document.createTextNode(s));return d.innerHTML;}');
        L.push('function toast(msg){toastEl.textContent=msg;toastEl.classList.add("visible");setTimeout(function(){toastEl.classList.remove("visible");},2500);}');
        L.push('function assignColors(cl){cellColors={};for(var i=0;i<cl.length;i++)cellColors[cl[i]]=PALETTE[i%PALETTE.length];}');
        L.push('');

        // === EULER <-> QUATERNION (SWG Y-up: yaw=Y, pitch=X, roll=Z) ===
        L.push('function quatToEuler(w,x,y,z){');
        L.push('  var sinp=2*(w*x-z*y);');
        L.push('  var pitch;');
        L.push('  if(Math.abs(sinp)>=1)pitch=Math.sign(sinp)*90;else pitch=Math.asin(sinp)*180/Math.PI;');
        L.push('  var siny=2*(w*y+x*z),cosy=1-2*(x*x+y*y);');
        L.push('  var yaw=Math.atan2(siny,cosy)*180/Math.PI;');
        L.push('  var sinr=2*(w*z+x*y),cosr=1-2*(x*x+z*z);');
        L.push('  var roll=Math.atan2(sinr,cosr)*180/Math.PI;');
        L.push('  return{yaw:yaw,pitch:pitch,roll:roll};');
        L.push('}');
        L.push('function eulerToQuat(yawDeg,pitchDeg,rollDeg){');
        L.push('  var d=Math.PI/180;');
        L.push('  var cy=Math.cos(yawDeg*d/2),sy=Math.sin(yawDeg*d/2);');
        L.push('  var cp=Math.cos(pitchDeg*d/2),sp=Math.sin(pitchDeg*d/2);');
        L.push('  var cr=Math.cos(rollDeg*d/2),sr=Math.sin(rollDeg*d/2);');
        L.push('  return{w:cy*cp*cr+sy*sp*sr,x:cy*sp*cr+sy*cp*sr,y:sy*cp*cr-cy*sp*sr,z:cy*cp*sr-sy*sp*cr};');
        L.push('}');
        L.push('function quatToMatrix(w,x,y,z){');
        L.push('  var xx=x*x,yy=y*y,zz=z*z,xy=x*y,xz=x*z,yz=y*z,wx=w*x,wy=w*y,wz=w*z;');
        L.push('  return[[1-2*(yy+zz),2*(xy+wz),2*(xz-wy)],[2*(xy-wz),1-2*(xx+zz),2*(yz+wx)],[2*(xz+wy),2*(yz-wx),1-2*(xx+yy)]];');
        L.push('}');
        L.push('');

        // === CONVEX HULL ===
        L.push('function cross2d(o,a,b){return(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);}');
        L.push('function convexHull(pts){');
        L.push('  if(pts.length<3)return pts.slice();');
        L.push('  var s=pts.slice().sort(function(a,b){return a[0]!==b[0]?a[0]-b[0]:a[1]-b[1];});');
        L.push('  var lo=[],up=[];');
        L.push('  for(var i=0;i<s.length;i++){while(lo.length>=2&&cross2d(lo[lo.length-2],lo[lo.length-1],s[i])<=0)lo.pop();lo.push(s[i]);}');
        L.push('  for(var i=s.length-1;i>=0;i--){while(up.length>=2&&cross2d(up[up.length-2],up[up.length-1],s[i])<=0)up.pop();up.push(s[i]);}');
        L.push('  lo.pop();up.pop();return lo.concat(up);');
        L.push('}');
        L.push('');

        // === NODE VISIBILITY ===
        L.push('function isVisible(n){');
        L.push('  if(hiddenCells[n.cellName])return false;');
        L.push('  if(hiddenTemplates[n.templatePath])return false;');
        L.push('  return true;');
        L.push('}');
        L.push('');

        // === CAMERA ===
        L.push('function w2s(wx,wz){return[(wx-camX)*zoom+canvas.width/2,-(wz-camZ)*zoom+canvas.height/2];}');
        L.push('function s2w(sx,sy){return[(sx-canvas.width/2)/zoom+camX,-(sy-canvas.height/2)/zoom+camZ];}');
        L.push('');
        L.push('function resizeCanvas(){var r=mainArea.getBoundingClientRect();canvas.width=r.width*devicePixelRatio;canvas.height=r.height*devicePixelRatio;ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);draw();}');
        L.push('');
        L.push('function fitToView(){');
        L.push('  if(!allNodes.length)return;');
        L.push('  var x0=Infinity,x1=-Infinity,z0=Infinity,z1=-Infinity;');
        L.push('  for(var i=0;i<allNodes.length;i++){var n=allNodes[i];if(n.posX<x0)x0=n.posX;if(n.posX>x1)x1=n.posX;if(n.posZ<z0)z0=n.posZ;if(n.posZ>z1)z1=n.posZ;}');
        L.push('  camX=(x0+x1)/2;camZ=(z0+z1)/2;');
        L.push('  var r=mainArea.getBoundingClientRect();');
        L.push('  zoom=Math.min(r.width/((x1-x0)+4),r.height/((z1-z0)+4))*0.85;');
        L.push('  zoom=Math.max(0.5,Math.min(200,zoom));');
        L.push('}');
        L.push('');

        // === DRAW ===
        L.push('function draw(){');
        L.push('  var r=mainArea.getBoundingClientRect(),w=r.width,h=r.height;');
        L.push('  ctx.clearRect(0,0,w,h);');
        // Grid
        L.push('  ctx.strokeStyle="rgba(128,128,128,0.15)";ctx.lineWidth=1;');
        L.push('  var gs=1;if(zoom<5)gs=10;else if(zoom<20)gs=5;else if(zoom<50)gs=2;');
        L.push('  var tl=s2w(0,0),br=s2w(w,h);');
        L.push('  for(var gx=Math.floor(tl[0]/gs)*gs;gx<=br[0];gx+=gs){var s=w2s(gx,0);ctx.beginPath();ctx.moveTo(s[0],0);ctx.lineTo(s[0],h);ctx.stroke();}');
        L.push('  for(var gz=Math.floor(br[1]/gs)*gs;gz<=tl[1];gz+=gs){var s=w2s(0,gz);ctx.beginPath();ctx.moveTo(0,s[1]);ctx.lineTo(w,s[1]);ctx.stroke();}');
        // Origin
        L.push('  ctx.strokeStyle="rgba(128,128,128,0.4)";var o=w2s(0,0);ctx.beginPath();ctx.moveTo(o[0],0);ctx.lineTo(o[0],h);ctx.stroke();ctx.beginPath();ctx.moveTo(0,o[1]);ctx.lineTo(w,o[1]);ctx.stroke();');
        L.push('');
        // Convex hulls per cell
        L.push('  for(var ci=0;ci<cells.length;ci++){');
        L.push('    var cn=cells[ci];if(hiddenCells[cn])continue;');
        L.push('    var pts=[];');
        L.push('    for(var i=0;i<allNodes.length;i++){var n=allNodes[i];if(n.cellName===cn&&isVisible(n))pts.push([n.posX,n.posZ]);}');
        L.push('    if(pts.length<3)continue;');
        L.push('    var hull=convexHull(pts);if(hull.length<3)continue;');
        // Expand hull slightly outward from centroid
        L.push('    var cx=0,cz=0;for(var i=0;i<hull.length;i++){cx+=hull[i][0];cz+=hull[i][1];}cx/=hull.length;cz/=hull.length;');
        L.push('    var color=cellColors[cn]||"#888";');
        L.push('    ctx.beginPath();');
        L.push('    for(var i=0;i<hull.length;i++){');
        L.push('      var dx=hull[i][0]-cx,dz=hull[i][1]-cz,len=Math.sqrt(dx*dx+dz*dz)||1;');
        L.push('      var ex=hull[i][0]+dx/len*1.5,ez=hull[i][1]+dz/len*1.5;');
        L.push('      var s=w2s(ex,ez);');
        L.push('      if(i===0)ctx.moveTo(s[0],s[1]);else ctx.lineTo(s[0],s[1]);');
        L.push('    }');
        L.push('    ctx.closePath();ctx.fillStyle=color;ctx.globalAlpha=0.08;ctx.fill();');
        L.push('    ctx.globalAlpha=0.25;ctx.strokeStyle=color;ctx.lineWidth=1;ctx.stroke();ctx.globalAlpha=1;');
        L.push('  }');
        L.push('');
        // Objects
        L.push('  var bs=Math.max(6,Math.min(20,zoom*0.5)),hf=bs/2;');
        L.push('  for(var i=0;i<allNodes.length;i++){');
        L.push('    var n=allNodes[i];if(!isVisible(n))continue;');
        L.push('    var s=w2s(n.posX,n.posZ),color=cellColors[n.cellName]||"#888";');
        L.push('    ctx.fillStyle=(i===selectedIdx)?"#ffffff":color;');
        L.push('    ctx.globalAlpha=(i===selectedIdx)?1:0.8;');
        L.push('    ctx.fillRect(s[0]-hf,s[1]-hf,bs,bs);');
        L.push('    if(i===selectedIdx){ctx.strokeStyle=color;ctx.lineWidth=2;ctx.strokeRect(s[0]-hf-2,s[1]-hf-2,bs+4,bs+4);}');
        L.push('    ctx.globalAlpha=1;');
        L.push('  }');
        // Labels at high zoom
        L.push('  if(zoom>25){ctx.font="10px "+getComputedStyle(document.body).fontFamily;ctx.textAlign="left";ctx.textBaseline="middle";');
        L.push('    for(var i=0;i<allNodes.length;i++){var n=allNodes[i];if(!isVisible(n))continue;var s=w2s(n.posX,n.posZ);ctx.fillStyle=cellColors[n.cellName]||"#888";ctx.fillText(n.templateName,s[0]+hf+3,s[1]);}');
        L.push('  }');
        L.push('}');
        L.push('');

        // === HIT TEST ===
        L.push('function hitTest(mx,my){var bs=Math.max(6,Math.min(20,zoom*0.5)),hf=bs/2+2;');
        L.push('  for(var i=allNodes.length-1;i>=0;i--){var n=allNodes[i];if(!isVisible(n))continue;var s=w2s(n.posX,n.posZ);');
        L.push('    if(mx>=s[0]-hf&&mx<=s[0]+hf&&my>=s[1]-hf&&my<=s[1]+hf)return i;}return-1;}');
        L.push('');

        // === INSPECTOR ===
        L.push('function showInspector(idx){');
        L.push('  if(idx<0||idx>=allNodes.length){inspectorEl.classList.remove("visible");return;}');
        L.push('  var n=allNodes[idx];');
        L.push('  inspectorEl.classList.add("visible");');
        L.push('  var h=[];');
        L.push('  h.push("<div class=\\"inspector-header\\"><h3>"+esc(n.templateName)+"</h3><button class=\\"inspector-close\\" id=\\"inspClose\\">\\u2715</button></div>");');
        // Template (editable)
        L.push('  h.push("<div class=\\"insp-row\\"><span class=\\"insp-label\\">Template</span><span class=\\"insp-value\\"><input class=\\"insp-input\\" id=\\"inspTemplate\\" value=\\""+esc(n.templatePath)+"\\" /></span></div>");');
        // Cell (editable)
        L.push('  h.push("<div class=\\"insp-row\\"><span class=\\"insp-label\\">Cell</span><span class=\\"insp-value\\"><input class=\\"insp-input\\" id=\\"inspCell\\" value=\\""+esc(n.cellName)+"\\" /></span></div>");');
        // Position (editable)
        L.push('  h.push("<div class=\\"insp-row\\"><span class=\\"insp-label\\">Position</span><span class=\\"insp-value\\"><div class=\\"insp-pos-row\\">"+');
        L.push('    "<label>x<input class=\\"insp-input\\" id=\\"inspPX\\" type=\\"number\\" step=\\"0.1\\" value=\\""+n.posX.toFixed(4)+"\\" /></label>"+');
        L.push('    "<label>y<input class=\\"insp-input\\" id=\\"inspPY\\" type=\\"number\\" step=\\"0.1\\" value=\\""+n.posY.toFixed(4)+"\\" /></label>"+');
        L.push('    "<label>z<input class=\\"insp-input\\" id=\\"inspPZ\\" type=\\"number\\" step=\\"0.1\\" value=\\""+n.posZ.toFixed(4)+"\\" /></label>"+');
        L.push('    "</div></span></div>");');
        // Rotation (editable as yaw/pitch/roll)
        L.push('  var eul=quatToEuler(n.quatW,n.quatX,n.quatY,n.quatZ);');
        L.push('  h.push("<div class=\\"insp-row\\"><span class=\\"insp-label\\">Rotation</span><span class=\\"insp-value\\"><div class=\\"insp-pos-row\\">"+');
        L.push('    "<label>yaw<input class=\\"insp-input\\" id=\\"inspYaw\\" type=\\"number\\" step=\\"1\\" value=\\""+eul.yaw.toFixed(1)+"\\" /></label>"+');
        L.push('    "<label>pitch<input class=\\"insp-input\\" id=\\"inspPitch\\" type=\\"number\\" step=\\"1\\" value=\\""+eul.pitch.toFixed(1)+"\\" /></label>"+');
        L.push('    "<label>roll<input class=\\"insp-input\\" id=\\"inspRoll\\" type=\\"number\\" step=\\"1\\" value=\\""+eul.roll.toFixed(1)+"\\" /></label>"+');
        L.push('    "</div></span></div>");');
        // Quaternion (read-only, collapsed)
        L.push('  h.push("<div class=\\"insp-row\\"><span class=\\"insp-label\\">Quat</span><span class=\\"insp-value\\" style=\\"font-size:10px;color:var(--vscode-descriptionForeground)\\">"+n.quatW.toFixed(4)+", "+n.quatX.toFixed(4)+", "+n.quatY.toFixed(4)+", "+n.quatZ.toFixed(4)+"</span></div>");');
        L.push('  h.push("<div class=\\"insp-row\\"><span class=\\"insp-label\\">Index</span><span class=\\"insp-value\\">#"+idx+"</span></div>");');
        L.push('  inspectorEl.innerHTML=h.join("");');
        L.push('');
        // Disable inputs when read-only
        L.push('  if(readOnly){["inspTemplate","inspCell","inspPX","inspPY","inspPZ","inspYaw","inspPitch","inspRoll"].forEach(function(id){var el=document.getElementById(id);if(el)el.disabled=true;});}');
        // Bind events
        L.push('  document.getElementById("inspClose").addEventListener("click",function(){inspectorEl.classList.remove("visible");});');
        L.push('  document.getElementById("inspTemplate").addEventListener("change",function(){');
        L.push('    var v=this.value.trim();if(!v)return;');
        L.push('    allNodes[idx].templatePath=v;allNodes[idx].templateName=v.split("/").pop().replace(/^shared_/,"").replace(/\\.iff$/,"");');
        L.push('    vscodeApi.postMessage({type:"updateTemplate",index:idx,templatePath:v});');
        L.push('    showInspector(idx);draw();buildFilterTree();');
        L.push('  });');
        L.push('  document.getElementById("inspCell").addEventListener("change",function(){');
        L.push('    var v=this.value.trim();if(!v)return;');
        L.push('    vscodeApi.postMessage({type:"updateCell",index:idx,cellName:v});');
        L.push('  });');
        L.push('  ["inspPX","inspPY","inspPZ"].forEach(function(id,ci){');
        L.push('    document.getElementById(id).addEventListener("change",function(){');
        L.push('      var px=parseFloat(document.getElementById("inspPX").value)||0;');
        L.push('      var py=parseFloat(document.getElementById("inspPY").value)||0;');
        L.push('      var pz=parseFloat(document.getElementById("inspPZ").value)||0;');
        L.push('      allNodes[idx].posX=px;allNodes[idx].posY=py;allNodes[idx].posZ=pz;');
        L.push('      vscodeApi.postMessage({type:"updatePosition",index:idx,posX:px,posY:py,posZ:pz});draw();');
        L.push('    });');
        L.push('  });');
        // Rotation handlers
        L.push('  ["inspYaw","inspPitch","inspRoll"].forEach(function(id){');
        L.push('    document.getElementById(id).addEventListener("change",function(){');
        L.push('      var yaw=parseFloat(document.getElementById("inspYaw").value)||0;');
        L.push('      var pitch=parseFloat(document.getElementById("inspPitch").value)||0;');
        L.push('      var roll=parseFloat(document.getElementById("inspRoll").value)||0;');
        L.push('      var q=eulerToQuat(yaw,pitch,roll);');
        L.push('      allNodes[idx].quatW=q.w;allNodes[idx].quatX=q.x;allNodes[idx].quatY=q.y;allNodes[idx].quatZ=q.z;');
        L.push('      vscodeApi.postMessage({type:"updateRotation",index:idx,yaw:yaw,pitch:pitch,roll:roll});');
        L.push('      showInspector(idx);draw();');
        L.push('    });');
        L.push('  });');
        L.push('}');
        L.push('');

        // === FILTER TREE ===
        L.push('function buildFilterTree(){');
        L.push('  var root={folders:{},templates:{},count:0};');
        L.push('  for(var i=0;i<allNodes.length;i++){');
        L.push('    var tp=allNodes[i].templatePath,parts=tp.split("/"),node=root;');
        L.push('    for(var j=0;j<parts.length-1;j++){var fn=parts[j];if(!node.folders[fn])node.folders[fn]={folders:{},templates:{},count:0,path:parts.slice(0,j+1).join("/")};node=node.folders[fn];}');
        L.push('    var fn=parts[parts.length-1];if(!node.templates[fn])node.templates[fn]={path:tp,count:0};node.templates[fn].count++;');
        L.push('  }');
        // Compute counts
        L.push('  function countUp(nd){var c=0;var fns=Object.keys(nd.folders);for(var i=0;i<fns.length;i++){countUp(nd.folders[fns[i]]);c+=nd.folders[fns[i]].count;}');
        L.push('    var tns=Object.keys(nd.templates);for(var i=0;i<tns.length;i++)c+=nd.templates[tns[i]].count;nd.count=c;}');
        L.push('  countUp(root);');
        L.push('  renderFilterTree(root);');
        L.push('}');
        L.push('');
        L.push('var ftExpanded={};');
        L.push('function renderFilterTree(root){');
        L.push('  var query=filterInput.value.toLowerCase().trim();');
        L.push('  filterTree.innerHTML="";');
        L.push('  function renderNode(nd,depth){');
        L.push('    var fns=Object.keys(nd.folders).sort();');
        L.push('    for(var i=0;i<fns.length;i++){');
        L.push('      var child=nd.folders[fns[i]],fp=child.path;');
        L.push('      if(query&&fp.toLowerCase().indexOf(query)===-1){var hasMatch=false;');
        L.push('        var tns=Object.keys(child.templates);for(var t=0;t<tns.length;t++){if(child.templates[tns[t]].path.toLowerCase().indexOf(query)!==-1){hasMatch=true;break;}}');
        L.push('        if(!hasMatch){var subs=Object.keys(child.folders);var subMatch=false;function checkSub(n2){var tk=Object.keys(n2.templates);for(var t=0;t<tk.length;t++){if(n2.templates[tk[t]].path.toLowerCase().indexOf(query)!==-1)return true;}var fk=Object.keys(n2.folders);for(var f=0;f<fk.length;f++){if(checkSub(n2.folders[fk[f]]))return true;}return false;}');
        L.push('          subMatch=checkSub(child);if(!subMatch)continue;}}');
        L.push('      var exp=query?true:!!ftExpanded[fp];');
        L.push('      var row=document.createElement("div");row.className="ft-row";row.style.paddingLeft=(6+depth*14)+"px";');
        L.push('      var arrow=document.createElement("span");arrow.className="ft-arrow";arrow.textContent=exp?"\\u25BC":"\\u25B6";');
        L.push('      var name=document.createElement("span");name.className="ft-name";name.textContent=fns[i]+"/";');
        L.push('      var cnt=document.createElement("span");cnt.className="ft-count";cnt.textContent="("+child.count+")";');
        L.push('      row.appendChild(arrow);row.appendChild(name);row.appendChild(cnt);');
        L.push('      (function(p){row.addEventListener("click",function(){if(ftExpanded[p])delete ftExpanded[p];else ftExpanded[p]=true;renderFilterTree(root);});})(fp);');
        L.push('      filterTree.appendChild(row);');
        L.push('      if(exp)renderNode(child,depth+1);');
        L.push('    }');
        // Template leaves
        L.push('    var tns=Object.keys(nd.templates).sort();');
        L.push('    for(var i=0;i<tns.length;i++){');
        L.push('      var tmpl=nd.templates[tns[i]];');
        L.push('      if(query&&tmpl.path.toLowerCase().indexOf(query)===-1)continue;');
        L.push('      var row=document.createElement("div");row.className="ft-row";row.style.paddingLeft=(6+depth*14+14)+"px";');
        L.push('      var chk=document.createElement("input");chk.type="checkbox";chk.className="ft-check";chk.checked=!hiddenTemplates[tmpl.path];');
        L.push('      var name=document.createElement("span");name.className="ft-name";name.textContent=tns[i].replace(/^shared_/,"").replace(/\\.iff$/,"");name.title=tmpl.path;');
        L.push('      var cnt=document.createElement("span");cnt.className="ft-count";cnt.textContent="("+tmpl.count+")";');
        L.push('      row.appendChild(chk);row.appendChild(name);row.appendChild(cnt);');
        L.push('      (function(tp,cb){');
        L.push('        cb.addEventListener("change",function(){if(cb.checked)delete hiddenTemplates[tp];else hiddenTemplates[tp]=true;draw();});');
        L.push('        row.addEventListener("click",function(e){if(e.target!==cb){cb.checked=!cb.checked;if(cb.checked)delete hiddenTemplates[tp];else hiddenTemplates[tp]=true;draw();}});');
        L.push('      })(tmpl.path,chk);');
        L.push('      filterTree.appendChild(row);');
        L.push('    }');
        L.push('  }');
        L.push('  renderNode(root,0);');
        L.push('}');
        L.push('');
        // Filter drawer toggle
        L.push('document.getElementById("btnFilter").addEventListener("click",function(){');
        L.push('  filterDrawerOpen=!filterDrawerOpen;');
        L.push('  filterDrawer.classList.toggle("visible",filterDrawerOpen);');
        L.push('  this.classList.toggle("active",filterDrawerOpen);');
        L.push('});');
        L.push('document.getElementById("btnEditWorking").addEventListener("click",function(){vscodeApi.postMessage({type:"editInWorking"});});');
        L.push('var ftTimer=null;');
        L.push('filterInput.addEventListener("input",function(){if(ftTimer)clearTimeout(ftTimer);ftTimer=setTimeout(function(){buildFilterTree();},150);});');
        L.push('');

        // === CONTEXT MENU ===
        L.push('function showCtxMenu(x,y,items){');
        L.push('  ctxMenu.innerHTML="";ctxMenu.style.left=x+"px";ctxMenu.style.top=y+"px";ctxMenu.style.display="block";');
        L.push('  for(var i=0;i<items.length;i++){');
        L.push('    if(items[i].sep){var s=document.createElement("div");s.className="ctx-sep";ctxMenu.appendChild(s);continue;}');
        L.push('    var d=document.createElement("div");d.className="ctx-item";d.textContent=items[i].label;');
        L.push('    (function(fn){d.addEventListener("click",function(){hideCtxMenu();fn();});})(items[i].fn);');
        L.push('    ctxMenu.appendChild(d);');
        L.push('  }');
        L.push('}');
        L.push('function hideCtxMenu(){ctxMenu.style.display="none";}');
        L.push('document.addEventListener("click",function(e){if(!ctxMenu.contains(e.target))hideCtxMenu();});');
        L.push('');

        // === LEGEND ===
        L.push('function buildLegend(){');
        L.push('  legendEl.innerHTML="";');
        L.push('  for(var i=0;i<cells.length;i++){');
        L.push('    var c=cells[i],item=document.createElement("span");item.className="legend-item"+(hiddenCells[c]?" hidden":"");');
        L.push('    var dot=document.createElement("span");dot.className="legend-dot";dot.style.background=cellColors[c];');
        L.push('    var lbl=document.createElement("span");lbl.textContent=c;');
        L.push('    item.appendChild(dot);item.appendChild(lbl);');
        L.push('    (function(cell,el){el.addEventListener("click",function(){if(hiddenCells[cell]){delete hiddenCells[cell];el.classList.remove("hidden");}else{hiddenCells[cell]=true;el.classList.add("hidden");}draw();});})(c,item);');
        L.push('    legendEl.appendChild(item);');
        L.push('  }');
        L.push('}');
        L.push('');

        // === MOUSE HANDLERS ===
        L.push('canvas.addEventListener("mousedown",function(e){');
        L.push('  hideCtxMenu();');
        L.push('  if(e.button===2)return;'); // right-click handled by contextmenu
        L.push('  var r=mainArea.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;');
        L.push('  var hit=hitTest(mx,my);');
        L.push('  if(hit>=0){');
        L.push('    selectedIdx=hit;showInspector(hit);draw();');
        // Start object drag (only if editable)
        L.push('    if(!readOnly){draggingObj=true;dragObjSX=e.clientX;dragObjSY=e.clientY;');
        L.push('    dragObjOrigX=allNodes[hit].posX;dragObjOrigZ=allNodes[hit].posZ;');
        L.push('    canvas.style.cursor="move";}');
        L.push('    return;');
        L.push('  }');
        // Pan
        L.push('  panning=true;panSX=e.clientX;panSY=e.clientY;panCX=camX;panCZ=camZ;canvas.style.cursor="grabbing";');
        L.push('});');
        L.push('');
        L.push('window.addEventListener("mousemove",function(e){');
        L.push('  if(draggingObj&&selectedIdx>=0){');
        L.push('    var dx=(e.clientX-dragObjSX)/zoom,dy=-(e.clientY-dragObjSY)/zoom;');
        L.push('    allNodes[selectedIdx].posX=dragObjOrigX+dx;allNodes[selectedIdx].posZ=dragObjOrigZ+dy;');
        L.push('    draw();showInspector(selectedIdx);return;');
        L.push('  }');
        L.push('  if(panning){camX=panCX-(e.clientX-panSX)/zoom;camZ=panCZ+(e.clientY-panSY)/zoom;draw();}');
        L.push('  var r=mainArea.getBoundingClientRect(),wc=s2w(e.clientX-r.left,e.clientY-r.top);');
        L.push('  coordsEl.textContent="x: "+wc[0].toFixed(1)+"  z: "+wc[1].toFixed(1)+"  zoom: "+zoom.toFixed(1);');
        L.push('});');
        L.push('');
        L.push('window.addEventListener("mouseup",function(e){');
        L.push('  if(draggingObj&&selectedIdx>=0){');
        L.push('    draggingObj=false;canvas.style.cursor="";');
        // Only send if actually moved
        L.push('    var n=allNodes[selectedIdx];');
        L.push('    if(Math.abs(n.posX-dragObjOrigX)>0.001||Math.abs(n.posZ-dragObjOrigZ)>0.001){');
        L.push('      vscodeApi.postMessage({type:"moveNode",index:selectedIdx,posX:n.posX,posY:n.posY,posZ:n.posZ});');
        L.push('    }');
        L.push('    return;');
        L.push('  }');
        L.push('  if(panning){panning=false;canvas.style.cursor="";}');
        L.push('});');
        L.push('');
        // Click to deselect (only if no drag occurred)
        L.push('canvas.addEventListener("click",function(e){');
        L.push('  if(draggingObj||panning)return;');
        L.push('  var r=mainArea.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;');
        L.push('  if(hitTest(mx,my)<0){selectedIdx=-1;inspectorEl.classList.remove("visible");draw();}');
        L.push('});');
        L.push('');
        // Zoom
        L.push('canvas.addEventListener("wheel",function(e){e.preventDefault();');
        L.push('  var r=mainArea.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;');
        L.push('  var wb=s2w(mx,my),f=e.deltaY<0?1.15:1/1.15;zoom=Math.max(0.5,Math.min(500,zoom*f));');
        L.push('  var wa=s2w(mx,my);camX+=wb[0]-wa[0];camZ+=wb[1]-wa[1];draw();');
        L.push('},{passive:false});');
        L.push('');
        // Right-click context menu
        L.push('canvas.addEventListener("contextmenu",function(e){');
        L.push('  e.preventDefault();');
        L.push('  var r=mainArea.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;');
        L.push('  var hit=hitTest(mx,my);');
        L.push('  if(hit>=0){');
        L.push('    selectedIdx=hit;showInspector(hit);draw();');
        L.push('    if(!readOnly){showCtxMenu(mx,my,[');
        L.push('      {label:"Duplicate",fn:function(){vscodeApi.postMessage({type:"duplicateNode",index:selectedIdx});}},');
        L.push('      {label:"Delete",fn:function(){vscodeApi.postMessage({type:"deleteNode",index:selectedIdx});selectedIdx=-1;inspectorEl.classList.remove("visible");}}');
        L.push('    ]);}');
        L.push('  } else if(!readOnly){');
        L.push('    var wc=s2w(mx,my);');
        L.push('    showCtxMenu(mx,my,[');
        L.push('      {label:"Add Object Here",fn:function(){vscodeApi.postMessage({type:"addNode",posX:wc[0],posZ:wc[1],cellName:cells[0]||"cell"});}}');
        L.push('    ]);');
        L.push('  }');
        L.push('});');
        L.push('');
        // Delete key
        L.push('document.addEventListener("keydown",function(e){');
        L.push('  if(e.target.tagName==="INPUT"||readOnly)return;');
        L.push('  if(e.key==="Delete"&&selectedIdx>=0){');
        L.push('    vscodeApi.postMessage({type:"deleteNode",index:selectedIdx});selectedIdx=-1;inspectorEl.classList.remove("visible");');
        L.push('  }');
        L.push('});');
        L.push('');
        L.push('window.addEventListener("resize",resizeCanvas);');
        L.push('');

        // === MESSAGE HANDLER ===
        L.push('window.addEventListener("message",function(ev){');
        L.push('  var msg=ev.data;');
        L.push('  if(msg.type==="data"){');
        L.push('    document.getElementById("fileName").textContent=msg.fileName;');
        L.push('    document.getElementById("nodeCount").textContent=msg.nodeCount+" objects";');
        L.push('    document.getElementById("cellCount").textContent=msg.cells.length+" cells";');
        L.push('    allNodes=msg.nodes;cells=msg.cells;');
        L.push('    readOnly=!!msg.readOnly;');
        L.push('    document.getElementById("readonlyBar").classList.toggle("visible",readOnly);');
        L.push('    assignColors(cells);buildLegend();buildFilterTree();');
        L.push('    if(selectedIdx<0){resizeCanvas();fitToView();}');
        L.push('    draw();');
        L.push('  } else if(msg.type==="selectIndex"){');
        L.push('    selectedIdx=msg.index;showInspector(msg.index);draw();');
        L.push('    toast("Object added");');
        L.push('  } else if(msg.type==="error"){');
        L.push('    document.getElementById("errorMsg").textContent=msg.message;');
        L.push('    document.getElementById("errorMsg").classList.add("visible");');
        L.push('  }');
        L.push('});');
        L.push('');
        L.push('vscodeApi.postMessage({type:"ready"});');
        L.push('})();</script></body></html>');
        return L.join('\n');
    }
}
