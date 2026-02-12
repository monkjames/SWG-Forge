import * as vscode from 'vscode';
import { parsePalette, serializePalette, colorToHex, PaletteData, PaletteColor } from '@swgemu/core';

export class PaletteEditorProvider implements vscode.CustomEditorProvider<PaletteDocument> {
    public static readonly viewType = 'paletteEditor.palFile';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PaletteDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new PaletteEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(
            PaletteEditorProvider.viewType,
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
    ): Promise<PaletteDocument> {
        const data = await vscode.workspace.fs.readFile(uri);
        return new PaletteDocument(uri, data);
    }

    async resolveCustomEditor(
        document: PaletteDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = this._getHtml();

        webviewPanel.webview.postMessage({
            type: 'load',
            colors: document.palette.colors.map((c, i) => ({
                index: i,
                hex: colorToHex(c),
                r: c.r, g: c.g, b: c.b, flags: c.flags
            })),
            fileName: document.uri.fsPath.split('/').pop() || 'palette.pal'
        });

        webviewPanel.webview.onDidReceiveMessage(e => {
            switch (e.type) {
                case 'ready':
                    webviewPanel.webview.postMessage({
                        type: 'load',
                        colors: document.palette.colors.map((c, i) => ({
                            index: i,
                            hex: colorToHex(c),
                            r: c.r, g: c.g, b: c.b, flags: c.flags
                        })),
                        fileName: document.uri.fsPath.split('/').pop() || 'palette.pal'
                    });
                    break;

                case 'editColor': {
                    const oldColors = document.palette.colors.map(c => ({ ...c }));
                    const { index, r, g, b } = e;
                    document.palette.colors[index] = { r, g, b, flags: document.palette.colors[index].flags };
                    const newColors = document.palette.colors.map(c => ({ ...c }));
                    this._onDidChangeCustomDocument.fire({
                        document,
                        undo: () => { document.palette.colors = oldColors; },
                        redo: () => { document.palette.colors = newColors; }
                    });
                    break;
                }

                case 'addColor': {
                    const oldColors = document.palette.colors.map(c => ({ ...c }));
                    const color: PaletteColor = e.r !== undefined
                        ? { r: e.r, g: e.g, b: e.b, flags: 0 }
                        : { r: 128, g: 128, b: 128, flags: 0 };
                    document.palette.colors.push(color);
                    const newColors = document.palette.colors.map(c => ({ ...c }));
                    this._onDidChangeCustomDocument.fire({
                        document,
                        undo: () => { document.palette.colors = oldColors; },
                        redo: () => { document.palette.colors = newColors; }
                    });
                    this._sendUpdate(webviewPanel, document);
                    break;
                }

                case 'removeColor': {
                    const oldColors = document.palette.colors.map(c => ({ ...c }));
                    if (e.index >= 0 && e.index < document.palette.colors.length) {
                        document.palette.colors.splice(e.index, 1);
                    }
                    const newColors = document.palette.colors.map(c => ({ ...c }));
                    this._onDidChangeCustomDocument.fire({
                        document,
                        undo: () => { document.palette.colors = oldColors; },
                        redo: () => { document.palette.colors = newColors; }
                    });
                    this._sendUpdate(webviewPanel, document);
                    break;
                }

                case 'reorderColors': {
                    const oldColors = document.palette.colors.map(c => ({ ...c }));
                    document.palette.colors = e.colors.map((c: any) => ({
                        r: c.r, g: c.g, b: c.b, flags: c.flags || 0
                    }));
                    const newColors = document.palette.colors.map(c => ({ ...c }));
                    this._onDidChangeCustomDocument.fire({
                        document,
                        undo: () => { document.palette.colors = oldColors; },
                        redo: () => { document.palette.colors = newColors; }
                    });
                    break;
                }
            }
        });
    }

    private _sendUpdate(panel: vscode.WebviewPanel, document: PaletteDocument): void {
        panel.webview.postMessage({
            type: 'load',
            colors: document.palette.colors.map((c, i) => ({
                index: i,
                hex: colorToHex(c),
                r: c.r, g: c.g, b: c.b, flags: c.flags
            })),
            fileName: document.uri.fsPath.split('/').pop() || 'palette.pal'
        });
    }

    async saveCustomDocument(document: PaletteDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        const data = serializePalette(document.palette);
        await vscode.workspace.fs.writeFile(document.uri, data);
    }

    async saveCustomDocumentAs(document: PaletteDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
        const data = serializePalette(document.palette);
        await vscode.workspace.fs.writeFile(destination, data);
    }

    async revertCustomDocument(document: PaletteDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        const data = await vscode.workspace.fs.readFile(document.uri);
        document.reload(data);
    }

    async backupCustomDocument(document: PaletteDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        const data = serializePalette(document.palette);
        await vscode.workspace.fs.writeFile(context.destination, data);
        return {
            id: context.destination.toString(),
            delete: () => vscode.workspace.fs.delete(context.destination)
        };
    }

    private _getHtml(): string {
        const lines = [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="UTF-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '<title>Palette Editor</title>',
            '<style>',
            this._getCss(),
            '</style>',
            '</head>',
            '<body>',
            '<div id="app">',
            '  <div class="toolbar">',
            '    <h2 id="file-name">Palette Editor</h2>',
            '    <div class="toolbar-info">',
            '      <span id="color-count">0 colors</span>',
            '    </div>',
            '    <div class="grid-size-selector">',
            '      <span class="size-label">Grid:</span>',
            '      <button class="size-btn" data-cols="4">4</button>',
            '      <button class="size-btn" data-cols="8">8</button>',
            '      <button class="size-btn active" data-cols="16">16</button>',
            '      <button class="size-btn" data-cols="32">32</button>',
            '    </div>',
            '    <div class="toolbar-actions">',
            '      <button id="btn-add" title="Add new color">+ Add Color</button>',
            '      <button id="btn-duplicate" title="Duplicate selected color" disabled>Duplicate</button>',
            '      <button id="btn-remove" title="Remove selected color" disabled>Remove</button>',
            '    </div>',
            '  </div>',
            '',
            '  <div class="editor-area">',
            '    <div class="grid-section">',
            '      <div id="color-grid" class="color-grid"></div>',
            '    </div>',
            '',
            '    <div class="detail-section" id="detail-section">',
            '      <h3>Color Details</h3>',
            '      <div class="detail-row">',
            '        <label>Index:</label>',
            '        <span id="detail-index">-</span>',
            '      </div>',
            '      <div class="detail-row">',
            '        <label>Preview:</label>',
            '        <div id="detail-preview" class="detail-preview"></div>',
            '      </div>',
            '      <div class="detail-row">',
            '        <label>Color:</label>',
            '        <input type="color" id="detail-picker" value="#808080">',
            '        <input type="text" id="detail-hex" class="hex-input" value="#808080" maxlength="7">',
            '      </div>',
            '      <div class="detail-row">',
            '        <label>R:</label>',
            '        <input type="number" id="detail-r" class="rgb-input" min="0" max="255" value="128">',
            '      </div>',
            '      <div class="detail-row">',
            '        <label>G:</label>',
            '        <input type="number" id="detail-g" class="rgb-input" min="0" max="255" value="128">',
            '      </div>',
            '      <div class="detail-row">',
            '        <label>B:</label>',
            '        <input type="number" id="detail-b" class="rgb-input" min="0" max="255" value="128">',
            '      </div>',
            '      <div class="detail-row">',
            '        <label>Flags:</label>',
            '        <span id="detail-flags">0x00</span>',
            '      </div>',
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
            '  --hover: var(--vscode-list-hoverBackground);',
            '  --badge-bg: var(--vscode-badge-background);',
            '  --badge-fg: var(--vscode-badge-foreground);',
            '  --desc: var(--vscode-descriptionForeground);',
            '}',
            'body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); }',
            '#app { display: flex; flex-direction: column; height: 100vh; }',
            '',
            '/* Toolbar */',
            '.toolbar { display: flex; align-items: center; gap: 16px; padding: 8px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }',
            '.toolbar h2 { margin: 0; font-size: 14px; font-weight: 600; white-space: nowrap; }',
            '.toolbar-info { font-size: 12px; color: var(--desc); }',
            '.toolbar-actions { display: flex; gap: 8px; margin-left: auto; }',
            'button { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 4px 12px; cursor: pointer; border-radius: 2px; font-size: 12px; }',
            'button:hover:not(:disabled) { background: var(--btn-hover); }',
            'button:disabled { opacity: 0.5; cursor: default; }',
            '',
            '/* Editor area */',
            '.editor-area { display: flex; flex: 1; overflow: hidden; }',
            '.grid-section { flex: 1; overflow-y: auto; padding: 16px; }',
            '.detail-section { width: 240px; border-left: 1px solid var(--border); padding: 12px 16px; overflow-y: auto; }',
            '.detail-section h3 { margin: 0 0 12px 0; font-size: 13px; font-weight: 600; }',
            '',
            '/* Grid size selector */',
            '.grid-size-selector { display: flex; align-items: center; gap: 4px; }',
            '.size-label { font-size: 12px; color: var(--desc); }',
            '.size-btn { min-width: 28px; padding: 2px 6px; font-size: 11px; background: var(--input-bg); color: var(--fg); border: 1px solid var(--input-border); }',
            '.size-btn.active { background: var(--btn-bg); color: var(--btn-fg); border-color: var(--btn-bg); }',
            '',
            '/* Color grid */',
            '.color-grid { display: grid; grid-template-columns: repeat(var(--grid-cols, 16), 1fr); gap: 2px; }',
            '.color-swatch { aspect-ratio: 1; border-radius: 2px; cursor: pointer; border: 2px solid transparent; position: relative; transition: transform 0.1s; min-width: 0; }',
            '.color-swatch:hover { transform: scale(1.15); z-index: 1; }',
            '.color-swatch.selected { border-color: #fff; box-shadow: 0 0 0 1px #000, 0 0 6px rgba(255,255,255,0.5); z-index: 2; }',
            '.color-swatch .swatch-index { display: none; position: absolute; bottom: -16px; left: 50%; transform: translateX(-50%); font-size: 9px; color: var(--desc); white-space: nowrap; }',
            '.color-swatch:hover .swatch-index, .color-swatch.selected .swatch-index { display: block; }',
            '',
            '/* Detail panel */',
            '.detail-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }',
            '.detail-row label { font-size: 12px; color: var(--desc); min-width: 48px; }',
            '.detail-preview { width: 48px; height: 48px; border-radius: 4px; border: 1px solid var(--border); }',
            'input[type="color"] { width: 40px; height: 28px; padding: 0; border: 1px solid var(--input-border); background: var(--input-bg); cursor: pointer; }',
            '.hex-input { width: 80px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); padding: 4px 6px; font-family: var(--vscode-editor-font-family); font-size: 12px; }',
            '.hex-input:focus { outline: 1px solid var(--btn-bg); }',
            '.rgb-input { width: 60px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); padding: 4px 6px; font-size: 12px; }',
            '.rgb-input:focus { outline: 1px solid var(--btn-bg); }',
        ];
        return lines.join('\n');
    }

    private _getScript(): string {
        const lines = [
            'const vscode = acquireVsCodeApi();',
            'let colors = [];',
            'let selectedIndex = -1;',
            'let gridCols = 16;',
            '',
            'const grid = document.getElementById("color-grid");',
            'const countEl = document.getElementById("color-count");',
            'const fileNameEl = document.getElementById("file-name");',
            'const detailSection = document.getElementById("detail-section");',
            'const detailIndex = document.getElementById("detail-index");',
            'const detailPreview = document.getElementById("detail-preview");',
            'const detailPicker = document.getElementById("detail-picker");',
            'const detailHex = document.getElementById("detail-hex");',
            'const detailR = document.getElementById("detail-r");',
            'const detailG = document.getElementById("detail-g");',
            'const detailB = document.getElementById("detail-b");',
            'const detailFlags = document.getElementById("detail-flags");',
            'const btnAdd = document.getElementById("btn-add");',
            'const btnDuplicate = document.getElementById("btn-duplicate");',
            'const btnRemove = document.getElementById("btn-remove");',
            '',
            'function renderGrid() {',
            '  grid.innerHTML = "";',
            '  colors.forEach(function(c, i) {',
            '    var swatch = document.createElement("div");',
            '    swatch.className = "color-swatch" + (i === selectedIndex ? " selected" : "");',
            '    swatch.style.backgroundColor = c.hex;',
            '    var idx = document.createElement("span");',
            '    idx.className = "swatch-index";',
            '    idx.textContent = "#" + i;',
            '    swatch.appendChild(idx);',
            '    swatch.addEventListener("click", function() { selectColor(i); });',
            '    grid.appendChild(swatch);',
            '  });',
            '  countEl.textContent = colors.length + " colors";',
            '}',
            '',
            'function selectColor(i) {',
            '  selectedIndex = i;',
            '  var c = colors[i];',
            '  if (!c) return;',
            '',
            '  // Update grid selection',
            '  grid.querySelectorAll(".color-swatch").forEach(function(el, j) {',
            '    if (j === i) el.classList.add("selected");',
            '    else el.classList.remove("selected");',
            '  });',
            '',
            '  // Update detail panel',
            '  detailIndex.textContent = "#" + i + " of " + colors.length;',
            '  detailPreview.style.backgroundColor = c.hex;',
            '  detailPicker.value = c.hex;',
            '  detailHex.value = c.hex;',
            '  detailR.value = c.r;',
            '  detailG.value = c.g;',
            '  detailB.value = c.b;',
            '  detailFlags.textContent = "0x" + (c.flags || 0).toString(16).padStart(2, "0");',
            '',
            '  btnDuplicate.disabled = false;',
            '  btnRemove.disabled = false;',
            '}',
            '',
            'function hexToRgb(hex) {',
            '  var clean = hex.replace("#", "");',
            '  return {',
            '    r: parseInt(clean.substring(0, 2), 16) || 0,',
            '    g: parseInt(clean.substring(2, 4), 16) || 0,',
            '    b: parseInt(clean.substring(4, 6), 16) || 0',
            '  };',
            '}',
            '',
            'function rgbToHex(r, g, b) {',
            '  return "#" + r.toString(16).padStart(2, "0") + g.toString(16).padStart(2, "0") + b.toString(16).padStart(2, "0");',
            '}',
            '',
            'function applyColorChange(r, g, b) {',
            '  if (selectedIndex < 0 || selectedIndex >= colors.length) return;',
            '  var hex = rgbToHex(r, g, b);',
            '  colors[selectedIndex].r = r;',
            '  colors[selectedIndex].g = g;',
            '  colors[selectedIndex].b = b;',
            '  colors[selectedIndex].hex = hex;',
            '',
            '  // Update UI without full re-render',
            '  var swatch = grid.children[selectedIndex];',
            '  if (swatch) swatch.style.backgroundColor = hex;',
            '  detailPreview.style.backgroundColor = hex;',
            '  detailPicker.value = hex;',
            '  detailHex.value = hex;',
            '  detailR.value = r;',
            '  detailG.value = g;',
            '  detailB.value = b;',
            '',
            '  vscode.postMessage({ type: "editColor", index: selectedIndex, r: r, g: g, b: b });',
            '}',
            '',
            '// Color picker change',
            'detailPicker.addEventListener("input", function(e) {',
            '  var rgb = hexToRgb(e.target.value);',
            '  applyColorChange(rgb.r, rgb.g, rgb.b);',
            '});',
            '',
            '// Hex input change',
            'detailHex.addEventListener("change", function(e) {',
            '  var val = e.target.value.trim();',
            '  if (!val.startsWith("#")) val = "#" + val;',
            '  if (/^#[0-9a-fA-F]{6}$/.test(val)) {',
            '    var rgb = hexToRgb(val);',
            '    applyColorChange(rgb.r, rgb.g, rgb.b);',
            '  }',
            '});',
            '',
            '// RGB input changes',
            'detailR.addEventListener("change", function() {',
            '  applyColorChange(parseInt(detailR.value) || 0, parseInt(detailG.value) || 0, parseInt(detailB.value) || 0);',
            '});',
            'detailG.addEventListener("change", function() {',
            '  applyColorChange(parseInt(detailR.value) || 0, parseInt(detailG.value) || 0, parseInt(detailB.value) || 0);',
            '});',
            'detailB.addEventListener("change", function() {',
            '  applyColorChange(parseInt(detailR.value) || 0, parseInt(detailG.value) || 0, parseInt(detailB.value) || 0);',
            '});',
            '',
            '// Add color',
            'btnAdd.addEventListener("click", function() {',
            '  vscode.postMessage({ type: "addColor" });',
            '});',
            '',
            '// Duplicate selected',
            'btnDuplicate.addEventListener("click", function() {',
            '  if (selectedIndex < 0 || selectedIndex >= colors.length) return;',
            '  var c = colors[selectedIndex];',
            '  vscode.postMessage({ type: "addColor", r: c.r, g: c.g, b: c.b });',
            '});',
            '',
            '// Remove selected',
            'btnRemove.addEventListener("click", function() {',
            '  if (selectedIndex < 0 || selectedIndex >= colors.length) return;',
            '  vscode.postMessage({ type: "removeColor", index: selectedIndex });',
            '});',
            '',
            '// Grid size selector',
            'document.querySelectorAll(".size-btn").forEach(function(btn) {',
            '  btn.addEventListener("click", function() {',
            '    document.querySelectorAll(".size-btn").forEach(function(b) { b.classList.remove("active"); });',
            '    btn.classList.add("active");',
            '    gridCols = parseInt(btn.dataset.cols) || 16;',
            '    grid.style.setProperty("--grid-cols", gridCols);',
            '  });',
            '});',
            '',
            '// Keyboard shortcuts',
            'document.addEventListener("keydown", function(e) {',
            '  if (e.target.tagName === "INPUT") return;',
            '  if (e.key === "Delete" && selectedIndex >= 0) {',
            '    btnRemove.click();',
            '  }',
            '  if (e.key === "ArrowRight" && selectedIndex < colors.length - 1) {',
            '    e.preventDefault();',
            '    selectColor(selectedIndex + 1);',
            '  }',
            '  if (e.key === "ArrowLeft" && selectedIndex > 0) {',
            '    e.preventDefault();',
            '    selectColor(selectedIndex - 1);',
            '  }',
            '  if (e.key === "ArrowDown") {',
            '    e.preventDefault();',
            '    var next = Math.min(selectedIndex + gridCols, colors.length - 1);',
            '    if (next !== selectedIndex) selectColor(next);',
            '  }',
            '  if (e.key === "ArrowUp") {',
            '    e.preventDefault();',
            '    var prev = Math.max(selectedIndex - gridCols, 0);',
            '    if (prev !== selectedIndex) selectColor(prev);',
            '  }',
            '});',
            '',
            '// Message handler',
            'window.addEventListener("message", function(event) {',
            '  var msg = event.data;',
            '  switch (msg.type) {',
            '    case "load":',
            '      colors = msg.colors || [];',
            '      if (msg.fileName) fileNameEl.textContent = msg.fileName;',
            '      if (selectedIndex >= colors.length) selectedIndex = colors.length - 1;',
            '      renderGrid();',
            '      if (selectedIndex >= 0) selectColor(selectedIndex);',
            '      break;',
            '  }',
            '});',
            '',
            '// Tell extension we are ready',
            'vscode.postMessage({ type: "ready" });',
        ];
        return lines.join('\n');
    }
}

class PaletteDocument implements vscode.CustomDocument {
    public palette: PaletteData;

    constructor(
        public readonly uri: vscode.Uri,
        initialData: Uint8Array
    ) {
        this.palette = parsePalette(initialData);
    }

    public reload(data: Uint8Array): void {
        this.palette = parsePalette(data);
    }

    public dispose(): void {
        // Nothing to dispose
    }
}
