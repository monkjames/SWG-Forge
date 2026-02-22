/**
 * Object Creator Webview Panel
 * Multi-step wizard: appearance → folder → details → preview → generate
 */

import * as vscode from 'vscode';
import * as path from 'path';
import {
    getResolvedPaths, scanAppearances, scanObjectFolders,
    findReferenceIFF, scanMenuComponents, checkNameCollision
} from './referenceResolver';
import {
    ObjectConfig, GenerationResult,
    generateObject, buildPreview, computeSTFName
} from './objectGenerator';

export class CreatorPanel {
    public static currentPanel: CreatorPanel | undefined;
    public static readonly viewType = 'objectCreator';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _webviewReady = false;

    public static createOrShow(extensionUri: vscode.Uri): CreatorPanel {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (CreatorPanel.currentPanel) {
            CreatorPanel.currentPanel._panel.reveal(column);
            return CreatorPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            CreatorPanel.viewType, 'Object Creator',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        CreatorPanel.currentPanel = new CreatorPanel(panel, extensionUri);
        return CreatorPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtml();
        this._panel.webview.onDidReceiveMessage(m => this._handleMessage(m), null, this._disposables);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose(): void {
        CreatorPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    private _handleMessage(msg: any): void {
        switch (msg.type) {
            case 'ready':
                this._webviewReady = true;
                this._sendInit();
                break;
            case 'findReference':
                this._findReference(msg.folder);
                break;
            case 'checkName':
                this._checkName(msg.folder, msg.name);
                break;
            case 'preview':
                this._sendPreview(msg.config);
                break;
            case 'generate':
                this._generate(msg.config);
                break;
        }
    }

    private _sendInit(): void {
        const paths = getResolvedPaths();
        if (!paths) {
            this._panel.webview.postMessage({ type: 'error', message: 'No workspace folder found' });
            return;
        }

        const appearances = scanAppearances(paths);
        const folders = scanObjectFolders(paths);
        const menuComponents = scanMenuComponents(paths);

        this._panel.webview.postMessage({
            type: 'init',
            appearances,
            folders,
            menuComponents,
        });
    }

    private _findReference(folder: string): void {
        const paths = getResolvedPaths();
        if (!paths) { return; }

        const ref = findReferenceIFF(paths, folder);
        this._panel.webview.postMessage({
            type: 'referenceFound',
            folder,
            reference: ref ? { path: ref.absolutePath, filename: ref.filename } : null,
        });
    }

    private _checkName(folder: string, name: string): void {
        const paths = getResolvedPaths();
        if (!paths) { return; }

        const collisions = checkNameCollision(paths, folder, name);
        this._panel.webview.postMessage({
            type: 'nameCheck',
            collisions,
        });
    }

    private _sendPreview(config: any): void {
        const paths = getResolvedPaths();
        if (!paths) { return; }

        const objConfig: ObjectConfig = {
            appearancePath: config.appearancePath,
            targetFolder: config.targetFolder,
            objectName: config.objectName,
            displayName: config.displayName,
            description: config.description,
            referenceIffPath: config.referenceIffPath,
            menuComponent: config.menuComponent || '',
            createMenuStub: config.createMenuStub || false,
        };

        const preview = buildPreview(paths, objConfig);
        const stfName = computeSTFName(config.targetFolder);

        this._panel.webview.postMessage({
            type: 'preview',
            create: preview.create,
            modify: preview.modify,
            stfName,
        });
    }

    private _generate(config: any): void {
        const paths = getResolvedPaths();
        if (!paths) { return; }

        const objConfig: ObjectConfig = {
            appearancePath: config.appearancePath,
            targetFolder: config.targetFolder,
            objectName: config.objectName,
            displayName: config.displayName,
            description: config.description,
            referenceIffPath: config.referenceIffPath,
            menuComponent: config.menuComponent || '',
            createMenuStub: config.createMenuStub || false,
        };

        const result: GenerationResult = generateObject(paths, objConfig);

        this._panel.webview.postMessage({
            type: 'generated',
            created: result.created,
            modified: result.modified,
            errors: result.errors,
            success: result.errors.length === 0,
        });

        if (result.errors.length === 0) {
            vscode.window.showInformationMessage('Object created: ' + config.objectName);
        } else {
            vscode.window.showWarningMessage('Object created with ' + result.errors.length + ' error(s)');
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
        h.push('.step-indicator { display: flex; gap: 4px; margin-bottom: 16px; }');
        h.push('.step-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-widget-border); }');
        h.push('.step-dot.active { background: var(--vscode-focusBorder); }');
        h.push('.step-dot.done { background: var(--vscode-gitDecoration-addedResourceForeground); }');
        h.push('.form-group { margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }');
        h.push('.form-group label { min-width: 120px; text-align: right; color: var(--vscode-descriptionForeground); }');
        h.push('.form-group input, .form-group select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; font-family: inherit; font-size: inherit; }');
        h.push('.form-group input[type="text"] { width: 300px; }');
        h.push('.form-group select { min-width: 300px; max-width: 500px; }');
        h.push('.form-group textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; font-family: inherit; font-size: inherit; width: 300px; height: 40px; resize: vertical; }');
        h.push('.search-box { margin-bottom: 8px; }');
        h.push('.search-box input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; font-family: inherit; width: 400px; }');
        h.push('.apt-list { max-height: 300px; overflow-y: auto; border: 1px solid var(--vscode-widget-border); padding: 0; margin: 0 0 8px 0; list-style: none; }');
        h.push('.apt-list li { padding: 4px 8px; cursor: pointer; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }');
        h.push('.apt-list li:hover { background: var(--vscode-list-hoverBackground); }');
        h.push('.apt-list li.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }');
        h.push('.info { padding: 6px 10px; margin: 8px 0; border-radius: 4px; font-size: 0.9em; }');
        h.push('.info.ok { background: var(--vscode-inputValidation-infoBackground); border: 1px solid var(--vscode-inputValidation-infoBorder); }');
        h.push('.info.warn { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }');
        h.push('.info.err { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }');
        h.push('.selected-value { font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); margin: 4px 0 8px 0; }');
        h.push('button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; font-family: inherit; font-size: inherit; margin: 4px; }');
        h.push('button:hover { background: var(--vscode-button-hoverBackground); }');
        h.push('button:disabled { opacity: 0.5; cursor: default; }');
        h.push('button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }');
        h.push('button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }');
        h.push('.button-bar { margin-top: 20px; }');
        h.push('.file-list { list-style: none; padding: 0; margin: 4px 0; }');
        h.push('.file-list li { padding: 3px 8px; font-family: var(--vscode-editor-font-family); font-size: 0.9em; display: flex; gap: 8px; align-items: baseline; }');
        h.push('.file-icon { width: 14px; text-align: center; font-weight: bold; }');
        h.push('.file-icon.create { color: var(--vscode-gitDecoration-addedResourceForeground); }');
        h.push('.file-icon.modify { color: var(--vscode-gitDecoration-modifiedResourceForeground); }');
        h.push('.result-item { padding: 3px 0; }');
        h.push('.result-ok { color: var(--vscode-gitDecoration-addedResourceForeground); }');
        h.push('.result-error { color: var(--vscode-errorForeground); }');
        h.push('.loading { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }');
        h.push('.checkbox-row { display: flex; align-items: center; gap: 6px; margin: 8px 0; }');
        h.push('.checkbox-row label { min-width: auto; color: var(--vscode-foreground); }');
        h.push('.menu-section { margin-left: 28px; margin-top: 6px; }');
        h.push('.folder-tree { max-height: 600px; overflow-y: auto; border: 1px solid var(--vscode-widget-border); padding: 8px; margin: 0 0 8px 0; font-family: var(--vscode-editor-font-family); font-size: 0.9em; }');
        h.push('.tree-node { display: flex; align-items: center; padding: 2px 0; }');
        h.push('.tree-icon { width: 16px; text-align: center; cursor: pointer; user-select: none; color: var(--vscode-descriptionForeground); }');
        h.push('.tree-label { flex: 1; padding: 2px 4px; cursor: pointer; }');
        h.push('.tree-label:hover { background: var(--vscode-list-hoverBackground); }');
        h.push('.tree-label.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }');
        h.push('.tree-children { margin-left: 16px; display: none; }');
        h.push('.tree-children.expanded { display: block; }');
    }

    private _pushBody(h: string[]): void {
        // Loading
        h.push('<div id="view-loading" class="loading step active">Loading Object Creator...</div>');

        // Error
        h.push('<div id="view-error" class="step">');
        h.push('  <h2 style="color:var(--vscode-errorForeground);">Error</h2>');
        h.push('  <p id="error-message"></p>');
        h.push('</div>');

        // Step indicator
        h.push('<div id="step-indicator" class="step-indicator" style="display:none;">');
        h.push('  <div class="step-dot" id="dot-1"></div>');
        h.push('  <div class="step-dot" id="dot-2"></div>');
        h.push('  <div class="step-dot" id="dot-3"></div>');
        h.push('  <div class="step-dot" id="dot-4"></div>');
        h.push('  <div class="step-dot" id="dot-5"></div>');
        h.push('</div>');

        // ── Step 1: Appearance ──
        h.push('<div id="step-1" class="step">');
        h.push('  <h2>Step 1: Select Appearance</h2>');
        h.push('  <p style="color:var(--vscode-descriptionForeground);">Select an .apt file from tre/working/appearance/</p>');
        h.push('  <div class="search-box"><input type="text" id="apt-search" placeholder="Filter appearances..." oninput="filterApt()"></div>');
        h.push('  <ul id="apt-list" class="apt-list"></ul>');
        h.push('  <div id="apt-count" style="font-size:0.85em; color:var(--vscode-descriptionForeground); margin-bottom:8px;"></div>');
        h.push('  <div id="apt-none" class="info warn" style="display:none;">No .apt files found in tre/working/appearance/. Place your appearance files there first.</div>');
        h.push('  <div class="button-bar">');
        h.push('    <button id="btn-step1-next" onclick="goStep(2)" disabled>Next</button>');
        h.push('  </div>');
        h.push('</div>');

        // ── Step 2: Target Folder ──
        h.push('<div id="step-2" class="step">');
        h.push('  <h2>Step 2: Target Folder</h2>');
        h.push('  <p style="color:var(--vscode-descriptionForeground);">Expand the tree and select a folder (e.g. object/tangible/item/quest)</p>');
        h.push('  <div class="form-group"><label>Selected:</label><input type="text" id="folder-input" placeholder="Click a folder in the tree..." readonly></div>');
        h.push('  <div id="folder-tree" class="folder-tree"></div>');
        h.push('  <div id="folder-ref" class="info ok" style="display:none;"></div>');
        h.push('  <div id="folder-err" class="info err" style="display:none;">No reference shared_*.iff found in this folder. Choose a folder that has existing objects.</div>');
        h.push('  <div class="button-bar">');
        h.push('    <button class="secondary" onclick="goStep(1)">Back</button>');
        h.push('    <button id="btn-step2-next" onclick="goStep(3)" disabled>Next</button>');
        h.push('  </div>');
        h.push('</div>');

        // ── Step 3: Object Details ──
        h.push('<div id="step-3" class="step">');
        h.push('  <h2>Step 3: Object Details</h2>');
        h.push('  <div class="selected-value" id="summary-so-far"></div>');
        h.push('  <div class="form-group"><label>Object Name:</label><input type="text" id="obj-name" placeholder="my_sword" oninput="onNameChange()"></div>');
        h.push('  <div id="name-collision" class="info warn" style="display:none;"></div>');
        h.push('  <div class="form-group"><label>Display Name:</label><input type="text" id="display-name" placeholder="Ancient Blade"></div>');
        h.push('  <div class="form-group"><label>Description:</label><textarea id="obj-desc" placeholder="A blade from another era"></textarea></div>');
        h.push('  <h3>Menu Component</h3>');
        h.push('  <div class="checkbox-row">');
        h.push('    <input type="checkbox" id="menu-check" onchange="toggleMenu()">');
        h.push('    <label for="menu-check">Add object menu component</label>');
        h.push('  </div>');
        h.push('  <div id="menu-section" class="menu-section" style="display:none;">');
        h.push('    <div class="form-group"><label>Component:</label><select id="menu-select" onchange="onMenuSelect()"><option value="">-- Select --</option></select></div>');
        h.push('    <div id="menu-new-row" class="form-group" style="display:none;"><label>New Name:</label><input type="text" id="menu-new-name" placeholder="myMenuComponent"></div>');
        h.push('  </div>');
        h.push('  <div class="button-bar">');
        h.push('    <button class="secondary" onclick="goStep(2)">Back</button>');
        h.push('    <button id="btn-step3-next" onclick="doPreview()">Preview</button>');
        h.push('  </div>');
        h.push('</div>');

        // ── Step 4: Preview ──
        h.push('<div id="step-4" class="step">');
        h.push('  <h2>Step 4: Preview</h2>');
        h.push('  <div id="preview-summary" class="selected-value"></div>');
        h.push('  <h3>Files to Create</h3>');
        h.push('  <ul id="preview-create" class="file-list"></ul>');
        h.push('  <h3>Files to Modify</h3>');
        h.push('  <ul id="preview-modify" class="file-list"></ul>');
        h.push('  <div class="button-bar">');
        h.push('    <button class="secondary" onclick="goStep(3)">Back</button>');
        h.push('    <button id="btn-generate" onclick="doGenerate()">Generate</button>');
        h.push('  </div>');
        h.push('</div>');

        // ── Step 5: Results ──
        h.push('<div id="step-5" class="step">');
        h.push('  <h2>Step 5: Results</h2>');
        h.push('  <div id="results-content"></div>');
        h.push('  <div class="button-bar">');
        h.push('    <button onclick="resetWizard()">Create Another</button>');
        h.push('    <button class="secondary" onclick="window.close()">Close</button>');
        h.push('  </div>');
        h.push('</div>');
    }

    private _pushScript(h: string[]): void {
        h.push('var vscode = acquireVsCodeApi();');
        h.push('var state = { appearances: [], folders: [], menuComponents: [], selectedApt: "", selectedFolder: "", referenceIff: null };');
        h.push('var currentStep = 0;');
        h.push('');

        // ── Step navigation ──
        h.push('function goStep(n) {');
        h.push('  document.querySelectorAll(".step").forEach(function(el) { el.classList.remove("active"); });');
        h.push('  document.getElementById("step-" + n).classList.add("active");');
        h.push('  document.getElementById("step-indicator").style.display = "flex";');
        h.push('  for (var i = 1; i <= 5; i++) {');
        h.push('    var dot = document.getElementById("dot-" + i);');
        h.push('    dot.className = "step-dot" + (i === n ? " active" : i < n ? " done" : "");');
        h.push('  }');
        h.push('  currentStep = n;');
        h.push('  if (n === 3) { updateSummary(); }');
        h.push('}');
        h.push('');

        // ── Step 1: Appearance selection ──
        h.push('function populateAppearances(list) {');
        h.push('  state.appearances = list;');
        h.push('  if (list.length === 0) {');
        h.push('    document.getElementById("apt-none").style.display = "block";');
        h.push('    return;');
        h.push('  }');
        h.push('  renderAptList(list);');
        h.push('}');
        h.push('');
        h.push('function renderAptList(items) {');
        h.push('  var ul = document.getElementById("apt-list");');
        h.push('  ul.innerHTML = "";');
        h.push('  items.forEach(function(apt) {');
        h.push('    var li = document.createElement("li");');
        h.push('    li.textContent = apt;');
        h.push('    if (apt === state.selectedApt) li.className = "selected";');
        h.push('    li.onclick = function() { selectApt(apt); };');
        h.push('    ul.appendChild(li);');
        h.push('  });');
        h.push('  document.getElementById("apt-count").textContent = items.length + " of " + state.appearances.length + " appearances";');
        h.push('}');
        h.push('');
        h.push('function selectApt(apt) {');
        h.push('  state.selectedApt = apt;');
        h.push('  renderAptList(getFilteredApts());');
        h.push('  document.getElementById("btn-step1-next").disabled = false;');
        h.push('}');
        h.push('');
        h.push('function filterApt() {');
        h.push('  renderAptList(getFilteredApts());');
        h.push('}');
        h.push('');
        h.push('function getFilteredApts() {');
        h.push('  var q = document.getElementById("apt-search").value.toLowerCase();');
        h.push('  if (!q) return state.appearances;');
        h.push('  return state.appearances.filter(function(a) { return a.toLowerCase().indexOf(q) >= 0; });');
        h.push('}');
        h.push('');

        // ── Step 2: Folder tree ──
        h.push('function populateFolders(list) {');
        h.push('  state.folders = list;');
        h.push('  buildFolderTree(list);');
        h.push('}');
        h.push('');
        h.push('function buildFolderTree(folders) {');
        h.push('  var tree = {};');
        h.push('  folders.forEach(function(path) {');
        h.push('    var parts = path.split("/");');
        h.push('    var node = tree;');
        h.push('    for (var i = 0; i < parts.length; i++) {');
        h.push('      if (!node[parts[i]]) { node[parts[i]] = {}; }');
        h.push('      node = node[parts[i]];');
        h.push('    }');
        h.push('  });');
        h.push('  var container = document.getElementById("folder-tree");');
        h.push('  container.innerHTML = "";');
        h.push('  renderTreeNode(container, tree, "");');
        h.push('}');
        h.push('');
        h.push('function renderTreeNode(parent, node, path) {');
        h.push('  var keys = Object.keys(node).sort();');
        h.push('  keys.forEach(function(key) {');
        h.push('    var fullPath = path ? path + "/" + key : key;');
        h.push('    var hasChildren = Object.keys(node[key]).length > 0;');
        h.push('    var nodeDiv = document.createElement("div");');
        h.push('    var nodeHeader = document.createElement("div");');
        h.push('    nodeHeader.className = "tree-node";');
        h.push('    var icon = document.createElement("span");');
        h.push('    icon.className = "tree-icon";');
        h.push('    var autoExpand = key === "object" || path === "";');
        h.push('    icon.textContent = hasChildren ? (autoExpand ? "▼" : "▶") : "  ";');
        h.push('    if (hasChildren) {');
        h.push('      icon.onclick = function(e) { toggleTreeNode(nodeDiv, icon); e.stopPropagation(); };');
        h.push('    }');
        h.push('    var label = document.createElement("span");');
        h.push('    label.className = "tree-label";');
        h.push('    label.textContent = key;');
        h.push('    label.onclick = function() { selectFolder(fullPath); };');
        h.push('    if (fullPath === state.selectedFolder) label.classList.add("selected");');
        h.push('    nodeHeader.appendChild(icon);');
        h.push('    nodeHeader.appendChild(label);');
        h.push('    nodeDiv.appendChild(nodeHeader);');
        h.push('    if (hasChildren) {');
        h.push('      var children = document.createElement("div");');
        h.push('      children.className = "tree-children" + (autoExpand ? " expanded" : "");');
        h.push('      renderTreeNode(children, node[key], fullPath);');
        h.push('      nodeDiv.appendChild(children);');
        h.push('    }');
        h.push('    parent.appendChild(nodeDiv);');
        h.push('  });');
        h.push('}');
        h.push('');
        h.push('function toggleTreeNode(nodeDiv, icon) {');
        h.push('  var children = nodeDiv.querySelector(".tree-children");');
        h.push('  if (!children) return;');
        h.push('  if (children.classList.contains("expanded")) {');
        h.push('    children.classList.remove("expanded");');
        h.push('    icon.textContent = "▶";');
        h.push('  } else {');
        h.push('    children.classList.add("expanded");');
        h.push('    icon.textContent = "▼";');
        h.push('  }');
        h.push('}');
        h.push('');
        h.push('function selectFolder(f) {');
        h.push('  state.selectedFolder = f;');
        h.push('  document.getElementById("folder-input").value = f;');
        h.push('  document.querySelectorAll(".tree-label").forEach(function(el) { el.classList.remove("selected"); });');
        h.push('  var labels = document.querySelectorAll(".tree-label");');
        h.push('  for (var i = 0; i < labels.length; i++) {');
        h.push('    if (labels[i].parentElement.querySelector(".tree-label").textContent === f.split("/").pop()) {');
        h.push('      var checkPath = "";');
        h.push('      var elem = labels[i].parentElement;');
        h.push('      while (elem && elem.id !== "folder-tree") {');
        h.push('        if (elem.querySelector(".tree-label")) {');
        h.push('          var txt = elem.querySelector(".tree-label").textContent;');
        h.push('          checkPath = txt + (checkPath ? "/" + checkPath : "");');
        h.push('        }');
        h.push('        elem = elem.parentElement;');
        h.push('      }');
        h.push('      if (checkPath === f) { labels[i].classList.add("selected"); break; }');
        h.push('    }');
        h.push('  }');
        h.push('  vscode.postMessage({ type: "findReference", folder: f });');
        h.push('}');
        h.push('');
        h.push('function onReferenceFound(data) {');
        h.push('  var refDiv = document.getElementById("folder-ref");');
        h.push('  var errDiv = document.getElementById("folder-err");');
        h.push('  var btn = document.getElementById("btn-step2-next");');
        h.push('  if (data.reference) {');
        h.push('    state.referenceIff = data.reference;');
        h.push('    refDiv.textContent = "Reference: " + data.reference.filename;');
        h.push('    refDiv.style.display = "block";');
        h.push('    errDiv.style.display = "none";');
        h.push('    btn.disabled = false;');
        h.push('  } else {');
        h.push('    state.referenceIff = null;');
        h.push('    refDiv.style.display = "none";');
        h.push('    errDiv.style.display = "block";');
        h.push('    btn.disabled = true;');
        h.push('  }');
        h.push('}');
        h.push('');

        // ── Step 3: Object details ──
        h.push('function updateSummary() {');
        h.push('  var el = document.getElementById("summary-so-far");');
        h.push('  el.textContent = state.selectedApt + " -> " + state.selectedFolder;');
        h.push('}');
        h.push('');
        h.push('var nameTimer = null;');
        h.push('function onNameChange() {');
        h.push('  clearTimeout(nameTimer);');
        h.push('  nameTimer = setTimeout(function() {');
        h.push('    var name = document.getElementById("obj-name").value.trim();');
        h.push('    if (name && state.selectedFolder) {');
        h.push('      vscode.postMessage({ type: "checkName", folder: state.selectedFolder, name: name });');
        h.push('    } else {');
        h.push('      document.getElementById("name-collision").style.display = "none";');
        h.push('    }');
        h.push('  }, 300);');
        h.push('}');
        h.push('');
        h.push('function onNameCheck(collisions) {');
        h.push('  var div = document.getElementById("name-collision");');
        h.push('  if (collisions.length > 0) {');
        h.push('    div.textContent = collisions.join(" | ");');
        h.push('    div.style.display = "block";');
        h.push('  } else {');
        h.push('    div.style.display = "none";');
        h.push('  }');
        h.push('}');
        h.push('');

        // ── Menu component ──
        h.push('function toggleMenu() {');
        h.push('  var checked = document.getElementById("menu-check").checked;');
        h.push('  document.getElementById("menu-section").style.display = checked ? "block" : "none";');
        h.push('}');
        h.push('');
        h.push('function populateMenuSelect(components) {');
        h.push('  var sel = document.getElementById("menu-select");');
        h.push('  sel.innerHTML = "<option value=\\"\\">-- Select existing --<\\/option>";');
        h.push('  sel.innerHTML += "<option value=\\"__new__\\">[Create New]<\\/option>";');
        h.push('  components.forEach(function(c) {');
        h.push('    var opt = document.createElement("option");');
        h.push('    opt.value = c; opt.textContent = c;');
        h.push('    sel.appendChild(opt);');
        h.push('  });');
        h.push('}');
        h.push('');
        h.push('function onMenuSelect() {');
        h.push('  var val = document.getElementById("menu-select").value;');
        h.push('  var newRow = document.getElementById("menu-new-row");');
        h.push('  if (val === "__new__") {');
        h.push('    newRow.style.display = "flex";');
        h.push('    var name = document.getElementById("obj-name").value.trim();');
        h.push('    if (name) {');
        h.push('      var camel = name.replace(/_([a-z])/g, function(m, c) { return c.toUpperCase(); });');
        h.push('      document.getElementById("menu-new-name").value = camel + "MenuComponent";');
        h.push('    }');
        h.push('  } else {');
        h.push('    newRow.style.display = "none";');
        h.push('  }');
        h.push('}');
        h.push('');

        // ── Get config ──
        h.push('function getConfig() {');
        h.push('  var menuVal = document.getElementById("menu-select").value;');
        h.push('  var menuChecked = document.getElementById("menu-check").checked;');
        h.push('  var menuComponent = "";');
        h.push('  var createMenuStub = false;');
        h.push('  if (menuChecked && menuVal) {');
        h.push('    if (menuVal === "__new__") {');
        h.push('      menuComponent = document.getElementById("menu-new-name").value.trim();');
        h.push('      createMenuStub = true;');
        h.push('    } else {');
        h.push('      menuComponent = menuVal;');
        h.push('    }');
        h.push('  }');
        h.push('  return {');
        h.push('    appearancePath: state.selectedApt,');
        h.push('    targetFolder: state.selectedFolder,');
        h.push('    objectName: document.getElementById("obj-name").value.trim(),');
        h.push('    displayName: document.getElementById("display-name").value.trim(),');
        h.push('    description: document.getElementById("obj-desc").value.trim(),');
        h.push('    referenceIffPath: state.referenceIff ? state.referenceIff.path : "",');
        h.push('    menuComponent: menuComponent,');
        h.push('    createMenuStub: createMenuStub');
        h.push('  };');
        h.push('}');
        h.push('');

        // ── Preview ──
        h.push('function doPreview() {');
        h.push('  var cfg = getConfig();');
        h.push('  if (!cfg.objectName) { alert("Object name is required"); return; }');
        h.push('  if (!cfg.displayName) { alert("Display name is required"); return; }');
        h.push('  if (!cfg.description) { alert("Description is required"); return; }');
        h.push('  vscode.postMessage({ type: "preview", config: cfg });');
        h.push('}');
        h.push('');
        h.push('function showPreview(data) {');
        h.push('  var createList = document.getElementById("preview-create");');
        h.push('  var modifyList = document.getElementById("preview-modify");');
        h.push('  createList.innerHTML = "";');
        h.push('  modifyList.innerHTML = "";');
        h.push('  var cfg = getConfig();');
        h.push('  document.getElementById("preview-summary").textContent = cfg.appearancePath + " -> " + cfg.targetFolder + "/shared_" + cfg.objectName + ".iff";');
        h.push('  data.create.forEach(function(f) {');
        h.push('    var li = document.createElement("li");');
        h.push('    var icon = document.createElement("span"); icon.className = "file-icon create"; icon.textContent = "+"; li.appendChild(icon);');
        h.push('    var name = document.createElement("span"); name.textContent = f; li.appendChild(name);');
        h.push('    createList.appendChild(li);');
        h.push('  });');
        h.push('  data.modify.forEach(function(f) {');
        h.push('    var li = document.createElement("li");');
        h.push('    var icon = document.createElement("span"); icon.className = "file-icon modify"; icon.textContent = "M"; li.appendChild(icon);');
        h.push('    var name = document.createElement("span"); name.textContent = f; li.appendChild(name);');
        h.push('    modifyList.appendChild(li);');
        h.push('  });');
        h.push('  goStep(4);');
        h.push('}');
        h.push('');

        // ── Generate ──
        h.push('function doGenerate() {');
        h.push('  document.getElementById("btn-generate").disabled = true;');
        h.push('  document.getElementById("btn-generate").textContent = "Generating...";');
        h.push('  vscode.postMessage({ type: "generate", config: getConfig() });');
        h.push('}');
        h.push('');
        h.push('function showResults(data) {');
        h.push('  var content = document.getElementById("results-content");');
        h.push('  var html = "";');
        h.push('  if (data.created.length > 0) {');
        h.push('    html += "<h3>Created</h3>";');
        h.push('    data.created.forEach(function(f) { html += "<div class=\\"result-item result-ok\\">+ " + f + "<\\/div>"; });');
        h.push('  }');
        h.push('  if (data.modified.length > 0) {');
        h.push('    html += "<h3>Modified</h3>";');
        h.push('    data.modified.forEach(function(f) { html += "<div class=\\"result-item result-ok\\">M " + f + "<\\/div>"; });');
        h.push('  }');
        h.push('  if (data.errors.length > 0) {');
        h.push('    html += "<h3>Errors</h3>";');
        h.push('    data.errors.forEach(function(e) { html += "<div class=\\"result-item result-error\\">&#10008; " + e + "<\\/div>"; });');
        h.push('  }');
        h.push('  html += "<div style=\\"margin-top:16px; font-weight:bold;\\">" + (data.success ? "Object created successfully!" : "Completed with errors") + "<\\/div>";');
        h.push('  content.innerHTML = html;');
        h.push('  goStep(5);');
        h.push('}');
        h.push('');

        // ── Reset ──
        h.push('function resetWizard() {');
        h.push('  state.selectedApt = "";');
        h.push('  state.selectedFolder = "";');
        h.push('  state.referenceIff = null;');
        h.push('  document.getElementById("apt-search").value = "";');
        h.push('  document.getElementById("folder-input").value = "";');
        h.push('  document.getElementById("obj-name").value = "";');
        h.push('  document.getElementById("display-name").value = "";');
        h.push('  document.getElementById("obj-desc").value = "";');
        h.push('  document.getElementById("menu-check").checked = false;');
        h.push('  document.getElementById("menu-section").style.display = "none";');
        h.push('  document.getElementById("name-collision").style.display = "none";');
        h.push('  document.getElementById("folder-ref").style.display = "none";');
        h.push('  document.getElementById("folder-err").style.display = "none";');
        h.push('  document.getElementById("btn-step1-next").disabled = true;');
        h.push('  document.getElementById("btn-step2-next").disabled = true;');
        h.push('  document.getElementById("btn-generate").disabled = false;');
        h.push('  document.getElementById("btn-generate").textContent = "Generate";');
        h.push('  renderAptList(state.appearances);');
        h.push('  buildFolderTree(state.folders);');
        h.push('  goStep(1);');
        h.push('}');
        h.push('');

        // ── Message handler ──
        h.push('window.addEventListener("message", function(event) {');
        h.push('  var msg = event.data;');
        h.push('  switch (msg.type) {');
        h.push('    case "init":');
        h.push('      populateAppearances(msg.appearances);');
        h.push('      populateFolders(msg.folders);');
        h.push('      state.menuComponents = msg.menuComponents;');
        h.push('      populateMenuSelect(msg.menuComponents);');
        h.push('      goStep(1);');
        h.push('      break;');
        h.push('    case "referenceFound":');
        h.push('      onReferenceFound(msg);');
        h.push('      break;');
        h.push('    case "nameCheck":');
        h.push('      onNameCheck(msg.collisions);');
        h.push('      break;');
        h.push('    case "preview":');
        h.push('      showPreview(msg);');
        h.push('      break;');
        h.push('    case "generated":');
        h.push('      showResults(msg);');
        h.push('      break;');
        h.push('    case "error":');
        h.push('      document.getElementById("error-message").textContent = msg.message;');
        h.push('      document.querySelectorAll(".step").forEach(function(el) { el.classList.remove("active"); });');
        h.push('      document.getElementById("view-error").classList.add("active");');
        h.push('      break;');
        h.push('  }');
        h.push('});');
        h.push('');
        h.push('vscode.postMessage({ type: "ready" });');
    }
}
