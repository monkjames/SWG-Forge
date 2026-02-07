import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TREWriter } from './treWriter';
import { Validator, ValidationResult } from './validators';

interface FileInfo {
    relativePath: string;
    absolutePath: string;
    size: number;
    modifiedTime: Date;
    isNew: boolean;  // Not in vanilla/infinity
}

export class TREBuilderProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _files: FileInfo[] = [];
    private _validationResults: ValidationResult[] = [];
    private _isBuilding: boolean = false;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlContent();

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'build':
                    this.build(false);
                    break;
                case 'forceBuild':
                    this.build(true);
                    break;
                case 'refresh':
                    this.refresh();
                    break;
                case 'validate':
                    this.validate();
                    break;
                case 'openFile':
                    this.openFile(message.path);
                    break;
            }
        });

        // Initial load
        this.refresh();
    }

    public async refresh() {
        await this._scanFiles();
        this._updateView();
    }

    public async validate() {
        if (!this._view) return;

        this._postMessage({ type: 'validating' });

        const workspaceFolder = this._getWorkspaceFolder();
        if (!workspaceFolder) return;

        const validator = new Validator(workspaceFolder);
        this._validationResults = await validator.runAll(this._files);

        this._updateView();
    }

    public async build(force: boolean = false) {
        if (!this._view || this._isBuilding) return;

        const workspaceFolder = this._getWorkspaceFolder();
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }

        this._isBuilding = true;
        this._postMessage({ type: 'building' });

        try {
            // Run validation first
            const validator = new Validator(workspaceFolder);
            this._validationResults = await validator.runAll(this._files);

            // Check for errors (not warnings) - skip if force build
            const errors = this._validationResults.filter(r => r.severity === 'error');
            if (errors.length > 0 && !force) {
                this._isBuilding = false;
                this._updateView();
                vscode.window.showWarningMessage(`Validation found ${errors.length} error(s). Use Force Build to ignore.`);
                return;
            }

            // Get output path from config
            const config = vscode.workspace.getConfiguration('treBuilder');
            const outputPath = config.get<string>('outputPath', 'tre4/infinity_wicked_special.tre');
            const fullOutputPath = path.join(workspaceFolder, outputPath);

            // Ensure output directory exists
            const outputDir = path.dirname(fullOutputPath);
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            // Backup existing TRE if it exists
            if (fs.existsSync(fullOutputPath)) {
                const backupPath = fullOutputPath + '.backup';
                fs.copyFileSync(fullOutputPath, backupPath);
            }

            // Build the TRE
            const writer = new TREWriter();
            const workingFolder = path.join(workspaceFolder, config.get<string>('workingFolder', 'tre/working'));

            await writer.build(workingFolder, fullOutputPath, (status) => {
                this._postMessage({ type: 'buildStatus', status });
            });

            this._isBuilding = false;
            this._updateView();

            // Generate client config after successful TRE build
            await this._generateClientConfig(workspaceFolder, outputDir);

            const warnings = this._validationResults.filter(r => r.severity === 'warning');
            const warningText = warnings.length > 0 ? ` (${warnings.length} warning(s))` : '';
            vscode.window.showInformationMessage(`TRE built successfully: ${outputPath}${warningText}`);

        } catch (error: any) {
            this._isBuilding = false;
            this._updateView();
            vscode.window.showErrorMessage(`Build failed: ${error.message}`);
        }
    }

    private openFile(relativePath: string) {
        const workspaceFolder = this._getWorkspaceFolder();
        if (!workspaceFolder) return;

        const config = vscode.workspace.getConfiguration('treBuilder');
        const workingFolder = config.get<string>('workingFolder', 'tre/working');
        const fullPath = path.join(workspaceFolder, workingFolder, relativePath);

        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fullPath));
    }

    private async _scanFiles() {
        const workspaceFolder = this._getWorkspaceFolder();
        if (!workspaceFolder) return;

        const config = vscode.workspace.getConfiguration('treBuilder');
        const workingFolder = config.get<string>('workingFolder', 'tre/working');
        const workingPath = path.join(workspaceFolder, workingFolder);

        if (!fs.existsSync(workingPath)) {
            this._files = [];
            return;
        }

        // Scan for all files recursively
        this._files = [];
        await this._scanDirectory(workingPath, workingPath, workspaceFolder);

        // Sort by modification time (newest first)
        this._files.sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime());
    }

    private async _scanDirectory(dir: string, rootDir: string, workspaceFolder: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                await this._scanDirectory(fullPath, rootDir, workspaceFolder);
            } else if (entry.isFile()) {
                const relativePath = path.relative(rootDir, fullPath);
                const stats = fs.statSync(fullPath);

                // Check if file exists in vanilla or infinity (to determine if "new")
                const vanillaPath = path.join(workspaceFolder, 'tre/vanilla', relativePath);
                const infinityPath = path.join(workspaceFolder, 'tre/infinity', relativePath);
                const isNew = !fs.existsSync(vanillaPath) && !fs.existsSync(infinityPath);

                this._files.push({
                    relativePath: relativePath.replace(/\\/g, '/'),
                    absolutePath: fullPath,
                    size: stats.size,
                    modifiedTime: stats.mtime,
                    isNew
                });
            }
        }
    }

    private async _generateClientConfig(workspaceFolder: string, outputDir: string): Promise<void> {
        try {
            // Generate swgemu_live.cfg from config-local.lua (source of truth)
            const configLuaPath = path.join(workspaceFolder, 'infinity4.0.0/MMOCoreORB/bin/conf/config-local.lua');
            const destCfgPath = path.join(outputDir, 'swgemu_live.cfg');

            if (!fs.existsSync(configLuaPath)) {
                this._postMessage({ type: 'buildStatus', status: 'Warning: config-local.lua not found, skipping cfg generation' });
                // Generate manifest for fast sync
                await this._generateManifest(outputDir);
                return;
            }

            let luaContent = fs.readFileSync(configLuaPath, 'utf-8');

            // Strip Lua block comments --[[ ... ]] before parsing
            luaContent = luaContent.replace(/--\[\[[\s\S]*?\]\]/g, '');

            // Parse TreFiles list from config-local.lua
            // Match the TreFiles = { ... } block
            const treFilesMatch = luaContent.match(/TreFiles\s*=\s*\{([\s\S]*?)\}/);
            if (!treFilesMatch) {
                this._postMessage({ type: 'buildStatus', status: 'Warning: TreFiles not found in config-local.lua' });
                await this._generateManifest(outputDir);
                return;
            }

            // Extract active (non-commented) TRE filenames in order
            const treBlock = treFilesMatch[1];
            const activeFiles: string[] = [];
            for (const line of treBlock.split('\n')) {
                const trimmed = line.trim();
                // Skip commented-out lines and empty lines
                if (trimmed.startsWith('--') || !trimmed) continue;
                // Match quoted filename
                const fileMatch = trimmed.match(/"([^"]+\.tre)"/);
                if (fileMatch) {
                    activeFiles.push(fileMatch[1]);
                }
            }

            if (activeFiles.length === 0) {
                this._postMessage({ type: 'buildStatus', status: 'Warning: No active TRE files found' });
                await this._generateManifest(outputDir);
                return;
            }

            // Generate searchTree entries with proper priorities
            // Priority descends from (count - 1) to 0
            // Files containing "sku1" get prefix "01", everything else gets "00"
            const maxPriority = activeFiles.length;
            let cfgLines: string[] = [];
            cfgLines.push('[SharedFile]');
            cfgLines.push(`\tmaxSearchPriority=${maxPriority}`);

            for (let i = 0; i < activeFiles.length; i++) {
                const filename = activeFiles[i];
                const priority = maxPriority - 1 - i;
                const sku = filename.includes('sku1') ? '01' : '00';
                cfgLines.push(`\tsearchTree_${sku}_${priority}=${filename}`);
            }

            // Append standard client sections
            cfgLines.push('');
            cfgLines.push('[SharedNetwork]');
            cfgLines.push('\tnetworkHandlerDispatchThrottle=true');
            cfgLines.push('');
            cfgLines.push('[ClientUserInterface]');
            cfgLines.push('\tmessageOfTheDayTable=live_motd');
            cfgLines.push('');
            cfgLines.push('[SwgClientUserInterface/SwgCuiService]');
            cfgLines.push('\tknownIssuesArticle=10424');
            cfgLines.push('');
            cfgLines.push('[Station]');
            cfgLines.push('subscriptionFeatures=1');
            cfgLines.push('gameFeatures=65535');
            cfgLines.push('');

            fs.writeFileSync(destCfgPath, cfgLines.join('\n'));
            this._postMessage({ type: 'buildStatus', status: `Generated swgemu_live.cfg (${activeFiles.length} TRE files)` });

            // Generate manifest for fast sync
            await this._generateManifest(outputDir);
        } catch (error: any) {
            // Non-fatal - just log the error
            console.error('Failed to generate client config:', error.message);
        }
    }

    private async _generateManifest(outputDir: string): Promise<void> {
        const crypto = require('crypto');
        const manifest: any = {
            version: '1.0',
            generated: new Date().toISOString(),
            files: {}
        };

        this._postMessage({ type: 'buildStatus', status: 'Generating sync manifest...' });

        // Scan output directory for .tre and .cfg files
        const entries = fs.readdirSync(outputDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (ext !== '.tre' && ext !== '.cfg') continue;

            const filePath = path.join(outputDir, entry.name);
            const stats = fs.statSync(filePath);

            // Calculate MD5 checksum
            const hash = crypto.createHash('md5');
            const fileBuffer = fs.readFileSync(filePath);
            hash.update(fileBuffer);
            const checksum = hash.digest('hex');

            manifest.files[entry.name] = {
                size: stats.size,
                checksum: checksum
            };
        }

        // Write manifest
        const manifestPath = path.join(outputDir, 'sync_manifest.json');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        this._postMessage({ type: 'buildStatus', status: `Manifest: ${Object.keys(manifest.files).length} files` });
    }

    private _getWorkspaceFolder(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
    }

    private _postMessage(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    private _updateView() {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'update',
                files: this._files.map(f => ({
                    ...f,
                    modifiedTime: f.modifiedTime.toISOString()
                })),
                validations: this._validationResults,
                isBuilding: this._isBuilding
            });
        }
    }

    private _getHtmlContent(): string {
        const config = vscode.workspace.getConfiguration('treBuilder');
        const outputPath = config.get<string>('outputPath', 'tre4/infinity_wicked_special.tre');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TRE Builder</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            padding: 0;
            margin: 0;
        }
        .header {
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
        }
        .target {
            font-size: 11px;
            opacity: 0.8;
            margin-bottom: 8px;
        }
        .stats {
            font-size: 12px;
            display: flex;
            gap: 12px;
        }
        .stat {
            opacity: 0.7;
        }
        .buttons {
            display: flex;
            gap: 6px;
            margin-top: 10px;
        }
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            border-radius: 3px;
            font-size: 12px;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .build-btn {
            background: var(--vscode-button-prominentBackground, #0e639c);
        }
        .force-btn {
            background: #b45309;
        }
        .force-btn:hover {
            background: #d97706;
        }
        .section {
            padding: 8px 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .section-header {
            font-weight: bold;
            font-size: 11px;
            text-transform: uppercase;
            opacity: 0.7;
            margin-bottom: 6px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .section-header:hover {
            opacity: 1;
        }
        .file-list {
            max-height: 300px;
            overflow-y: auto;
        }
        .file-item {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 3px 0;
            font-size: 12px;
            cursor: pointer;
        }
        .file-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .file-icon {
            opacity: 0.6;
        }
        .file-name {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .file-meta {
            font-size: 10px;
            opacity: 0.5;
        }
        .file-new {
            color: #4ade80;
            font-size: 10px;
            font-weight: bold;
        }
        .validation-item {
            display: flex;
            align-items: flex-start;
            gap: 6px;
            padding: 4px 0;
            font-size: 12px;
        }
        .validation-icon {
            flex-shrink: 0;
        }
        .validation-error { color: #f87171; }
        .validation-warning { color: #fbbf24; }
        .validation-ok { color: #4ade80; }
        .status {
            padding: 10px;
            text-align: center;
            font-size: 12px;
        }
        .spinner {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid var(--vscode-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-right: 8px;
            vertical-align: middle;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        .empty {
            padding: 20px;
            text-align: center;
            opacity: 0.6;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="target">Target: <strong>${outputPath}</strong></div>
        <div class="stats">
            <span class="stat" id="fileCount">Files: 0</span>
            <span class="stat" id="totalSize">Size: 0 KB</span>
        </div>
        <div class="buttons">
            <button class="build-btn" id="buildBtn" onclick="build()">Build TRE</button>
            <button class="force-btn" id="forceBtn" onclick="forceBuild()" style="display:none">Force Build</button>
            <button onclick="validate()">Validate</button>
            <button onclick="refresh()">Refresh</button>
        </div>
    </div>

    <div id="status" class="status" style="display:none"></div>

    <div class="section" id="validationSection" style="display:none">
        <div class="section-header" onclick="toggleSection('validations')">
            <span id="validationToggle">▼</span> Validation Results
        </div>
        <div id="validations"></div>
    </div>

    <div class="section">
        <div class="section-header" onclick="toggleSection('files')">
            <span id="filesToggle">▼</span> Files (by last modified)
        </div>
        <div class="file-list" id="fileList"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let files = [];
        let validations = [];
        let sectionsCollapsed = { files: false, validations: false };

        function build() {
            vscode.postMessage({ command: 'build' });
        }

        function forceBuild() {
            vscode.postMessage({ command: 'forceBuild' });
        }

        function refresh() {
            vscode.postMessage({ command: 'refresh' });
        }

        function validate() {
            vscode.postMessage({ command: 'validate' });
        }

        function openFile(path) {
            vscode.postMessage({ command: 'openFile', path: path });
        }

        function toggleSection(section) {
            sectionsCollapsed[section] = !sectionsCollapsed[section];
            renderFiles();
            renderValidations();
        }

        function formatSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        }

        function formatTime(isoString) {
            const date = new Date(isoString);
            const now = new Date();
            const diffMs = now - date;
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffDays = Math.floor(diffMs / 86400000);

            if (diffMins < 1) return 'just now';
            if (diffMins < 60) return diffMins + 'm ago';
            if (diffHours < 24) return diffHours + 'h ago';
            if (diffDays < 7) return diffDays + 'd ago';
            return date.toLocaleDateString();
        }

        function getFileIcon(path) {
            if (path.endsWith('.iff')) return '📦';
            if (path.endsWith('.stf')) return '📝';
            if (path.endsWith('.trn')) return '🗺️';
            if (path.endsWith('.ws')) return '🌍';
            return '📄';
        }

        function renderFiles() {
            const container = document.getElementById('fileList');
            const toggle = document.getElementById('filesToggle');
            toggle.textContent = sectionsCollapsed.files ? '▶' : '▼';

            if (sectionsCollapsed.files) {
                container.innerHTML = '';
                return;
            }

            if (files.length === 0) {
                container.innerHTML = '<div class="empty">No files in working folder</div>';
                return;
            }

            container.innerHTML = files.map(f => {
                const newBadge = f.isNew ? '<span class="file-new">NEW</span>' : '';
                return '<div class="file-item" onclick="openFile(\\'' + f.relativePath.replace(/'/g, "\\\\'") + '\\')">' +
                    '<span class="file-icon">' + getFileIcon(f.relativePath) + '</span>' +
                    '<span class="file-name">' + f.relativePath + '</span>' +
                    newBadge +
                    '<span class="file-meta">' + formatTime(f.modifiedTime) + '</span>' +
                '</div>';
            }).join('');

            // Update stats
            document.getElementById('fileCount').textContent = 'Files: ' + files.length;
            const totalSize = files.reduce((sum, f) => sum + f.size, 0);
            document.getElementById('totalSize').textContent = 'Size: ' + formatSize(totalSize);
        }

        function renderValidations() {
            const section = document.getElementById('validationSection');
            const container = document.getElementById('validations');
            const toggle = document.getElementById('validationToggle');

            if (validations.length === 0) {
                section.style.display = 'none';
                return;
            }

            section.style.display = 'block';
            toggle.textContent = sectionsCollapsed.validations ? '▶' : '▼';

            if (sectionsCollapsed.validations) {
                container.innerHTML = '';
                return;
            }

            container.innerHTML = validations.map(v => {
                const iconClass = 'validation-' + (v.severity === 'error' ? 'error' : v.severity === 'warning' ? 'warning' : 'ok');
                const icon = v.severity === 'error' ? '❌' : v.severity === 'warning' ? '⚠️' : '✅';
                return '<div class="validation-item">' +
                    '<span class="validation-icon ' + iconClass + '">' + icon + '</span>' +
                    '<span>' + v.message + '</span>' +
                '</div>';
            }).join('');
        }

        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.type) {
                case 'update':
                    files = message.files || [];
                    validations = message.validations || [];
                    document.getElementById('buildBtn').disabled = message.isBuilding;
                    document.getElementById('forceBtn').disabled = message.isBuilding;
                    document.getElementById('status').style.display = 'none';
                    // Show Force Build button if there are validation errors
                    const hasErrors = validations.some(v => v.severity === 'error');
                    document.getElementById('forceBtn').style.display = hasErrors ? 'inline-block' : 'none';
                    renderFiles();
                    renderValidations();
                    break;

                case 'building':
                    document.getElementById('status').style.display = 'block';
                    document.getElementById('status').innerHTML = '<span class="spinner"></span>Building TRE...';
                    document.getElementById('buildBtn').disabled = true;
                    break;

                case 'validating':
                    document.getElementById('status').style.display = 'block';
                    document.getElementById('status').innerHTML = '<span class="spinner"></span>Running validations...';
                    break;

                case 'buildStatus':
                    document.getElementById('status').innerHTML = '<span class="spinner"></span>' + message.status;
                    break;
            }
        });

        // Request initial data
        refresh();
    </script>
</body>
</html>`;
    }
}
