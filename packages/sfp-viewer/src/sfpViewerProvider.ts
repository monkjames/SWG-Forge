import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseSFP, serializeSFP, SfpData } from './sfpParser';

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

class SFPDocument implements vscode.CustomDocument {
    public data: SfpData;

    constructor(public readonly uri: vscode.Uri, initialData: Buffer) {
        this.data = parseSFP(initialData);
    }

    reload(raw: Buffer): void {
        this.data = parseSFP(raw);
    }

    dispose() {}
}

// ---------------------------------------------------------------------------
// Deep-clone helper for undo snapshots
// ---------------------------------------------------------------------------

function cloneSfp(d: SfpData): SfpData {
    return {
        colSize: d.colSize,
        rowSize: d.rowSize,
        centerX: d.centerX,
        centerY: d.centerY,
        colChunkSize: d.colChunkSize,
        rowChunkSize: d.rowChunkSize,
        totalWidth: d.totalWidth,
        totalHeight: d.totalHeight,
        grid: d.grid.map(row => [...row]),
    };
}

function applySfp(target: SfpData, src: SfpData): void {
    target.colSize = src.colSize;
    target.rowSize = src.rowSize;
    target.centerX = src.centerX;
    target.centerY = src.centerY;
    target.colChunkSize = src.colChunkSize;
    target.rowChunkSize = src.rowChunkSize;
    target.totalWidth = src.totalWidth;
    target.totalHeight = src.totalHeight;
    target.grid = src.grid.map(row => [...row]);
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SFPViewerProvider implements vscode.CustomEditorProvider<SFPDocument> {
    private static readonly viewType = 'sfpViewer.sfpFile';

    private readonly _onDidChangeCustomDocument =
        new vscode.EventEmitter<vscode.CustomDocumentEditEvent<SFPDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    // Track webview panels per document so we can push updates
    private readonly _webviews = new Map<string, vscode.WebviewPanel>();

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            SFPViewerProvider.viewType,
            new SFPViewerProvider(context),
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        );
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    // ---- Document lifecycle ----

    async openCustomDocument(uri: vscode.Uri): Promise<SFPDocument> {
        const raw = await fs.promises.readFile(uri.fsPath);
        return new SFPDocument(uri, Buffer.from(raw));
    }

    async saveCustomDocument(document: SFPDocument): Promise<void> {
        const data = serializeSFP(document.data);
        await vscode.workspace.fs.writeFile(document.uri, data);
    }

    async saveCustomDocumentAs(document: SFPDocument, destination: vscode.Uri): Promise<void> {
        const data = serializeSFP(document.data);
        await vscode.workspace.fs.writeFile(destination, data);
    }

    async revertCustomDocument(document: SFPDocument): Promise<void> {
        const raw = await fs.promises.readFile(document.uri.fsPath);
        document.reload(Buffer.from(raw));
        this.postUpdate(document);
    }

    async backupCustomDocument(
        document: SFPDocument,
        context: vscode.CustomDocumentBackupContext
    ): Promise<vscode.CustomDocumentBackup> {
        const data = serializeSFP(document.data);
        await vscode.workspace.fs.writeFile(context.destination, data);
        return {
            id: context.destination.toString(),
            delete: () => vscode.workspace.fs.delete(context.destination),
        };
    }

    // ---- Editor ----

    async resolveCustomEditor(
        document: SFPDocument,
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        this._webviews.set(document.uri.toString(), webviewPanel);
        webviewPanel.onDidDispose(() => {
            this._webviews.delete(document.uri.toString());
        });

        webviewPanel.webview.options = { enableScripts: true };

        const isEditable = this.isInWorkingFolder(document.uri.fsPath);
        const workingPath = this.getWorkingFolderPath(document.uri.fsPath);
        const workingExists = workingPath ? fs.existsSync(workingPath) : false;

        webviewPanel.webview.html = this._getHtml();

        webviewPanel.webview.onDidReceiveMessage(async (e) => {
            try {
                switch (e.type) {
                    case 'ready':
                        webviewPanel.webview.postMessage({
                            type: 'init',
                            sfp: this.sfpToJson(document),
                            isEditable,
                            workingFolderPath: workingPath,
                            workingExists,
                        });
                        break;

                    case 'toggleCell':
                        if (isEditable) {
                            this.handleToggleCell(document, e.row, e.col);
                        }
                        break;

                    case 'resize':
                        if (isEditable) {
                            this.handleResize(document, e.colSize, e.rowSize);
                        }
                        break;

                    case 'setCenter':
                        if (isEditable) {
                            this.handleSetCenter(document, e.col, e.row);
                        }
                        break;

                    case 'setChunkSize':
                        if (isEditable) {
                            this.handleSetChunkSize(document, e.colChunkSize, e.rowChunkSize);
                        }
                        break;

                    case 'copyToWorkingFolder':
                        await this.handleCopyToWorkingFolder(document, e.targetPath, webviewPanel);
                        break;
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(`SFP Editor error: ${err.message}`);
            }
        });
    }

    // ---- Edit handlers ----

    private handleToggleCell(document: SFPDocument, row: number, col: number): void {
        const d = document.data;
        if (row < 0 || row >= d.rowSize || col < 0 || col >= d.colSize) { return; }

        const oldState = cloneSfp(d);
        const oldVal = d.grid[row][col];
        d.grid[row][col] = oldVal === 'H' ? 'F' : 'H';
        const newState = cloneSfp(d);

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => { applySfp(d, oldState); this.postUpdate(document); },
            redo: () => { applySfp(d, newState); this.postUpdate(document); },
        });

        this.postUpdate(document);
    }

    private handleResize(document: SFPDocument, newCols: number, newRows: number): void {
        const d = document.data;
        newCols = Math.max(1, Math.min(50, newCols));
        newRows = Math.max(1, Math.min(50, newRows));
        if (newCols === d.colSize && newRows === d.rowSize) { return; }

        const oldState = cloneSfp(d);

        // Build new grid, copying existing data and filling new cells with 'F'
        const newGrid: string[][] = [];
        for (let r = 0; r < newRows; r++) {
            const row: string[] = [];
            for (let c = 0; c < newCols; c++) {
                row.push((r < d.rowSize && c < d.colSize) ? d.grid[r][c] : 'F');
            }
            newGrid.push(row);
        }

        d.colSize = newCols;
        d.rowSize = newRows;
        d.grid = newGrid;
        d.totalWidth = d.colSize * d.colChunkSize;
        d.totalHeight = d.rowSize * d.rowChunkSize;
        // Clamp center
        if (d.centerX >= d.colSize) { d.centerX = d.colSize - 1; }
        if (d.centerY >= d.rowSize) { d.centerY = d.rowSize - 1; }

        const newState = cloneSfp(d);

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => { applySfp(d, oldState); this.postUpdate(document); },
            redo: () => { applySfp(d, newState); this.postUpdate(document); },
        });

        this.postUpdate(document);
    }

    private handleSetCenter(document: SFPDocument, col: number, row: number): void {
        const d = document.data;
        if (col < 0 || col >= d.colSize || row < 0 || row >= d.rowSize) { return; }
        if (col === d.centerX && row === d.centerY) { return; }

        const oldState = cloneSfp(d);
        d.centerX = col;
        d.centerY = row;
        const newState = cloneSfp(d);

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => { applySfp(d, oldState); this.postUpdate(document); },
            redo: () => { applySfp(d, newState); this.postUpdate(document); },
        });

        this.postUpdate(document);
    }

    private handleSetChunkSize(document: SFPDocument, colCS: number, rowCS: number): void {
        const d = document.data;
        colCS = Math.max(0.5, Math.min(100, colCS));
        rowCS = Math.max(0.5, Math.min(100, rowCS));
        if (colCS === d.colChunkSize && rowCS === d.rowChunkSize) { return; }

        const oldState = cloneSfp(d);
        d.colChunkSize = colCS;
        d.rowChunkSize = rowCS;
        d.totalWidth = d.colSize * d.colChunkSize;
        d.totalHeight = d.rowSize * d.rowChunkSize;
        const newState = cloneSfp(d);

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => { applySfp(d, oldState); this.postUpdate(document); },
            redo: () => { applySfp(d, newState); this.postUpdate(document); },
        });

        this.postUpdate(document);
    }

    // ---- Copy to working folder ----

    private async handleCopyToWorkingFolder(
        document: SFPDocument,
        targetPath: string,
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        try {
            const targetUri = vscode.Uri.file(targetPath);
            const targetDir = path.dirname(targetPath);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir));
            await vscode.workspace.fs.copy(document.uri, targetUri, { overwrite: false });
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await vscode.commands.executeCommand('vscode.open', targetUri);
        } catch (err: any) {
            if (err.code === 'FileExists') {
                const action = await vscode.window.showWarningMessage(
                    `File already exists: ${path.basename(targetPath)}`,
                    'Open Existing',
                    'Overwrite'
                );
                if (action === 'Open Existing') {
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(targetPath));
                } else if (action === 'Overwrite') {
                    await vscode.workspace.fs.copy(document.uri, vscode.Uri.file(targetPath), { overwrite: true });
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(targetPath));
                }
            } else {
                vscode.window.showErrorMessage(`Failed to copy: ${err.message}`);
            }
        }
    }

    // ---- Helpers ----

    private isInWorkingFolder(filePath: string): boolean {
        return filePath.replace(/\\/g, '/').includes('/tre/working/');
    }

    private getWorkingFolderPath(filePath: string): string | null {
        if (this.isInWorkingFolder(filePath)) { return null; }

        const normalized = filePath.replace(/\\/g, '/');
        const mappings = [
            { from: '/tre/vanilla/', to: '/tre/working/' },
            { from: '/tre/infinity/', to: '/tre/working/' },
        ];

        for (const m of mappings) {
            if (normalized.includes(m.from)) {
                return normalized.replace(m.from, m.to);
            }
        }

        // Generic fallback: extract relative path after tre/<folder>/
        const treMatch = normalized.match(/\/tre\/([^/]+)\/(.*)/);
        if (treMatch) {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            return path.join(ws, 'tre', 'working', treMatch[2]).replace(/\\/g, '/');
        }

        return null;
    }

    private sfpToJson(document: SFPDocument): any {
        const d = document.data;
        return {
            colSize: d.colSize,
            rowSize: d.rowSize,
            centerX: d.centerX,
            centerY: d.centerY,
            colChunkSize: d.colChunkSize,
            rowChunkSize: d.rowChunkSize,
            totalWidth: d.totalWidth,
            totalHeight: d.totalHeight,
            grid: d.grid,
            fileName: document.uri.fsPath.split('/').pop() || 'unknown.sfp',
        };
    }

    private postUpdate(document: SFPDocument): void {
        const panel = this._webviews.get(document.uri.toString());
        if (panel) {
            panel.webview.postMessage({ type: 'update', sfp: this.sfpToJson(document) });
        }
    }

    // ---- HTML ----

    private _getHtml(): string {
        const lines: string[] = [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="UTF-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '<title>SFP Editor</title>',
            '<style>',
            '  * { margin: 0; padding: 0; box-sizing: border-box; }',
            '  body { overflow: hidden; background: #1e1e1e; font-family: var(--vscode-font-family, monospace); color: #ccc; display: flex; flex-direction: column; height: 100vh; }',
            '  #canvas { flex: 1; display: block; cursor: pointer; min-height: 0; }',
            '  body.readonly #canvas { cursor: default; }',
            '',
            '  #readonly-banner {',
            '    display: none; align-items: center; justify-content: space-between;',
            '    padding: 8px 16px; background: rgba(180, 130, 40, 0.2);',
            '    border-bottom: 1px solid rgba(180, 130, 40, 0.5); font-size: 12px; flex-shrink: 0;',
            '  }',
            '  #readonly-banner.visible { display: flex; }',
            '  #readonly-banner button {',
            '    background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);',
            '    border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: 12px;',
            '  }',
            '  #readonly-banner button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }',
            '',
            '  #toolbar {',
            '    display: none; align-items: center; gap: 12px; padding: 6px 12px;',
            '    background: rgba(40,40,40,0.95); border-bottom: 1px solid #444; font-size: 12px; flex-shrink: 0;',
            '  }',
            '  #toolbar.visible { display: flex; }',
            '  #toolbar .group { display: flex; align-items: center; gap: 4px; }',
            '  #toolbar .group-label { color: #888; margin-right: 2px; }',
            '  #toolbar button {',
            '    background: var(--vscode-button-secondaryBackground, #3a3d41);',
            '    color: var(--vscode-button-secondaryForeground, #ccc);',
            '    border: 1px solid #555; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 12px;',
            '  }',
            '  #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #505357); }',
            '  #toolbar input[type="number"] {',
            '    width: 50px; background: var(--vscode-input-background, #3c3c3c);',
            '    color: var(--vscode-input-foreground, #ccc);',
            '    border: 1px solid var(--vscode-input-border, #555); padding: 2px 4px;',
            '    border-radius: 2px; font-size: 12px; font-family: inherit;',
            '  }',
            '  #toolbar .sep { width: 1px; height: 20px; background: #555; }',
            '',
            '  #info-bar {',
            '    padding: 6px 16px; font-size: 12px; color: #aaa; border-bottom: 1px solid #333; flex-shrink: 0;',
            '  }',
            '  #info-bar .filename { color: #4ec9b0; font-weight: bold; }',
            '  #info-bar .dim { color: #569cd6; }',
            '  #info-bar .sep { color: #555; margin: 0 6px; }',
            '',
            '  #footer {',
            '    display: flex; align-items: center; justify-content: space-between;',
            '    padding: 5px 16px; font-size: 11px; border-top: 1px solid #333; flex-shrink: 0;',
            '    color: #888; min-height: 26px;',
            '  }',
            '  #footer .legend { display: flex; gap: 14px; }',
            '  #footer .legend-item { display: flex; align-items: center; gap: 4px; }',
            '  #footer .swatch {',
            '    display: inline-block; width: 12px; height: 12px;',
            '    border-radius: 2px; border: 1px solid #555;',
            '  }',
            '  #hover-info { color: #aaa; }',
            '</style>',
            '</head>',
            '<body>',
            '<div id="readonly-banner">',
            '  <span>This file is read-only. Copy to the working folder to edit.</span>',
            '  <button id="banner-btn">Copy to Working Folder</button>',
            '</div>',
            '<div id="toolbar">',
            '  <div class="group">',
            '    <span class="group-label">Grid:</span>',
            '    <button id="btn-sub-col">-Col</button>',
            '    <button id="btn-add-col">+Col</button>',
            '    <button id="btn-sub-row">-Row</button>',
            '    <button id="btn-add-row">+Row</button>',
            '  </div>',
            '  <div class="sep"></div>',
            '  <div class="group">',
            '    <span class="group-label">Cell (m):</span>',
            '    <input type="number" id="inp-col-chunk" step="1" min="1" max="100" title="Meters per column">',
            '    <span style="color:#666">x</span>',
            '    <input type="number" id="inp-row-chunk" step="1" min="1" max="100" title="Meters per row">',
            '  </div>',
            '  <div class="sep"></div>',
            '  <div class="group" style="color:#888; font-size:11px;">',
            '    <span>Left-click: toggle cell | Right-click: set center</span>',
            '  </div>',
            '</div>',
            '<div id="info-bar"></div>',
            '<canvas id="canvas"></canvas>',
            '<div id="footer">',
            '  <div class="legend">',
            '    <div class="legend-item"><span class="swatch" style="background:#c0392b"></span> Structure (H)</div>',
            '    <div class="legend-item"><span class="swatch" style="background:#27ae60"></span> Free (F)</div>',
            '    <div class="legend-item"><span class="swatch" style="background:transparent; border: 2px solid #f1c40f"></span> Center</div>',
            '  </div>',
            '  <div id="hover-info"></div>',
            '</div>',
            '<script>',
            '(function() {',
            '',
            'var vscodeApi = acquireVsCodeApi();',
            'var sfp = null;',
            'var isEditable = false;',
            'var workingFolderPath = null;',
            'var workingExists = false;',
            '',
            'var canvas = document.getElementById("canvas");',
            'var ctx = canvas.getContext("2d");',
            'var hoveredCol = -1, hoveredRow = -1;',
            'var gridX = 0, gridY = 0, cellPx = 0;',
            '',
            'var COLOR_H = "#c0392b";',
            'var COLOR_H_HOVER = "#e74c3c";',
            'var COLOR_F = "#27ae60";',
            'var COLOR_F_HOVER = "#2ecc71";',
            'var COLOR_CENTER = "#f1c40f";',
            'var COLOR_GRID = "#444";',
            'var COLOR_BG = "#1e1e1e";',
            '',
            '// ---- Message handling ----',
            'window.addEventListener("message", function(event) {',
            '  var msg = event.data;',
            '  if (msg.type === "init") {',
            '    sfp = msg.sfp;',
            '    isEditable = msg.isEditable;',
            '    workingFolderPath = msg.workingFolderPath;',
            '    workingExists = msg.workingExists;',
            '    setupUI();',
            '    resize();',
            '  } else if (msg.type === "update") {',
            '    sfp = msg.sfp;',
            '    updateToolbarInputs();',
            '    updateInfoBar();',
            '    render();',
            '  }',
            '});',
            '',
            'vscodeApi.postMessage({ type: "ready" });',
            '',
            '// ---- UI setup ----',
            'function setupUI() {',
            '  var banner = document.getElementById("readonly-banner");',
            '  var toolbar = document.getElementById("toolbar");',
            '',
            '  if (isEditable) {',
            '    banner.classList.remove("visible");',
            '    toolbar.classList.add("visible");',
            '    document.body.classList.remove("readonly");',
            '  } else {',
            '    banner.classList.add("visible");',
            '    toolbar.classList.remove("visible");',
            '    document.body.classList.add("readonly");',
            '',
            '    var btn = document.getElementById("banner-btn");',
            '    if (workingExists) {',
            '      btn.textContent = "Open Editable Version";',
            '    } else {',
            '      btn.textContent = "Copy to Working Folder";',
            '    }',
            '  }',
            '',
            '  updateToolbarInputs();',
            '  updateInfoBar();',
            '}',
            '',
            'function updateToolbarInputs() {',
            '  if (!sfp) { return; }',
            '  document.getElementById("inp-col-chunk").value = sfp.colChunkSize;',
            '  document.getElementById("inp-row-chunk").value = sfp.rowChunkSize;',
            '}',
            '',
            '// ---- Resize ----',
            'function resize() {',
            '  canvas.width = canvas.clientWidth;',
            '  canvas.height = canvas.clientHeight;',
            '  render();',
            '}',
            'window.addEventListener("resize", resize);',
            '',
            '// ---- Render ----',
            'function render() {',
            '  if (!sfp) { return; }',
            '  ctx.fillStyle = COLOR_BG;',
            '  ctx.fillRect(0, 0, canvas.width, canvas.height);',
            '',
            '  var cols = sfp.colSize;',
            '  var rows = sfp.rowSize;',
            '  if (cols === 0 || rows === 0) { return; }',
            '',
            '  var padX = 100, padY = 60;',
            '  var availW = canvas.width - padX;',
            '  var availH = canvas.height - padY;',
            '  cellPx = Math.floor(Math.min(availW / cols, availH / rows));',
            '  cellPx = Math.max(cellPx, 20);',
            '  cellPx = Math.min(cellPx, 120);',
            '',
            '  var totalW = cols * cellPx;',
            '  var totalH = rows * cellPx;',
            '  gridX = Math.floor((canvas.width - totalW) / 2);',
            '  gridY = Math.floor((canvas.height - totalH) / 2);',
            '',
            '  // Draw cells',
            '  for (var r = 0; r < rows; r++) {',
            '    for (var c = 0; c < cols; c++) {',
            '      var x = gridX + c * cellPx;',
            '      var y = gridY + r * cellPx;',
            '      var cellType = (sfp.grid[r] && sfp.grid[r][c]) || "?";',
            '      var isHovered = (r === hoveredRow && c === hoveredCol);',
            '',
            '      if (cellType === "H") {',
            '        ctx.fillStyle = isHovered ? COLOR_H_HOVER : COLOR_H;',
            '      } else if (cellType === "F") {',
            '        ctx.fillStyle = isHovered ? COLOR_F_HOVER : COLOR_F;',
            '      } else {',
            '        ctx.fillStyle = "#555";',
            '      }',
            '      ctx.fillRect(x + 1, y + 1, cellPx - 2, cellPx - 2);',
            '',
            '      if (cellPx >= 36) {',
            '        ctx.fillStyle = "rgba(255,255,255,0.5)";',
            '        ctx.font = "bold " + Math.floor(cellPx * 0.3) + "px monospace";',
            '        ctx.textAlign = "center";',
            '        ctx.textBaseline = "middle";',
            '        ctx.fillText(cellType, x + cellPx / 2, y + cellPx / 2);',
            '      }',
            '    }',
            '  }',
            '',
            '  // Grid lines',
            '  ctx.strokeStyle = COLOR_GRID;',
            '  ctx.lineWidth = 1;',
            '  for (var r = 0; r <= rows; r++) {',
            '    ctx.beginPath();',
            '    ctx.moveTo(gridX, gridY + r * cellPx);',
            '    ctx.lineTo(gridX + totalW, gridY + r * cellPx);',
            '    ctx.stroke();',
            '  }',
            '  for (var c = 0; c <= cols; c++) {',
            '    ctx.beginPath();',
            '    ctx.moveTo(gridX + c * cellPx, gridY);',
            '    ctx.lineTo(gridX + c * cellPx, gridY + totalH);',
            '    ctx.stroke();',
            '  }',
            '',
            '  // Center marker',
            '  var cx = gridX + sfp.centerX * cellPx;',
            '  var cy = gridY + sfp.centerY * cellPx;',
            '  ctx.strokeStyle = COLOR_CENTER;',
            '  ctx.lineWidth = 3;',
            '  ctx.strokeRect(cx + 2, cy + 2, cellPx - 4, cellPx - 4);',
            '  var ccx = cx + cellPx / 2;',
            '  var ccy = cy + cellPx / 2;',
            '  ctx.beginPath();',
            '  ctx.moveTo(ccx - 8, ccy); ctx.lineTo(ccx + 8, ccy);',
            '  ctx.moveTo(ccx, ccy - 8); ctx.lineTo(ccx, ccy + 8);',
            '  ctx.stroke();',
            '',
            '  // Dimension labels along top',
            '  ctx.fillStyle = "#888";',
            '  ctx.font = "11px monospace";',
            '  ctx.textAlign = "center";',
            '  ctx.textBaseline = "bottom";',
            '  for (var c = 0; c < cols; c++) {',
            '    ctx.fillText((c * sfp.colChunkSize).toFixed(0) + "m", gridX + c * cellPx + cellPx / 2, gridY - 4);',
            '  }',
            '',
            '  // Row labels along left',
            '  ctx.textAlign = "right";',
            '  ctx.textBaseline = "middle";',
            '  for (var r = 0; r < rows; r++) {',
            '    ctx.fillText((r * sfp.rowChunkSize).toFixed(0) + "m", gridX - 6, gridY + r * cellPx + cellPx / 2);',
            '  }',
            '',
            '  // Total dimensions below grid',
            '  ctx.fillStyle = "#569cd6";',
            '  ctx.font = "12px monospace";',
            '  ctx.textAlign = "center";',
            '  ctx.textBaseline = "top";',
            '  ctx.fillText(sfp.totalWidth.toFixed(0) + "m wide x " + sfp.totalHeight.toFixed(0) + "m tall", gridX + totalW / 2, gridY + totalH + 8);',
            '}',
            '',
            '// ---- Hit test ----',
            'function getCellAt(e) {',
            '  var rect = canvas.getBoundingClientRect();',
            '  var mx = e.clientX - rect.left;',
            '  var my = e.clientY - rect.top;',
            '  var c = Math.floor((mx - gridX) / cellPx);',
            '  var r = Math.floor((my - gridY) / cellPx);',
            '  if (sfp && c >= 0 && c < sfp.colSize && r >= 0 && r < sfp.rowSize) {',
            '    return { col: c, row: r };',
            '  }',
            '  return null;',
            '}',
            '',
            '// ---- Mouse events ----',
            'canvas.addEventListener("mousemove", function(e) {',
            '  var cell = getCellAt(e);',
            '  var prevCol = hoveredCol, prevRow = hoveredRow;',
            '  if (cell) {',
            '    hoveredCol = cell.col;',
            '    hoveredRow = cell.row;',
            '  } else {',
            '    hoveredCol = -1;',
            '    hoveredRow = -1;',
            '  }',
            '  if (hoveredCol !== prevCol || hoveredRow !== prevRow) {',
            '    render();',
            '    updateHoverInfo();',
            '  }',
            '});',
            '',
            'canvas.addEventListener("mouseleave", function() {',
            '  hoveredCol = -1;',
            '  hoveredRow = -1;',
            '  render();',
            '  updateHoverInfo();',
            '});',
            '',
            '// Left-click: toggle cell',
            'canvas.addEventListener("click", function(e) {',
            '  if (!isEditable || !sfp) { return; }',
            '  var cell = getCellAt(e);',
            '  if (cell) {',
            '    var old = sfp.grid[cell.row][cell.col];',
            '    sfp.grid[cell.row][cell.col] = old === "H" ? "F" : "H";',
            '    render();',
            '    updateInfoBar();',
            '    vscodeApi.postMessage({ type: "toggleCell", row: cell.row, col: cell.col });',
            '  }',
            '});',
            '',
            '// Right-click: set center',
            'canvas.addEventListener("contextmenu", function(e) {',
            '  e.preventDefault();',
            '  if (!isEditable || !sfp) { return; }',
            '  var cell = getCellAt(e);',
            '  if (cell) {',
            '    sfp.centerX = cell.col;',
            '    sfp.centerY = cell.row;',
            '    render();',
            '    updateInfoBar();',
            '    vscodeApi.postMessage({ type: "setCenter", col: cell.col, row: cell.row });',
            '  }',
            '});',
            '',
            '// ---- Toolbar buttons ----',
            'document.getElementById("btn-add-col").addEventListener("click", function() {',
            '  if (!sfp) { return; }',
            '  vscodeApi.postMessage({ type: "resize", colSize: sfp.colSize + 1, rowSize: sfp.rowSize });',
            '});',
            'document.getElementById("btn-sub-col").addEventListener("click", function() {',
            '  if (!sfp || sfp.colSize <= 1) { return; }',
            '  vscodeApi.postMessage({ type: "resize", colSize: sfp.colSize - 1, rowSize: sfp.rowSize });',
            '});',
            'document.getElementById("btn-add-row").addEventListener("click", function() {',
            '  if (!sfp) { return; }',
            '  vscodeApi.postMessage({ type: "resize", colSize: sfp.colSize, rowSize: sfp.rowSize + 1 });',
            '});',
            'document.getElementById("btn-sub-row").addEventListener("click", function() {',
            '  if (!sfp || sfp.rowSize <= 1) { return; }',
            '  vscodeApi.postMessage({ type: "resize", colSize: sfp.colSize, rowSize: sfp.rowSize - 1 });',
            '});',
            '',
            '// Cell size inputs',
            'document.getElementById("inp-col-chunk").addEventListener("change", function() {',
            '  if (!sfp) { return; }',
            '  var val = parseFloat(this.value) || sfp.colChunkSize;',
            '  vscodeApi.postMessage({ type: "setChunkSize", colChunkSize: val, rowChunkSize: sfp.rowChunkSize });',
            '});',
            'document.getElementById("inp-row-chunk").addEventListener("change", function() {',
            '  if (!sfp) { return; }',
            '  var val = parseFloat(this.value) || sfp.rowChunkSize;',
            '  vscodeApi.postMessage({ type: "setChunkSize", colChunkSize: sfp.colChunkSize, rowChunkSize: val });',
            '});',
            '',
            '// Banner button',
            'document.getElementById("banner-btn").addEventListener("click", function() {',
            '  if (workingFolderPath) {',
            '    vscodeApi.postMessage({ type: "copyToWorkingFolder", targetPath: workingFolderPath });',
            '  }',
            '});',
            '',
            '// ---- Info bar (inline text above grid) ----',
            'function updateInfoBar() {',
            '  if (!sfp) { return; }',
            '  var hCount = 0;',
            '  for (var r = 0; r < sfp.grid.length; r++) {',
            '    for (var c = 0; c < sfp.grid[r].length; c++) {',
            '      if (sfp.grid[r][c] === "H") { hCount++; }',
            '    }',
            '  }',
            '  var total = sfp.colSize * sfp.rowSize;',
            '  var pct = total > 0 ? (hCount / total * 100).toFixed(0) : 0;',
            '  document.getElementById("info-bar").innerHTML = [',
            '    "<span class=\\"filename\\">" + sfp.fileName + "</span>",',
            '    "<span class=\\"sep\\">|</span>",',
            '    sfp.colSize + " x " + sfp.rowSize + " cells",',
            '    "<span class=\\"sep\\">|</span>",',
            '    sfp.colChunkSize.toFixed(0) + "m x " + sfp.rowChunkSize.toFixed(0) + "m per cell",',
            '    "<span class=\\"sep\\">|</span>",',
            '    "<span class=\\"dim\\">" + sfp.totalWidth.toFixed(0) + "m x " + sfp.totalHeight.toFixed(0) + "m</span>",',
            '    "<span class=\\"sep\\">|</span>",',
            '    "Center (" + sfp.centerX + ", " + sfp.centerY + ")",',
            '    "<span class=\\"sep\\">|</span>",',
            '    "Structure: " + hCount + "/" + total + " (" + pct + "%)",',
            '  ].join(" ");',
            '}',
            '',
            '// ---- Hover info (in footer) ----',
            'function updateHoverInfo() {',
            '  var el = document.getElementById("hover-info");',
            '  if (!sfp || hoveredCol < 0 || hoveredRow < 0) {',
            '    el.textContent = "";',
            '    return;',
            '  }',
            '  var cellType = (sfp.grid[hoveredRow] && sfp.grid[hoveredRow][hoveredCol]) || "?";',
            '  var typeLabel = cellType === "H" ? "Structure" : cellType === "F" ? "Free" : "Unknown";',
            '  var worldX = hoveredCol * sfp.colChunkSize;',
            '  var worldZ = hoveredRow * sfp.rowChunkSize;',
            '  var isCenter = (hoveredCol === sfp.centerX && hoveredRow === sfp.centerY);',
            '  el.textContent = "Cell [" + hoveredCol + ", " + hoveredRow + "] = " + typeLabel +',
            '    " | " + worldX.toFixed(0) + "m, " + worldZ.toFixed(0) + "m" +',
            '    (isCenter ? " | CENTER" : "");',
            '}',
            '',
            '})();',
            '</script>',
            '</body>',
            '</html>',
        ];

        return lines.join('\n');
    }
}
