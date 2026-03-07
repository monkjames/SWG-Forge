/**
 * Art Workshop Webview Panel
 * Singleton panel: scan staging → form for names/descriptions → preview → generate
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StagedItem, LootGroup, FileOperation, PATHS, ART_TYPE_CONFIGS } from './types';
import { scanStagingFolder, ensureStagingFolders } from './stagingScanner';
import { createAPT, createSHT, cloneAndPatchObjectIFF, findTemplateIFF } from './iffBuilder';
import { findTemplateMesh, copyAndPatchMesh, findTemplateAPT, findAnimatedTemplates, copyAndPatchAnimated } from './meshManager';
import { addCRCEntries } from './crcTable';
import { addStrings } from './stfEditor';
import { updateObjectsLua, updateServerObjectsLua, createLootItems, createLootGroups } from './luaGenerator';

export class ArtWorkshopPanel {
    public static currentPanel: ArtWorkshopPanel | undefined;
    public static readonly viewType = 'artWorkshop';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _workspaceRoot: string = '';
    private _webviewReady = false;
    private _items: StagedItem[] = [];
    private _lootGroups: LootGroup[] = [];

    public static createOrShow(extensionUri: vscode.Uri): ArtWorkshopPanel {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (ArtWorkshopPanel.currentPanel) {
            ArtWorkshopPanel.currentPanel._panel.reveal(column);
            ArtWorkshopPanel.currentPanel._webviewReady = true;
            return ArtWorkshopPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            ArtWorkshopPanel.viewType, 'Art Workshop',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        ArtWorkshopPanel.currentPanel = new ArtWorkshopPanel(panel, extensionUri);
        return ArtWorkshopPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        this._panel.webview.html = this._getHtml();
        this._panel.webview.onDidReceiveMessage(m => this._handleMessage(m), null, this._disposables);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose(): void {
        ArtWorkshopPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    private async _handleMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this._webviewReady = true;
                this._doScan();
                break;

            case 'rescan':
                this._doScan();
                break;

            case 'createFolders':
                ensureStagingFolders(this._workspaceRoot);
                vscode.window.showInformationMessage('Staging folders created in art_workshop/');
                this._doScan();
                break;

            case 'updateItem': {
                const { internalName, field, value } = msg;
                const item = this._items.find(i => i.internalName === internalName);
                if (item) {
                    if (field === 'displayName') item.displayName = value;
                    if (field === 'description') item.description = value;
                    if (field === 'selected') item.selected = value;
                }
                break;
            }

            case 'updateLootGroups':
                this._lootGroups = msg.groups;
                break;

            case 'preview':
                this._doPreview();
                break;

            case 'generate':
                await this._doGenerate(false);
                break;

            case 'testMode':
                await this._doGenerate(true);
                break;
        }
    }

    private _doScan(): void {
        this._items = scanStagingFolder(this._workspaceRoot);

        // Auto-create a default loot group per type+subtype folder
        const groupMap = new Map<string, string[]>();
        for (const item of this._items) {
            const groupKey = item.typeConfig.stagingFolder.replace(/\//g, '_');
            if (!groupMap.has(groupKey)) {
                groupMap.set(groupKey, []);
            }
            groupMap.get(groupKey)!.push(item.internalName);
        }
        this._lootGroups = Array.from(groupMap.entries()).map(([name, items]) => ({ name, items }));

        this._panel.webview.postMessage({
            type: 'scanned',
            items: this._items,
            lootGroups: this._lootGroups,
            stagingExists: fs.existsSync(path.join(this._workspaceRoot, PATHS.STAGING_ROOT)),
        });
    }

    private _doPreview(): void {
        const selectedItems = this._items.filter(i => i.selected);
        const ops: FileOperation[] = [];

        for (const item of selectedItems) {
            const name = item.internalName;
            ops.push({ type: 'create', path: `tre/working/texture/${name}.dds`, description: 'DDS texture' });
            ops.push({ type: 'create', path: `tre/working/shader/${name}.sht`, description: 'Shader' });

            if (item.typeConfig.animated) {
                ops.push({ type: 'create', path: `tre/working/appearance/${name}.sat`, description: 'Animated appearance' });
                ops.push({ type: 'create', path: `tre/working/appearance/mesh/${name}.mgn`, description: 'Animated mesh' });
            } else {
                ops.push({ type: 'create', path: `tre/working/appearance/${name}.apt`, description: 'Appearance' });
                ops.push({ type: 'create', path: `tre/working/appearance/mesh/${name}.msh`, description: 'Mesh' });
            }

            ops.push({ type: 'create', path: `tre/working/object/tangible/painting/shared_${name}.iff`, description: 'Object IFF' });
            ops.push({ type: 'create', path: `custom_scripts/object/tangible/painting/${name}.lua`, description: 'Server template' });
            ops.push({ type: 'create', path: `custom_scripts/loot/items/painting/${name}.lua`, description: 'Loot item' });
        }

        ops.push({ type: 'modify', path: PATHS.CRC_TABLE, description: `+${selectedItems.length} CRC entries` });
        ops.push({ type: 'modify', path: PATHS.STF_NAME, description: `+${selectedItems.length} name strings` });
        ops.push({ type: 'modify', path: PATHS.STF_DESC, description: `+${selectedItems.length} description strings` });
        ops.push({ type: 'modify', path: 'custom_scripts/object/tangible/painting/objects.lua', description: `+${selectedItems.length} shared templates` });
        ops.push({ type: 'modify', path: 'custom_scripts/object/tangible/painting/serverobjects.lua', description: `+${selectedItems.length} includes` });
        ops.push({ type: 'modify', path: 'custom_scripts/loot/items/painting/serverobjects.lua', description: `+${selectedItems.length} loot includes` });

        const activeGroups = this._lootGroups.filter(g => g.items.some(n => selectedItems.find(i => i.internalName === n)));
        for (const group of activeGroups) {
            ops.push({ type: 'create', path: `custom_scripts/loot/groups/${group.name}.lua`, description: `Loot group (${group.items.length} items)` });
        }
        ops.push({ type: 'modify', path: 'custom_scripts/loot/groups/serverobjects.lua', description: `+${activeGroups.length} group includes` });

        this._panel.webview.postMessage({ type: 'preview', operations: ops, itemCount: selectedItems.length });
    }

    private async _doGenerate(testMode: boolean): Promise<void> {
        const selectedItems = this._items.filter(i => i.selected);
        if (selectedItems.length === 0) {
            vscode.window.showWarningMessage('No items selected');
            return;
        }

        const errors: string[] = [];
        let generated = 0;
        const modeLabel = testMode ? 'Test' : 'Generate';

        // In test mode, all output goes to art_workshop/_output/ mirroring the real structure.
        // We wipe it clean each run so you always see a fresh result.
        const outputRoot = testMode
            ? path.join(this._workspaceRoot, PATHS.STAGING_ROOT, '_output')
            : this._workspaceRoot;

        if (testMode) {
            // Clean previous test output
            if (fs.existsSync(outputRoot)) {
                fs.rmSync(outputRoot, { recursive: true, force: true });
            }
            fs.mkdirSync(outputRoot, { recursive: true });
        }

        // Find template IFF for cloning (always reads from real TRE)
        const templateIff = findTemplateIFF(this._workspaceRoot);
        if (!templateIff) {
            vscode.window.showErrorMessage('No template painting IFF found in TRE');
            return;
        }

        this._panel.webview.postMessage({ type: 'generating', total: selectedItems.length, current: 0, testMode });

        for (let idx = 0; idx < selectedItems.length; idx++) {
            const item = selectedItems[idx];
            const name = item.internalName;

            this._panel.webview.postMessage({ type: 'generating', total: selectedItems.length, current: idx, currentName: item.displayName, testMode });

            try {
                // Step 1: Copy DDS
                const ddsDir = path.join(outputRoot, 'tre/working/texture');
                fs.mkdirSync(ddsDir, { recursive: true });
                fs.copyFileSync(item.ddsPath, path.join(ddsDir, `${name}.dds`));

                // Step 2: Create SHT
                const shaderDir = path.join(outputRoot, 'tre/working/shader');
                fs.mkdirSync(shaderDir, { recursive: true });
                fs.writeFileSync(path.join(shaderDir, `${name}.sht`), createSHT(`texture/${name}.dds`));

                // Step 3: Appearance chain
                if (item.typeConfig.animated) {
                    const templates = findAnimatedTemplates(this._workspaceRoot, item.typeConfig);
                    const appearDir = path.join(outputRoot, 'tre/working/appearance');
                    const meshDir = path.join(outputRoot, 'tre/working/appearance/mesh');
                    fs.mkdirSync(meshDir, { recursive: true });

                    if (templates.sat) {
                        fs.writeFileSync(path.join(appearDir, `${name}.sat`), copyAndPatchAnimated(templates.sat, `shader/${name}.sht`));
                    }
                    if (templates.mgn) {
                        fs.writeFileSync(path.join(meshDir, `${name}.mgn`), copyAndPatchAnimated(templates.mgn, `shader/${name}.sht`));
                    }
                    if (templates.cdf) {
                        fs.copyFileSync(templates.cdf, path.join(appearDir, `${name}.cdf`));
                    }
                } else {
                    const meshDir = path.join(outputRoot, 'tre/working/appearance/mesh');
                    const appearDir = path.join(outputRoot, 'tre/working/appearance');
                    fs.mkdirSync(meshDir, { recursive: true });

                    fs.writeFileSync(path.join(appearDir, `${name}.apt`), createAPT(`appearance/mesh/${name}.msh`));

                    const templateMsh = findTemplateMesh(this._workspaceRoot, item.typeConfig);
                    if (templateMsh) {
                        fs.writeFileSync(path.join(meshDir, `${name}.msh`), copyAndPatchMesh(templateMsh, `shader/${name}.sht`));
                    } else {
                        errors.push(`${name}: No template mesh found for ${item.typeConfig.label}`);
                        continue;
                    }
                }

                // Step 4: Object IFF
                const objDir = path.join(outputRoot, 'tre/working/object/tangible/painting');
                fs.mkdirSync(objDir, { recursive: true });

                const appearancePath = item.typeConfig.animated ? `appearance/${name}.sat` : `appearance/${name}.apt`;
                const objBytes = cloneAndPatchObjectIFF(templateIff, appearancePath, `@art_n:${name}`, `@art_d:${name}`);
                fs.writeFileSync(path.join(objDir, `shared_${name}.iff`), objBytes);

                generated++;
            } catch (err: any) {
                errors.push(`${name}: ${err.message}`);
            }
        }

        // Step 5: CRC - in test mode, copy vanilla CRC table to output then modify it there
        try {
            if (testMode) {
                // Copy CRC table into test output so we can modify it safely
                const srcCrc = path.join(this._workspaceRoot, PATHS.CRC_TABLE);
                const vanillaCrc = path.join(this._workspaceRoot, 'tre/vanilla/misc/object_template_crc_string_table.iff');
                const destCrc = path.join(outputRoot, PATHS.CRC_TABLE);
                fs.mkdirSync(path.dirname(destCrc), { recursive: true });
                if (fs.existsSync(srcCrc)) {
                    fs.copyFileSync(srcCrc, destCrc);
                } else if (fs.existsSync(vanillaCrc)) {
                    fs.copyFileSync(vanillaCrc, destCrc);
                }
            }
            const crcPaths = selectedItems.map(i => `object/tangible/painting/shared_${i.internalName}.iff`);
            addCRCEntries(outputRoot, crcPaths);
        } catch (err: any) {
            errors.push(`CRC table: ${err.message}`);
        }

        // Step 6: Strings
        try {
            const stfNamePath = path.join(outputRoot, PATHS.STF_NAME);
            const stfDescPath = path.join(outputRoot, PATHS.STF_DESC);

            addStrings(stfNamePath, selectedItems.map(i => ({ id: i.internalName, value: i.displayName })));
            addStrings(stfDescPath, selectedItems.map(i => ({ id: i.internalName, value: i.description || i.displayName })));
        } catch (err: any) {
            errors.push(`Strings: ${err.message}`);
        }

        // Step 7: Lua templates
        try {
            updateObjectsLua(outputRoot, selectedItems);
            updateServerObjectsLua(outputRoot, selectedItems);
        } catch (err: any) {
            errors.push(`Lua objects: ${err.message}`);
        }

        // Step 8: Loot items
        try {
            createLootItems(outputRoot, selectedItems);
        } catch (err: any) {
            errors.push(`Loot items: ${err.message}`);
        }

        // Step 9: Loot groups
        try {
            const activeGroups = this._lootGroups.filter(g =>
                g.items.some(n => selectedItems.find(i => i.internalName === n))
            );
            createLootGroups(outputRoot, activeGroups);
        } catch (err: any) {
            errors.push(`Loot groups: ${err.message}`);
        }

        // Build file tree of what was created (for test mode display)
        const createdFiles: string[] = [];
        if (testMode) {
            this._walkDir(outputRoot, outputRoot, createdFiles);
        }

        this._panel.webview.postMessage({
            type: 'generated',
            success: errors.length === 0,
            generated,
            total: selectedItems.length,
            errors,
            testMode,
            outputPath: testMode ? PATHS.STAGING_ROOT + '/_output' : undefined,
            createdFiles: testMode ? createdFiles : undefined,
        });

        if (testMode) {
            vscode.window.showInformationMessage(
                `Test output: ${generated} items written to art_workshop/_output/`
            );
        } else if (errors.length === 0) {
            vscode.window.showInformationMessage(`Art Workshop: Generated ${generated} items successfully`);
        } else {
            vscode.window.showWarningMessage(`Art Workshop: Generated ${generated}/${selectedItems.length} items with ${errors.length} errors`);
        }
    }

    /** Recursively collect relative file paths under a directory */
    private _walkDir(dir: string, root: string, out: string[]): void {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._walkDir(full, root, out);
            } else {
                const rel = path.relative(root, full);
                const size = fs.statSync(full).size;
                const sizeStr = size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
                out.push(`${rel} (${sizeStr})`);
            }
        }
    }

    // ─── Webview HTML ───────────────────────────────────────────────────────

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border, #444);
    --accent: var(--vscode-button-background, #0e639c);
    --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
    --accent-fg: var(--vscode-button-foreground, #fff);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-fg: var(--vscode-input-foreground, #ccc);
    --input-border: var(--vscode-input-border, #555);
    --badge-bg: var(--vscode-badge-background, #4d4d4d);
    --badge-fg: var(--vscode-badge-foreground, #fff);
    --error: var(--vscode-errorForeground, #f44);
    --warning: #e8a838;
    --success: #4ec94e;
    --list-hover: var(--vscode-list-hoverBackground, #2a2d2e);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; color: var(--fg); background: var(--bg); padding: 16px; }
h1 { font-size: 18px; font-weight: 600; margin-bottom: 12px; }
h2 { font-size: 15px; font-weight: 600; margin: 16px 0 8px; }
h3 { font-size: 13px; font-weight: 600; margin: 12px 0 6px; }
button {
    background: var(--accent); color: var(--accent-fg); border: none;
    padding: 6px 14px; cursor: pointer; font-size: 12px; border-radius: 2px;
}
button:hover { background: var(--accent-hover); }
button.secondary { background: var(--badge-bg); color: var(--badge-fg); }
button.secondary:hover { background: var(--input-border); }
button:disabled { opacity: 0.5; cursor: default; }
input[type="text"] {
    background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border);
    padding: 4px 8px; font-size: 12px; width: 100%; border-radius: 2px;
}
input[type="text"]:focus { outline: 1px solid var(--accent); }
.header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
.header-actions { display: flex; gap: 8px; }
.badge { background: var(--accent); color: var(--accent-fg); padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.empty-state { text-align: center; padding: 60px 20px; color: var(--input-fg); }
.empty-state p { margin: 8px 0; }
.empty-state .folder-list { text-align: left; display: inline-block; margin: 16px 0; font-family: monospace; font-size: 12px; line-height: 1.8; }

/* Item groups */
.group { margin-bottom: 16px; border: 1px solid var(--border); border-radius: 4px; }
.group-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; background: var(--badge-bg); cursor: pointer; user-select: none;
}
.group-header:hover { background: var(--list-hover); }
.group-body { padding: 0; }
.group-body.collapsed { display: none; }

/* Item row */
.item-row {
    display: grid; grid-template-columns: 30px 1fr 1fr 1fr; gap: 8px;
    align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--border);
}
.item-row:last-child { border-bottom: none; }
.item-row:hover { background: var(--list-hover); }
.item-filename { font-family: monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-warning { color: var(--warning); font-size: 11px; }

/* Loot groups section */
.loot-section { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px; }
.loot-group { border: 1px solid var(--border); border-radius: 4px; margin-bottom: 8px; padding: 8px 12px; }
.loot-group-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.loot-group-header input { max-width: 200px; }
.loot-group-items { display: flex; flex-wrap: wrap; gap: 4px; }
.loot-tag { background: var(--badge-bg); color: var(--badge-fg); padding: 2px 8px; border-radius: 3px; font-size: 11px; display: flex; align-items: center; gap: 4px; }
.loot-tag .remove { cursor: pointer; opacity: 0.7; }
.loot-tag .remove:hover { opacity: 1; }
.unassigned-items { margin-top: 8px; }
.unassigned-tag { background: var(--input-bg); color: var(--input-fg); padding: 2px 8px; border-radius: 3px; font-size: 11px; cursor: pointer; display: inline-block; margin: 2px; }
.unassigned-tag:hover { background: var(--accent); color: var(--accent-fg); }

/* Preview screen */
.preview-list { max-height: 500px; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px; }
.preview-item { padding: 4px 12px; font-family: monospace; font-size: 12px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; }
.preview-item:last-child { border-bottom: none; }
.preview-item.create::before { content: "+"; color: var(--success); font-weight: bold; }
.preview-item.modify::before { content: "~"; color: var(--warning); font-weight: bold; }
.preview-desc { color: var(--input-fg); margin-left: auto; }

/* Progress */
.progress-bar { width: 100%; height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; margin: 8px 0; }
.progress-fill { height: 100%; background: var(--accent); transition: width 0.3s; }
.progress-text { font-size: 12px; color: var(--input-fg); }

/* Footer */
.footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }

/* Screens */
.screen { display: none; }
.screen.active { display: block; }

/* Results */
.result-errors { margin-top: 8px; }
.result-error { color: var(--error); font-size: 12px; padding: 2px 0; }

/* Dry run */
.dry-summary { display: flex; gap: 16px; margin: 12px 0; flex-wrap: wrap; }
.dry-stat { padding: 6px 12px; border-radius: 4px; font-size: 12px; font-weight: 600; }
.dry-stat.create { background: #1a3a1a; color: var(--success); }
.dry-stat.modify { background: #3a3a1a; color: var(--warning); }
.dry-stat.exists { background: #1a2a3a; color: #6ac; }
.dry-stat.missing { background: #3a1a1a; color: var(--error); }
.dry-section { margin-bottom: 16px; border: 1px solid var(--border); border-radius: 4px; }
.dry-section-header {
    padding: 8px 12px; background: var(--badge-bg); font-weight: 600;
    cursor: pointer; user-select: none; display: flex; justify-content: space-between;
}
.dry-section-header:hover { background: var(--list-hover); }
.dry-section-body { padding: 0; }
.dry-section-body.collapsed { display: none; }
.dry-entry { padding: 6px 12px; border-bottom: 1px solid var(--border); }
.dry-entry:last-child { border-bottom: none; }
.dry-entry-header { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.dry-entry-path { font-family: monospace; }
.dry-entry-status { padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
.dry-entry-status.create { background: #1a3a1a; color: var(--success); }
.dry-entry-status.modify { background: #3a3a1a; color: var(--warning); }
.dry-entry-status.exists { background: #1a2a3a; color: #6ac; }
.dry-entry-detail { color: var(--input-fg); font-size: 11px; margin-top: 2px; }
.dry-entry-content {
    margin-top: 4px; padding: 6px 8px; background: var(--input-bg);
    border-radius: 3px; font-family: monospace; font-size: 11px; line-height: 1.5;
    white-space: pre-wrap; max-height: 200px; overflow-y: auto; display: none;
}
.dry-entry-toggle { cursor: pointer; color: var(--accent); font-size: 11px; margin-left: auto; }
.dry-entry-toggle:hover { text-decoration: underline; }
</style>
</head>
<body>

<div class="header">
    <div>
        <h1>Art Workshop</h1>
        <span id="subtitle" style="color: var(--input-fg); font-size: 12px;">DDS textures to in-game lootable art objects</span>
    </div>
    <div class="header-actions">
        <button class="secondary" onclick="doRescan()">Rescan</button>
    </div>
</div>

<!-- Empty state -->
<div id="screen-empty" class="screen active">
    <div class="empty-state">
        <h2>No staging folder found</h2>
        <p>Create the staging folder structure to get started:</p>
        <div class="folder-list">
art_workshop/<br>
&nbsp;&nbsp;paintings/<br>
&nbsp;&nbsp;&nbsp;&nbsp;square_tiny/ square_small/ square_medium/ square_large/<br>
&nbsp;&nbsp;&nbsp;&nbsp;tall/ wide/ frameless/<br>
&nbsp;&nbsp;rugs/<br>
&nbsp;&nbsp;&nbsp;&nbsp;rectangle_large/ rectangle_medium/ rectangle_small/<br>
&nbsp;&nbsp;&nbsp;&nbsp;oval_large/ oval_medium/ round_large/<br>
&nbsp;&nbsp;banners/<br>
&nbsp;&nbsp;&nbsp;&nbsp;style1/ style2/<br>
&nbsp;&nbsp;tapestries/
        </div>
        <p>Drop DDS files into the appropriate folder, then scan.</p>
        <button onclick="doCreateFolders()">Create Staging Folders</button>
    </div>
</div>

<!-- No items found -->
<div id="screen-no-items" class="screen">
    <div class="empty-state">
        <h2>No DDS files found</h2>
        <p>Drop DDS texture files into the staging subfolders, then click Rescan.</p>
        <p style="margin-top: 16px;">Staging folder: <code>art_workshop/</code></p>
    </div>
</div>

<!-- Main form -->
<div id="screen-form" class="screen">
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
        <h2 style="margin: 0;">Staged Items</h2>
        <span id="item-count" class="badge">0</span>
    </div>
    <div id="items-container"></div>

    <div class="loot-section">
        <div style="display: flex; align-items: center; justify-content: space-between;">
            <h2 style="margin: 0;">Loot Groups</h2>
            <button class="secondary" onclick="addLootGroup()">+ Add Group</button>
        </div>
        <div id="loot-groups-container" style="margin-top: 8px;"></div>
        <div id="unassigned-container" class="unassigned-items"></div>
    </div>

    <div class="footer">
        <button class="secondary" onclick="doTestMode()">Test Mode</button>
        <button class="secondary" onclick="doPreview()">Preview Changes</button>
        <button onclick="doGenerate()">Generate All</button>
    </div>
</div>

<!-- Preview screen -->
<div id="screen-preview" class="screen">
    <h2>Preview: <span id="preview-count">0</span> items</h2>
    <div id="preview-list" class="preview-list" style="margin-top: 8px;"></div>
    <div class="footer">
        <button class="secondary" onclick="showScreen('screen-form')">Back</button>
        <button onclick="doGenerate()">Confirm &amp; Generate</button>
    </div>
</div>

<!-- Generating screen -->
<div id="screen-generating" class="screen">
    <h2>Generating...</h2>
    <div class="progress-bar"><div id="progress-fill" class="progress-fill" style="width: 0%;"></div></div>
    <p id="progress-text" class="progress-text">Preparing...</p>
</div>

<!-- Results screen -->
<div id="screen-results" class="screen">
    <h2 id="results-title">Complete</h2>
    <p id="results-summary"></p>
    <div id="results-output-path" style="margin: 8px 0; font-size: 12px; display: none;"></div>
    <div id="results-files" style="display: none; margin-top: 12px;">
        <h3>Generated Files</h3>
        <div id="results-file-list" class="preview-list" style="max-height: 400px; margin-top: 4px;"></div>
    </div>
    <div id="results-errors" class="result-errors"></div>
    <div class="footer">
        <button class="secondary" onclick="doRescan(); showScreen('screen-form');">Back to Form</button>
        <button id="btn-generate-real" style="display: none;" onclick="doGenerate()">Generate For Real</button>
        <button onclick="doRescan(); showScreen('screen-form');">Done</button>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
let items = [];
let lootGroups = [];
let selectedGroupForAssign = null;

// ─── Message handling ───────────────────────────────────────────────────────

window.addEventListener('message', function(event) {
    const msg = event.data;

    if (msg.type === 'scanned') {
        items = msg.items;
        lootGroups = msg.lootGroups;
        if (!msg.stagingExists) {
            showScreen('screen-empty');
        } else if (items.length === 0) {
            showScreen('screen-no-items');
        } else {
            renderItems();
            renderLootGroups();
            showScreen('screen-form');
        }
    }

    if (msg.type === 'preview') {
        renderPreview(msg.operations, msg.itemCount);
        showScreen('screen-preview');
    }

    if (msg.type === 'generating') {
        showScreen('screen-generating');
        const pct = msg.total > 0 ? Math.round((msg.current / msg.total) * 100) : 0;
        document.getElementById('progress-fill').style.width = pct + '%';
        document.getElementById('progress-text').textContent =
            msg.currentName ? ('Processing: ' + msg.currentName + ' (' + (msg.current + 1) + '/' + msg.total + ')') : 'Preparing...';
    }

    if (msg.type === 'generated') {
        showScreen('screen-results');
        const isTest = msg.testMode;

        document.getElementById('results-title').textContent = isTest
            ? 'Test Mode Complete'
            : (msg.success ? 'Generation Complete' : 'Generation Finished with Errors');

        document.getElementById('results-summary').textContent = isTest
            ? 'Generated ' + msg.generated + ' of ' + msg.total + ' items to test output folder. No real files were modified.'
            : 'Generated ' + msg.generated + ' of ' + msg.total + ' items.';

        // Show output path for test mode
        const outputDiv = document.getElementById('results-output-path');
        if (isTest && msg.outputPath) {
            outputDiv.style.display = 'block';
            outputDiv.innerHTML = 'Output: <code style="background: var(--input-bg); padding: 2px 6px; border-radius: 2px;">' + msg.outputPath + '</code>';
        } else {
            outputDiv.style.display = 'none';
        }

        // Show file tree for test mode
        const filesDiv = document.getElementById('results-files');
        const fileList = document.getElementById('results-file-list');
        if (isTest && msg.createdFiles && msg.createdFiles.length > 0) {
            filesDiv.style.display = 'block';
            fileList.innerHTML = '';
            for (const f of msg.createdFiles) {
                const div = document.createElement('div');
                div.className = 'preview-item create';
                div.innerHTML = '<span>' + f + '</span>';
                fileList.appendChild(div);
            }
        } else {
            filesDiv.style.display = 'none';
        }

        // Show "Generate For Real" button in test mode
        document.getElementById('btn-generate-real').style.display = isTest ? 'inline-block' : 'none';

        const errContainer = document.getElementById('results-errors');
        errContainer.innerHTML = '';
        for (const err of msg.errors) {
            const div = document.createElement('div');
            div.className = 'result-error';
            div.textContent = err;
            errContainer.appendChild(div);
        }
    }
});

// ─── Screen management ──────────────────────────────────────────────────────

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// ─── Render items ───────────────────────────────────────────────────────────

function renderItems() {
    const container = document.getElementById('items-container');
    container.innerHTML = '';
    document.getElementById('item-count').textContent = items.filter(i => i.selected).length;

    // Group by typeConfig.label
    const groups = {};
    for (const item of items) {
        const label = item.typeConfig.label;
        if (!groups[label]) groups[label] = [];
        groups[label].push(item);
    }

    for (const [label, groupItems] of Object.entries(groups)) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'group';

        const header = document.createElement('div');
        header.className = 'group-header';
        header.innerHTML = '<span>' + label + ' <span class="badge">' + groupItems.length + '</span></span><span>&#9660;</span>';
        header.onclick = function() {
            const body = this.nextElementSibling;
            body.classList.toggle('collapsed');
            this.querySelector('span:last-child').textContent = body.classList.contains('collapsed') ? '\\u25B6' : '\\u25BC';
        };

        const body = document.createElement('div');
        body.className = 'group-body';

        for (const item of groupItems) {
            const row = document.createElement('div');
            row.className = 'item-row';

            // Checkbox
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = item.selected;
            cb.onchange = function() {
                item.selected = this.checked;
                vscode.postMessage({ type: 'updateItem', internalName: item.internalName, field: 'selected', value: this.checked });
                document.getElementById('item-count').textContent = items.filter(i => i.selected).length;
            };

            // Filename
            const fnDiv = document.createElement('div');
            fnDiv.className = 'item-filename';
            fnDiv.textContent = item.baseName + '.dds';
            if (item.warnings.length > 0) {
                const warn = document.createElement('div');
                warn.className = 'item-warning';
                warn.textContent = item.warnings[0];
                fnDiv.appendChild(warn);
            }

            // Display name
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = item.displayName;
            nameInput.placeholder = 'Display name';
            nameInput.onchange = function() {
                item.displayName = this.value;
                vscode.postMessage({ type: 'updateItem', internalName: item.internalName, field: 'displayName', value: this.value });
            };

            // Description
            const descInput = document.createElement('input');
            descInput.type = 'text';
            descInput.value = item.description;
            descInput.placeholder = 'Description (optional)';
            descInput.onchange = function() {
                item.description = this.value;
                vscode.postMessage({ type: 'updateItem', internalName: item.internalName, field: 'description', value: this.value });
            };

            row.appendChild(cb);
            row.appendChild(fnDiv);
            row.appendChild(nameInput);
            row.appendChild(descInput);
            body.appendChild(row);
        }

        groupDiv.appendChild(header);
        groupDiv.appendChild(body);
        container.appendChild(groupDiv);
    }
}

// ─── Loot groups ────────────────────────────────────────────────────────────

function renderLootGroups() {
    const container = document.getElementById('loot-groups-container');
    container.innerHTML = '';

    for (let gi = 0; gi < lootGroups.length; gi++) {
        const group = lootGroups[gi];
        const groupDiv = document.createElement('div');
        groupDiv.className = 'loot-group';

        const header = document.createElement('div');
        header.className = 'loot-group-header';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = group.name;
        nameInput.placeholder = 'Group name';
        nameInput.onchange = function() {
            group.name = this.value;
            syncLootGroups();
        };

        const removeBtn = document.createElement('button');
        removeBtn.className = 'secondary';
        removeBtn.textContent = 'Remove';
        removeBtn.style.fontSize = '11px';
        removeBtn.style.padding = '2px 8px';
        removeBtn.onclick = function() {
            lootGroups.splice(gi, 1);
            renderLootGroups();
            syncLootGroups();
        };

        header.appendChild(nameInput);
        header.appendChild(removeBtn);

        const itemsDiv = document.createElement('div');
        itemsDiv.className = 'loot-group-items';

        for (const itemName of group.items) {
            const tag = document.createElement('span');
            tag.className = 'loot-tag';
            tag.innerHTML = itemName + ' <span class="remove" data-group="' + gi + '" data-item="' + itemName + '">x</span>';
            tag.querySelector('.remove').onclick = function() {
                const gIdx = parseInt(this.dataset.group);
                const iName = this.dataset.item;
                lootGroups[gIdx].items = lootGroups[gIdx].items.filter(n => n !== iName);
                renderLootGroups();
                syncLootGroups();
            };
            itemsDiv.appendChild(tag);
        }

        groupDiv.appendChild(header);
        groupDiv.appendChild(itemsDiv);
        container.appendChild(groupDiv);
    }

    // Unassigned items
    const assigned = new Set();
    for (const g of lootGroups) for (const n of g.items) assigned.add(n);
    const unassigned = items.filter(i => i.selected && !assigned.has(i.internalName));

    const unDiv = document.getElementById('unassigned-container');
    unDiv.innerHTML = '';
    if (unassigned.length > 0 && lootGroups.length > 0) {
        const label = document.createElement('h3');
        label.textContent = 'Unassigned (' + unassigned.length + ') - click to assign to last group:';
        unDiv.appendChild(label);
        for (const item of unassigned) {
            const tag = document.createElement('span');
            tag.className = 'unassigned-tag';
            tag.textContent = item.internalName;
            tag.onclick = function() {
                lootGroups[lootGroups.length - 1].items.push(item.internalName);
                renderLootGroups();
                syncLootGroups();
            };
            unDiv.appendChild(tag);
        }
    }
}

function addLootGroup() {
    lootGroups.push({ name: 'new_group_' + (lootGroups.length + 1), items: [] });
    renderLootGroups();
    syncLootGroups();
}

function syncLootGroups() {
    vscode.postMessage({ type: 'updateLootGroups', groups: lootGroups });
}

// ─── Preview ────────────────────────────────────────────────────────────────

function renderPreview(operations, itemCount) {
    document.getElementById('preview-count').textContent = itemCount + ' items -> ' + operations.length + ' file operations';
    const list = document.getElementById('preview-list');
    list.innerHTML = '';
    for (const op of operations) {
        const div = document.createElement('div');
        div.className = 'preview-item ' + op.type;
        div.innerHTML = '<span>' + op.path + '</span><span class="preview-desc">' + op.description + '</span>';
        list.appendChild(div);
    }
}

// ─── Actions ────────────────────────────────────────────────────────────────

function doRescan() { vscode.postMessage({ type: 'rescan' }); }
function doCreateFolders() { vscode.postMessage({ type: 'createFolders' }); }
function doPreview() { vscode.postMessage({ type: 'preview' }); }
function doGenerate() { vscode.postMessage({ type: 'generate' }); }
function doTestMode() { vscode.postMessage({ type: 'testMode' }); }

// ─── Init ───────────────────────────────────────────────────────────────────

vscode.postMessage({ type: 'ready' });
</script>

</body>
</html>`;
    }
}
