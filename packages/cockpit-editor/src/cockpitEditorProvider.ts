import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseCPIT, serializeCPIT } from '@swgemu/core';
import type { CPITData } from '@swgemu/core';

class CockpitDocument implements vscode.CustomDocument {
    public data: CPITData;
    constructor(public readonly uri: vscode.Uri, data: CPITData) {
        this.data = data;
    }
    public dispose(): void {}
}

export class CockpitEditorProvider implements vscode.CustomEditorProvider<CockpitDocument> {
    public static readonly viewType = 'cockpitEditor.cpitFile';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<CockpitDocument>>();
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

    private async handleEditInWorking(document: CockpitDocument, panel: vscode.WebviewPanel): Promise<void> {
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
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(workingPath));
            return;
        }

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
        const provider = new CockpitEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(
            CockpitEditorProvider.viewType,
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
    ): Promise<CockpitDocument> {
        const buf = fs.readFileSync(uri.fsPath);
        const data = parseCPIT(new Uint8Array(buf));
        return new CockpitDocument(uri, data);
    }

    async resolveCustomEditor(
        document: CockpitDocument,
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
                    this.sendData(document, webviewPanel, readOnly);
                    break;
                case 'editInWorking':
                    await this.handleEditInWorking(document, webviewPanel);
                    break;
                case 'change':
                    if (readOnly) return;
                    this.applyChange(document, msg.data);
                    break;
            }
        });

        webviewPanel.webview.html = this.getHtml();
    }

    private sendData(document: CockpitDocument, panel: vscode.WebviewPanel, readOnly: boolean): void {
        const fname = path.basename(document.uri.fsPath);
        panel.webview.postMessage({
            type: 'data',
            data: document.data,
            fileName: fname,
            readOnly
        });
    }

    private applyChange(document: CockpitDocument, data: CPITData): void {
        document.data = data;
        this._onDidChangeCustomDocument.fire({ document });
    }

    async saveCustomDocument(document: CockpitDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        const buf = serializeCPIT(document.data);
        fs.writeFileSync(document.uri.fsPath, buf);
    }

    async saveCustomDocumentAs(document: CockpitDocument, destination: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
        const buf = serializeCPIT(document.data);
        fs.writeFileSync(destination.fsPath, buf);
    }

    async revertCustomDocument(document: CockpitDocument, _cancellation: vscode.CancellationToken): Promise<void> {
        const buf = fs.readFileSync(document.uri.fsPath);
        document.data = parseCPIT(new Uint8Array(buf));
        const panel = this.panels.get(document.uri.toString());
        if (panel) {
            const readOnly = !this.isEditable(document.uri);
            this.sendData(document, panel, readOnly);
        }
    }

    async backupCustomDocument(document: CockpitDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        const buf = serializeCPIT(document.data);
        const dest = context.destination;
        fs.writeFileSync(dest.fsPath, buf);
        return { id: dest.fsPath, delete: () => { try { fs.unlinkSync(dest.fsPath); } catch {} } };
    }

    private getHtml(): string {
        var L: string[] = [];
        L.push('<!DOCTYPE html>');
        L.push('<html lang="en"><head><meta charset="UTF-8">');
        L.push('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">');
        L.push('<style>');
        L.push('* { box-sizing: border-box; margin: 0; padding: 0; }');
        L.push('body { font-family: var(--vscode-font-family, "Segoe UI", sans-serif); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }');
        L.push('.header { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }');
        L.push('.header h2 { margin: 0; font-size: 16px; font-weight: 600; }');
        L.push('.badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 2px 8px; border-radius: 10px; font-size: 11px; }');
        L.push('.badge.ro { background: #c53535; color: #fff; }');
        L.push('.tbtn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: 12px; }');
        L.push('.tbtn:hover { background: var(--vscode-button-hoverBackground); }');
        L.push('.tbtn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }');
        L.push('.tbtn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }');
        L.push('.section { margin-bottom: 20px; border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px; padding: 12px 16px; }');
        L.push('.section h3 { font-size: 13px; font-weight: 600; margin-bottom: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; }');
        L.push('.field { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }');
        L.push('.field label { min-width: 120px; font-weight: 500; }');
        L.push('.field input[type="text"], .field input[type="number"] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #444); padding: 4px 8px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }');
        L.push('.field input[type="text"] { width: 360px; }');
        L.push('.field input[type="number"] { width: 100px; text-align: right; }');
        L.push('.field input:disabled { opacity: 0.5; }');
        L.push('.offset-row { display: flex; gap: 16px; align-items: center; margin-bottom: 8px; }');
        L.push('.offset-row label { min-width: 20px; font-weight: 600; text-align: right; }');
        L.push('.zoom-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }');
        L.push('.zoom-row label { min-width: 70px; font-weight: 500; color: var(--vscode-descriptionForeground); }');
        L.push('.zoom-row .tbtn { padding: 2px 8px; font-size: 11px; }');
        L.push('.zoom-actions { margin-top: 8px; display: flex; gap: 8px; }');
        L.push('.hyper-toggle { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }');
        L.push('.hyper-toggle input[type="checkbox"] { width: 16px; height: 16px; }');
        L.push('.toast { position: fixed; bottom: 16px; right: 16px; background: var(--vscode-notificationsBackground, #333); color: var(--vscode-notificationsForeground, #ccc); padding: 8px 16px; border-radius: 4px; font-size: 12px; opacity: 0; transition: opacity 0.3s; z-index: 100; }');
        L.push('.toast.show { opacity: 1; }');
        L.push('</style></head><body>');

        // Header
        L.push('<div class="header">');
        L.push('  <h2>SWG Cockpit Editor</h2>');
        L.push('  <span class="badge" id="badgeName">—</span>');
        L.push('  <span class="badge ro" id="badgeRO" style="display:none">READ-ONLY</span>');
        L.push('  <button class="tbtn secondary" id="btnEditWorking" style="display:none">Edit in Working</button>');
        L.push('</div>');

        // Frame section
        L.push('<div class="section">');
        L.push('  <h3>Frame Appearance</h3>');
        L.push('  <div class="field">');
        L.push('    <label>Path:</label>');
        L.push('    <input type="text" id="framePath" placeholder="appearance/ship_cockpit.apt">');
        L.push('  </div>');
        L.push('</div>');

        // Zoom section
        L.push('<div class="section">');
        L.push('  <h3>Zoom Levels</h3>');
        L.push('  <div id="zoomList"></div>');
        L.push('  <div class="zoom-actions">');
        L.push('    <button class="tbtn secondary" id="btnAddZoom">+ Add Level</button>');
        L.push('    <button class="tbtn secondary" id="btnRemoveZoom">- Remove Last</button>');
        L.push('  </div>');
        L.push('</div>');

        // First person zoom
        L.push('<div class="section">');
        L.push('  <h3>First Person Zoom (Default)</h3>');
        L.push('  <div class="field">');
        L.push('    <label>Zoom:</label>');
        L.push('    <input type="number" id="fpZoom" step="0.1">');
        L.push('  </div>');
        L.push('</div>');

        // Third person offset
        L.push('<div class="section">');
        L.push('  <h3>Third Person Camera Offset (3OFF)</h3>');
        L.push('  <div class="offset-row">');
        L.push('    <label>X:</label><input type="number" id="tp_x" step="0.1">');
        L.push('    <label>Y:</label><input type="number" id="tp_y" step="0.1">');
        L.push('    <label>Z:</label><input type="number" id="tp_z" step="0.1">');
        L.push('  </div>');
        L.push('</div>');

        // First person offset
        L.push('<div class="section">');
        L.push('  <h3>First Person Camera Offset (1OFF)</h3>');
        L.push('  <div class="offset-row">');
        L.push('    <label>X:</label><input type="number" id="fp_x" step="0.1">');
        L.push('    <label>Y:</label><input type="number" id="fp_y" step="0.1">');
        L.push('    <label>Z:</label><input type="number" id="fp_z" step="0.1">');
        L.push('  </div>');
        L.push('</div>');

        // Hyperspace (optional)
        L.push('<div class="section" id="hyperSection">');
        L.push('  <h3>Hyperspace — POB Ships (ISPB)</h3>');
        L.push('  <div class="hyper-toggle">');
        L.push('    <input type="checkbox" id="hyperEnabled">');
        L.push('    <label for="hyperEnabled">Enable hyperspace parameters</label>');
        L.push('  </div>');
        L.push('  <div id="hyperFields" style="display:none">');
        L.push('    <div class="offset-row">');
        L.push('      <label>X:</label><input type="number" id="hy_x" step="0.1">');
        L.push('      <label>Y:</label><input type="number" id="hy_y" step="0.1">');
        L.push('      <label>Z:</label><input type="number" id="hy_z" step="0.1">');
        L.push('    </div>');
        L.push('  </div>');
        L.push('</div>');

        // Toast
        L.push('<div class="toast" id="toast"></div>');

        // Script
        L.push('<script>');
        L.push('(function() {');
        L.push('  var vscode = acquireVsCodeApi();');
        L.push('  var cpitData = null;');
        L.push('  var readOnly = true;');
        L.push('');
        L.push('  function $(id) { return document.getElementById(id); }');
        L.push('');
        L.push('  function showToast(msg) {');
        L.push('    var t = $("toast"); t.textContent = msg; t.classList.add("show");');
        L.push('    setTimeout(function() { t.classList.remove("show"); }, 2000);');
        L.push('  }');
        L.push('');
        L.push('  function setDisabled(el, dis) {');
        L.push('    if (dis) { el.setAttribute("disabled",""); } else { el.removeAttribute("disabled"); }');
        L.push('  }');
        L.push('');
        L.push('  function buildZoomList() {');
        L.push('    var container = $("zoomList");');
        L.push('    container.innerHTML = "";');
        L.push('    if (!cpitData) return;');
        L.push('    for (var i = 0; i < cpitData.zoomLevels.length; i++) {');
        L.push('      var row = document.createElement("div");');
        L.push('      row.className = "zoom-row";');
        L.push('      var lbl = document.createElement("label");');
        L.push('      lbl.textContent = "Level " + (i + 1) + ":";');
        L.push('      var inp = document.createElement("input");');
        L.push('      inp.type = "number";');
        L.push('      inp.step = "0.1";');
        L.push('      inp.style.width = "100px";');
        L.push('      inp.style.textAlign = "right";');
        L.push('      inp.style.background = "var(--vscode-input-background)";');
        L.push('      inp.style.color = "var(--vscode-input-foreground)";');
        L.push('      inp.style.border = "1px solid var(--vscode-input-border, #444)";');
        L.push('      inp.style.padding = "4px 8px";');
        L.push('      inp.style.borderRadius = "3px";');
        L.push('      inp.style.fontFamily = "var(--vscode-editor-font-family, monospace)";');
        L.push('      inp.style.fontSize = "12px";');
        L.push('      inp.value = cpitData.zoomLevels[i];');
        L.push('      if (readOnly) inp.setAttribute("disabled", "");');
        L.push('      (function(idx) {');
        L.push('        inp.addEventListener("change", function() {');
        L.push('          cpitData.zoomLevels[idx] = parseFloat(this.value) || 0;');
        L.push('          sendChange();');
        L.push('        });');
        L.push('      })(i);');
        L.push('      row.appendChild(lbl);');
        L.push('      row.appendChild(inp);');
        L.push('      container.appendChild(row);');
        L.push('    }');
        L.push('  }');
        L.push('');
        L.push('  function sendChange() {');
        L.push('    if (readOnly || !cpitData) return;');
        L.push('    vscode.postMessage({ type: "change", data: JSON.parse(JSON.stringify(cpitData)) });');
        L.push('  }');
        L.push('');
        L.push('  function populateFields() {');
        L.push('    if (!cpitData) return;');
        L.push('    $("framePath").value = cpitData.frame || "";');
        L.push('    $("fpZoom").value = cpitData.firstPersonZoom;');
        L.push('    $("tp_x").value = cpitData.thirdPersonOffset.x;');
        L.push('    $("tp_y").value = cpitData.thirdPersonOffset.y;');
        L.push('    $("tp_z").value = cpitData.thirdPersonOffset.z;');
        L.push('    $("fp_x").value = cpitData.firstPersonOffset.x;');
        L.push('    $("fp_y").value = cpitData.firstPersonOffset.y;');
        L.push('    $("fp_z").value = cpitData.firstPersonOffset.z;');
        L.push('    var hasHyper = !!cpitData.hyperspace;');
        L.push('    $("hyperEnabled").checked = hasHyper;');
        L.push('    $("hyperFields").style.display = hasHyper ? "" : "none";');
        L.push('    if (hasHyper) {');
        L.push('      $("hy_x").value = cpitData.hyperspace.x;');
        L.push('      $("hy_y").value = cpitData.hyperspace.y;');
        L.push('      $("hy_z").value = cpitData.hyperspace.z;');
        L.push('    }');
        L.push('    buildZoomList();');
        L.push('    applyReadOnly();');
        L.push('  }');
        L.push('');
        L.push('  function applyReadOnly() {');
        L.push('    var inputs = document.querySelectorAll("input");');
        L.push('    for (var i = 0; i < inputs.length; i++) {');
        L.push('      setDisabled(inputs[i], readOnly);');
        L.push('    }');
        L.push('    var btns = document.querySelectorAll(".tbtn:not(#btnEditWorking)");');
        L.push('    for (var i = 0; i < btns.length; i++) {');
        L.push('      setDisabled(btns[i], readOnly);');
        L.push('      btns[i].style.opacity = readOnly ? "0.4" : "1";');
        L.push('    }');
        L.push('  }');
        L.push('');
        L.push('  // Input change handlers');
        L.push('  $("framePath").addEventListener("change", function() {');
        L.push('    if (!cpitData || readOnly) return;');
        L.push('    cpitData.frame = this.value;');
        L.push('    sendChange();');
        L.push('  });');
        L.push('  $("fpZoom").addEventListener("change", function() {');
        L.push('    if (!cpitData || readOnly) return;');
        L.push('    cpitData.firstPersonZoom = parseFloat(this.value) || 0;');
        L.push('    sendChange();');
        L.push('  });');
        L.push('');
        L.push('  ["tp_x","tp_y","tp_z"].forEach(function(id) {');
        L.push('    $(id).addEventListener("change", function() {');
        L.push('      if (!cpitData || readOnly) return;');
        L.push('      var axis = id.split("_")[1];');
        L.push('      cpitData.thirdPersonOffset[axis] = parseFloat(this.value) || 0;');
        L.push('      sendChange();');
        L.push('    });');
        L.push('  });');
        L.push('');
        L.push('  ["fp_x","fp_y","fp_z"].forEach(function(id) {');
        L.push('    $(id).addEventListener("change", function() {');
        L.push('      if (!cpitData || readOnly) return;');
        L.push('      var axis = id.split("_")[1];');
        L.push('      cpitData.firstPersonOffset[axis] = parseFloat(this.value) || 0;');
        L.push('      sendChange();');
        L.push('    });');
        L.push('  });');
        L.push('');
        L.push('  $("hyperEnabled").addEventListener("change", function() {');
        L.push('    if (!cpitData || readOnly) return;');
        L.push('    if (this.checked) {');
        L.push('      cpitData.hyperspace = { x: 0, y: 0, z: 0 };');
        L.push('      $("hyperFields").style.display = "";');
        L.push('      $("hy_x").value = 0; $("hy_y").value = 0; $("hy_z").value = 0;');
        L.push('    } else {');
        L.push('      cpitData.hyperspace = undefined;');
        L.push('      $("hyperFields").style.display = "none";');
        L.push('    }');
        L.push('    applyReadOnly();');
        L.push('    sendChange();');
        L.push('  });');
        L.push('');
        L.push('  ["hy_x","hy_y","hy_z"].forEach(function(id) {');
        L.push('    $(id).addEventListener("change", function() {');
        L.push('      if (!cpitData || readOnly || !cpitData.hyperspace) return;');
        L.push('      var axis = id.split("_")[1];');
        L.push('      cpitData.hyperspace[axis] = parseFloat(this.value) || 0;');
        L.push('      sendChange();');
        L.push('    });');
        L.push('  });');
        L.push('');
        L.push('  $("btnAddZoom").addEventListener("click", function() {');
        L.push('    if (!cpitData || readOnly) return;');
        L.push('    var last = cpitData.zoomLevels.length > 0 ? cpitData.zoomLevels[cpitData.zoomLevels.length - 1] : 0;');
        L.push('    cpitData.zoomLevels.push(last + 4);');
        L.push('    buildZoomList();');
        L.push('    sendChange();');
        L.push('  });');
        L.push('');
        L.push('  $("btnRemoveZoom").addEventListener("click", function() {');
        L.push('    if (!cpitData || readOnly || cpitData.zoomLevels.length === 0) return;');
        L.push('    cpitData.zoomLevels.pop();');
        L.push('    buildZoomList();');
        L.push('    sendChange();');
        L.push('  });');
        L.push('');
        L.push('  $("btnEditWorking").addEventListener("click", function() {');
        L.push('    vscode.postMessage({ type: "editInWorking" });');
        L.push('  });');
        L.push('');
        L.push('  window.addEventListener("message", function(ev) {');
        L.push('    var msg = ev.data;');
        L.push('    switch (msg.type) {');
        L.push('      case "data":');
        L.push('        cpitData = msg.data;');
        L.push('        readOnly = msg.readOnly;');
        L.push('        $("badgeName").textContent = msg.fileName;');
        L.push('        if (readOnly) {');
        L.push('          $("badgeRO").style.display = "";');
        L.push('          $("btnEditWorking").style.display = "";');
        L.push('        } else {');
        L.push('          $("badgeRO").style.display = "none";');
        L.push('          $("btnEditWorking").style.display = "none";');
        L.push('        }');
        L.push('        populateFields();');
        L.push('        break;');
        L.push('      case "toast":');
        L.push('        showToast(msg.message);');
        L.push('        break;');
        L.push('    }');
        L.push('  });');
        L.push('');
        L.push('  vscode.postMessage({ type: "ready" });');
        L.push('})();');
        L.push('</script>');
        L.push('</body></html>');
        return L.join('\n');
    }
}
