import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parsePalette, colorToHex, PaletteData } from '@swgemu/core';

interface PaletteFileInfo {
    name: string;
    relativePath: string;
    fullPath: string;
    source: string;  // 'working' | 'infinity' | 'vanilla'
}

export class PaletteBrowsePanel {
    public static currentPanel: PaletteBrowsePanel | undefined;
    public static readonly viewType = 'paletteBrowser';

    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _palettes: PaletteFileInfo[] = [];

    public static createOrShow(extensionUri: vscode.Uri): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (PaletteBrowsePanel.currentPanel) {
            PaletteBrowsePanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            PaletteBrowsePanel.viewType,
            'Browse Palettes',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        PaletteBrowsePanel.currentPanel = new PaletteBrowsePanel(panel);
    }

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(
            msg => this._handleMessage(msg),
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose(): void {
        PaletteBrowsePanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private async _handleMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this._scanPalettes();
                break;

            case 'getPreview':
                this._sendPreview(msg.fullPath, msg.relativePath);
                break;

            case 'openInEditor':
                this._openInEditor(msg.fullPath);
                break;

            case 'copyToWorking':
                this._copyToWorking(msg.fullPath, msg.relativePath);
                break;
        }
    }

    private _scanPalettes(): void {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!ws) {
            this._panel.webview.postMessage({ type: 'palettes', palettes: [] });
            return;
        }

        this._palettes = [];

        const sources: { dir: string; label: string }[] = [
            { dir: path.join(ws, 'tre/working'), label: 'working' },
            { dir: path.join(ws, 'tre/infinity'), label: 'infinity' },
            { dir: path.join(ws, 'tre/vanilla'), label: 'vanilla' },
        ];

        for (const source of sources) {
            this._scanDir(source.dir, source.dir, source.label);
        }

        // Sort: working first, then infinity, then vanilla; alphabetical within each
        const order: Record<string, number> = { working: 0, infinity: 1, vanilla: 2 };
        this._palettes.sort((a, b) => {
            const o = (order[a.source] || 0) - (order[b.source] || 0);
            if (o !== 0) return o;
            return a.relativePath.localeCompare(b.relativePath);
        });

        this._panel.webview.postMessage({
            type: 'palettes',
            palettes: this._palettes.map(p => ({
                name: p.name,
                relativePath: p.relativePath,
                fullPath: p.fullPath,
                source: p.source,
            }))
        });
    }

    private _scanDir(baseDir: string, currentDir: string, source: string): void {
        if (!fs.existsSync(currentDir)) return;

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                this._scanDir(baseDir, fullPath, source);
            } else if (entry.name.endsWith('.pal')) {
                const relativePath = path.relative(baseDir, fullPath);
                this._palettes.push({
                    name: entry.name,
                    relativePath,
                    fullPath,
                    source,
                });
            }
        }
    }

    private _sendPreview(fullPath: string, relativePath: string): void {
        try {
            const data = fs.readFileSync(fullPath);
            const palette = parsePalette(new Uint8Array(data));
            const colors = palette.colors.map(c => ({
                hex: colorToHex(c),
                r: c.r, g: c.g, b: c.b
            }));
            this._panel.webview.postMessage({
                type: 'preview',
                relativePath,
                colors,
                count: colors.length
            });
        } catch (err: any) {
            this._panel.webview.postMessage({
                type: 'preview',
                relativePath,
                colors: [],
                count: 0,
                error: err.message
            });
        }
    }

    private _openInEditor(fullPath: string): void {
        const uri = vscode.Uri.file(fullPath);
        vscode.commands.executeCommand('vscode.openWith', uri, 'paletteEditor.palFile');
    }

    private _copyToWorking(fullPath: string, relativePath: string): void {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!ws) return;

        const destPath = path.join(ws, 'tre/working', relativePath);
        const destDir = path.dirname(destPath);

        try {
            fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(fullPath, destPath);
            vscode.window.showInformationMessage(`Copied to tre/working/${relativePath}`);

            // Re-scan to update list
            this._scanPalettes();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to copy: ${err.message}`);
        }
    }

    private _getHtml(): string {
        const lines = [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="UTF-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '<title>Browse Palettes</title>',
            '<style>',
            this._getCss(),
            '</style>',
            '</head>',
            '<body>',
            '<div id="app">',
            '  <div class="toolbar">',
            '    <h2>Browse Palettes</h2>',
            '    <input type="text" id="search" placeholder="Search palettes... (e.g. armor, creature, hair)">',
            '    <span id="stats" class="stats"></span>',
            '  </div>',
            '',
            '  <div class="main">',
            '    <div class="list-section">',
            '      <div id="palette-list" class="palette-list"></div>',
            '    </div>',
            '',
            '    <div class="preview-section" id="preview-section">',
            '      <div class="preview-header">',
            '        <h3 id="preview-name">Select a palette</h3>',
            '        <div class="preview-actions">',
            '          <button id="btn-open" disabled>Open in Editor</button>',
            '          <button id="btn-copy" disabled>Copy to tre/working/</button>',
            '        </div>',
            '      </div>',
            '      <div id="preview-info" class="preview-info"></div>',
            '      <div id="preview-grid" class="color-grid"></div>',
            '    </div>',
            '  </div>',
            '</div>',
            '',
            '<script>',
            this._getScript(),
            '</script>',
            '</body>',
            '</html>',
        ];
        return lines.join('\n');
    }

    private _getCss(): string {
        const lines = [
            ':root {',
            '  --bg: var(--vscode-editor-background);',
            '  --fg: var(--vscode-editor-foreground);',
            '  --border: var(--vscode-panel-border, #444);',
            '  --input-bg: var(--vscode-input-background);',
            '  --input-fg: var(--vscode-input-foreground);',
            '  --input-border: var(--vscode-input-border, #555);',
            '  --btn-bg: var(--vscode-button-background);',
            '  --btn-fg: var(--vscode-button-foreground);',
            '  --btn-hover: var(--vscode-button-hoverBackground);',
            '  --highlight: var(--vscode-list-activeSelectionBackground);',
            '  --highlight-fg: var(--vscode-list-activeSelectionForeground);',
            '  --hover: var(--vscode-list-hoverBackground);',
            '  --badge-bg: var(--vscode-badge-background);',
            '  --badge-fg: var(--vscode-badge-foreground);',
            '  --desc: var(--vscode-descriptionForeground);',
            '}',
            'body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); }',
            '#app { display: flex; flex-direction: column; height: 100vh; }',
            '',
            '.toolbar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); }',
            '.toolbar h2 { margin: 0; font-size: 14px; font-weight: 600; white-space: nowrap; }',
            '.toolbar input { flex: 1; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); padding: 6px 10px; font-size: 13px; outline: none; }',
            '.toolbar input:focus { border-color: var(--btn-bg); }',
            '.stats { font-size: 12px; color: var(--desc); white-space: nowrap; }',
            '',
            'button { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 4px 12px; cursor: pointer; border-radius: 2px; font-size: 12px; }',
            'button:hover:not(:disabled) { background: var(--btn-hover); }',
            'button:disabled { opacity: 0.5; cursor: default; }',
            '',
            '.main { display: flex; flex: 1; overflow: hidden; }',
            '.list-section { flex: 1; overflow-y: auto; }',
            '.preview-section { width: 360px; border-left: 1px solid var(--border); display: flex; flex-direction: column; overflow-y: auto; }',
            '',
            '.palette-list { padding: 4px 0; }',
            '.pal-group { padding: 4px 16px 2px 16px; font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--desc); margin-top: 8px; }',
            '.pal-group:first-child { margin-top: 0; }',
            '.pal-row { display: flex; align-items: center; gap: 8px; padding: 3px 16px 3px 24px; cursor: pointer; }',
            '.pal-row:hover { background: var(--hover); }',
            '.pal-row.selected { background: var(--highlight); color: var(--highlight-fg); }',
            '.pal-name { font-family: var(--vscode-editor-font-family); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
            '.pal-source { background: var(--badge-bg); color: var(--badge-fg); padding: 0 5px; border-radius: 8px; font-size: 10px; }',
            '',
            '.preview-header { padding: 12px 16px 8px; }',
            '.preview-header h3 { margin: 0 0 8px 0; font-size: 13px; word-break: break-all; }',
            '.preview-actions { display: flex; gap: 8px; }',
            '.preview-info { padding: 0 16px 8px; font-size: 12px; color: var(--desc); }',
            '',
            '.color-grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 2px; padding: 0 16px 16px; }',
            '.color-swatch { aspect-ratio: 1; border-radius: 2px; cursor: default; border: 1px solid rgba(255,255,255,0.15); position: relative; min-width: 0; }',
            '.color-swatch:hover { transform: scale(1.2); z-index: 1; border-color: #fff; }',
            '.color-swatch .tooltip { display: none; position: absolute; bottom: 110%; left: 50%; transform: translateX(-50%); background: #222; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 10px; white-space: nowrap; pointer-events: none; }',
            '.color-swatch:hover .tooltip { display: block; }',
        ];
        return lines.join('\n');
    }

    private _getScript(): string {
        const lines = [
            'var vscode = acquireVsCodeApi();',
            'var allPalettes = [];',
            'var selectedPalette = null;',
            '',
            'var search = document.getElementById("search");',
            'var stats = document.getElementById("stats");',
            'var list = document.getElementById("palette-list");',
            'var previewName = document.getElementById("preview-name");',
            'var previewInfo = document.getElementById("preview-info");',
            'var previewGrid = document.getElementById("preview-grid");',
            'var btnOpen = document.getElementById("btn-open");',
            'var btnCopy = document.getElementById("btn-copy");',
            '',
            'function escapeHtml(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }',
            '',
            'function renderList(palettes) {',
            '  list.innerHTML = "";',
            '  var groups = {};',
            '  palettes.forEach(function(p) {',
            '    if (!groups[p.source]) groups[p.source] = [];',
            '    groups[p.source].push(p);',
            '  });',
            '',
            '  var order = ["working", "infinity", "vanilla"];',
            '  var labels = { working: "Working (editable)", infinity: "Infinity", vanilla: "Vanilla" };',
            '  order.forEach(function(src) {',
            '    var items = groups[src];',
            '    if (!items || items.length === 0) return;',
            '    var header = document.createElement("div");',
            '    header.className = "pal-group";',
            '    header.textContent = labels[src] + " (" + items.length + ")";',
            '    list.appendChild(header);',
            '',
            '    items.forEach(function(p) {',
            '      var row = document.createElement("div");',
            '      row.className = "pal-row";',
            '      if (selectedPalette && selectedPalette.fullPath === p.fullPath) row.classList.add("selected");',
            '      row.innerHTML = \'<span class="pal-name">\' + escapeHtml(p.relativePath) + "</span>";',
            '      row.addEventListener("click", function() {',
            '        selectedPalette = p;',
            '        list.querySelectorAll(".pal-row").forEach(function(r) { r.classList.remove("selected"); });',
            '        row.classList.add("selected");',
            '        previewName.textContent = p.relativePath;',
            '        previewInfo.textContent = "Source: " + p.source + " | Loading...";',
            '        previewGrid.innerHTML = "";',
            '        btnOpen.disabled = false;',
            '        btnCopy.disabled = p.source === "working";',
            '        vscode.postMessage({ type: "getPreview", fullPath: p.fullPath, relativePath: p.relativePath });',
            '      });',
            '      list.appendChild(row);',
            '    });',
            '  });',
            '',
            '  stats.textContent = palettes.length + " palettes";',
            '}',
            '',
            'function renderPreview(colors, count, error) {',
            '  previewGrid.innerHTML = "";',
            '  if (error) {',
            '    previewInfo.textContent = "Error: " + error;',
            '    return;',
            '  }',
            '  previewInfo.textContent = "Source: " + (selectedPalette ? selectedPalette.source : "?") + " | " + count + " colors";',
            '  colors.forEach(function(c, i) {',
            '    var swatch = document.createElement("div");',
            '    swatch.className = "color-swatch";',
            '    swatch.style.backgroundColor = c.hex;',
            '    swatch.innerHTML = \'<span class="tooltip">#\' + i + " " + c.hex + " (" + c.r + "," + c.g + "," + c.b + ")</span>";',
            '    previewGrid.appendChild(swatch);',
            '  });',
            '}',
            '',
            '// Search with debounce',
            'var searchTimeout;',
            'search.addEventListener("input", function() {',
            '  clearTimeout(searchTimeout);',
            '  searchTimeout = setTimeout(function() {',
            '    var q = search.value.toLowerCase();',
            '    if (!q) {',
            '      renderList(allPalettes);',
            '    } else {',
            '      var filtered = allPalettes.filter(function(p) {',
            '        return p.relativePath.toLowerCase().indexOf(q) >= 0;',
            '      });',
            '      renderList(filtered);',
            '    }',
            '  }, 200);',
            '});',
            '',
            'btnOpen.addEventListener("click", function() {',
            '  if (!selectedPalette) return;',
            '  vscode.postMessage({ type: "openInEditor", fullPath: selectedPalette.fullPath });',
            '});',
            '',
            'btnCopy.addEventListener("click", function() {',
            '  if (!selectedPalette) return;',
            '  vscode.postMessage({ type: "copyToWorking", fullPath: selectedPalette.fullPath, relativePath: selectedPalette.relativePath });',
            '});',
            '',
            '// Message handler',
            'window.addEventListener("message", function(event) {',
            '  var msg = event.data;',
            '  switch (msg.type) {',
            '    case "palettes":',
            '      allPalettes = msg.palettes;',
            '      renderList(allPalettes);',
            '      break;',
            '    case "preview":',
            '      renderPreview(msg.colors, msg.count, msg.error);',
            '      break;',
            '  }',
            '});',
            '',
            'vscode.postMessage({ type: "ready" });',
        ];
        return lines.join('\n');
    }
}
