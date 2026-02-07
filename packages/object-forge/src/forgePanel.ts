import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { generateArmorSet, getDefaultArmorConfig, ArmorConfig, ARMOR_PIECES, GeneratedFiles } from './armorGenerator';
import {
    appendSchematicsRegistry, cloneSharedIFFs, registerCRCEntries,
    cloneAppearanceFiles, registerACMEntries, addSTFStrings
} from './postGenActions';

export class ForgePanel {
    public static currentPanel: ForgePanel | undefined;
    public static readonly viewType = 'objectForge';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _lastGenerated: GeneratedFiles | null = null;

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
            'Object Forge',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        ForgePanel.currentPanel = new ForgePanel(panel, extensionUri);
        return ForgePanel.currentPanel;
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
            case 'preview':
                this._previewArmorSet(msg.config);
                break;
            case 'generate':
                await this._generateAndWrite(msg.config);
                break;
            case 'step1_schematics': {
                const r = appendSchematicsRegistry(ws, msg.armorName, msg.snippet);
                this._panel.webview.postMessage({ type: 'stepResult', step: 1, ...r });
                if (r.success) vscode.window.showInformationMessage(`Step 1: ${r.message}`);
                else vscode.window.showWarningMessage(`Step 1: ${r.message}`);
                break;
            }
            case 'step2_cloneIFFs': {
                const r = cloneSharedIFFs(ws, msg.sourceArmorName, msg.sourceFolderName, msg.targetArmorName, msg.targetFolderName);
                this._panel.webview.postMessage({ type: 'stepResult', step: 2, ...r });
                vscode.window.showInformationMessage(`Step 2: ${r.message}`);
                break;
            }
            case 'step3_crc': {
                const r = registerCRCEntries(ws, msg.crcPaths);
                this._panel.webview.postMessage({ type: 'stepResult', step: 3, ...r });
                vscode.window.showInformationMessage(`Step 3: ${r.message}`);
                break;
            }
            case 'step4_appearance': {
                const r = cloneAppearanceFiles(ws, msg.sourceArmorName, msg.targetArmorName);
                this._panel.webview.postMessage({ type: 'stepResult', step: 4, ...r });
                vscode.window.showInformationMessage(`Step 4: ${r.message}`);
                break;
            }
            case 'step5_acm': {
                const r = registerACMEntries(ws, msg.acmPaths, msg.sourceArmorName);
                this._panel.webview.postMessage({ type: 'stepResult', step: 5, ...r });
                vscode.window.showInformationMessage(`Step 5: ${r.message}`);
                break;
            }
            case 'step6_stf': {
                const r = addSTFStrings(ws, msg.armorName, msg.displayName);
                this._panel.webview.postMessage({ type: 'stepResult', step: 6, ...r });
                vscode.window.showInformationMessage(`Step 6: ${r.message}`);
                break;
            }
        }
    }

    private _previewArmorSet(config: any): void {
        try {
            const armorConfig = this._parseConfig(config);
            const result = generateArmorSet(armorConfig);
            this._lastGenerated = result;

            this._panel.webview.postMessage({
                type: 'previewResult',
                summary: result.summary,
                fileCount: result.armorPieces.length + result.schematics.length + result.lootSchematics.length + 6,
                crcCount: result.crcPaths.length,
                acmCount: result.acmPaths.length,
                files: [
                    ...result.armorPieces.map(f => ({ path: f.path, type: 'armor', piece: f.piece })),
                    ...result.schematics.map(f => ({ path: f.path, type: 'schematic', piece: f.piece })),
                    ...result.lootSchematics.map(f => ({ path: f.path, type: 'loot', piece: f.piece })),
                    { path: result.objectsLua.path, type: 'registry' },
                    { path: result.serverObjectsLua.path, type: 'registry' },
                    { path: result.schematicObjectsLua.path, type: 'registry' },
                    { path: result.schematicServerObjectsLua.path, type: 'registry' },
                    { path: result.lootSchematicObjectsLua.path, type: 'registry' },
                    { path: result.lootSchematicServerObjectsLua.path, type: 'registry' },
                ],
                crcPaths: result.crcPaths,
                acmPaths: result.acmPaths,
                schematicsSnippet: result.schematicsRegistrySnippet,
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Preview failed: ${err.message}`);
        }
    }

    private async _generateAndWrite(config: any): Promise<void> {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!ws) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
        }

        try {
            const armorConfig = this._parseConfig(config);
            const result = generateArmorSet(armorConfig);
            this._lastGenerated = result;

            const scriptsBase = path.join(ws, 'infinity4.0.0/MMOCoreORB/bin/scripts');

            // Collect all files to write
            const allFiles = [
                ...result.armorPieces.map(f => ({ path: f.path, content: f.content })),
                ...result.schematics.map(f => ({ path: f.path, content: f.content })),
                ...result.lootSchematics.map(f => ({ path: f.path, content: f.content })),
                result.objectsLua,
                result.serverObjectsLua,
            ];

            // Write files, creating directories as needed
            let written = 0;
            for (const file of allFiles) {
                const fullPath = path.join(scriptsBase, file.path);
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(fullPath, file.content, 'utf8');
                written++;
            }

            // Append to existing schematic objects.lua and serverobjects.lua (don't overwrite)
            const appendFiles = [
                { path: result.schematicObjectsLua.path, content: result.schematicObjectsLua.content },
                { path: result.schematicServerObjectsLua.path, content: result.schematicServerObjectsLua.content },
                { path: result.lootSchematicObjectsLua.path, content: result.lootSchematicObjectsLua.content },
                { path: result.lootSchematicServerObjectsLua.path, content: result.lootSchematicServerObjectsLua.content },
            ];

            for (const file of appendFiles) {
                const fullPath = path.join(scriptsBase, file.path);
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                if (fs.existsSync(fullPath)) {
                    // Append to existing file
                    fs.appendFileSync(fullPath, '\n' + file.content, 'utf8');
                } else {
                    fs.writeFileSync(fullPath, file.content, 'utf8');
                }
                written++;
            }

            this._panel.webview.postMessage({
                type: 'generateComplete',
                written,
                schematicsSnippet: result.schematicsRegistrySnippet,
                crcPaths: result.crcPaths,
                acmPaths: result.acmPaths,
            });

            vscode.window.showInformationMessage(
                `Object Forge: Created ${written} files for ${armorConfig.displayName} armor set`
            );
        } catch (err: any) {
            vscode.window.showErrorMessage(`Generation failed: ${err.message}`);
        }
    }

    private _parseConfig(raw: any): ArmorConfig {
        const defaults = getDefaultArmorConfig();
        return {
            armorName: raw.armorName || defaults.armorName,
            displayName: raw.displayName || defaults.displayName,
            folderName: raw.folderName || raw.armorName || defaults.folderName,
            rating: raw.rating || defaults.rating,
            maxCondition: parseInt(raw.maxCondition) || defaults.maxCondition,
            kinetic: parseInt(raw.kinetic) || defaults.kinetic,
            energy: parseInt(raw.energy) || defaults.energy,
            electricity: parseInt(raw.electricity) || defaults.electricity,
            stun: parseInt(raw.stun) || defaults.stun,
            blast: parseInt(raw.blast) || defaults.blast,
            heat: parseInt(raw.heat) || defaults.heat,
            cold: parseInt(raw.cold) || defaults.cold,
            acid: parseInt(raw.acid) || defaults.acid,
            lightSaber: parseInt(raw.lightSaber) || defaults.lightSaber,
            vulnerability: raw.vulnerability || defaults.vulnerability,
            specialResist: raw.specialResist || defaults.specialResist,
            healthEncumbrance: parseInt(raw.healthEncumbrance) || defaults.healthEncumbrance,
            actionEncumbrance: parseInt(raw.actionEncumbrance) || defaults.actionEncumbrance,
            mindEncumbrance: parseInt(raw.mindEncumbrance) || defaults.mindEncumbrance,
            xp: parseInt(raw.xp) || defaults.xp,
            requiredSkill: raw.requiredSkill || defaults.requiredSkill,
            certificationsRequired: raw.certificationsRequired,
            customizationVariable: raw.customizationVariable || defaults.customizationVariable,
            ingredients: raw.ingredients || defaults.ingredients,
        };
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
            '<title>Object Forge</title>',
            '<style>',
            this._getCss(),
            '</style>',
            '</head>',
            '<body>',
            '<div id="app">',
            '  <div id="header">',
            '    <h2>Object Forge - Armor Set Generator</h2>',
            '    <p class="subtitle">Generate all Lua files for a complete 10-piece armor set</p>',
            '  </div>',
            '',
            '  <div id="form-container">',
            '    <div class="form-section">',
            '      <h3>Identity</h3>',
            '      <div class="form-row">',
            '        <label>Armor Name (code)<br><span class="hint">lowercase_with_underscores, e.g. nightsister_crafted</span></label>',
            '        <input type="text" id="armorName" value="custom_crafted" placeholder="my_armor_name">',
            '      </div>',
            '      <div class="form-row">',
            '        <label>Display Name<br><span class="hint">For comments, e.g. "Nightsister"</span></label>',
            '        <input type="text" id="displayName" value="Custom" placeholder="My Armor">',
            '      </div>',
            '      <div class="form-row">',
            '        <label>TRE Folder<br><span class="hint">Subfolder under armor/ in TRE, e.g. "nightsister"</span></label>',
            '        <input type="text" id="folderName" value="custom" placeholder="my_armor">',
            '      </div>',
            '    </div>',
            '',
            '    <div class="form-section">',
            '      <h3>Source Armor (for IFF/Appearance cloning)</h3>',
            '      <p class="hint" style="margin:0 0 8px">Existing armor set to clone IFF templates and appearances from</p>',
            '      <div class="form-grid">',
            '        <div class="form-row">',
            '          <label>Source Armor Name<br><span class="hint">e.g. bounty_hunter_crafted</span></label>',
            '          <input type="text" id="sourceArmorName" value="bounty_hunter_crafted" placeholder="bounty_hunter_crafted">',
            '        </div>',
            '        <div class="form-row">',
            '          <label>Source TRE Folder<br><span class="hint">e.g. bounty_hunter</span></label>',
            '          <input type="text" id="sourceFolderName" value="bounty_hunter" placeholder="bounty_hunter">',
            '        </div>',
            '      </div>',
            '    </div>',
            '',
            '    <div class="form-section">',
            '      <h3>Armor Properties</h3>',
            '      <div class="form-grid">',
            '        <div class="form-row">',
            '          <label>Rating</label>',
            '          <select id="rating"><option value="LIGHT" selected>LIGHT</option><option value="MEDIUM">MEDIUM</option><option value="HEAVY">HEAVY</option></select>',
            '        </div>',
            '        <div class="form-row">',
            '          <label>Max Condition</label>',
            '          <input type="number" id="maxCondition" value="30000">',
            '        </div>',
            '        <div class="form-row">',
            '          <label>Vulnerability</label>',
            '          <input type="text" id="vulnerability" value="ACID + STUN + LIGHTSABER">',
            '        </div>',
            '        <div class="form-row">',
            '          <label>Special Resist</label>',
            '          <input type="text" id="specialResist" value="LIGHTSABER" placeholder="(optional)">',
            '        </div>',
            '      </div>',
            '    </div>',
            '',
            '    <div class="form-section">',
            '      <h3>Resistances</h3>',
            '      <div class="form-grid resist-grid">',
            '        <div class="form-row"><label>Kinetic</label><input type="number" id="kinetic" value="15"></div>',
            '        <div class="form-row"><label>Energy</label><input type="number" id="energy" value="15"></div>',
            '        <div class="form-row"><label>Electricity</label><input type="number" id="electricity" value="15"></div>',
            '        <div class="form-row"><label>Stun</label><input type="number" id="stun" value="45"></div>',
            '        <div class="form-row"><label>Blast</label><input type="number" id="blast" value="15"></div>',
            '        <div class="form-row"><label>Heat</label><input type="number" id="heat" value="15"></div>',
            '        <div class="form-row"><label>Cold</label><input type="number" id="cold" value="15"></div>',
            '        <div class="form-row"><label>Acid</label><input type="number" id="acid" value="15"></div>',
            '        <div class="form-row"><label>Lightsaber</label><input type="number" id="lightSaber" value="25"></div>',
            '      </div>',
            '    </div>',
            '',
            '    <div class="form-section">',
            '      <h3>Encumbrance &amp; Crafting</h3>',
            '      <div class="form-grid">',
            '        <div class="form-row"><label>Health Enc</label><input type="number" id="healthEncumbrance" value="1"></div>',
            '        <div class="form-row"><label>Action Enc</label><input type="number" id="actionEncumbrance" value="1"></div>',
            '        <div class="form-row"><label>Mind Enc</label><input type="number" id="mindEncumbrance" value="1"></div>',
            '        <div class="form-row"><label>XP Reward</label><input type="number" id="xp" value="550"></div>',
            '        <div class="form-row"><label>Required Skill</label><input type="text" id="requiredSkill" value="crafting_armorsmith_master"></div>',
            '        <div class="form-row"><label>Color Variable</label><input type="text" id="customizationVariable" value="/private/index_color_1"></div>',
            '      </div>',
            '    </div>',
            '',
            '    <div class="form-actions">',
            '      <button id="btn-preview" class="btn-primary">Preview Files</button>',
            '      <button id="btn-generate" class="btn-generate">Generate All Files</button>',
            '    </div>',
            '  </div>',
            '',
            '  <div id="preview-area" class="hidden">',
            '    <h3>Preview</h3>',
            '    <div id="preview-stats"></div>',
            '    <div id="preview-files"></div>',
            '    <div id="preview-registry" class="hidden">',
            '      <h4>Schematics Registry Snippet</h4>',
            '      <pre id="registry-snippet"></pre>',
            '    </div>',
            '    <div id="preview-crc" class="hidden">',
            '      <h4>CRC Table Entries Needed</h4>',
            '      <pre id="crc-paths"></pre>',
            '    </div>',
            '    <div id="preview-acm" class="hidden">',
            '      <h4>ACM Entries Needed (Appearance Paths)</h4>',
            '      <pre id="acm-paths"></pre>',
            '    </div>',
            '  </div>',
            '',
            '  <div id="result-area" class="hidden">',
            '    <h3>Generation Complete</h3>',
            '    <div id="result-message"></div>',
            '    <div id="post-gen-steps">',
            '      <h4>Post-Generation Steps</h4>',
            '      <p class="hint">Click each button in order to complete the TRE-side setup:</p>',
            '      <div class="step-list">',
            '        <div class="step-row" data-step="1">',
            '          <button class="btn-step" id="btn-step1">1. Register Schematics</button>',
            '          <span class="step-desc">Append schematic entries to managers/crafting/schematics.lua</span>',
            '          <span class="step-status" id="status-1"></span>',
            '        </div>',
            '        <div class="step-row" data-step="2">',
            '          <button class="btn-step" id="btn-step2">2. Clone IFF Files</button>',
            '          <span class="step-desc">Clone shared_*.iff (armor + schematic + loot) from source armor</span>',
            '          <span class="step-status" id="status-2"></span>',
            '        </div>',
            '        <div class="step-row" data-step="3">',
            '          <button class="btn-step" id="btn-step3">3. Register CRC Entries</button>',
            '          <span class="step-desc">Add all new IFF paths to the CRC string table</span>',
            '          <span class="step-status" id="status-3"></span>',
            '        </div>',
            '        <div class="step-row" data-step="4">',
            '          <button class="btn-step" id="btn-step4">4. Clone Appearances</button>',
            '          <span class="step-desc">Copy SAT appearance files from source armor</span>',
            '          <span class="step-status" id="status-4"></span>',
            '        </div>',
            '        <div class="step-row" data-step="5">',
            '          <button class="btn-step" id="btn-step5">5. Register ACM Entries</button>',
            '          <span class="step-desc">Add customization entries to asset_customization_manager.iff</span>',
            '          <span class="step-status" id="status-5"></span>',
            '        </div>',
            '        <div class="step-row" data-step="6">',
            '          <button class="btn-step" id="btn-step6">6. Add STF Strings</button>',
            '          <span class="step-desc">Add item name/description strings to STF files</span>',
            '          <span class="step-status" id="status-6"></span>',
            '        </div>',
            '        <div class="step-row step-row-all">',
            '          <button class="btn-step btn-run-all" id="btn-run-all">Run All Steps (1-6)</button>',
            '          <span class="step-desc">Execute all steps sequentially</span>',
            '          <span class="step-status" id="status-all"></span>',
            '        </div>',
            '      </div>',
            '      <p class="hint" style="margin-top:12px">After all steps: build server with <code>make -j24</code></p>',
            '    </div>',
            '  </div>',
            '</div>',
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
            ':root { --bg: var(--vscode-editor-background); --fg: var(--vscode-editor-foreground); --border: var(--vscode-panel-border, #444); --input-bg: var(--vscode-input-background); --input-fg: var(--vscode-input-foreground); --input-border: var(--vscode-input-border, #555); --btn-bg: var(--vscode-button-background); --btn-fg: var(--vscode-button-foreground); --btn-hover: var(--vscode-button-hoverBackground); --badge-bg: var(--vscode-badge-background); --badge-fg: var(--vscode-badge-foreground); }',
            'body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); }',
            '#app { max-width: 900px; margin: 0 auto; padding: 16px; }',
            '#header { margin-bottom: 20px; }',
            '#header h2 { margin: 0; font-size: 16px; }',
            '.subtitle { opacity: 0.7; font-size: 12px; margin: 4px 0 0; }',
            '',
            '.form-section { margin-bottom: 20px; padding: 12px 16px; border: 1px solid var(--border); border-radius: 4px; }',
            '.form-section h3 { margin: 0 0 12px 0; font-size: 13px; font-weight: 600; }',
            '.form-row { margin-bottom: 8px; }',
            '.form-row label { display: block; font-size: 12px; margin-bottom: 3px; }',
            '.form-row .hint { font-size: 11px; opacity: 0.6; }',
            '.form-row input, .form-row select { width: 100%; box-sizing: border-box; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); padding: 5px 8px; font-size: 13px; }',
            '.form-row input:focus, .form-row select:focus { outline: none; border-color: var(--btn-bg); }',
            '.form-row input[type=number] { width: 100px; }',
            '.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }',
            '.resist-grid { grid-template-columns: 1fr 1fr 1fr; }',
            '',
            '.form-actions { display: flex; gap: 12px; margin: 20px 0; }',
            'button { background: var(--btn-bg); color: var(--btn-fg); border: none; padding: 8px 20px; cursor: pointer; border-radius: 3px; font-size: 13px; }',
            'button:hover { background: var(--btn-hover); }',
            '.btn-primary { }',
            '.btn-generate { background: #2ea043; color: white; }',
            '.btn-generate:hover { background: #3fb950; }',
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
            'pre { background: var(--input-bg); padding: 10px; border-radius: 3px; font-size: 11px; overflow-x: auto; white-space: pre-wrap; }',
            'code { background: var(--input-bg); padding: 1px 4px; border-radius: 2px; }',
            '.hidden { display: none !important; }',
            '#result-message { margin-bottom: 16px; font-size: 14px; color: #3fb950; }',
            '#post-gen-steps h4 { margin: 0 0 4px 0; }',
            '.step-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }',
            '.step-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 4px; }',
            '.step-row-all { margin-top: 8px; border-color: var(--btn-bg); }',
            '.btn-step { min-width: 190px; text-align: left; padding: 6px 12px; font-size: 12px; white-space: nowrap; }',
            '.btn-run-all { background: #2ea043; color: white; min-width: 190px; }',
            '.btn-run-all:hover { background: #3fb950; }',
            '.step-desc { font-size: 11px; opacity: 0.7; flex: 1; }',
            '.step-status { font-size: 11px; min-width: 80px; text-align: right; }',
            '.step-status.pending { color: var(--fg); opacity: 0.5; }',
            '.step-status.running { color: #d29922; }',
            '.step-status.done { color: #3fb950; }',
            '.step-status.error { color: #f85149; }',
            '.btn-step:disabled { opacity: 0.5; cursor: not-allowed; }',
        ];
        return lines.join('\n');
    }

    private _getScript(): string {
        const lines = [
            'const vscode = acquireVsCodeApi();',
            '',
            '// Stored generation data for post-gen steps',
            'var genData = null;',
            '',
            'function getConfig() {',
            '  return {',
            '    armorName: document.getElementById("armorName").value,',
            '    displayName: document.getElementById("displayName").value,',
            '    folderName: document.getElementById("folderName").value,',
            '    sourceArmorName: document.getElementById("sourceArmorName").value,',
            '    sourceFolderName: document.getElementById("sourceFolderName").value,',
            '    rating: document.getElementById("rating").value,',
            '    maxCondition: document.getElementById("maxCondition").value,',
            '    kinetic: document.getElementById("kinetic").value,',
            '    energy: document.getElementById("energy").value,',
            '    electricity: document.getElementById("electricity").value,',
            '    stun: document.getElementById("stun").value,',
            '    blast: document.getElementById("blast").value,',
            '    heat: document.getElementById("heat").value,',
            '    cold: document.getElementById("cold").value,',
            '    acid: document.getElementById("acid").value,',
            '    lightSaber: document.getElementById("lightSaber").value,',
            '    vulnerability: document.getElementById("vulnerability").value,',
            '    specialResist: document.getElementById("specialResist").value,',
            '    healthEncumbrance: document.getElementById("healthEncumbrance").value,',
            '    actionEncumbrance: document.getElementById("actionEncumbrance").value,',
            '    mindEncumbrance: document.getElementById("mindEncumbrance").value,',
            '    xp: document.getElementById("xp").value,',
            '    requiredSkill: document.getElementById("requiredSkill").value,',
            '    customizationVariable: document.getElementById("customizationVariable").value,',
            '  };',
            '}',
            '',
            'function setStatus(step, cls, text) {',
            '  var el = document.getElementById("status-" + step);',
            '  if (!el) return;',
            '  el.className = "step-status " + cls;',
            '  el.textContent = text;',
            '}',
            '',
            'function runStep(step) {',
            '  if (!genData) { alert("Generate files first before running post-gen steps."); return; }',
            '  var cfg = getConfig();',
            '  setStatus(step, "running", "Running...");',
            '  switch(step) {',
            '    case 1:',
            '      vscode.postMessage({ type: "step1_schematics", armorName: cfg.armorName, snippet: genData.schematicsSnippet });',
            '      break;',
            '    case 2:',
            '      vscode.postMessage({ type: "step2_cloneIFFs", sourceArmorName: cfg.sourceArmorName, sourceFolderName: cfg.sourceFolderName, targetArmorName: cfg.armorName, targetFolderName: cfg.folderName });',
            '      break;',
            '    case 3:',
            '      vscode.postMessage({ type: "step3_crc", crcPaths: genData.crcPaths });',
            '      break;',
            '    case 4:',
            '      vscode.postMessage({ type: "step4_appearance", sourceArmorName: cfg.sourceArmorName, targetArmorName: cfg.armorName });',
            '      break;',
            '    case 5:',
            '      vscode.postMessage({ type: "step5_acm", acmPaths: genData.acmPaths, sourceArmorName: cfg.sourceArmorName });',
            '      break;',
            '    case 6:',
            '      vscode.postMessage({ type: "step6_stf", armorName: cfg.armorName, displayName: cfg.displayName });',
            '      break;',
            '  }',
            '}',
            '',
            'async function runAllSteps() {',
            '  if (!genData) { alert("Generate files first before running post-gen steps."); return; }',
            '  setStatus("all", "running", "Running all...");',
            '  for (var i = 1; i <= 6; i++) {',
            '    runStep(i);',
            '    // Wait a bit for each step to complete before starting next',
            '    await new Promise(function(r) { setTimeout(r, 500); });',
            '  }',
            '}',
            '',
            'document.getElementById("btn-preview").addEventListener("click", function() {',
            '  vscode.postMessage({ type: "preview", config: getConfig() });',
            '});',
            '',
            'document.getElementById("btn-generate").addEventListener("click", function() {',
            '  if (confirm("This will create ~36 Lua files. Existing schematic/loot registry files will be APPENDED to. Continue?")) {',
            '    vscode.postMessage({ type: "generate", config: getConfig() });',
            '  }',
            '});',
            '',
            '// Step button listeners',
            'for (var s = 1; s <= 6; s++) {',
            '  (function(step) {',
            '    document.getElementById("btn-step" + step).addEventListener("click", function() { runStep(step); });',
            '  })(s);',
            '}',
            'document.getElementById("btn-run-all").addEventListener("click", function() { runAllSteps(); });',
            '',
            'function esc(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;"); }',
            '',
            'window.addEventListener("message", function(event) {',
            '  var msg = event.data;',
            '  if (msg.type === "previewResult") {',
            '    document.getElementById("preview-area").classList.remove("hidden");',
            '    document.getElementById("result-area").classList.add("hidden");',
            '',
            '    document.getElementById("preview-stats").innerHTML =',
            '      \'<span class="stat"><span class="stat-val">\' + msg.fileCount + \'</span> Lua files</span>\' +',
            '      \'<span class="stat"><span class="stat-val">\' + msg.crcCount + \'</span> CRC entries</span>\' +',
            '      \'<span class="stat"><span class="stat-val">\' + msg.acmCount + \'</span> ACM entries</span>\';',
            '',
            '    // Group files by type',
            '    var groups = { armor: [], schematic: [], loot: [], registry: [] };',
            '    msg.files.forEach(function(f) {',
            '      (groups[f.type] || groups.registry).push(f.path);',
            '    });',
            '',
            '    var html = "";',
            '    var labels = { armor: "Armor Pieces", schematic: "Draft Schematics", loot: "Loot Schematics", registry: "Registry Files" };',
            '    for (var type in groups) {',
            '      var files = groups[type];',
            '      if (!files.length) continue;',
            '      html += \'<div class="file-group"><div class="file-group-header">\' + labels[type] + " (" + files.length + ")</div>";',
            '      files.forEach(function(p) { html += \'<div class="file-entry">\' + esc(p) + "</div>"; });',
            '      html += "</div>";',
            '    }',
            '    document.getElementById("preview-files").innerHTML = html;',
            '',
            '    document.getElementById("registry-snippet").textContent = msg.schematicsSnippet;',
            '    document.getElementById("preview-registry").classList.remove("hidden");',
            '',
            '    document.getElementById("crc-paths").textContent = msg.crcPaths.join("\\n");',
            '    document.getElementById("preview-crc").classList.remove("hidden");',
            '',
            '    document.getElementById("acm-paths").textContent = msg.acmPaths.join("\\n");',
            '    document.getElementById("preview-acm").classList.remove("hidden");',
            '  }',
            '',
            '  if (msg.type === "generateComplete") {',
            '    document.getElementById("result-area").classList.remove("hidden");',
            '    document.getElementById("result-message").textContent = msg.written + " files created successfully!";',
            '',
            '    // Store data for post-gen steps',
            '    genData = {',
            '      schematicsSnippet: msg.schematicsSnippet,',
            '      crcPaths: msg.crcPaths,',
            '      acmPaths: msg.acmPaths,',
            '    };',
            '',
            '    document.getElementById("registry-snippet").textContent = msg.schematicsSnippet;',
            '    document.getElementById("preview-registry").classList.remove("hidden");',
            '',
            '    document.getElementById("crc-paths").textContent = msg.crcPaths.join("\\n");',
            '    document.getElementById("preview-crc").classList.remove("hidden");',
            '',
            '    document.getElementById("acm-paths").textContent = msg.acmPaths.join("\\n");',
            '    document.getElementById("preview-acm").classList.remove("hidden");',
            '',
            '    // Reset all step statuses',
            '    for (var i = 1; i <= 6; i++) { setStatus(i, "pending", "Ready"); }',
            '    setStatus("all", "", "");',
            '  }',
            '',
            '  if (msg.type === "stepResult") {',
            '    var step = msg.step;',
            '    if (msg.success) {',
            '      setStatus(step, "done", msg.message);',
            '    } else {',
            '      setStatus(step, "error", msg.message);',
            '    }',
            '    // Check if all steps are done for "Run All" status',
            '    var allDone = true;',
            '    for (var i = 1; i <= 6; i++) {',
            '      var el = document.getElementById("status-" + i);',
            '      if (!el || (!el.classList.contains("done") && !el.classList.contains("error"))) { allDone = false; break; }',
            '    }',
            '    if (allDone) { setStatus("all", "done", "All steps complete!"); }',
            '  }',
            '});',
        ];
        return lines.join('\n');
    }
}
