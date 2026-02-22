import * as vscode from 'vscode';
import * as path from 'path';
import {
    WalkwayConfig, WalkwayShape, WalkwayEffect,
    SHAPES, SIZES, TEXTURES, EFFECTS,
    getWalkwayName, getSfpKey,
    generateWalkway, generateBatch,
    writeWalkwayFiles, registerCRC, registerSTF,
    GeneratedWalkway,
} from './walkwayGenerator';

export class ForgePanel {
    public static currentPanel: ForgePanel | undefined;
    public static readonly viewType = 'walkwayBuilder';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _lastGenerated: GeneratedWalkway[] = [];

    public static createOrShow(extensionUri: vscode.Uri): ForgePanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ForgePanel.currentPanel) {
            ForgePanel.currentPanel._panel.reveal(column);
            return ForgePanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            ForgePanel.viewType,
            'Walkway Builder',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        ForgePanel.currentPanel = new ForgePanel(panel, extensionUri);
        return ForgePanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(
            msg => this._handleMessage(msg),
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose(): void {
        ForgePanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private async _handleMessage(msg: any): Promise<void> {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        switch (msg.type) {
            case 'preview': {
                try {
                    const config = this._parseConfig(msg.config);
                    const result = generateWalkway(config, ws);
                    this._lastGenerated = [result];
                    this._sendPreview([result]);
                } catch (err: any) {
                    vscode.window.showErrorMessage('Preview failed: ' + err.message);
                }
                break;
            }
            case 'previewBatch': {
                try {
                    const cfg = msg.config;
                    const results = generateBatch(
                        cfg.shape, parseInt(cfg.size), cfg.effect,
                        parseInt(cfg.featheringType), parseFloat(cfg.featheringAmount),
                        ws, cfg.width ? parseInt(cfg.width) : undefined, cfg.height ? parseInt(cfg.height) : undefined
                    );
                    this._lastGenerated = results;
                    this._sendPreview(results);
                } catch (err: any) {
                    vscode.window.showErrorMessage('Batch preview failed: ' + err.message);
                }
                break;
            }
            case 'generate': {
                try {
                    const config = this._parseConfig(msg.config);
                    const result = generateWalkway(config, ws);
                    this._lastGenerated = [result];
                    const stats = writeWalkwayFiles(result, ws);
                    this._panel.webview.postMessage({
                        type: 'generateComplete',
                        variants: 1,
                        stats,
                        crcPaths: result.crcPaths,
                        stfEntries: result.stfEntries,
                    });
                    vscode.window.showInformationMessage(
                        'Walkway Builder: Created ' + stats.written + ' files, appended ' + stats.appended + ' registrations for ' + result.name
                    );
                } catch (err: any) {
                    vscode.window.showErrorMessage('Generation failed: ' + err.message);
                }
                break;
            }
            case 'generateBatch': {
                try {
                    const cfg = msg.config;
                    const results = generateBatch(
                        cfg.shape, parseInt(cfg.size), cfg.effect,
                        parseInt(cfg.featheringType), parseFloat(cfg.featheringAmount),
                        ws, cfg.width ? parseInt(cfg.width) : undefined, cfg.height ? parseInt(cfg.height) : undefined
                    );
                    this._lastGenerated = results;

                    let totalWritten = 0;
                    let totalAppended = 0;
                    const allErrors: string[] = [];
                    const allCrcPaths: string[] = [];
                    const allStfEntries: any[] = [];

                    for (const r of results) {
                        const stats = writeWalkwayFiles(r, ws);
                        totalWritten += stats.written;
                        totalAppended += stats.appended;
                        allErrors.push(...stats.errors);
                        allCrcPaths.push(...r.crcPaths);
                        allStfEntries.push(...r.stfEntries);
                    }

                    this._panel.webview.postMessage({
                        type: 'generateComplete',
                        variants: results.length,
                        stats: { written: totalWritten, appended: totalAppended, skipped: 0, errors: allErrors, files: [] },
                        crcPaths: allCrcPaths,
                        stfEntries: allStfEntries,
                    });
                    vscode.window.showInformationMessage(
                        'Walkway Builder: Generated ' + results.length + ' variants (' + totalWritten + ' files written, ' + totalAppended + ' appended)'
                    );
                } catch (err: any) {
                    vscode.window.showErrorMessage('Batch generation failed: ' + err.message);
                }
                break;
            }
            case 'registerCRC': {
                const r = registerCRC(ws, msg.crcPaths);
                this._panel.webview.postMessage({ type: 'stepResult', step: 'crc', ...r });
                if (r.success) vscode.window.showInformationMessage('CRC: ' + r.message);
                else vscode.window.showWarningMessage('CRC: ' + r.message);
                break;
            }
            case 'registerSTF': {
                const r = registerSTF(ws, msg.stfEntries);
                this._panel.webview.postMessage({ type: 'stepResult', step: 'stf', ...r });
                if (r.success) vscode.window.showInformationMessage('STF: ' + r.message);
                else vscode.window.showWarningMessage('STF: ' + r.message);
                break;
            }
        }
    }

    private _sendPreview(results: GeneratedWalkway[]): void {
        const allFiles: { path: string; type: string }[] = [];
        const allCrc: string[] = [];
        const allStf: any[] = [];

        for (const r of results) {
            allFiles.push(
                { path: r.layFile.path, type: 'TRE' },
                { path: r.sfpFile.path, type: 'TRE' },
                { path: r.buildingIFF.path, type: 'TRE' },
                { path: r.deedIFF.path, type: 'TRE' },
                { path: r.schematicIFF.path, type: 'TRE' },
                { path: r.lootSchematicIFF.path, type: 'TRE' },
                { path: r.buildingLua.path, type: 'Building' },
                { path: r.deedLua.path, type: 'Deed' },
                { path: r.schematicLua.path, type: 'Schematic' },
                { path: r.lootSchematicLua.path, type: 'Loot Schem' },
                { path: r.lootItemLua.path, type: 'Loot Item' },
            );
            allCrc.push(...r.crcPaths);
            allStf.push(...r.stfEntries);
        }

        // Deduplicate SFP files (shared per shape+size)
        const seen = new Set<string>();
        const deduped = allFiles.filter(f => {
            if (seen.has(f.path)) return false;
            seen.add(f.path);
            return true;
        });

        this._panel.webview.postMessage({
            type: 'previewResult',
            variants: results.length,
            files: deduped,
            crcPaths: [...new Set(allCrc)],
            stfEntries: allStf,
            registrations: 9,
        });
    }

    private _parseConfig(raw: any): WalkwayConfig {
        const texture = TEXTURES.find(t => t.key === raw.texture);
        const shape = raw.shape as WalkwayShape;
        const displayLabel = texture?.label || raw.texture;
        const sizeLabel = raw.size + 'm';

        return {
            shape,
            size: parseInt(raw.size) || 32,
            width: raw.width ? parseInt(raw.width) : undefined,
            height: raw.height ? parseInt(raw.height) : undefined,
            texture: raw.texture || 'duracrete',
            effect: (raw.effect || 'texture_flatten') as WalkwayEffect,
            featheringType: parseInt(raw.featheringType) || 3,
            featheringAmount: parseFloat(raw.featheringAmount) || 0.25,
            displayName: raw.displayName || (displayLabel + ' ' + shape.charAt(0).toUpperCase() + shape.slice(1) + ' ' + sizeLabel),
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // Webview HTML — string[] join pattern for SSH Remote
    // ═══════════════════════════════════════════════════════════════

    private _getHtml(): string {
        const lines: string[] = [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="UTF-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '<title>Walkway Builder</title>',
            '<style>',
            this._getCss(),
            '</style>',
            '</head>',
            '<body>',
            '<div id="app">',
            '  <div id="header">',
            '    <h2>Walkway Builder</h2>',
            '    <p class="subtitle">Generate complete walkway tile variants — LAY, SFP, IFF, Lua, CRC, STF</p>',
            '  </div>',
            '',
        ];

        // ── Form ──
        lines.push('  <div class="form-section">');
        lines.push('    <h3>Shape &amp; Size</h3>');
        lines.push('    <div class="form-grid">');
        lines.push('      <div class="form-row">');
        lines.push('        <label>Shape</label>');
        lines.push('        <select id="shape">');
        for (const s of SHAPES) {
            lines.push('          <option value="' + s.value + '">' + s.label + '</option>');
        }
        lines.push('        </select>');
        lines.push('      </div>');
        lines.push('      <div class="form-row">');
        lines.push('        <label>Size</label>');
        lines.push('        <select id="size">');
        for (const s of SIZES.square) {
            lines.push('          <option value="' + s.value + '">' + s.label + '</option>');
        }
        lines.push('        </select>');
        lines.push('      </div>');
        lines.push('    </div>');
        lines.push('    <div id="namePreview" class="name-preview"></div>');
        lines.push('  </div>');

        // Texture
        lines.push('  <div class="form-section">');
        lines.push('    <h3>Texture</h3>');
        lines.push('    <div class="form-row">');
        lines.push('      <select id="texture">');
        for (const t of TEXTURES) {
            const tag = t.rarity === 'rare' ? ' [Rare]' : t.rarity === 'uncommon' ? ' [Uncommon]' : '';
            lines.push('        <option value="' + t.key + '">' + t.label + tag + '</option>');
        }
        lines.push('      </select>');
        lines.push('    </div>');
        lines.push('  </div>');

        // Effect
        lines.push('  <div class="form-section">');
        lines.push('    <h3>Effect</h3>');
        lines.push('    <div class="form-grid">');
        lines.push('      <div class="form-row">');
        lines.push('        <label>Terrain Effect</label>');
        lines.push('        <select id="effect">');
        for (const e of EFFECTS) {
            const sel = e.value === 'texture_flatten' ? ' selected' : '';
            lines.push('          <option value="' + e.value + '"' + sel + '>' + e.label + '</option>');
        }
        lines.push('        </select>');
        lines.push('      </div>');
        lines.push('      <div class="form-row">');
        lines.push('        <label>Feathering Type</label>');
        lines.push('        <select id="featheringType">');
        lines.push('          <option value="0">Linear</option>');
        lines.push('          <option value="1">Quadratic (x&sup2;)</option>');
        lines.push('          <option value="2">Square Root</option>');
        lines.push('          <option value="3" selected>Smoothstep</option>');
        lines.push('        </select>');
        lines.push('      </div>');
        lines.push('      <div class="form-row">');
        lines.push('        <label>Feathering Amount</label>');
        lines.push('        <input type="range" id="featheringAmount" min="0" max="1" step="0.05" value="0.25">');
        lines.push('        <span id="featherVal">0.25</span>');
        lines.push('      </div>');
        lines.push('    </div>');
        lines.push('  </div>');

        // Display Name
        lines.push('  <div class="form-section">');
        lines.push('    <h3>Display Name</h3>');
        lines.push('    <div class="form-row">');
        lines.push('      <label>In-game name<br><span class="hint">Auto-generated, override if needed</span></label>');
        lines.push('      <input type="text" id="displayName" value="" placeholder="Auto-generated">');
        lines.push('    </div>');
        lines.push('  </div>');

        // Actions
        lines.push('  <div class="form-actions">');
        lines.push('    <button id="btn-preview" class="btn-primary">Preview</button>');
        lines.push('    <button id="btn-generate" class="btn-generate">Generate Single</button>');
        lines.push('    <button id="btn-batch-preview" class="btn-primary">Preview All Textures</button>');
        lines.push('    <button id="btn-batch" class="btn-batch">Generate All Textures</button>');
        lines.push('  </div>');

        // Preview area
        lines.push('  <div id="preview-area" class="hidden">');
        lines.push('    <h3>Preview</h3>');
        lines.push('    <div id="preview-stats"></div>');
        lines.push('    <div id="preview-files"></div>');
        lines.push('  </div>');

        // Result area
        lines.push('  <div id="result-area" class="hidden">');
        lines.push('    <h3>Generation Complete</h3>');
        lines.push('    <div id="result-message"></div>');
        lines.push('    <div id="post-gen-steps">');
        lines.push('      <h4>Post-Generation Steps</h4>');
        lines.push('      <p class="hint">Click each button to complete TRE-side setup:</p>');
        lines.push('      <div class="step-list">');
        lines.push('        <div class="step-row">');
        lines.push('          <button class="btn-step" id="btn-crc">1. Register CRC Entries</button>');
        lines.push('          <span class="step-desc">Add shared IFF paths to CRC string table</span>');
        lines.push('          <span class="step-status" id="status-crc"></span>');
        lines.push('        </div>');
        lines.push('        <div class="step-row">');
        lines.push('          <button class="btn-step" id="btn-stf">2. Add STF Strings</button>');
        lines.push('          <span class="step-desc">Add names/descriptions to city_n.stf and city_d.stf</span>');
        lines.push('          <span class="step-status" id="status-stf"></span>');
        lines.push('        </div>');
        lines.push('        <div class="step-row step-row-all">');
        lines.push('          <button class="btn-step btn-run-all" id="btn-run-all">Run All Steps</button>');
        lines.push('          <span class="step-desc">Execute CRC + STF sequentially</span>');
        lines.push('          <span class="step-status" id="status-all"></span>');
        lines.push('        </div>');
        lines.push('      </div>');
        lines.push('      <p class="hint" style="margin-top:12px">After all steps: build server with <code>make -j24</code> and rebuild TRE</p>');
        lines.push('    </div>');
        lines.push('  </div>');

        lines.push('</div>');
        lines.push('<script>');
        lines.push(this._getScript());
        lines.push('</script>');
        lines.push('</body>');
        lines.push('</html>');

        return lines.join('\n');
    }

    private _getCss(): string {
        return [
            ':root { --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --border: var(--vscode-panel-border, #444); --input-bg: var(--vscode-input-background); --input-fg: var(--vscode-input-foreground); --input-border: var(--vscode-input-border, #555); --btn-bg: var(--vscode-button-background); --btn-fg: var(--vscode-button-foreground); --btn-hover: var(--vscode-button-hoverBackground); --badge-bg: var(--vscode-badge-background); --badge-fg: var(--vscode-badge-foreground); }',
            'body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); }',
            '#app { max-width: 900px; margin: 0 auto; padding: 16px; }',
            '#header { margin-bottom: 12px; }',
            '#header h2 { margin: 0; font-size: 16px; }',
            '.subtitle { opacity: 0.7; font-size: 12px; margin: 4px 0 0; }',
            '.form-section { margin-bottom: 16px; padding: 12px 16px; border: 1px solid var(--border); border-radius: 4px; }',
            '.form-section h3 { margin: 0 0 10px 0; font-size: 13px; font-weight: 600; }',
            '.form-row { margin-bottom: 8px; }',
            '.form-row label { display: block; font-size: 12px; margin-bottom: 3px; }',
            '.hint { font-size: 11px; opacity: 0.6; }',
            '.form-row input, .form-row select { width: 100%; box-sizing: border-box; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); padding: 5px 8px; font-size: 13px; }',
            '.form-row input:focus, .form-row select:focus { outline: none; border-color: var(--btn-bg); }',
            '.form-row input[type=range] { padding: 0; border: none; background: transparent; }',
            '.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }',
            '.name-preview { margin-top: 8px; font-family: var(--vscode-editor-font-family); font-size: 12px; padding: 6px 10px; background: var(--input-bg); border-radius: 3px; opacity: 0.85; }',
            '',
            '.form-actions { display: flex; gap: 10px; margin: 20px 0; flex-wrap: wrap; }',
            'button { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 8px 18px; cursor: pointer; border-radius: 3px; font-size: 13px; }',
            'button:hover { background: var(--btn-hover); }',
            '.btn-generate { background: #2ea043; color: white; }',
            '.btn-generate:hover { background: #3fb950; }',
            '.btn-batch { background: #8957e5; color: white; }',
            '.btn-batch:hover { background: #a371f7; }',
            '',
            '#preview-area, #result-area { margin-top: 20px; padding: 12px 16px; border: 1px solid var(--border); border-radius: 4px; }',
            '#preview-area h3, #result-area h3 { margin: 0 0 12px 0; }',
            '#preview-stats { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }',
            '.stat { font-size: 12px; }',
            '.stat-val { background: var(--badge-bg); color: var(--badge-fg); padding: 1px 6px; border-radius: 8px; font-size: 11px; font-weight: 600; }',
            '#preview-files { font-size: 12px; }',
            '.file-group { margin: 8px 0; }',
            '.file-group-header { font-weight: 600; margin-bottom: 4px; }',
            '.file-entry { font-family: var(--vscode-editor-font-family); padding: 1px 0; opacity: 0.85; font-size: 11px; }',
            '.hidden { display: none !important; }',
            '#result-message { margin-bottom: 16px; font-size: 14px; color: #3fb950; }',
            '#post-gen-steps h4 { margin: 0 0 4px 0; }',
            '.step-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }',
            '.step-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; }',
            '.step-row-all { margin-top: 8px; border-color: var(--btn-bg); }',
            '.btn-step { min-width: 180px; text-align: left; padding: 6px 12px; font-size: 12px; white-space: nowrap; }',
            '.btn-run-all { background: #2ea043; color: white; min-width: 180px; }',
            '.btn-run-all:hover { background: #3fb950; }',
            '.step-desc { font-size: 11px; opacity: 0.7; flex: 1; }',
            '.step-status { font-size: 11px; min-width: 80px; text-align: right; }',
            '.step-status.done { color: #3fb950; }',
            '.step-status.error { color: #f85149; }',
            '.step-status.running { color: #d29922; }',
        ].join('\n');
    }

    private _getScript(): string {
        // Embed constants as JSON for the webview
        const sizesJson = JSON.stringify(SIZES).replace(/"/g, '\\"');

        return [
            'var vscode = acquireVsCodeApi();',
            'var genData = null;',
            '',
            '// Size options per shape',
            'var SIZES = JSON.parse("' + sizesJson + '");',
            '',
            '// ─── Dynamic size dropdown ──────────────────────',
            'var shapeEl = document.getElementById("shape");',
            'var sizeEl = document.getElementById("size");',
            '',
            'function updateSizes() {',
            '  var shape = shapeEl.value;',
            '  var opts = SIZES[shape] || [];',
            '  sizeEl.innerHTML = "";',
            '  for (var i = 0; i < opts.length; i++) {',
            '    var o = document.createElement("option");',
            '    o.value = opts[i].value;',
            '    o.textContent = opts[i].label;',
            '    if (opts[i].width) o.setAttribute("data-width", opts[i].width);',
            '    if (opts[i].height) o.setAttribute("data-height", opts[i].height);',
            '    sizeEl.appendChild(o);',
            '  }',
            '  updateNamePreview();',
            '}',
            '',
            'shapeEl.addEventListener("change", updateSizes);',
            '',
            '// ─── Name preview ──────────────────────────────',
            'function updateNamePreview() {',
            '  var shape = shapeEl.value;',
            '  var size = sizeEl.value;',
            '  var texture = document.getElementById("texture").value;',
            '  var opt = sizeEl.options[sizeEl.selectedIndex];',
            '  var name;',
            '  if ((shape === "rectangle" || shape === "sidewalk") && opt) {',
            '    var w = opt.getAttribute("data-width") || size;',
            '    var h = opt.getAttribute("data-height") || (parseInt(size) * 2);',
            '    name = "walkway_" + shape + "_" + w + "x" + h + "_" + texture;',
            '  } else if ((shape === "scurve" || shape === "scurve_r") && opt) {',
            '    var pw = opt.getAttribute("data-width") || "4";',
            '    name = "walkway_" + shape + "_" + size + "w" + pw + "_" + texture;',
            '  } else {',
            '    name = "walkway_" + shape + "_" + size + "_" + texture;',
            '  }',
            '  document.getElementById("namePreview").textContent = "Name: " + name;',
            '}',
            '',
            'sizeEl.addEventListener("change", updateNamePreview);',
            'document.getElementById("texture").addEventListener("change", updateNamePreview);',
            '',
            '// ─── Feathering slider ─────────────────────────',
            'var featherSlider = document.getElementById("featheringAmount");',
            'var featherVal = document.getElementById("featherVal");',
            'featherSlider.addEventListener("input", function() {',
            '  featherVal.textContent = this.value;',
            '});',
            '',
            '// ─── Collect config ────────────────────────────',
            'function getConfig() {',
            '  var opt = sizeEl.options[sizeEl.selectedIndex];',
            '  return {',
            '    shape: shapeEl.value,',
            '    size: sizeEl.value,',
            '    width: opt ? opt.getAttribute("data-width") : null,',
            '    height: opt ? opt.getAttribute("data-height") : null,',
            '    texture: document.getElementById("texture").value,',
            '    effect: document.getElementById("effect").value,',
            '    featheringType: document.getElementById("featheringType").value,',
            '    featheringAmount: featherSlider.value,',
            '    displayName: document.getElementById("displayName").value,',
            '  };',
            '}',
            '',
            '// ─── Button handlers ───────────────────────────',
            'document.getElementById("btn-preview").addEventListener("click", function() {',
            '  vscode.postMessage({ type: "preview", config: getConfig() });',
            '});',
            '',
            'document.getElementById("btn-generate").addEventListener("click", function() {',
            '  if (confirm("Generate files for this single walkway variant?")) {',
            '    vscode.postMessage({ type: "generate", config: getConfig() });',
            '  }',
            '});',
            '',
            'document.getElementById("btn-batch-preview").addEventListener("click", function() {',
            '  vscode.postMessage({ type: "previewBatch", config: getConfig() });',
            '});',
            '',
            'document.getElementById("btn-batch").addEventListener("click", function() {',
            '  if (confirm("Generate ALL ' + TEXTURES.length + ' texture variants for this shape+size? This creates ~' + (TEXTURES.length * 11) + ' files.")) {',
            '    vscode.postMessage({ type: "generateBatch", config: getConfig() });',
            '  }',
            '});',
            '',
            '// ─── Post-gen steps ────────────────────────────',
            'document.getElementById("btn-crc").addEventListener("click", function() {',
            '  if (!genData) { alert("Generate files first."); return; }',
            '  setStatus("crc", "running", "Running...");',
            '  vscode.postMessage({ type: "registerCRC", crcPaths: genData.crcPaths });',
            '});',
            '',
            'document.getElementById("btn-stf").addEventListener("click", function() {',
            '  if (!genData) { alert("Generate files first."); return; }',
            '  setStatus("stf", "running", "Running...");',
            '  vscode.postMessage({ type: "registerSTF", stfEntries: genData.stfEntries });',
            '});',
            '',
            'document.getElementById("btn-run-all").addEventListener("click", function() {',
            '  if (!genData) { alert("Generate files first."); return; }',
            '  setStatus("all", "running", "Running...");',
            '  setStatus("crc", "running", "Running...");',
            '  vscode.postMessage({ type: "registerCRC", crcPaths: genData.crcPaths });',
            '  setTimeout(function() {',
            '    setStatus("stf", "running", "Running...");',
            '    vscode.postMessage({ type: "registerSTF", stfEntries: genData.stfEntries });',
            '  }, 500);',
            '});',
            '',
            'function setStatus(step, cls, text) {',
            '  var el = document.getElementById("status-" + step);',
            '  if (!el) return;',
            '  el.className = "step-status " + cls;',
            '  el.textContent = text;',
            '}',
            '',
            'function esc(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;"); }',
            '',
            '// ─── Message handler ───────────────────────────',
            'window.addEventListener("message", function(event) {',
            '  var msg = event.data;',
            '',
            '  if (msg.type === "previewResult") {',
            '    document.getElementById("preview-area").classList.remove("hidden");',
            '    document.getElementById("result-area").classList.add("hidden");',
            '    document.getElementById("preview-stats").innerHTML =',
            '      \'<span class="stat"><span class="stat-val">\' + msg.variants + \'</span> variants</span>\' +',
            '      \'<span class="stat"><span class="stat-val">\' + msg.files.length + \'</span> files</span>\' +',
            '      \'<span class="stat"><span class="stat-val">\' + msg.crcPaths.length + \'</span> CRC entries</span>\' +',
            '      \'<span class="stat"><span class="stat-val">\' + msg.stfEntries.length + \'</span> STF entries</span>\' +',
            '      \'<span class="stat"><span class="stat-val">\' + msg.registrations + \'</span> registration files</span>\';',
            '',
            '    var groups = {};',
            '    msg.files.forEach(function(f) {',
            '      if (!groups[f.type]) groups[f.type] = [];',
            '      groups[f.type].push(f.path);',
            '    });',
            '    var html = "";',
            '    for (var type in groups) {',
            '      var files = groups[type];',
            '      html += \'<div class="file-group"><div class="file-group-header">\' + type + " (" + files.length + ")</div>";',
            '      files.forEach(function(p) { html += \'<div class="file-entry">\' + esc(p) + "</div>"; });',
            '      html += "</div>";',
            '    }',
            '    document.getElementById("preview-files").innerHTML = html;',
            '  }',
            '',
            '  if (msg.type === "generateComplete") {',
            '    document.getElementById("result-area").classList.remove("hidden");',
            '    document.getElementById("preview-area").classList.add("hidden");',
            '    var errStr = msg.stats.errors.length > 0 ? " (" + msg.stats.errors.length + " warnings)" : "";',
            '    document.getElementById("result-message").textContent =',
            '      msg.variants + " variant(s) generated: " + msg.stats.written + " files written, " + msg.stats.appended + " registrations appended" + errStr;',
            '    genData = { crcPaths: msg.crcPaths, stfEntries: msg.stfEntries };',
            '    setStatus("crc", "", "Ready");',
            '    setStatus("stf", "", "Ready");',
            '    setStatus("all", "", "");',
            '  }',
            '',
            '  if (msg.type === "stepResult") {',
            '    var step = msg.step;',
            '    if (msg.success) { setStatus(step, "done", msg.message); }',
            '    else { setStatus(step, "error", msg.message); }',
            '    var crcDone = document.getElementById("status-crc");',
            '    var stfDone = document.getElementById("status-stf");',
            '    if (crcDone && stfDone && crcDone.classList.contains("done") && stfDone.classList.contains("done")) {',
            '      setStatus("all", "done", "All complete!");',
            '    }',
            '  }',
            '});',
            '',
            '// Init',
            'updateSizes();',
            'updateNamePreview();',
        ].join('\n');
    }
}
