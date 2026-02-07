import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    parseACM, serializeACM, acmCRC, findAssetByPath, getACMSummary,
    addCidxEntry, addMinimalUidxEntry, addAssetLikeExisting, resolveCustomization,
    ACMData, ACMPalette, ACMVariable, ACMCidxEntry, ACMSummary
} from '@swgemu/core';
import { parsePalette, colorToHex, PaletteData } from '@swgemu/core';

export class ACMPanel {
    public static currentPanel: ACMPanel | undefined;
    public static readonly viewType = 'acmEditor';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _acm: ACMData | null = null;
    private _acmPath: string = '';
    private _modified: boolean = false;
    private _paletteCache: Map<string, PaletteData> = new Map();

    public static createOrShow(extensionUri: vscode.Uri, acmFilePath?: string): ACMPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ACMPanel.currentPanel) {
            ACMPanel.currentPanel._panel.reveal(column);
            if (acmFilePath) {
                ACMPanel.currentPanel._loadACM(acmFilePath);
            }
            return ACMPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            ACMPanel.viewType,
            'ACM Editor',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        ACMPanel.currentPanel = new ACMPanel(panel, extensionUri);
        if (acmFilePath) {
            ACMPanel.currentPanel._loadACM(acmFilePath);
        }
        return ACMPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._updateWebview();

        this._panel.webview.onDidReceiveMessage(
            msg => this._handleMessage(msg),
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public showAddAssets(): void {
        this._panel.webview.postMessage({ type: 'showAddAssets' });
    }

    public dispose(): void {
        ACMPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    // ─── Message handling ───────────────────────────────────────────────────

    private async _handleMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case 'ready':
                // Webview initialized - try to auto-load ACM
                await this._autoLoadACM();
                break;

            case 'loadFile':
                await this._browseForACM();
                break;

            case 'searchAssets':
                this._searchAssets(msg.query);
                break;

            case 'searchPalettes':
                this._searchPalettes(msg.query);
                break;

            case 'searchVariables':
                this._searchVariables(msg.query);
                break;

            case 'getPaletteColors':
                await this._sendPaletteColors(msg.palettePath);
                break;

            case 'getAssetCustomization':
                this._sendAssetCustomization(msg.assetIndex);
                break;

            case 'addAssetPaths':
                this._addAssetPaths(msg.paths, msg.copyFromIndex);
                break;

            case 'save':
                await this._saveACM();
                break;

            case 'saveAs':
                await this._saveACMAs();
                break;
        }
    }

    // ─── ACM loading ────────────────────────────────────────────────────────

    private async _autoLoadACM(): Promise<void> {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!ws) return;

        // Try common locations
        const candidates = [
            path.join(ws, 'tre/infinity/customization/asset_customization_manager.iff'),
            path.join(ws, 'tre/working/customization/asset_customization_manager.iff'),
            path.join(ws, 'tre/vanilla/customization/asset_customization_manager.iff'),
            path.join(ws, 'scripts/imported_files/customization/asset_customization_manager.iff'),
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                await this._loadACM(candidate);
                return;
            }
        }

        // No auto-load; user can browse
        this._panel.webview.postMessage({ type: 'noACMFound' });
    }

    private async _browseForACM(): Promise<void> {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            filters: { 'IFF Files': ['iff'], 'All Files': ['*'] },
            title: 'Select asset_customization_manager.iff'
        });

        if (result && result[0]) {
            await this._loadACM(result[0].fsPath);
        }
    }

    private async _loadACM(filePath: string): Promise<void> {
        try {
            const data = fs.readFileSync(filePath);
            this._acm = parseACM(new Uint8Array(data));
            this._acmPath = filePath;
            this._modified = false;
            this._paletteCache.clear();

            const summary = getACMSummary(this._acm);
            this._panel.webview.postMessage({
                type: 'acmLoaded',
                path: filePath,
                summary,
                palettes: this._acm.palettes.map(p => ({ index: p.index, path: p.path })),
                variables: this._acm.variables.map(v => ({ index: v.index, path: v.path })),
            });

            this._panel.title = 'ACM: ' + path.basename(filePath);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to load ACM: ${err.message}`);
        }
    }

    // ─── Search ─────────────────────────────────────────────────────────────

    private _searchAssets(query: string): void {
        if (!this._acm) return;
        const q = query.toLowerCase();
        // We don't have path strings for CIDX (only CRCs), so search by CRC hex
        // or by asset index
        const results = this._acm.cidxEntries
            .filter((e, i) => {
                if (!query) return i < 100;
                const crcHex = e.crc.toString(16).padStart(8, '0');
                const idxStr = e.assetIndex.toString();
                return crcHex.includes(q) || idxStr.includes(q);
            })
            .slice(0, 200)
            .map(e => ({
                crc: e.crc,
                crcHex: '0x' + e.crc.toString(16).padStart(8, '0').toUpperCase(),
                assetIndex: e.assetIndex
            }));

        this._panel.webview.postMessage({ type: 'assetResults', results });
    }

    private _searchPalettes(query: string): void {
        if (!this._acm) return;
        const q = query.toLowerCase();
        const results = this._acm.palettes
            .filter(p => !query || p.path.toLowerCase().includes(q))
            .slice(0, 100);

        this._panel.webview.postMessage({
            type: 'paletteResults',
            results: results.map(p => ({ index: p.index, path: p.path }))
        });
    }

    private _searchVariables(query: string): void {
        if (!this._acm) return;
        const q = query.toLowerCase();
        const results = this._acm.variables
            .filter(v => !query || v.path.toLowerCase().includes(q))
            .slice(0, 100);

        this._panel.webview.postMessage({
            type: 'variableResults',
            results: results.map(v => ({ index: v.index, path: v.path }))
        });
    }

    // ─── Palette colors ─────────────────────────────────────────────────────

    private async _sendPaletteColors(palettePath: string): Promise<void> {
        // Try to load the actual .pal file
        let colors: { hex: string; r: number; g: number; b: number }[] = [];

        if (this._paletteCache.has(palettePath)) {
            const pal = this._paletteCache.get(palettePath)!;
            colors = pal.colors.map(c => ({
                hex: colorToHex(c), r: c.r, g: c.g, b: c.b
            }));
        } else {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (ws) {
                // Search in TRE directories
                const searchPaths = [
                    path.join(ws, 'tre/infinity', palettePath),
                    path.join(ws, 'tre/working', palettePath),
                    path.join(ws, 'tre/vanilla', palettePath),
                ];

                for (const searchPath of searchPaths) {
                    if (fs.existsSync(searchPath)) {
                        try {
                            const data = fs.readFileSync(searchPath);
                            const pal = parsePalette(new Uint8Array(data));
                            this._paletteCache.set(palettePath, pal);
                            colors = pal.colors.map(c => ({
                                hex: colorToHex(c), r: c.r, g: c.g, b: c.b
                            }));
                        } catch (e) {
                            // Continue to next path
                        }
                        break;
                    }
                }
            }
        }

        this._panel.webview.postMessage({
            type: 'paletteColors',
            palettePath,
            colors,
            count: colors.length
        });
    }

    // ─── Asset customization detail ─────────────────────────────────────────

    private _sendAssetCustomization(assetIndex: number): void {
        if (!this._acm) return;

        const vars = resolveCustomization(this._acm, assetIndex);
        this._panel.webview.postMessage({
            type: 'assetCustomization',
            assetIndex,
            variables: vars
        });
    }

    // ─── Modification ───────────────────────────────────────────────────────

    private _addAssetPaths(paths: string[], copyFromIndex?: number): void {
        if (!this._acm) {
            vscode.window.showErrorMessage('No ACM loaded');
            return;
        }

        let added = 0;
        for (const assetPath of paths) {
            const trimmed = assetPath.trim();
            if (!trimmed) continue;

            // Check if already exists
            if (findAssetByPath(this._acm, trimmed)) continue;

            if (copyFromIndex !== undefined && copyFromIndex > 0) {
                // Copy customization from existing asset
                try {
                    addAssetLikeExisting(this._acm, trimmed, copyFromIndex);
                    added++;
                } catch (e: any) {
                    vscode.window.showWarningMessage(`Failed to add ${trimmed}: ${e.message}`);
                }
            } else {
                // Add minimal (no customization)
                const maxIdx = this._acm.uidxEntries.reduce((m, e) => Math.max(m, e.index), 0);
                const newIdx = maxIdx + 1;
                addMinimalUidxEntry(this._acm, newIdx);
                addCidxEntry(this._acm, trimmed, newIdx);
                added++;
            }
        }

        this._modified = true;
        const summary = getACMSummary(this._acm);

        this._panel.webview.postMessage({
            type: 'assetsAdded',
            count: added,
            summary
        });

        vscode.window.showInformationMessage(`Added ${added} asset(s) to ACM`);
    }

    // ─── Save ───────────────────────────────────────────────────────────────

    private async _saveACM(): Promise<void> {
        if (!this._acm || !this._acmPath) {
            await this._saveACMAs();
            return;
        }

        try {
            const data = serializeACM(this._acm);
            fs.writeFileSync(this._acmPath, data);
            this._modified = false;
            vscode.window.showInformationMessage(`ACM saved to ${this._acmPath}`);
            this._panel.webview.postMessage({ type: 'saved' });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to save: ${err.message}`);
        }
    }

    private async _saveACMAs(): Promise<void> {
        if (!this._acm) return;

        const result = await vscode.window.showSaveDialog({
            defaultUri: this._acmPath ? vscode.Uri.file(this._acmPath) : undefined,
            filters: { 'IFF Files': ['iff'] },
            title: 'Save ACM File'
        });

        if (result) {
            this._acmPath = result.fsPath;
            await this._saveACM();
        }
    }

    // ─── Webview HTML ───────────────────────────────────────────────────────

    private _updateWebview(): void {
        this._panel.webview.html = this._getHtml();
    }

    private _getHtml(): string {
        const lines = [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="UTF-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '<title>ACM Editor</title>',
            '<style>',
            this._getCss(),
            '</style>',
            '</head>',
            '<body>',
            '<div id="app">',
            '  <div id="toolbar">',
            '    <h2>Asset Customization Manager</h2>',
            '    <div class="toolbar-actions">',
            '      <button id="btn-load" title="Open ACM file">Open</button>',
            '      <button id="btn-save" title="Save" disabled>Save</button>',
            '      <button id="btn-save-as" title="Save As" disabled>Save As</button>',
            '    </div>',
            '  </div>',
            '',
            '  <div id="summary" class="hidden">',
            '    <div class="summary-path" id="acm-path"></div>',
            '    <div class="summary-stats" id="acm-stats"></div>',
            '  </div>',
            '',
            '  <div id="tabs">',
            '    <button class="tab active" data-tab="palettes">Palettes</button>',
            '    <button class="tab" data-tab="variables">Variables</button>',
            '    <button class="tab" data-tab="assets">Assets (CIDX)</button>',
            '    <button class="tab" data-tab="add">Add Assets</button>',
            '  </div>',
            '',
            '  <!-- Palettes Tab -->',
            '  <div id="tab-palettes" class="tab-content active">',
            '    <div class="search-bar">',
            '      <input type="text" id="palette-search" placeholder="Search palettes... (e.g. armor, lightsaber, creature)">',
            '    </div>',
            '    <div id="palette-list" class="item-list"></div>',
            '    <div id="palette-detail" class="detail-pane hidden">',
            '      <h3 id="palette-detail-name"></h3>',
            '      <div id="palette-color-grid" class="color-grid"></div>',
            '    </div>',
            '  </div>',
            '',
            '  <!-- Variables Tab -->',
            '  <div id="tab-variables" class="tab-content hidden">',
            '    <div class="search-bar">',
            '      <input type="text" id="variable-search" placeholder="Search variables... (e.g. color, blend, shader)">',
            '    </div>',
            '    <div id="variable-list" class="item-list"></div>',
            '  </div>',
            '',
            '  <!-- Assets Tab -->',
            '  <div id="tab-assets" class="tab-content hidden">',
            '    <div class="search-bar">',
            '      <input type="text" id="asset-search" placeholder="Search by CRC hex or asset index...">',
            '    </div>',
            '    <div id="asset-list" class="item-list"></div>',
            '    <div id="asset-detail" class="detail-pane hidden">',
            '      <h3>Asset <span id="asset-detail-index"></span></h3>',
            '      <div id="asset-customization"></div>',
            '    </div>',
            '  </div>',
            '',
            '  <!-- Add Assets Tab -->',
            '  <div id="tab-add" class="tab-content hidden">',
            '    <div class="add-section">',
            '      <h3>Register New Assets in ACM</h3>',
            '      <p class="hint">Enter appearance paths (one per line). These are the paths like<br>',
            '        <code>appearance/armor_my_chest_m.sat</code> or <code>shader/my_shader.sht</code></p>',
            '      <textarea id="add-paths" rows="10" placeholder="appearance/armor_custom_chest_m.sat&#10;appearance/armor_custom_chest_f.sat&#10;appearance/armor_custom_bicep_l_m.sat"></textarea>',
            '',
            '      <div class="add-options">',
            '        <label>',
            '          <input type="radio" name="add-mode" value="minimal" checked>',
            '          Minimal (no customization) - just register in ACM',
            '        </label>',
            '        <label>',
            '          <input type="radio" name="add-mode" value="copy">',
            '          Copy customization from existing asset index:',
            '          <input type="number" id="copy-from-index" min="1" value="1" style="width:80px">',
            '        </label>',
            '      </div>',
            '',
            '      <div class="add-actions">',
            '        <button id="btn-add-assets">Add to ACM</button>',
            '        <button id="btn-lookup-crc">Lookup CRC</button>',
            '      </div>',
            '',
            '      <div id="crc-results" class="hidden">',
            '        <h4>CRC Results</h4>',
            '        <table id="crc-table"><thead><tr><th>Path</th><th>CRC</th><th>In ACM?</th></tr></thead><tbody></tbody></table>',
            '      </div>',
            '    </div>',
            '  </div>',
            '',
            '  <div id="loading" class="hidden">',
            '    <div class="spinner"></div>',
            '    <span>Loading ACM...</span>',
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
            '}',
            'body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); }',
            '#app { display: flex; flex-direction: column; height: 100vh; }',
            '',
            '/* Toolbar */',
            '#toolbar { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; border-bottom: 1px solid var(--border); }',
            '#toolbar h2 { margin: 0; font-size: 14px; font-weight: 600; }',
            '.toolbar-actions { display: flex; gap: 8px; }',
            'button { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 4px 12px; cursor: pointer; border-radius: 2px; font-size: 12px; }',
            'button:hover:not(:disabled) { background: var(--btn-hover); }',
            'button:disabled { opacity: 0.5; cursor: default; }',
            '',
            '/* Summary */',
            '#summary { padding: 8px 16px; border-bottom: 1px solid var(--border); }',
            '.summary-path { font-size: 11px; opacity: 0.7; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
            '.summary-stats { display: flex; gap: 16px; flex-wrap: wrap; }',
            '.stat { display: flex; align-items: center; gap: 4px; }',
            '.stat-value { background: var(--badge-bg); color: var(--badge-fg); padding: 1px 6px; border-radius: 8px; font-size: 11px; font-weight: 600; }',
            '.stat-label { font-size: 11px; opacity: 0.8; }',
            '',
            '/* Tabs */',
            '#tabs { display: flex; border-bottom: 1px solid var(--border); }',
            '.tab { background: transparent; color: var(--fg); border: none; padding: 8px 16px; cursor: pointer; opacity: 0.7; border-bottom: 2px solid transparent; border-radius: 0; }',
            '.tab:hover { opacity: 1; }',
            '.tab.active { opacity: 1; border-bottom-color: var(--btn-bg); }',
            '',
            '/* Tab content */',
            '.tab-content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }',
            '.tab-content.hidden, .hidden { display: none !important; }',
            '',
            '/* Search bar */',
            '.search-bar { padding: 8px 16px; }',
            '.search-bar input { width: 100%; box-sizing: border-box; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); padding: 6px 10px; font-size: 13px; outline: none; }',
            '.search-bar input:focus { border-color: var(--btn-bg); }',
            '',
            '/* Item list */',
            '.item-list { flex: 1; overflow-y: auto; padding: 0 16px; }',
            '.item-row { display: flex; align-items: center; gap: 8px; padding: 4px 8px; cursor: pointer; border-radius: 3px; }',
            '.item-row:hover { background: var(--hover); }',
            '.item-row.selected { background: var(--highlight); color: var(--highlight-fg); }',
            '.item-index { font-size: 11px; opacity: 0.5; min-width: 36px; text-align: right; }',
            '.item-path { font-family: var(--vscode-editor-font-family); font-size: 12px; }',
            '.item-badge { background: var(--badge-bg); color: var(--badge-fg); padding: 0 5px; border-radius: 8px; font-size: 10px; }',
            '',
            '/* Color grid for palettes */',
            '.detail-pane { padding: 12px 16px; border-top: 1px solid var(--border); max-height: 300px; overflow-y: auto; }',
            '.detail-pane h3 { margin: 0 0 8px 0; font-size: 13px; }',
            '.color-grid { display: flex; flex-wrap: wrap; gap: 3px; }',
            '.color-swatch { width: 28px; height: 28px; border-radius: 3px; cursor: pointer; border: 1px solid rgba(255,255,255,0.15); position: relative; }',
            '.color-swatch:hover { transform: scale(1.3); z-index: 1; border-color: #fff; }',
            '.color-swatch .tooltip { display: none; position: absolute; bottom: 110%; left: 50%; transform: translateX(-50%); background: #222; color: #fff; padding: 2px 6px; border-radius: 3px; font-size: 10px; white-space: nowrap; pointer-events: none; }',
            '.color-swatch:hover .tooltip { display: block; }',
            '',
            '/* Asset detail */',
            '#asset-customization .cust-var { margin: 6px 0; padding: 6px 8px; background: var(--input-bg); border-radius: 3px; }',
            '#asset-customization .cust-var-name { font-family: var(--vscode-editor-font-family); font-size: 12px; }',
            '#asset-customization .cust-var-type { font-size: 11px; opacity: 0.7; margin-top: 2px; }',
            '#asset-customization .cust-palette-preview { display: flex; gap: 2px; margin-top: 4px; }',
            '',
            '/* Add Assets tab */',
            '.add-section { padding: 16px; overflow-y: auto; flex: 1; }',
            '.add-section h3 { margin: 0 0 8px 0; }',
            '.hint { font-size: 12px; opacity: 0.7; margin-bottom: 12px; }',
            '.hint code { background: var(--input-bg); padding: 1px 4px; border-radius: 2px; }',
            'textarea { width: 100%; box-sizing: border-box; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); padding: 8px; font-family: var(--vscode-editor-font-family); font-size: 12px; resize: vertical; }',
            '.add-options { margin: 12px 0; display: flex; flex-direction: column; gap: 8px; }',
            '.add-options label { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }',
            '.add-actions { display: flex; gap: 8px; margin-top: 12px; }',
            '#crc-results { margin-top: 16px; }',
            '#crc-results h4 { margin: 0 0 8px 0; }',
            '#crc-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
            '#crc-table th, #crc-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); }',
            '#crc-table th { font-weight: 600; opacity: 0.8; }',
            '.crc-found { color: #4ec9b0; }',
            '.crc-missing { color: #ce9178; }',
            '',
            '/* Loading */',
            '#loading { position: fixed; top: 0; left: 0; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; gap: 8px; background: rgba(0,0,0,0.5); }',
            '.spinner { width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--btn-bg); border-radius: 50%; animation: spin 0.8s linear infinite; }',
            '@keyframes spin { to { transform: rotate(360deg); } }',
        ];
        return lines.join('\n');
    }

    private _getScript(): string {
        const lines = [
            'const vscode = acquireVsCodeApi();',
            'let acmData = null;',
            'let allPalettes = [];',
            'let allVariables = [];',
            '',
            '// Tab switching',
            'document.querySelectorAll(".tab").forEach(tab => {',
            '  tab.addEventListener("click", () => {',
            '    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));',
            '    document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));',
            '    tab.classList.add("active");',
            '    document.getElementById("tab-" + tab.dataset.tab).classList.remove("hidden");',
            '  });',
            '});',
            '',
            '// Toolbar buttons',
            'document.getElementById("btn-load").addEventListener("click", () => vscode.postMessage({ type: "loadFile" }));',
            'document.getElementById("btn-save").addEventListener("click", () => vscode.postMessage({ type: "save" }));',
            'document.getElementById("btn-save-as").addEventListener("click", () => vscode.postMessage({ type: "saveAs" }));',
            '',
            '// Search inputs with debounce',
            'function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }',
            '',
            'document.getElementById("palette-search").addEventListener("input", debounce(e => {',
            '  vscode.postMessage({ type: "searchPalettes", query: e.target.value });',
            '}, 200));',
            '',
            'document.getElementById("variable-search").addEventListener("input", debounce(e => {',
            '  vscode.postMessage({ type: "searchVariables", query: e.target.value });',
            '}, 200));',
            '',
            'document.getElementById("asset-search").addEventListener("input", debounce(e => {',
            '  vscode.postMessage({ type: "searchAssets", query: e.target.value });',
            '}, 200));',
            '',
            '// Add assets',
            'document.getElementById("btn-add-assets").addEventListener("click", () => {',
            '  const paths = document.getElementById("add-paths").value.split("\\n").filter(l => l.trim());',
            '  const mode = document.querySelector("input[name=add-mode]:checked").value;',
            '  const copyIdx = mode === "copy" ? parseInt(document.getElementById("copy-from-index").value) : undefined;',
            '  vscode.postMessage({ type: "addAssetPaths", paths, copyFromIndex: copyIdx });',
            '});',
            '',
            'document.getElementById("btn-lookup-crc").addEventListener("click", () => {',
            '  const paths = document.getElementById("add-paths").value.split("\\n").filter(l => l.trim());',
            '  if (!paths.length) return;',
            '  // Calculate CRCs client-side using the same algorithm',
            '  const tbody = document.querySelector("#crc-table tbody");',
            '  tbody.innerHTML = "";',
            '  paths.forEach(p => {',
            '    const crc = swgCRC(p.trim());',
            '    const hex = "0x" + crc.toString(16).toUpperCase().padStart(8, "0");',
            '    // We cannot check ACM membership client-side, so just show CRC',
            '    const row = document.createElement("tr");',
            '    row.innerHTML = "<td>" + escapeHtml(p.trim()) + "</td><td><code>" + hex + "</code></td><td>-</td>";',
            '    tbody.appendChild(row);',
            '  });',
            '  document.getElementById("crc-results").classList.remove("hidden");',
            '});',
            '',
            '// CRC implementation (matches ACM - no lowercasing)',
            'const CRC_TABLE = new Uint32Array(256);',
            '(function() {',
            '  for (let i = 0; i < 256; i++) {',
            '    let c = (i << 24) >>> 0;',
            '    for (let j = 0; j < 8; j++) {',
            '      if (c & 0x80000000) { c = ((c << 1) ^ 0x04C11DB7) >>> 0; }',
            '      else { c = (c << 1) >>> 0; }',
            '    }',
            '    CRC_TABLE[i] = c;',
            '  }',
            '})();',
            '',
            'function swgCRC(s) {',
            '  let crc = 0xFFFFFFFF;',
            '  for (let i = 0; i < s.length; i++) {',
            '    const idx = ((crc >>> 24) ^ s.charCodeAt(i)) & 0xFF;',
            '    crc = ((crc << 8) ^ CRC_TABLE[idx]) >>> 0;',
            '  }',
            '  return (crc ^ 0xFFFFFFFF) >>> 0;',
            '}',
            '',
            'function escapeHtml(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }',
            '',
            '// Render functions',
            'function renderPalettes(palettes) {',
            '  const list = document.getElementById("palette-list");',
            '  list.innerHTML = "";',
            '  palettes.forEach(p => {',
            '    const row = document.createElement("div");',
            '    row.className = "item-row";',
            '    row.innerHTML = \'<span class="item-index">\' + p.index + \'</span><span class="item-path">\' + escapeHtml(p.path) + "</span>";',
            '    row.addEventListener("click", () => {',
            '      list.querySelectorAll(".item-row").forEach(r => r.classList.remove("selected"));',
            '      row.classList.add("selected");',
            '      document.getElementById("palette-detail-name").textContent = p.path;',
            '      document.getElementById("palette-detail").classList.remove("hidden");',
            '      document.getElementById("palette-color-grid").innerHTML = "<em>Loading colors...</em>";',
            '      vscode.postMessage({ type: "getPaletteColors", palettePath: p.path });',
            '    });',
            '    list.appendChild(row);',
            '  });',
            '}',
            '',
            'function renderVariables(variables) {',
            '  const list = document.getElementById("variable-list");',
            '  list.innerHTML = "";',
            '  variables.forEach(v => {',
            '    const row = document.createElement("div");',
            '    row.className = "item-row";',
            '    const prefix = v.path.startsWith("/shared_owner/") ? "shared" : v.path.startsWith("/private/") ? "private" : "other";',
            '    const isColor = v.path.includes("color");',
            '    const isBlend = v.path.includes("blend");',
            '    const typeLabel = isColor ? "color" : isBlend ? "blend" : "int";',
            '    row.innerHTML = \'<span class="item-index">\' + v.index + \'</span><span class="item-path">\' + escapeHtml(v.path) + \'</span><span class="item-badge">\' + prefix + \'</span><span class="item-badge">\' + typeLabel + "</span>";',
            '    list.appendChild(row);',
            '  });',
            '}',
            '',
            'function renderAssets(assets) {',
            '  const list = document.getElementById("asset-list");',
            '  list.innerHTML = "";',
            '  assets.forEach(a => {',
            '    const row = document.createElement("div");',
            '    row.className = "item-row";',
            '    row.innerHTML = \'<span class="item-index">\' + a.assetIndex + \'</span><span class="item-path"><code>\' + a.crcHex + "</code></span>";',
            '    row.addEventListener("click", () => {',
            '      list.querySelectorAll(".item-row").forEach(r => r.classList.remove("selected"));',
            '      row.classList.add("selected");',
            '      document.getElementById("asset-detail-index").textContent = "#" + a.assetIndex;',
            '      document.getElementById("asset-detail").classList.remove("hidden");',
            '      document.getElementById("asset-customization").innerHTML = "<em>Loading...</em>";',
            '      vscode.postMessage({ type: "getAssetCustomization", assetIndex: a.assetIndex });',
            '    });',
            '    list.appendChild(row);',
            '  });',
            '}',
            '',
            'function renderColorGrid(colors) {',
            '  const grid = document.getElementById("palette-color-grid");',
            '  grid.innerHTML = "";',
            '  if (!colors.length) { grid.innerHTML = "<em>Palette file not found in TRE directories</em>"; return; }',
            '  colors.forEach((c, i) => {',
            '    const swatch = document.createElement("div");',
            '    swatch.className = "color-swatch";',
            '    swatch.style.backgroundColor = c.hex;',
            '    swatch.innerHTML = \'<span class="tooltip">#\' + i + " " + c.hex + " (" + c.r + "," + c.g + "," + c.b + ")</span>";',
            '    grid.appendChild(swatch);',
            '  });',
            '}',
            '',
            'function renderAssetCustomization(vars) {',
            '  const el = document.getElementById("asset-customization");',
            '  if (!vars.length) { el.innerHTML = "<em>No customization variables (minimal entry)</em>"; return; }',
            '  el.innerHTML = "";',
            '  vars.forEach(v => {',
            '    const div = document.createElement("div");',
            '    div.className = "cust-var";',
            '    let typeInfo = "";',
            '    if (v.isPalette) {',
            '      typeInfo = "Palette: " + (v.palettePath || "unknown") + " (default: " + v.defaultValue + ")";',
            '    } else {',
            '      typeInfo = "Range: " + (v.minRange !== undefined ? v.minRange + " - " + v.maxRange : "unknown") + " (default: " + v.defaultValue + ")";',
            '    }',
            '    div.innerHTML = \'<div class="cust-var-name">\' + escapeHtml(v.variableName) + \'</div><div class="cust-var-type">\' + typeInfo + "</div>";',
            '    el.appendChild(div);',
            '  });',
            '}',
            '',
            '// Message handler',
            'window.addEventListener("message", event => {',
            '  const msg = event.data;',
            '  switch (msg.type) {',
            '    case "acmLoaded":',
            '      acmData = msg;',
            '      allPalettes = msg.palettes;',
            '      allVariables = msg.variables;',
            '      document.getElementById("summary").classList.remove("hidden");',
            '      document.getElementById("acm-path").textContent = msg.path;',
            '      const s = msg.summary;',
            '      document.getElementById("acm-stats").innerHTML = ',
            '        \'<span class="stat"><span class="stat-value">\' + s.palettes + \'</span><span class="stat-label">palettes</span></span>\' +',
            '        \'<span class="stat"><span class="stat-value">\' + s.variables + \'</span><span class="stat-label">variables</span></span>\' +',
            '        \'<span class="stat"><span class="stat-value">\' + s.uidxEntries + \'</span><span class="stat-label">assets (UIDX)</span></span>\' +',
            '        \'<span class="stat"><span class="stat-value">\' + s.cidxEntries + \'</span><span class="stat-label">CRC entries</span></span>\';',
            '      document.getElementById("btn-save").disabled = false;',
            '      document.getElementById("btn-save-as").disabled = false;',
            '      renderPalettes(msg.palettes);',
            '      renderVariables(msg.variables);',
            '      vscode.postMessage({ type: "searchAssets", query: "" });',
            '      break;',
            '',
            '    case "paletteResults":',
            '      renderPalettes(msg.results);',
            '      break;',
            '',
            '    case "variableResults":',
            '      renderVariables(msg.results);',
            '      break;',
            '',
            '    case "assetResults":',
            '      renderAssets(msg.results);',
            '      break;',
            '',
            '    case "paletteColors":',
            '      renderColorGrid(msg.colors);',
            '      break;',
            '',
            '    case "assetCustomization":',
            '      renderAssetCustomization(msg.variables);',
            '      break;',
            '',
            '    case "assetsAdded":',
            '      const sa = msg.summary;',
            '      document.getElementById("acm-stats").innerHTML = ',
            '        \'<span class="stat"><span class="stat-value">\' + sa.palettes + \'</span><span class="stat-label">palettes</span></span>\' +',
            '        \'<span class="stat"><span class="stat-value">\' + sa.variables + \'</span><span class="stat-label">variables</span></span>\' +',
            '        \'<span class="stat"><span class="stat-value">\' + sa.uidxEntries + \'</span><span class="stat-label">assets (UIDX)</span></span>\' +',
            '        \'<span class="stat"><span class="stat-value">\' + sa.cidxEntries + \'</span><span class="stat-label">CRC entries</span></span>\';',
            '      break;',
            '',
            '    case "noACMFound":',
            '      break;',
            '',
            '    case "showAddAssets":',
            '      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));',
            '      document.querySelectorAll(".tab-content").forEach(c => c.classList.add("hidden"));',
            '      document.querySelector(".tab[data-tab=add]").classList.add("active");',
            '      document.getElementById("tab-add").classList.remove("hidden");',
            '      break;',
            '',
            '    case "saved":',
            '      break;',
            '  }',
            '});',
            '',
            '// Initialize',
            'vscode.postMessage({ type: "ready" });',
        ];
        return lines.join('\n');
    }
}
