/**
 * Clothing Maker Webview Panel
 * Multi-step wizard for creating wearable clothing items
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CLOTHING_TYPES, CRAFTING_SKILLS } from './clothingTypes';
import { generateClothing, type ClothingConfig } from './clothingGenerator';

export class ClothingPanel {
    public static currentPanel: ClothingPanel | undefined;
    public static readonly viewType = 'clothingMaker';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri): ClothingPanel {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (ClothingPanel.currentPanel) {
            ClothingPanel.currentPanel._panel.reveal(column);
            return ClothingPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            ClothingPanel.viewType, 'Clothing Maker',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        ClothingPanel.currentPanel = new ClothingPanel(panel, extensionUri);
        return ClothingPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtml();
        this._panel.webview.onDidReceiveMessage(m => this._handleMessage(m), null, this._disposables);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose(): void {
        ClothingPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    private _handleMessage(msg: any): void {
        switch (msg.type) {
            case 'ready':
                this._sendInit();
                break;
            case 'generate':
                this._generate(msg.config);
                break;
        }
    }

    private _sendInit(): void {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            this._panel.webview.postMessage({ type: 'error', message: 'No workspace folder' });
            return;
        }

        const config = vscode.workspace.getConfiguration('swgForge');
        const treWorking = path.join(workspaceRoot, config.get<string>('tre.workingPath', 'tre/working'));

        // Scan appearances
        const appearances: string[] = [];
        const appearanceDir = path.join(treWorking, 'appearance');
        if (fs.existsSync(appearanceDir)) {
            const scan = (dir: string, prefix: string = '') => {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    const relPath = prefix ? prefix + '/' + entry.name : entry.name;
                    if (entry.isDirectory()) {
                        scan(fullPath, relPath);
                    } else if (entry.name.endsWith('.apt')) {
                        appearances.push('appearance/' + relPath);
                    }
                }
            };
            scan(appearanceDir);
        }

        // Clothing types
        const clothingTypes = Object.keys(CLOTHING_TYPES);

        // Crafting skills
        const skills = [...CRAFTING_SKILLS];

        this._panel.webview.postMessage({
            type: 'init',
            appearances,
            clothingTypes,
            skills,
        });
    }

    private _generate(config: any): void {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) { return; }

        const vsconfig = vscode.workspace.getConfiguration('swgForge');
        const treWorking = path.join(workspaceRoot, vsconfig.get<string>('tre.workingPath', 'tre/working'));
        const treInfinity = path.join(workspaceRoot, vsconfig.get<string>('tre.referencePath', 'tre/infinity'));
        const scriptsPath = path.join(workspaceRoot, vsconfig.get<string>('serverScriptsPath', 'infinity_wicked/MMOCoreORB/bin/scripts'));
        const customScriptsPath = path.join(scriptsPath, vsconfig.get<string>('customScriptsFolder', 'custom_scripts'));

        // Find reference IFF
        const clothingType = CLOTHING_TYPES[config.clothingType];
        const refDir = path.join(treWorking, clothingType.folder);
        let referenceIff = '';
        if (fs.existsSync(refDir)) {
            const files = fs.readdirSync(refDir).filter(f => f.startsWith('shared_') && f.endsWith('.iff'));
            if (files.length > 0) {
                referenceIff = path.join(refDir, files[0]);
            }
        }
        if (!referenceIff) {
            this._panel.webview.postMessage({
                type: 'generated',
                success: false,
                errors: ['No reference IFF found in ' + clothingType.folder],
                created: [],
                modified: [],
            });
            return;
        }

        const clothingConfig: ClothingConfig = {
            appearancePath: config.appearancePath,
            clothingType,
            objectName: config.objectName,
            displayName: config.displayName,
            description: config.description,
            stats: {
                sockets: config.sockets || 0,
                hitpoints: config.hitpoints || 1000,
            },
            isCrafted: config.isCrafted,
            skill: config.skill,
            complexity: config.complexity || 1,
            xp: config.xp || 90,
            lootSchematicUses: config.lootSchematicUses || 1,
            colorSlots: config.colorSlots || 1,
            selectedPalettes: config.selectedPalettes || [],
            referenceIffPath: referenceIff,
            treWorking,
            treInfinity,
            scriptsPath,
            customScriptsPath,
        };

        const result = generateClothing(clothingConfig);

        this._panel.webview.postMessage({
            type: 'generated',
            success: result.errors.length === 0,
            created: result.created,
            modified: result.modified,
            errors: result.errors,
        });

        if (result.errors.length === 0) {
            vscode.window.showInformationMessage('Clothing created: ' + config.objectName);
        } else {
            vscode.window.showWarningMessage('Clothing created with ' + result.errors.length + ' warning(s)');
        }
    }

    // ── HTML ─────────────────────────────────────────────────────────

    private _getHtml(): string {
        const h: string[] = [];
        h.push('<!DOCTYPE html>');
        h.push('<html lang="en">');
        h.push('<head>');
        h.push('<meta charset="UTF-8">');
        h.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
        h.push('<style>');
        this._pushCss(h);
        h.push('</style>');
        h.push('</head>');
        h.push('<body>');
        this._pushBody(h);
        h.push('<script>');
        this._pushScript(h);
        h.push('<\/script>');
        h.push('</body>');
        h.push('</html>');
        return h.join('\n');
    }

    private _pushCss(h: string[]): void {
        h.push('body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; margin: 0; }');
        h.push('h2 { margin: 0 0 16px; font-size: 1.3em; }');
        h.push('h3 { margin: 16px 0 8px; font-size: 1.05em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }');
        h.push('.step { display: none; }');
        h.push('.step.active { display: block; }');
        h.push('.form-group { margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }');
        h.push('.form-group label { min-width: 140px; text-align: right; color: var(--vscode-descriptionForeground); }');
        h.push('.form-group input, .form-group select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; font-family: inherit; font-size: inherit; }');
        h.push('.form-group input[type="text"] { width: 300px; }');
        h.push('.form-group input[type="number"] { width: 100px; }');
        h.push('.form-group select { min-width: 200px; }');
        h.push('.form-group textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; width: 300px; height: 40px; }');
        h.push('.radio-group { display: flex; gap: 16px; }');
        h.push('.radio-group label { min-width: auto; display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--vscode-foreground); }');
        h.push('.list-box { max-height: 300px; overflow-y: auto; border: 1px solid var(--vscode-widget-border); padding: 8px; margin: 0 0 8px 0; }');
        h.push('.list-item { padding: 4px 8px; cursor: pointer; margin: 2px 0; }');
        h.push('.list-item:hover { background: var(--vscode-list-hoverBackground); }');
        h.push('.list-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }');
        h.push('button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; font-family: inherit; font-size: inherit; margin: 4px; }');
        h.push('button:hover { background: var(--vscode-button-hoverBackground); }');
        h.push('button:disabled { opacity: 0.5; cursor: default; }');
        h.push('button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }');
        h.push('button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }');
        h.push('.button-bar { margin-top: 20px; }');
        h.push('.info { padding: 6px 10px; margin: 8px 0; border-radius: 4px; font-size: 0.9em; }');
        h.push('.info.ok { background: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); }');
        h.push('.loading { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }');
        h.push('.file-list { list-style: none; padding: 0; margin: 4px 0; }');
        h.push('.file-list li { padding: 3px 8px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }');
        h.push('.result-ok { color: var(--vscode-gitDecoration-addedResourceForeground); }');
        h.push('.result-error { color: var(--vscode-errorForeground); }');
    }

    private _pushBody(h: string[]): void {
        h.push('<div id="view-loading" class="loading step active">Loading Clothing Maker...</div>');

        h.push('<div id="step-main" class="step">');
        h.push('  <h2>Clothing Maker</h2>');
        h.push('  <p style="color:var(--vscode-descriptionForeground);">Create wearable clothing with ACM customization and optional crafting schematics</p>');

        h.push('  <h3>1. Appearance</h3>');
        h.push('  <div class="form-group"><label>APT File:</label><select id="appearance"><option value="">-- Select --</option></select></div>');

        h.push('  <h3>2. Clothing Type</h3>');
        h.push('  <div class="form-group"><label>Type:</label><select id="clothing-type"><option value="">-- Select --</option></select></div>');

        h.push('  <h3>3. Mode</h3>');
        h.push('  <div class="form-group"><label>Mode:</label><div class="radio-group">');
        h.push('    <label><input type="radio" name="mode" value="looted" checked> Looted (no crafting)</label>');
        h.push('    <label><input type="radio" name="mode" value="crafted"> Crafted (with schematics)</label>');
        h.push('  </div></div>');

        h.push('  <div id="crafting-section" style="display:none;">');
        h.push('    <h3>Crafting Details</h3>');
        h.push('    <div class="form-group"><label>Skill Required:</label><select id="skill"></select></div>');
        h.push('    <div class="form-group"><label>Complexity:</label><input type="number" id="complexity" value="1" min="1" max="100"></div>');
        h.push('    <div class="form-group"><label>XP Reward:</label><input type="number" id="xp" value="90" min="0"></div>');
        h.push('    <div class="form-group"><label>Schematic Uses:</label><input type="number" id="uses" value="1" min="1"></div>');
        h.push('  </div>');

        h.push('  <h3>4. Object Details</h3>');
        h.push('  <div class="form-group"><label>Object Name:</label><input type="text" id="obj-name" placeholder="my_boots"></div>');
        h.push('  <div class="form-group"><label>Display Name:</label><input type="text" id="display-name" placeholder="Fancy Boots"></div>');
        h.push('  <div class="form-group"><label>Description:</label><textarea id="obj-desc" placeholder="A stylish pair of boots"></textarea></div>');

        h.push('  <h3>5. Stats</h3>');
        h.push('  <div class="form-group"><label>Sockets:</label><input type="number" id="sockets" value="0" min="0" max="4"></div>');
        h.push('  <div class="form-group"><label>Hitpoints:</label><input type="number" id="hitpoints" value="1000" min="100" step="100"></div>');

        h.push('  <h3>6. Customization</h3>');
        h.push('  <div class="form-group"><label>Color Slots:</label><select id="color-slots"><option value="1">1 (single palette)</option><option value="2">2 (dual palette)</option></select></div>');
        h.push('  <div class="info ok">ACM palette selection coming soon - palettes will be added automatically</div>');

        h.push('  <div class="button-bar">');
        h.push('    <button id="btn-generate" onclick="doGenerate()">Generate</button>');
        h.push('  </div>');
        h.push('</div>');

        h.push('<div id="step-results" class="step">');
        h.push('  <h2>Results</h2>');
        h.push('  <div id="results-content"></div>');
        h.push('  <div class="button-bar">');
        h.push('    <button onclick="resetWizard()">Create Another</button>');
        h.push('    <button class="secondary" onclick="window.close()">Close</button>');
        h.push('  </div>');
        h.push('</div>');
    }

    private _pushScript(h: string[]): void {
        h.push('var vscode = acquireVsCodeApi();');
        h.push('var state = { appearances: [], clothingTypes: [], skills: [] };');
        h.push('');

        h.push('document.querySelectorAll("input[name=mode]").forEach(function(r) {');
        h.push('  r.addEventListener("change", function() {');
        h.push('    var isCrafted = r.value === "crafted";');
        h.push('    document.getElementById("crafting-section").style.display = isCrafted ? "block" : "none";');
        h.push('  });');
        h.push('});');
        h.push('');

        h.push('function doGenerate() {');
        h.push('  var config = {');
        h.push('    appearancePath: document.getElementById("appearance").value,');
        h.push('    clothingType: document.getElementById("clothing-type").value,');
        h.push('    objectName: document.getElementById("obj-name").value.trim(),');
        h.push('    displayName: document.getElementById("display-name").value.trim(),');
        h.push('    description: document.getElementById("obj-desc").value.trim(),');
        h.push('    sockets: parseInt(document.getElementById("sockets").value) || 0,');
        h.push('    hitpoints: parseInt(document.getElementById("hitpoints").value) || 1000,');
        h.push('    isCrafted: document.querySelector("input[name=mode]:checked").value === "crafted",');
        h.push('    skill: document.getElementById("skill").value,');
        h.push('    complexity: parseInt(document.getElementById("complexity").value) || 1,');
        h.push('    xp: parseInt(document.getElementById("xp").value) || 90,');
        h.push('    lootSchematicUses: parseInt(document.getElementById("uses").value) || 1,');
        h.push('    colorSlots: parseInt(document.getElementById("color-slots").value) || 1,');
        h.push('    selectedPalettes: []');
        h.push('  };');
        h.push('  if (!config.appearancePath || !config.clothingType || !config.objectName || !config.displayName) {');
        h.push('    alert("Please fill in all required fields");');
        h.push('    return;');
        h.push('  }');
        h.push('  document.getElementById("btn-generate").disabled = true;');
        h.push('  document.getElementById("btn-generate").textContent = "Generating...";');
        h.push('  vscode.postMessage({ type: "generate", config: config });');
        h.push('}');
        h.push('');

        h.push('function showResults(data) {');
        h.push('  var html = "";');
        h.push('  if (data.created.length > 0) {');
        h.push('    html += "<h3>Created</h3><ul class=\\"file-list\\">";');
        h.push('    data.created.forEach(function(f) { html += "<li class=\\"result-ok\\">+ " + f + "<\\/li>"; });');
        h.push('    html += "<\\/ul>";');
        h.push('  }');
        h.push('  if (data.modified.length > 0) {');
        h.push('    html += "<h3>Modified</h3><ul class=\\"file-list\\">";');
        h.push('    data.modified.forEach(function(f) { html += "<li class=\\"result-ok\\">M " + f + "<\\/li>"; });');
        h.push('    html += "<\\/ul>";');
        h.push('  }');
        h.push('  if (data.errors.length > 0) {');
        h.push('    html += "<h3>Warnings</h3><ul class=\\"file-list\\">";');
        h.push('    data.errors.forEach(function(e) { html += "<li class=\\"result-error\\">! " + e + "<\\/li>"; });');
        h.push('    html += "<\\/ul>";');
        h.push('  }');
        h.push('  html += "<div style=\\"margin-top:16px; font-weight:bold;\\">" + (data.success ? "Clothing created successfully!" : "Completed with warnings") + "<\\/div>";');
        h.push('  document.getElementById("results-content").innerHTML = html;');
        h.push('  document.querySelectorAll(".step").forEach(function(el) { el.classList.remove("active"); });');
        h.push('  document.getElementById("step-results").classList.add("active");');
        h.push('}');
        h.push('');

        h.push('function resetWizard() {');
        h.push('  document.getElementById("appearance").value = "";');
        h.push('  document.getElementById("clothing-type").value = "";');
        h.push('  document.getElementById("obj-name").value = "";');
        h.push('  document.getElementById("display-name").value = "";');
        h.push('  document.getElementById("obj-desc").value = "";');
        h.push('  document.getElementById("sockets").value = "0";');
        h.push('  document.getElementById("hitpoints").value = "1000";');
        h.push('  document.querySelector("input[name=mode][value=looted]").checked = true;');
        h.push('  document.getElementById("crafting-section").style.display = "none";');
        h.push('  document.getElementById("btn-generate").disabled = false;');
        h.push('  document.getElementById("btn-generate").textContent = "Generate";');
        h.push('  document.querySelectorAll(".step").forEach(function(el) { el.classList.remove("active"); });');
        h.push('  document.getElementById("step-main").classList.add("active");');
        h.push('}');
        h.push('');

        h.push('window.addEventListener("message", function(event) {');
        h.push('  var msg = event.data;');
        h.push('  switch (msg.type) {');
        h.push('    case "init":');
        h.push('      state = msg;');
        h.push('      var appearanceSel = document.getElementById("appearance");');
        h.push('      msg.appearances.forEach(function(a) {');
        h.push('        var opt = document.createElement("option");');
        h.push('        opt.value = a; opt.textContent = a;');
        h.push('        appearanceSel.appendChild(opt);');
        h.push('      });');
        h.push('      var typeSel = document.getElementById("clothing-type");');
        h.push('      msg.clothingTypes.forEach(function(t) {');
        h.push('        var opt = document.createElement("option");');
        h.push('        opt.value = t; opt.textContent = t;');
        h.push('        typeSel.appendChild(opt);');
        h.push('      });');
        h.push('      var skillSel = document.getElementById("skill");');
        h.push('      msg.skills.forEach(function(s) {');
        h.push('        var opt = document.createElement("option");');
        h.push('        opt.value = s; opt.textContent = s;');
        h.push('        skillSel.appendChild(opt);');
        h.push('      });');
        h.push('      document.querySelectorAll(".step").forEach(function(el) { el.classList.remove("active"); });');
        h.push('      document.getElementById("step-main").classList.add("active");');
        h.push('      break;');
        h.push('    case "generated":');
        h.push('      showResults(msg);');
        h.push('      break;');
        h.push('    case "error":');
        h.push('      alert("Error: " + msg.message);');
        h.push('      break;');
        h.push('  }');
        h.push('});');
        h.push('');
        h.push('vscode.postMessage({ type: "ready" });');
    }
}
