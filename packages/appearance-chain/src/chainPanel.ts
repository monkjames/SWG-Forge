/**
 * Chain Panel - Webview panel for editing appearance chains.
 * Shows per-file IFF trees inline with editable fields, template pills,
 * collapse persistence, and Save All.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ChainResolver } from './chainResolver';
import { ChainAnalysis, ChainNode, ChainNodeWithIFF } from './types';
import { IFFNode, serializeIFF, updateChunkData, nodeToJson } from './iffParser';
import { decodeDDSThumbnail } from './ddsDecoder';

export class ChainPanel {
    public static currentPanel: ChainPanel | undefined;
    public static readonly viewType = 'swgemu.appearanceChain';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _currentAnalysis: ChainAnalysis | null = null;
    /** Live IFF trees keyed by absolute path - mutated during edits */
    private _iffTreeCache: Map<string, IFFNode> = new Map();
    /** Tracks which files have been modified */
    private _dirtyFiles: Set<string> = new Set();

    public static createOrShow(extensionUri: vscode.Uri): ChainPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ChainPanel.currentPanel) {
            ChainPanel.currentPanel._panel.reveal(column);
            return ChainPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            ChainPanel.viewType,
            'Appearance Chain',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        ChainPanel.currentPanel = new ChainPanel(panel, extensionUri);
        return ChainPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._panel.webview.html = this._getHtmlContent();

        this._panel.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );

        this._panel.onDidDispose(
            () => {
                ChainPanel.currentPanel = undefined;
                for (const d of this._disposables) {
                    d.dispose();
                }
                this._disposables = [];
            },
            null,
            this._disposables
        );
    }

    public analyzeFile(filePath: string): void {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const resolver = new ChainResolver(workspaceRoot);

        try {
            this._currentAnalysis = resolver.analyze(filePath);
            this._iffTreeCache = new Map(resolver.iffRoots);
            this._dirtyFiles.clear();
            this._panel.title = `Chain: ${this._getFileName(filePath)}`;
            this._sendAnalysis();
        } catch (err: any) {
            this._panel.webview.postMessage({
                type: 'error',
                message: `Failed to analyze: ${err.message}`
            });
        }
    }

    private _sendAnalysis(): void {
        if (!this._currentAnalysis) return;

        this._panel.webview.postMessage({
            type: 'analysis',
            data: {
                rootNode: this._serializeNode(this._currentAnalysis.rootNode),
                summary: this._currentAnalysis.summary,
                startFile: this._currentAnalysis.startFile,
                analysisTime: this._currentAnalysis.analysisTime
            }
        });
    }

    private _serializeNode(node: ChainNode): any {
        const withIFF = node as ChainNodeWithIFF;
        return {
            id: node.id,
            fileType: node.fileType,
            referencePath: node.referencePath,
            resolvedPath: node.resolvedPath,
            source: node.source,
            fileSize: node.fileSize,
            exists: node.exists,
            label: node.label,
            editable: withIFF.editable || false,
            iffTree: withIFF.iffTree || null,
            children: node.children.map(c => this._serializeNode(c))
        };
    }

    private _handleMessage(message: any): void {
        switch (message.type) {
            case 'openFile':
                if (message.path) {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(message.path));
                }
                break;

            case 'refresh':
                if (this._currentAnalysis) {
                    this.analyzeFile(this._currentAnalysis.startFile);
                }
                break;

            case 'updateChunk': {
                const { filePath, chunkOffset, newData } = message;
                const root = this._iffTreeCache.get(filePath);
                if (!root) {
                    this._panel.webview.postMessage({
                        type: 'error', message: 'File not in cache: ' + filePath
                    });
                    break;
                }
                const success = updateChunkData(root, chunkOffset, new Uint8Array(newData));
                if (success) {
                    this._dirtyFiles.add(filePath);
                    this._panel.webview.postMessage({
                        type: 'chunkUpdated', filePath, chunkOffset,
                        dirtyCount: this._dirtyFiles.size
                    });
                } else {
                    this._panel.webview.postMessage({
                        type: 'error', message: 'Chunk not found at offset ' + chunkOffset
                    });
                }
                break;
            }

            case 'saveAll': {
                const results: { filePath: string; success: boolean; error?: string }[] = [];
                for (const filePath of this._dirtyFiles) {
                    const root = this._iffTreeCache.get(filePath);
                    if (!root) {
                        results.push({ filePath, success: false, error: 'Not in cache' });
                        continue;
                    }
                    try {
                        const binary = serializeIFF(root);
                        fs.writeFileSync(filePath, binary);
                        results.push({ filePath, success: true });
                    } catch (err: any) {
                        results.push({ filePath, success: false, error: err.message });
                    }
                }
                const allOk = results.every(r => r.success);
                this._dirtyFiles.clear();
                this._panel.webview.postMessage({ type: 'saved', results, dirtyCount: 0 });
                if (allOk) {
                    vscode.window.showInformationMessage(
                        `Saved ${results.length} file(s) successfully`
                    );
                } else {
                    const failed = results.filter(r => !r.success);
                    vscode.window.showWarningMessage(
                        `${failed.length} file(s) failed to save`
                    );
                }
                break;
            }

            case 'getThumbnail': {
                const thumbPath = message.path;
                const dataURI = decodeDDSThumbnail(thumbPath, 300);
                this._panel.webview.postMessage({
                    type: 'thumbnailData',
                    path: thumbPath,
                    dataURI: dataURI
                });
                break;
            }

            case 'exportToWorking': {
                if (!this._currentAnalysis) break;
                const copied: string[] = [];
                const errors: string[] = [];
                this._walkChainNodes(this._currentAnalysis.rootNode, (node) => {
                    if (node.exists && node.resolvedPath && node.source && node.source !== 'working') {
                        // Compute tre-relative path by stripping the tre/<source>/ prefix
                        const normalized = node.resolvedPath.replace(/\\/g, '/');
                        const sourceDir = '/tre/' + node.source + '/';
                        const idx = normalized.indexOf(sourceDir);
                        if (idx === -1) return;
                        const trePath = normalized.slice(idx + sourceDir.length);
                        const workspaceRoot = normalized.slice(0, idx);
                        const destPath = path.join(workspaceRoot, 'tre', 'working', trePath);
                        try {
                            fs.mkdirSync(path.dirname(destPath), { recursive: true });
                            fs.copyFileSync(node.resolvedPath, destPath);
                            copied.push(trePath);
                        } catch (err: any) {
                            errors.push(trePath + ': ' + err.message);
                        }
                    }
                });
                if (copied.length > 0) {
                    vscode.window.showInformationMessage(
                        `Copied ${copied.length} file(s) to tre/working/`
                    );
                }
                if (errors.length > 0) {
                    vscode.window.showWarningMessage(
                        `${errors.length} file(s) failed to copy`
                    );
                }
                // Re-analyze to pick up working copies
                if (copied.length > 0) {
                    this.analyzeFile(this._currentAnalysis.startFile);
                }
                break;
            }

            case 'getChunkData': {
                const { filePath, chunkOffset } = message;
                const root = this._iffTreeCache.get(filePath);
                if (!root) break;
                const chunk = this._findChunkByOffset(root, chunkOffset);
                if (chunk && chunk.data) {
                    this._panel.webview.postMessage({
                        type: 'chunkData',
                        filePath,
                        chunkOffset,
                        dataArray: Array.from(chunk.data)
                    });
                }
                break;
            }
        }
    }

    private _walkChainNodes(node: ChainNode, fn: (n: ChainNode) => void): void {
        fn(node);
        if (node.children) {
            for (const child of node.children) {
                this._walkChainNodes(child, fn);
            }
        }
    }

    private _findChunkByOffset(node: IFFNode, offset: number): IFFNode | null {
        if (node.offset === offset && node.type === 'chunk') return node;
        if (node.children) {
            for (const child of node.children) {
                const found = this._findChunkByOffset(child, offset);
                if (found) return found;
            }
        }
        return null;
    }

    private _getFileName(filePath: string): string {
        return filePath.split('/').pop() || filePath;
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Appearance Chain Editor</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family);
            font-size: 13px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }

        /* Toolbar */
        .toolbar {
            position: sticky; top: 0; z-index: 10;
            display: flex; align-items: center; gap: 8px;
            padding: 8px 16px;
            background: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .toolbar button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; padding: 4px 10px; border-radius: 3px;
            cursor: pointer; font-size: 12px;
        }
        .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
        .toolbar button.save-btn { background: #2ea043; }
        .toolbar button.save-btn:hover { background: #3fb950; }
        .toolbar button.save-btn:disabled { background: #555; cursor: default; opacity: 0.5; }
        .dirty-indicator { font-size: 11px; color: #e5a00d; font-weight: bold; }
        .analysis-time { font-size: 11px; opacity: 0.4; margin-left: auto; }

        /* Summary */
        .summary {
            display: flex; gap: 16px; padding: 10px 16px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 12px; flex-wrap: wrap;
        }
        .summary-item { display: flex; align-items: center; gap: 5px; }
        .summary-label { opacity: 0.7; }
        .summary-value { font-weight: bold; }
        .summary-ok { color: #4ade80; }
        .summary-warn { color: #f87171; }
        .type-badge {
            padding: 1px 6px; border-radius: 3px; font-size: 11px;
            font-weight: bold; text-transform: uppercase;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }

        /* Chain tree */
        .tree { padding: 8px 0; }
        .tree-node { user-select: none; }
        .tree-row {
            display: flex; align-items: center; gap: 4px;
            padding: 3px 8px 3px 0; cursor: pointer;
            white-space: nowrap; min-height: 24px;
        }
        .tree-row:hover { background: var(--vscode-list-hoverBackground); }
        .tree-indent { display: inline-block; width: 20px; flex-shrink: 0; }
        .tree-toggle {
            display: inline-flex; align-items: center; justify-content: center;
            width: 20px; height: 20px; flex-shrink: 0;
            font-size: 10px; opacity: 0.7; cursor: pointer;
        }
        .tree-toggle:hover { opacity: 1; }
        .tree-toggle.leaf { visibility: hidden; }
        .tree-status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .tree-status.ok { background: #4ade80; }
        .tree-status.missing { background: #f87171; }
        .tree-type {
            font-size: 11px; font-weight: bold; padding: 1px 5px; border-radius: 3px;
            flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.5px; min-width: 40px; text-align: center;
        }
        .tree-type.apt, .tree-type.sat { background: #1a4d1a; color: #66d96a; }
        .tree-type.lod, .tree-type.lmg { background: #1a3d5c; color: #5bb8f7; }
        .tree-type.msh, .tree-type.mgn { background: #4d3d1a; color: #f0c040; }
        .tree-type.sht, .tree-type.eft { background: #3d1a4d; color: #c084fc; }
        .tree-type.dds { background: #4d1a2e; color: #f472b6; }
        .tree-type.skt, .tree-type.lat { background: #1a3d3d; color: #5eead4; }
        .tree-type.object { background: #3d2b1a; color: #fbbf24; }
        .tree-type.unknown { background: #333; color: #999; }
        .tree-filename {
            font-weight: bold; color: var(--vscode-foreground);
            overflow: hidden; text-overflow: ellipsis;
        }
        .tree-refpath {
            flex: 1; font-size: 11px; opacity: 0.55; overflow: hidden; text-overflow: ellipsis; margin-left: 4px;
        }
        .tree-refpath.clickable:hover { text-decoration: underline; color: var(--vscode-textLink-foreground); opacity: 1; }
        .tree-refpath.missing-path { opacity: 0.35; text-decoration: line-through; }
        .tree-label { font-size: 11px; opacity: 0.5; margin-right: 4px; flex-shrink: 0; }
        .tree-meta { font-size: 11px; opacity: 0.5; flex-shrink: 0; margin-left: 8px; }
        .tree-source { font-size: 10px; padding: 0 4px; border-radius: 3px; flex-shrink: 0; margin-left: 4px; }
        .tree-source.working { background: #166534; color: #4ade80; }
        .tree-source.vanilla { background: #1e3a5f; color: #60a5fa; }
        .tree-source.infinity { background: #4c1d95; color: #a78bfa; }
        .editable-badge { font-size: 9px; margin-left: 4px; opacity: 0.5; }
        .dds-thumbnail {
            display: block; margin: 4px 0 4px 50px; max-width: 300px;
            border: 1px solid var(--vscode-panel-border); border-radius: 4px;
            background: repeating-conic-gradient(#333 0% 25%, #2a2a2a 0% 50%) 50% / 16px 16px;
        }
        .dds-thumbnail img { display: block; max-width: 300px; height: auto; }
        .dds-loading { font-size: 11px; opacity: 0.4; margin: 4px 0 4px 50px; }
        .children { display: block; }
        .children.collapsed { display: none; }

        /* IFF tree */
        .iff-tree { border-left: 1px solid var(--vscode-panel-border); margin-left: 30px; padding-left: 4px; }
        .iff-node {
            display: flex; align-items: center; gap: 4px;
            padding: 1px 4px; min-height: 22px; font-size: 12px;
        }
        .iff-node:hover { background: rgba(255,255,255,0.03); }
        .iff-form-tag { color: #569cd6; font-weight: bold; }
        .iff-chunk-tag { color: #dcdcaa; font-family: monospace; font-size: 12px; }
        .iff-size { font-size: 10px; opacity: 0.4; margin-left: 4px; }
        .iff-toggle { cursor: pointer; width: 16px; text-align: center; font-size: 9px; opacity: 0.6; flex-shrink: 0; }
        .iff-toggle:hover { opacity: 1; }
        .iff-collapsed { display: none; }

        /* Editable path field */
        .iff-editable { display: flex; align-items: center; gap: 4px; padding: 1px 4px; min-height: 24px; }
        .iff-editable .path-input {
            flex: 1; max-width: 500px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 2px 6px; font-size: 12px; font-family: monospace;
            border-radius: 2px;
        }
        .iff-editable .path-input:focus { border-color: var(--vscode-focusBorder); outline: none; }
        .iff-editable .path-input[readonly] {
            opacity: 0.6; cursor: default;
            border-color: transparent; background: transparent;
        }
        .iff-editable .path-input.dirty { border-color: #e5a00d; }
        .lock-icon { font-size: 11px; opacity: 0.4; }

        /* Binary chunk (collapsed) */
        .iff-binary { padding: 1px 4px; font-size: 11px; opacity: 0.5; cursor: pointer; }
        .iff-binary:hover { opacity: 0.8; background: rgba(255,255,255,0.03); }

        /* Template pill system */
        .template-section {
            margin-left: 32px; padding: 8px 12px; margin-top: 2px; margin-bottom: 4px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border); border-radius: 4px;
        }
        .template-pills { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
        .pill {
            padding: 2px 8px; border-radius: 10px; border: none; cursor: pointer;
            font-size: 11px; font-weight: 500;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .pill:hover { opacity: 0.8; }
        .template-display {
            display: flex; flex-wrap: wrap; gap: 4px; min-height: 24px;
            padding: 4px 6px; margin-bottom: 6px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border); border-radius: 3px;
        }
        .template-item {
            display: inline-flex; align-items: center; gap: 3px;
            padding: 1px 6px; border-radius: 8px; font-size: 11px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .template-item .remove { cursor: pointer; font-size: 13px; opacity: 0.6; }
        .template-item .remove:hover { opacity: 1; }
        .template-buttons { display: flex; gap: 6px; margin-bottom: 8px; }
        .template-buttons button {
            padding: 2px 8px; font-size: 11px; border: 1px solid var(--vscode-input-border);
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border-radius: 3px; cursor: pointer;
        }
        .template-buttons button:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .template-buttons button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-background);
        }
        .template-fields { display: flex; flex-direction: column; gap: 4px; }
        .template-field {
            display: flex; align-items: center; gap: 8px; font-size: 12px;
        }
        .template-field-name { min-width: 50px; opacity: 0.6; font-size: 11px; }
        .template-field input, .template-field select {
            flex: 1; max-width: 300px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 2px 6px; font-size: 12px; border-radius: 2px;
        }
        .template-saved { font-size: 11px; color: #4ade80; margin-left: 8px; }
        .hex-preview { font-family: monospace; font-size: 11px; opacity: 0.4; word-break: break-all; max-width: 400px; }

        .error-box { padding: 16px; color: #f87171; text-align: center; }
        .loading { padding: 32px; text-align: center; opacity: 0.6; }
        .status-msg {
            position: fixed; bottom: 12px; right: 12px; z-index: 100;
            padding: 6px 14px; border-radius: 4px; font-size: 12px;
            background: #2ea043; color: #fff; opacity: 0; transition: opacity 0.3s;
        }
        .status-msg.visible { opacity: 1; }
        .status-msg.error { background: #f87171; }
        .iff-templated {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 1px 0;
            flex-wrap: wrap;
        }
        .iff-templated .iff-chunk-tag.clickable { cursor: pointer; }
        .iff-templated .iff-chunk-tag.clickable:hover { text-decoration: underline; }
        .inline-field { display: inline-flex; align-items: center; }
        .inline-input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, #444);
            padding: 1px 4px;
            font-family: inherit;
            font-size: 11px;
            border-radius: 2px;
        }
        .inline-input[type="number"] { width: 80px; }
        .inline-input[type="text"] { width: 160px; }
        .inline-input.dirty { border-color: #e8a000; }
        .inline-input:focus { outline: 1px solid var(--vscode-focusBorder); }
        select.inline-input { padding: 1px 2px; }
        .working-bar {
            background: #7c6f00;
            color: #fff;
            padding: 8px 12px;
            border-radius: 4px;
            margin-bottom: 8px;
            display: none;
            align-items: center;
            gap: 10px;
            font-size: 12px;
        }
        .working-bar.visible { display: flex; }
        .working-bar .bar-text { flex: 1; }
        .working-bar button {
            background: #e8a000;
            color: #000;
            border: none;
            padding: 4px 12px;
            border-radius: 3px;
            cursor: pointer;
            font-weight: bold;
            font-size: 12px;
            white-space: nowrap;
        }
        .working-bar button:hover { background: #ffc107; }
    </style>
</head>
<body>
    <div class="toolbar">
        <button onclick="refresh()">Refresh</button>
        <button class="save-btn" id="saveBtn" onclick="saveAll()" disabled>Save All</button>
        <button onclick="expandAll()">Expand All</button>
        <button onclick="collapseAll()">Collapse All</button>
        <span class="dirty-indicator" id="dirtyIndicator" style="display:none">
            Modified: <span id="dirtyCount">0</span> file(s)
        </span>
        <span class="analysis-time" id="analysisTime"></span>
    </div>

    <div class="working-bar" id="workingBar">
        <span class="bar-text" id="workingBarText">Some files are outside tre/working/ and cannot be edited.</span>
        <button onclick="exportToWorking()">Copy to Working</button>
    </div>
    <div class="summary" id="summary" style="display:none"></div>
    <div id="content"><div class="loading">Analyzing appearance chain...</div></div>
    <div class="status-msg" id="statusMsg"></div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentData = null;
        let chainCollapsed = new Set();
        let dirtyChunks = new Map(); // filePath -> Set of offsets

        // Collapse persistence by chunk tag (stored in localStorage)
        const COLLAPSE_KEY = 'appearance-chain-collapsed-tags';
        let tagCollapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'));
        // Version forms (00xx) auto-collapse on first encounter per session
        const defaultedVersionForms = new Set();

        // Template persistence by property name (first string) - shares storage with vscode-iff-editor
        const TEMPLATE_KEY = 'iff-editor-templates';
        function getTemplates() { try { return JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '{}'); } catch { return {}; } }
        function saveTemplate(propName, tmpl) { const t = getTemplates(); t[propName] = tmpl; localStorage.setItem(TEMPLATE_KEY, JSON.stringify(t)); }
        function getTemplate(propName) { return getTemplates()[propName] || ''; }

        // Currently open template section
        let openTemplateChunk = null; // { filePath, offset, tag, propName }
        let templateItems = [];

        // DDS thumbnail cache: path -> data URI
        const thumbnailCache = {};

        const FILE_TYPE_LABELS = {
            apt:'APT', sat:'SAT', lod:'LOD', lmg:'LMG', msh:'MSH', mgn:'MGN',
            sht:'SHT', dds:'DDS', eft:'EFT', skt:'SKT', lat:'LAT',
            object:'OBJ', unknown:'???'
        };

        // Suppressed chunks by property name (first string) - hidden from tree
        const SUPPRESSED = new Set([
            'lookAtText',
            'snapToTerrain',
            'containerType',
            'containerVolumeLimit',
            'tintPalette',
            'slotDescriptorFilename',
            'arrangementDescriptorFilename',
            'portalLayoutFilename',
            'scale',
            'gameObjectType',
            'sendToClient',
            'scaleThresholdBeforeExtentTest',
            'clearFloraRadius',
            'surfaceType',
            'noBuildRadius',
            'onlyVisibleInTools',
            'locationReservationRadius',
            'forceNoCollision',
        ]);

        // Editable chunk detection: parent FORM name -> { tag, stringOffset }
        const EDITABLE_CHUNKS = {
            'APT ': { 'NAME': 0 }, 'IAPT': { 'NAME': 0 },
            'DTLA': { 'CHLD': 4 },
            'PSDT': { 'NAME': 0 },
            'SKMG': { 'SKTM': 0 },
            'MLOD': { 'NAME': 0 }
        };
        // SPS child forms and SSHT subtree also have editable NAME chunks
        // We handle these by checking if the chunk tag is NAME and the parent context matches

        function refresh() { vscode.postMessage({ type: 'refresh' }); }
        function saveAll() { vscode.postMessage({ type: 'saveAll' }); }
        function exportToWorking() { vscode.postMessage({ type: 'exportToWorking' }); }

        function checkWorkingBar() {
            if (!currentData) return;
            const nonWorking = [];
            walkNodes(currentData.rootNode, n => {
                if (n.exists && n.source && n.source !== 'working') nonWorking.push(n);
            });
            const bar = document.getElementById('workingBar');
            if (nonWorking.length > 0) {
                document.getElementById('workingBarText').textContent =
                    nonWorking.length + ' file(s) are outside tre/working/ and cannot be edited.';
                bar.classList.add('visible');
            } else {
                bar.classList.remove('visible');
            }
        }

        function expandAll() { chainCollapsed.clear(); renderTree(); }
        function collapseAll() {
            if (!currentData) return;
            walkNodes(currentData.rootNode, n => { if (n.children && n.children.length > 0) chainCollapsed.add(n.id); });
            renderTree();
        }
        function walkNodes(node, fn) { fn(node); if (node.children) node.children.forEach(c => walkNodes(c, fn)); }
        function toggleChainNode(id) { chainCollapsed.has(id) ? chainCollapsed.delete(id) : chainCollapsed.add(id); renderTree(); }
        function toggleTagCollapse(tag) {
            tagCollapsed.has(tag) ? tagCollapsed.delete(tag) : tagCollapsed.add(tag);
            localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...tagCollapsed]));
            renderTree();
        }
        function openFile(path) { vscode.postMessage({ type: 'openFile', path: path }); }
        function formatSize(bytes) {
            if (bytes === 0) return '';
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / 1048576).toFixed(1) + ' MB';
        }
        function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }
        function escapeAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#039;').replace(/\\\\/g,'/'); }

        function showStatus(msg, isError) {
            const el = document.getElementById('statusMsg');
            el.textContent = msg;
            el.className = 'status-msg visible' + (isError ? ' error' : '');
            setTimeout(() => { el.className = 'status-msg'; }, 2500);
        }

        function updateDirtyUI() {
            const count = dirtyChunks.size;
            document.getElementById('dirtyIndicator').style.display = count > 0 ? 'inline' : 'none';
            document.getElementById('dirtyCount').textContent = count;
            document.getElementById('saveBtn').disabled = count === 0;
        }

        function markDirty(filePath) {
            if (!dirtyChunks.has(filePath)) dirtyChunks.set(filePath, new Set());
            updateDirtyUI();
        }

        // Extract null-terminated string from data array starting at given offset
        function extractString(dataArray, startOffset) {
            let s = '';
            for (let i = startOffset; i < dataArray.length; i++) {
                if (dataArray[i] === 0) break;
                s += String.fromCharCode(dataArray[i]);
            }
            return s;
        }

        // Check if a chunk is an editable path based on its tag and parent FORM context
        function isEditablePath(chunk, parentFormNames) {
            if (!chunk.dataArray) return false;
            // Direct parent form match
            for (const pfn of parentFormNames) {
                const rules = EDITABLE_CHUNKS[pfn];
                if (rules && rules[chunk.tag] !== undefined) return true;
            }
            // SPS children: NAME chunks in numbered FORMs under SPS
            if (chunk.tag === 'NAME' && parentFormNames.some(p => /^\\d{4}$/.test(p)) &&
                parentFormNames.includes('SPS ')) return true;
            // SSHT subtree: NAME chunks containing texture/ or effect/
            if (chunk.tag === 'NAME' && parentFormNames.includes('SSHT') && chunk.dataArray) {
                const preview = extractString(chunk.dataArray, 0);
                if (preview.includes('texture/') || preview.includes('effect/')) return true;
            }
            return true; // Default: any NAME or SKTM is editable
        }

        function getStringOffset(chunk, parentFormNames) {
            for (const pfn of parentFormNames) {
                const rules = EDITABLE_CHUNKS[pfn];
                if (rules && rules[chunk.tag] !== undefined) return rules[chunk.tag];
            }
            return 0;
        }

        // Summary
        function renderSummary(summary, analysisTime) {
            const el = document.getElementById('summary');
            el.style.display = 'flex';
            const types = Object.entries(summary.filesByType).map(([t,c]) =>
                '<span class="type-badge">' + (FILE_TYPE_LABELS[t]||t) + ' ' + c + '</span>'
            ).join('');
            el.innerHTML =
                '<div class="summary-item"><span class="summary-label">Total:</span><span class="summary-value">' + summary.totalFiles + '</span></div>' +
                '<div class="summary-item"><span class="summary-label">Found:</span><span class="summary-value summary-ok">' + summary.existingFiles + '</span></div>' +
                (summary.missingFiles > 0 ? '<div class="summary-item"><span class="summary-label">Missing:</span><span class="summary-value summary-warn">' + summary.missingFiles + '</span></div>' : '') +
                '<div class="summary-item chain-types">' + types + '</div>';
            document.getElementById('analysisTime').textContent = analysisTime + 'ms';
        }

        // Chain node rendering
        function renderChainNode(node, depth) {
            const hasKids = node.children && node.children.length > 0;
            const hasIFF = !!node.iffTree;
            const isDDS = node.fileType === 'dds';
            const expandable = hasKids || hasIFF || isDDS;
            const collapsed = chainCollapsed.has(node.id);
            const fp = node.resolvedPath ? escapeAttr(node.resolvedPath) : '';
            const typeLabel = FILE_TYPE_LABELS[node.fileType] || '???';
            const fileName = node.referencePath ? node.referencePath.split('/').pop() : '';

            let h = '<div class="tree-node">';
            h += '<div class="tree-row">';
            for (let i = 0; i < depth; i++) h += '<span class="tree-indent"></span>';

            if (expandable) {
                h += '<span class="tree-toggle" onclick="toggleChainNode(\\'' + node.id + '\\')">' + (collapsed ? '\\u25B6' : '\\u25BC') + '</span>';
            } else {
                h += '<span class="tree-toggle leaf"></span>';
            }

            h += '<span class="tree-status ' + (node.exists ? 'ok' : 'missing') + '"></span>';
            h += '<span class="tree-type ' + node.fileType + '">' + typeLabel + '</span>';
            h += '<span class="tree-filename">' + escapeHtml(fileName) + '</span>';
            if (node.label) h += '<span class="tree-label">[' + escapeHtml(node.label) + ']</span>';

            if (node.exists && node.resolvedPath) {
                h += '<span class="tree-refpath clickable" onclick="event.stopPropagation();openFile(\\'' + fp + '\\')">' + escapeHtml(node.referencePath) + '</span>';
            } else {
                h += '<span class="tree-refpath' + (node.exists ? '' : ' missing-path') + '">' + escapeHtml(node.referencePath) + '</span>';
            }

            if (node.fileSize > 0) h += '<span class="tree-meta">' + formatSize(node.fileSize) + '</span>';
            if (node.source) h += '<span class="tree-source ' + node.source + '">' + node.source + '</span>';
            else if (!node.exists) h += '<span class="tree-meta" style="color:#f87171">MISSING</span>';
            if (node.editable) h += '<span class="editable-badge">\\u270F</span>';
            else if (node.exists && node.iffTree) h += '<span class="editable-badge">\\uD83D\\uDD12</span>';

            h += '</div>'; // tree-row

            if (!collapsed) {
                // IFF tree inline
                if (hasIFF) {
                    h += '<div class="iff-tree">';
                    h += renderIFFNode(node.iffTree, 0, node.editable, fp, []);
                    h += '</div>';
                }
                // DDS thumbnail
                if (isDDS && node.exists && node.resolvedPath) {
                    if (thumbnailCache[node.resolvedPath]) {
                        h += '<div class="dds-thumbnail"><img src="' + thumbnailCache[node.resolvedPath] + '"></div>';
                    } else {
                        h += '<div class="dds-loading" id="dds-' + node.id + '">Loading texture...</div>';
                        requestThumbnail(node.resolvedPath, node.id);
                    }
                }
                // Child chain nodes
                if (hasKids) {
                    h += '<div class="children">';
                    for (const c of node.children) h += renderChainNode(c, depth + 1);
                    h += '</div>';
                }
            }

            h += '</div>';
            return h;
        }

        function requestThumbnail(path, nodeId) {
            if (thumbnailCache[path] !== undefined) return; // already requested
            thumbnailCache[path] = null; // mark as pending
            vscode.postMessage({ type: 'getThumbnail', path: path });
        }

        // IFF tree rendering
        function renderIFFNode(iffNode, depth, editable, filePath, parentFormNames, formPath) {
            if (!iffNode) return '';
            const indent = depth * 16;
            formPath = formPath || '';

            if (iffNode.type === 'form') {
                const fn = iffNode.formName || '????';

                // Suppress FORM DERV entirely
                if (fn === 'DERV') return '';

                // Build a unique collapse key based on ancestry
                const myPath = formPath ? formPath + '>' + fn : fn;
                const colKey = 'FORM:' + myPath;

                // Version forms (00xx) default collapsed on first encounter this session
                const isVersionForm = /^[0-9]{4}$/.test(fn);
                if (isVersionForm && !defaultedVersionForms.has(colKey)) {
                    defaultedVersionForms.add(colKey);
                    tagCollapsed.add(colKey);
                }

                const collapsed = tagCollapsed.has(colKey);
                const childCtx = [...parentFormNames, fn];

                let h = '<div class="iff-node" style="padding-left:' + indent + 'px">';
                h += '<span class="iff-toggle" onclick="toggleTagCollapse(\\'' + escapeAttr(colKey) + '\\')">' + (collapsed ? '\\u25B6' : '\\u25BC') + '</span>';
                h += '<span class="iff-form-tag">FORM ' + escapeHtml(fn) + '</span>';
                h += '<span class="iff-size">(' + iffNode.size + ')</span>';
                h += '</div>';

                if (!collapsed && iffNode.children) {
                    h += '<div class="iff-form-children">';
                    for (const child of iffNode.children) {
                        h += renderIFFNode(child, depth + 1, editable, filePath, childCtx, myPath);
                    }
                    h += '</div>';
                }
                return h;
            }

            // Chunk node
            const tag = iffNode.tag;
            const propName = iffNode.propertyName || '';
            if (SUPPRESSED.has(propName)) return '';
            const displayName = propName || tag;
            const collapseKey = propName || tag;
            const isCollapsed = tagCollapsed.has(collapseKey);
            const hasData = !!iffNode.dataArray;
            const isLarge = !hasData && (iffNode.fullSize || 0) > 256;

            // Determine if this is an editable path chunk
            const isPath = hasData && (tag === 'NAME' || tag === 'SKTM' || tag === 'CHLD');

            if (isPath) {
                const strOff = getStringOffset(iffNode, parentFormNames);
                const pathVal = extractString(iffNode.dataArray, strOff);
                const readOnly = !editable;
                const isDirty = dirtyChunks.has(filePath) && dirtyChunks.get(filePath).has(iffNode.offset);

                let h = '<div class="iff-editable" style="padding-left:' + indent + 'px">';
                h += '<span class="iff-chunk-tag">' + escapeHtml(displayName) + '</span>';
                h += '<input type="text" class="path-input' + (isDirty ? ' dirty' : '') + '"';
                h += ' value="' + escapeHtml(pathVal) + '"';
                h += ' data-offset="' + iffNode.offset + '"';
                h += ' data-file="' + escapeAttr(filePath) + '"';
                h += ' data-tag="' + tag + '"';
                h += ' data-str-off="' + strOff + '"';
                if (readOnly) h += ' readonly';
                h += ' onchange="handlePathChange(this)"';
                h += '>';
                if (readOnly) h += '<span class="lock-icon">\\uD83D\\uDD12</span>';
                h += '</div>';
                return h;
            }

            // Large binary chunk - just show display name + size
            if (isLarge) {
                let h = '<div class="iff-binary" style="padding-left:' + indent + 'px"';
                h += ' onclick="toggleTagCollapse(\\'' + escapeAttr(collapseKey) + '\\')">';
                h += '<span class="iff-chunk-tag">' + escapeHtml(displayName) + '</span>';
                h += '<span class="iff-size"> (' + formatSize(iffNode.fullSize) + ')</span>';
                h += '</div>';
                return h;
            }

            // Small chunk - check for saved template to auto-apply
            if (hasData) {
                const savedTmpl = propName ? getTemplate(propName) : '';
                const savedItems = savedTmpl ? savedTmpl.split(',').map(s => s.trim()).filter(s => s) : [];
                const isOpen = openTemplateChunk && openTemplateChunk.offset === iffNode.offset &&
                               openTemplateChunk.filePath === filePath;

                // If a saved template exists, render parsed values inline (no click needed)
                if (savedItems.length > 0 && !isOpen) {
                    let h = '<div class="iff-templated" style="padding-left:' + indent + 'px">';
                    h += '<span class="iff-chunk-tag clickable" onclick="toggleTemplate(\\'' + escapeAttr(filePath) + '\\',' + iffNode.offset + ',\\'' + tag + '\\',\\'' + escapeAttr(propName) + '\\')">' + escapeHtml(displayName) + '</span>';
                    const parsed = parseWithTemplate(iffNode.dataArray, savedItems);
                    const isDirty = dirtyChunks.has(filePath) && dirtyChunks.get(filePath).has(iffNode.offset);
                    const tmplStr = savedItems.join(',');
                    parsed.forEach((f, i) => {
                        h += '<span class="inline-field">';
                        if (f.type === 'bool') {
                            h += '<select class="inline-input' + (isDirty ? ' dirty' : '') + '"';
                            h += ' data-idx="' + i + '" data-file="' + escapeAttr(filePath) + '"';
                            h += ' data-offset="' + iffNode.offset + '" data-tmpl="' + escapeAttr(tmplStr) + '"';
                            h += ' onchange="handleInlineFieldChange(this)" ' + (!editable ? 'disabled' : '') + '>';
                            h += '<option value="true"' + (f.value ? ' selected' : '') + '>True</option>';
                            h += '<option value="false"' + (!f.value ? ' selected' : '') + '>False</option>';
                            h += '</select>';
                        } else if (f.type === 'string') {
                            h += '<input type="text" class="inline-input' + (isDirty ? ' dirty' : '') + '"';
                            h += ' value="' + escapeHtml(f.value) + '" data-idx="' + i + '"';
                            h += ' data-file="' + escapeAttr(filePath) + '" data-offset="' + iffNode.offset + '"';
                            h += ' data-tmpl="' + escapeAttr(tmplStr) + '"';
                            h += ' onchange="handleInlineFieldChange(this)" ' + (!editable ? 'readonly' : '') + '>';
                        } else {
                            const step = (f.type === 'float') ? 'any' : '1';
                            h += '<input type="number" class="inline-input' + (isDirty ? ' dirty' : '') + '"';
                            h += ' value="' + f.value + '" step="' + step + '" data-idx="' + i + '"';
                            h += ' data-file="' + escapeAttr(filePath) + '" data-offset="' + iffNode.offset + '"';
                            h += ' data-tmpl="' + escapeAttr(tmplStr) + '"';
                            h += ' onchange="handleInlineFieldChange(this)" ' + (!editable ? 'readonly' : '') + '>';
                        }
                        h += '</span>';
                    });
                    h += '</div>';
                    return h;
                }

                // No saved template or template editor is open - show clickable chunk
                let h = '<div class="iff-binary" style="padding-left:' + indent + 'px"';
                h += ' onclick="toggleTemplate(\\'' + escapeAttr(filePath) + '\\',' + iffNode.offset + ',\\'' + tag + '\\',\\'' + escapeAttr(propName) + '\\')">';
                h += '<span class="iff-chunk-tag">' + escapeHtml(displayName) + '</span>';
                h += '<span class="iff-size"> (' + (iffNode.fullSize || iffNode.dataArray.length) + ' bytes)</span>';
                h += '</div>';

                if (isOpen) {
                    h += renderTemplateSection(iffNode, editable, filePath);
                }
                return h;
            }

            // Chunk with no data sent (medium-large, > 256 bytes)
            let h = '<div class="iff-binary" style="padding-left:' + indent + 'px">';
            h += '<span class="iff-chunk-tag">' + escapeHtml(displayName) + '</span>';
            if (iffNode.fullSize) h += '<span class="iff-size"> (' + formatSize(iffNode.fullSize) + ')</span>';
            else h += '<span class="iff-size"> (' + iffNode.size + ')</span>';
            h += '</div>';
            return h;
        }

        // Template pill section
        function toggleTemplate(filePath, offset, tag, propName) {
            if (openTemplateChunk && openTemplateChunk.offset === offset && openTemplateChunk.filePath === filePath) {
                openTemplateChunk = null;
            } else {
                openTemplateChunk = { filePath, offset, tag, propName: propName || tag };
                const saved = getTemplate(propName || tag);
                templateItems = saved ? saved.split(',').map(s => s.trim()).filter(s => s) : [];
            }
            renderTree();
        }

        function renderTemplateSection(chunk, editable, filePath) {
            const propName = chunk.propertyName || chunk.tag;
            let h = '<div class="template-section">';

            // Pills
            h += '<div class="template-pills">';
            ['string','bool','byte','short','ushort','int','uint','float'].forEach(t => {
                h += '<button class="pill" onclick="event.stopPropagation();addPill(\\'' + t + '\\')">' + t + '</button>';
            });
            h += '</div>';

            // Current template display
            h += '<div class="template-display">';
            templateItems.forEach((t, i) => {
                h += '<span class="template-item">' + t;
                h += '<span class="remove" onclick="event.stopPropagation();removePill(' + i + ')">&times;</span>';
                h += '</span>';
            });
            if (templateItems.length === 0) h += '<span style="opacity:0.4;font-size:11px">Click type pills to build a template</span>';
            h += '</div>';

            // Buttons
            h += '<div class="template-buttons">';
            h += '<button onclick="event.stopPropagation();clearTemplate()">Clear</button>';
            h += '<button class="primary" onclick="event.stopPropagation();saveCurrentTemplate(\\'' + escapeAttr(propName) + '\\')">Save for ' + escapeHtml(propName) + '</button>';
            h += '<span class="template-saved" id="tmplSaved"></span>';
            h += '</div>';

            // Parsed fields
            if (templateItems.length > 0 && chunk.dataArray) {
                h += '<div class="template-fields">';
                const parsed = parseWithTemplate(chunk.dataArray, templateItems);
                parsed.forEach((f, i) => {
                    h += '<div class="template-field">';
                    h += '<span class="template-field-name">' + f.type + '</span>';
                    if (f.type === 'bool') {
                        h += '<select data-idx="' + i + '" data-file="' + escapeAttr(filePath) + '" data-offset="' + chunk.offset + '"';
                        h += ' onchange="handleTemplateFieldChange()" ' + (!editable ? 'disabled' : '') + '>';
                        h += '<option value="true"' + (f.value ? ' selected' : '') + '>True</option>';
                        h += '<option value="false"' + (!f.value ? ' selected' : '') + '>False</option>';
                        h += '</select>';
                    } else if (f.type === 'string') {
                        h += '<input type="text" value="' + escapeHtml(f.value) + '" data-idx="' + i + '"';
                        h += ' data-file="' + escapeAttr(filePath) + '" data-offset="' + chunk.offset + '"';
                        h += ' onchange="handleTemplateFieldChange()" ' + (!editable ? 'readonly' : '') + '>';
                    } else {
                        const step = (f.type === 'float') ? 'any' : '1';
                        h += '<input type="number" value="' + f.value + '" step="' + step + '" data-idx="' + i + '"';
                        h += ' data-file="' + escapeAttr(filePath) + '" data-offset="' + chunk.offset + '"';
                        h += ' onchange="handleTemplateFieldChange()" ' + (!editable ? 'readonly' : '') + '>';
                    }
                    h += '</div>';
                });
                h += '</div>';
            } else if (chunk.dataArray) {
                // Show hex preview when no template
                let hex = '';
                for (let i = 0; i < Math.min(chunk.dataArray.length, 64); i++) {
                    hex += chunk.dataArray[i].toString(16).padStart(2, '0') + ' ';
                }
                h += '<div class="hex-preview">' + hex.trim() + '</div>';
            }

            h += '</div>';
            return h;
        }

        function addPill(type) { templateItems.push(type); renderTree(); }
        function removePill(idx) { templateItems.splice(idx, 1); renderTree(); }
        function clearTemplate() { templateItems = []; renderTree(); }
        function saveCurrentTemplate(propName) {
            saveTemplate(propName, templateItems.join(', '));
            showStatus('Template saved for ' + propName);
        }

        // Parse binary data with template
        function parseWithTemplate(dataArray, types) {
            const result = [];
            let off = 0;
            for (const type of types) {
                if (off >= dataArray.length) break;
                let value;
                switch (type) {
                    case 'string': {
                        let end = off;
                        while (end < dataArray.length && dataArray[end] !== 0) end++;
                        value = '';
                        for (let i = off; i < end; i++) value += String.fromCharCode(dataArray[i]);
                        off = end + 1;
                        break;
                    }
                    case 'bool': value = dataArray[off] !== 0; off += 1; break;
                    case 'byte': value = dataArray[off]; off += 1; break;
                    case 'short': {
                        const buf = new DataView(new Uint8Array(dataArray.slice(off, off + 2)).buffer);
                        value = buf.getInt16(0, true); off += 2; break;
                    }
                    case 'ushort': {
                        const buf = new DataView(new Uint8Array(dataArray.slice(off, off + 2)).buffer);
                        value = buf.getUint16(0, true); off += 2; break;
                    }
                    case 'int': {
                        const buf = new DataView(new Uint8Array(dataArray.slice(off, off + 4)).buffer);
                        value = buf.getInt32(0, true); off += 4; break;
                    }
                    case 'uint': {
                        const buf = new DataView(new Uint8Array(dataArray.slice(off, off + 4)).buffer);
                        value = buf.getUint32(0, true); off += 4; break;
                    }
                    case 'float': {
                        const buf = new DataView(new Uint8Array(dataArray.slice(off, off + 4)).buffer);
                        value = parseFloat(buf.getFloat32(0, true).toFixed(6)); off += 4; break;
                    }
                    default: value = dataArray[off]; off += 1;
                }
                result.push({ type, value });
            }
            return result;
        }

        // Serialize template fields back to bytes
        function serializeFromTemplate(types) {
            const fields = document.querySelectorAll('.template-field input, .template-field select');
            const bytes = [];
            let fieldIdx = 0;
            for (const type of types) {
                if (fieldIdx >= fields.length) break;
                const el = fields[fieldIdx++];
                switch (type) {
                    case 'string': {
                        const val = el.value;
                        for (let i = 0; i < val.length; i++) bytes.push(val.charCodeAt(i) & 0xFF);
                        bytes.push(0);
                        break;
                    }
                    case 'bool': bytes.push(el.value === 'true' ? 1 : 0); break;
                    case 'byte': bytes.push(Math.max(0, Math.min(255, parseInt(el.value) || 0))); break;
                    case 'short': case 'ushort': {
                        const v = parseInt(el.value) || 0;
                        const buf = new ArrayBuffer(2);
                        if (type === 'short') new DataView(buf).setInt16(0, v, true);
                        else new DataView(buf).setUint16(0, v, true);
                        const a = new Uint8Array(buf);
                        bytes.push(a[0], a[1]);
                        break;
                    }
                    case 'int': case 'uint': {
                        const v = parseInt(el.value) || 0;
                        const buf = new ArrayBuffer(4);
                        if (type === 'int') new DataView(buf).setInt32(0, v, true);
                        else new DataView(buf).setUint32(0, v, true);
                        const a = new Uint8Array(buf);
                        bytes.push(a[0], a[1], a[2], a[3]);
                        break;
                    }
                    case 'float': {
                        const buf = new ArrayBuffer(4);
                        new DataView(buf).setFloat32(0, parseFloat(el.value) || 0, true);
                        const a = new Uint8Array(buf);
                        bytes.push(a[0], a[1], a[2], a[3]);
                        break;
                    }
                }
            }
            return bytes;
        }

        // Handle path input change
        function handlePathChange(input) {
            const filePath = input.dataset.file;
            const offset = parseInt(input.dataset.offset);
            const tag = input.dataset.tag;
            const strOff = parseInt(input.dataset.strOff) || 0;
            const newPath = input.value;

            // Build new chunk data
            const newBytes = [];
            if (strOff === 4) {
                // CHLD: preserve first 4 bytes (LE index), request original data
                // For now, get original from the IFF tree data in currentData
                const origData = findChunkData(filePath, offset);
                if (origData) {
                    for (let i = 0; i < 4; i++) newBytes.push(origData[i]);
                } else {
                    newBytes.push(0, 0, 0, 0);
                }
            }
            for (let i = 0; i < newPath.length; i++) newBytes.push(newPath.charCodeAt(i) & 0xFF);
            newBytes.push(0); // null terminator

            vscode.postMessage({ type: 'updateChunk', filePath, chunkOffset: offset, newData: newBytes });
            input.classList.add('dirty');
            markDirty(filePath);
            if (!dirtyChunks.has(filePath)) dirtyChunks.set(filePath, new Set());
            dirtyChunks.get(filePath).add(offset);
            showStatus('Modified: ' + tag + ' in ' + filePath.split('/').pop());
        }

        // Handle inline template field change (auto-applied templates)
        function handleInlineFieldChange(el) {
            const filePath = el.dataset.file;
            const offset = parseInt(el.dataset.offset);
            const tmplStr = el.dataset.tmpl;
            const types = tmplStr.split(',').map(s => s.trim()).filter(s => s);

            // Find the parent container and collect all inline fields for this chunk
            const container = el.closest('.iff-templated');
            const fields = container.querySelectorAll('.inline-input');
            const bytes = serializeFromFields(types, fields);

            vscode.postMessage({ type: 'updateChunk', filePath, chunkOffset: offset, newData: bytes });
            el.classList.add('dirty');
            markDirty(filePath);
            if (!dirtyChunks.has(filePath)) dirtyChunks.set(filePath, new Set());
            dirtyChunks.get(filePath).add(offset);
            showStatus('Modified in ' + filePath.split('/').pop());
        }

        // Serialize fields to bytes given types and DOM elements
        function serializeFromFields(types, fields) {
            const bytes = [];
            let fieldIdx = 0;
            for (const type of types) {
                if (fieldIdx >= fields.length) break;
                const el = fields[fieldIdx++];
                switch (type) {
                    case 'string': {
                        const val = el.value;
                        for (let i = 0; i < val.length; i++) bytes.push(val.charCodeAt(i) & 0xFF);
                        bytes.push(0);
                        break;
                    }
                    case 'bool': bytes.push(el.value === 'true' ? 1 : 0); break;
                    case 'byte': bytes.push(Math.max(0, Math.min(255, parseInt(el.value) || 0))); break;
                    case 'short': case 'ushort': {
                        const v = parseInt(el.value) || 0;
                        const buf = new ArrayBuffer(2);
                        if (type === 'short') new DataView(buf).setInt16(0, v, true);
                        else new DataView(buf).setUint16(0, v, true);
                        const a = new Uint8Array(buf);
                        bytes.push(a[0], a[1]);
                        break;
                    }
                    case 'int': case 'uint': {
                        const v = parseInt(el.value) || 0;
                        const buf = new ArrayBuffer(4);
                        if (type === 'int') new DataView(buf).setInt32(0, v, true);
                        else new DataView(buf).setUint32(0, v, true);
                        const a = new Uint8Array(buf);
                        bytes.push(a[0], a[1], a[2], a[3]);
                        break;
                    }
                    case 'float': {
                        const buf = new ArrayBuffer(4);
                        new DataView(buf).setFloat32(0, parseFloat(el.value) || 0, true);
                        const a = new Uint8Array(buf);
                        bytes.push(a[0], a[1], a[2], a[3]);
                        break;
                    }
                }
            }
            return bytes;
        }

        // Handle template field change
        function handleTemplateFieldChange() {
            if (!openTemplateChunk) return;
            const { filePath, offset } = openTemplateChunk;
            const newBytes = serializeFromTemplate(templateItems);
            vscode.postMessage({ type: 'updateChunk', filePath, chunkOffset: offset, newData: newBytes });
            markDirty(filePath);
            if (!dirtyChunks.has(filePath)) dirtyChunks.set(filePath, new Set());
            dirtyChunks.get(filePath).add(offset);
            showStatus('Modified: ' + (openTemplateChunk.propName || openTemplateChunk.tag) + ' in ' + filePath.split('/').pop());
        }

        // Find chunk data in current analysis tree
        function findChunkData(filePath, offset) {
            if (!currentData) return null;
            function search(node) {
                if (node.resolvedPath === filePath && node.iffTree) {
                    return searchIFF(node.iffTree, offset);
                }
                if (node.children) {
                    for (const c of node.children) {
                        const r = search(c);
                        if (r) return r;
                    }
                }
                return null;
            }
            function searchIFF(iff, off) {
                if (iff.type === 'chunk' && iff.offset === off) return iff.dataArray;
                if (iff.children) {
                    for (const c of iff.children) {
                        const r = searchIFF(c, off);
                        if (r) return r;
                    }
                }
                return null;
            }
            return search(currentData.rootNode);
        }

        function renderTree() {
            if (!currentData) return;
            document.getElementById('content').innerHTML = '<div class="tree">' + renderChainNode(currentData.rootNode, 0) + '</div>';
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.type) {
                case 'analysis':
                    currentData = msg.data;
                    chainCollapsed.clear();
                    dirtyChunks.clear();
                    openTemplateChunk = null;
                    updateDirtyUI();
                    renderSummary(msg.data.summary, msg.data.analysisTime);
                    renderTree();
                    checkWorkingBar();
                    break;
                case 'error':
                    document.getElementById('content').innerHTML = '<div class="error-box">' + escapeHtml(msg.message) + '</div>';
                    break;
                case 'chunkUpdated':
                    // Update dirty count from backend
                    if (msg.dirtyCount !== undefined) {
                        document.getElementById('dirtyCount').textContent = msg.dirtyCount;
                        document.getElementById('dirtyIndicator').style.display = msg.dirtyCount > 0 ? 'inline' : 'none';
                        document.getElementById('saveBtn').disabled = msg.dirtyCount === 0;
                    }
                    break;
                case 'saved':
                    dirtyChunks.clear();
                    updateDirtyUI();
                    const ok = msg.results.filter(r => r.success).length;
                    const fail = msg.results.filter(r => !r.success).length;
                    if (fail > 0) showStatus(ok + ' saved, ' + fail + ' failed', true);
                    else showStatus(ok + ' file(s) saved');
                    // Remove dirty styling
                    document.querySelectorAll('.path-input.dirty').forEach(el => el.classList.remove('dirty'));
                    break;
                case 'chunkData':
                    // Update the chunk's dataArray in current data for template editing
                    // (for large chunks that were loaded on demand)
                    break;
                case 'thumbnailData':
                    if (msg.dataURI) {
                        thumbnailCache[msg.path] = msg.dataURI;
                    } else {
                        thumbnailCache[msg.path] = ''; // failed, don't retry
                    }
                    renderTree();
                    break;
            }
        });
    </script>
</body>
</html>`;
    }
}
