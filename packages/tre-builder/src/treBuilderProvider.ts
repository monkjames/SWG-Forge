import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TREWriter } from './treWriter';
import { Validator, ValidationResult } from './validators';
import { parseCRCTable, addCRCEntries, serializeCRCTable } from '@swgemu/core';

interface FileInfo {
    relativePath: string;
    absolutePath: string;
    size: number;
    modifiedTime: Date;
    isNew: boolean;  // Not in vanilla/infinity
    changeStatus: 'new' | 'modified' | 'unchanged' | 'unknown';  // vs last build
}

interface SyncInfo {
    status: 'synced' | 'stale' | 'unknown';
    label: string;
}

interface BuildManifest {
    timestamp: number;
    mode: string;
    files: Record<string, { size: number; mtime: number }>;
}

export class TREBuilderProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _files: FileInfo[] = [];
    private _validationResults: ValidationResult[] = [];
    private _isBuilding: boolean = false;
    private readonly _extensionUri: vscode.Uri;

    private static readonly OUTPUT_PATH_KEY = 'treBuilder.lastOutputPath';
    private static readonly DEFAULT_OUTPUT = 'tre4/infinity_wicked1.tre';

    private static readonly MODE_KEY = 'treBuilder.mode';
    private static readonly MODES = {
        working: { folder: 'tre/working', defaultOutput: 'tre4/infinity_wicked1.tre', label: 'Working' },
        rnd:     { folder: 'tre/rnd',     defaultOutput: 'tre4/infinity_rnd.tre',     label: 'R&D'     },
    } as const;

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._extensionUri = _context.extensionUri;
    }

    private getOutputPath(): string {
        return this._context.globalState.get<string>(
            TREBuilderProvider.OUTPUT_PATH_KEY,
            TREBuilderProvider.DEFAULT_OUTPUT
        );
    }

    private async setOutputPath(value: string): Promise<void> {
        await this._context.globalState.update(TREBuilderProvider.OUTPUT_PATH_KEY, value);
    }

    private getMode(): 'working' | 'rnd' {
        return this._context.globalState.get<'working' | 'rnd'>(TREBuilderProvider.MODE_KEY, 'working');
    }

    private _getLastBuildManifest(): BuildManifest | null {
        const mode = this.getMode();
        return this._context.globalState.get<BuildManifest>(`treBuilder.buildManifest.${mode}`) || null;
    }

    private _saveBuildManifest(): void {
        const mode = this.getMode();
        const manifest: BuildManifest = {
            timestamp: Date.now(),
            mode,
            files: {}
        };
        for (const file of this._files) {
            manifest.files[file.relativePath] = {
                size: file.size,
                mtime: Math.floor(file.modifiedTime.getTime())
            };
        }
        this._context.globalState.update(`treBuilder.buildManifest.${mode}`, manifest);
    }

    private async setMode(mode: 'working' | 'rnd'): Promise<void> {
        await this._context.globalState.update(TREBuilderProvider.MODE_KEY, mode);
        // Auto-switch output path when it still matches the other mode's default
        const other = mode === 'working' ? TREBuilderProvider.MODES.rnd : TREBuilderProvider.MODES.working;
        if (this.getOutputPath() === other.defaultOutput) {
            await this.setOutputPath(TREBuilderProvider.MODES[mode].defaultOutput);
        }
    }

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
                case 'reset':
                    this.reset();
                    break;
                case 'validate':
                    this.validate();
                    break;
                case 'openFile':
                    this.openFile(message.path);
                    break;
                case 'fixCRC':
                    this.fixCRC();
                    break;
                case 'setOutputPath':
                    this.setOutputPath(message.path);
                    break;
                case 'setMode':
                    this.setMode(message.mode).then(() => this.refresh());
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

    public async reset() {
        this._validationResults = [];
        this._isBuilding = false;
        await this._scanFiles();
        this._updateView();
    }

    public async validate() {
        if (!this._view) return;

        this._postMessage({ type: 'validating' });

        const workspaceFolder = this._getWorkspaceFolder();
        if (!workspaceFolder) return;

        const validator = this._createValidator(workspaceFolder);
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
            const validator = this._createValidator(workspaceFolder);
            this._validationResults = await validator.runAll(this._files);

            // Check for errors (not warnings) - skip if force build
            const errors = this._validationResults.filter(r => r.severity === 'error');
            if (errors.length > 0 && !force) {
                this._isBuilding = false;
                this._updateView();
                vscode.window.showWarningMessage(`Validation found ${errors.length} error(s). Use Force Build to ignore.`);
                return;
            }

            // Get output path from persisted state
            const outputPath = this.getOutputPath();
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
            const workingFolder = path.join(workspaceFolder, TREBuilderProvider.MODES[this.getMode()].folder);

            await writer.build(workingFolder, fullOutputPath, (status) => {
                this._postMessage({ type: 'buildStatus', status });
            });

            // Save build manifest for NEW/MOD tracking
            this._saveBuildManifest();

            this._isBuilding = false;
            await this._scanFiles();  // Rescan to update change status badges
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

        const workingFolder = TREBuilderProvider.MODES[this.getMode()].folder;
        const fullPath = path.join(workspaceFolder, workingFolder, relativePath);

        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fullPath));
    }

    public async fixCRC() {
        const workspaceFolder = this._getWorkspaceFolder();
        if (!workspaceFolder) return;

        // Gather missing paths from validation results
        const missingPaths = this._validationResults
            .filter(r => r.severity === 'error' && r.file)
            .map(r => r.file!);

        if (missingPaths.length === 0) {
            vscode.window.showInformationMessage('No missing CRC entries to fix.');
            return;
        }

        // Find the CRC table in the active mode folder
        const activeFolder = TREBuilderProvider.MODES[this.getMode()].folder;
        const crcPath = path.join(workspaceFolder, activeFolder, 'misc/object_template_crc_string_table.iff');
        if (!fs.existsSync(crcPath)) {
            vscode.window.showErrorMessage(`No CRC table found in ${activeFolder}/misc/. Copy one there first.`);
            return;
        }

        try {
            const data = fs.readFileSync(crcPath);
            const table = parseCRCTable(new Uint8Array(data));
            const added = addCRCEntries(table, missingPaths);

            if (added.length === 0) {
                vscode.window.showInformationMessage('All entries already exist in the CRC table.');
                return;
            }

            const serialized = serializeCRCTable(table);
            fs.writeFileSync(crcPath, Buffer.from(serialized));

            vscode.window.showInformationMessage(`Added ${added.length} entries to CRC table.`);

            // Re-run validation to update the UI
            await this.validate();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to fix CRC table: ${e.message}`);
        }
    }

    private async _scanFiles() {
        const workspaceFolder = this._getWorkspaceFolder();
        if (!workspaceFolder) return;

        const workingFolder = TREBuilderProvider.MODES[this.getMode()].folder;
        const workingPath = path.join(workspaceFolder, workingFolder);

        if (!fs.existsSync(workingPath)) {
            this._files = [];
            return;
        }

        // Load last build manifest for change tracking
        const manifest = this._getLastBuildManifest();

        // Scan for all files recursively
        this._files = [];
        await this._scanDirectory(workingPath, workingPath, workspaceFolder, manifest);

        // Sort by modification time (newest first)
        this._files.sort((a, b) => b.modifiedTime.getTime() - a.modifiedTime.getTime());
    }

    private async _scanDirectory(dir: string, rootDir: string, workspaceFolder: string, manifest: BuildManifest | null) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                await this._scanDirectory(fullPath, rootDir, workspaceFolder, manifest);
            } else if (entry.isFile()) {
                const relativePath = path.relative(rootDir, fullPath);
                const stats = fs.statSync(fullPath);
                const relNorm = relativePath.replace(/\\/g, '/');

                // Check if file exists in vanilla or infinity (to determine if "new")
                const vanillaPath = path.join(workspaceFolder, 'tre/vanilla', relativePath);
                const infinityPath = path.join(workspaceFolder, 'tre/infinity', relativePath);
                const isNew = !fs.existsSync(vanillaPath) && !fs.existsSync(infinityPath);

                // Determine change status vs last build
                let changeStatus: FileInfo['changeStatus'] = 'unknown';
                if (manifest) {
                    const prev = manifest.files[relNorm];
                    if (!prev) {
                        changeStatus = 'new';
                    } else if (Math.floor(stats.mtimeMs) > prev.mtime || stats.size !== prev.size) {
                        changeStatus = 'modified';
                    } else {
                        changeStatus = 'unchanged';
                    }
                }

                this._files.push({
                    relativePath: relNorm,
                    absolutePath: fullPath,
                    size: stats.size,
                    modifiedTime: stats.mtime,
                    isNew,
                    changeStatus
                });
            }
        }
    }

    private async _generateClientConfig(workspaceFolder: string, outputDir: string): Promise<void> {
        try {
            // Generate swgemu_live.cfg from config-local.lua (source of truth)
            const configLuaPath = path.join(workspaceFolder, 'infinity_wicked/MMOCoreORB/bin/conf/config-local.lua');
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

    private _createValidator(workspaceFolder: string): Validator {
        const forgeConfig = vscode.workspace.getConfiguration('swgForge');
        const scriptsPath = forgeConfig.get<string>('serverScriptsPath', 'infinity_wicked/MMOCoreORB/bin/scripts');
        const customScriptsFolder = forgeConfig.get<string>('customScriptsFolder', 'custom_scripts');
        const workingFolder = path.join(workspaceFolder, TREBuilderProvider.MODES[this.getMode()].folder);
        return new Validator(workspaceFolder, workingFolder, scriptsPath, customScriptsFolder);
    }

    private _getSyncStatus(): { working: SyncInfo; rnd: SyncInfo } {
        const workspaceFolder = this._getWorkspaceFolder();
        const result: { working: SyncInfo; rnd: SyncInfo } = {
            working: { status: 'unknown', label: 'Unknown' },
            rnd:     { status: 'unknown', label: 'Unknown' },
        };
        if (!workspaceFolder) return result;

        for (const mode of ['working', 'rnd'] as const) {
            const cfg = TREBuilderProvider.MODES[mode];
            const trePath = path.join(workspaceFolder, cfg.defaultOutput);
            const sourceDir = path.join(workspaceFolder, cfg.folder);

            if (!fs.existsSync(sourceDir)) {
                result[mode] = { status: 'unknown', label: 'No source folder' };
                continue;
            }

            if (!fs.existsSync(trePath)) {
                result[mode] = { status: 'stale', label: 'TRE not built' };
                continue;
            }

            const treStats = fs.statSync(trePath);
            const manifest = this._context.globalState.get<BuildManifest>(`treBuilder.buildManifest.${mode}`);

            if (!manifest) {
                result[mode] = { status: 'unknown', label: 'No build manifest' };
                continue;
            }

            // Check if any source files are newer than the TRE
            const treMtime = treStats.mtimeMs;
            let newerCount = 0;
            let newCount = 0;
            for (const [relPath, info] of Object.entries(manifest.files)) {
                const fullPath = path.join(sourceDir, relPath);
                if (!fs.existsSync(fullPath)) continue;
                const st = fs.statSync(fullPath);
                if (Math.floor(st.mtimeMs) > info.mtime || st.size !== info.size) {
                    newerCount++;
                }
            }

            // Check for files not in manifest (added after build)
            const currentFiles = this._collectFilePaths(sourceDir, sourceDir);
            for (const rel of currentFiles) {
                if (!manifest.files[rel]) {
                    newCount++;
                }
            }

            const totalChanges = newerCount + newCount;
            if (totalChanges === 0) {
                const age = Date.now() - treMtime;
                const ageStr = age < 3600000 ? Math.floor(age / 60000) + 'm ago'
                             : age < 86400000 ? Math.floor(age / 3600000) + 'h ago'
                             : Math.floor(age / 86400000) + 'd ago';
                result[mode] = { status: 'synced', label: 'In sync (built ' + ageStr + ')' };
            } else {
                const parts: string[] = [];
                if (newCount > 0) parts.push(newCount + ' new');
                if (newerCount > 0) parts.push(newerCount + ' modified');
                result[mode] = { status: 'stale', label: parts.join(', ') + ' since build' };
            }
        }

        return result;
    }

    private _collectFilePaths(dir: string, rootDir: string): string[] {
        const results: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...this._collectFilePaths(full, rootDir));
            } else if (entry.isFile()) {
                results.push(path.relative(rootDir, full).replace(/\\/g, '/'));
            }
        }
        return results;
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
                isBuilding: this._isBuilding,
                mode: this.getMode(),
                outputPath: this.getOutputPath(),
                syncStatus: this._getSyncStatus(),
            });
        }
    }

    private _getHtmlContent(): string {
        const outputPath = this.getOutputPath();

        const lines: string[] = [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="UTF-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '<title>TRE Builder</title>',
            '<style>',
            '  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0; margin: 0; }',
            '  .header { padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }',
            '  .target { font-size: 11px; opacity: 0.8; margin-bottom: 8px; display: flex; align-items: center; gap: 4px; }',
            '  .target-input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #444); padding: 3px 6px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; flex: 1; min-width: 0; }',
            '  .stats { font-size: 12px; display: flex; gap: 12px; }',
            '  .stat { opacity: 0.7; }',
            '  .buttons { display: flex; gap: 6px; margin-top: 10px; }',
            '  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; cursor: pointer; border-radius: 3px; font-size: 12px; }',
            '  button:hover { background: var(--vscode-button-hoverBackground); }',
            '  button:disabled { opacity: 0.5; cursor: not-allowed; }',
            '  .build-btn { background: var(--vscode-button-prominentBackground, #0e639c); }',
            '  .force-btn { background: #b45309; }',
            '  .force-btn:hover { background: #d97706; }',
            '  .fix-btn { background: #15803d; }',
            '  .fix-btn:hover { background: #16a34a; }',
            '  .mode-toggle { display: flex; gap: 0; margin-bottom: 8px; border-radius: 4px; overflow: hidden; border: 1px solid var(--vscode-button-background); }',
            '  .mode-btn { flex: 1; background: transparent; color: var(--vscode-foreground); border: none; padding: 4px 10px; cursor: pointer; font-size: 11px; border-radius: 0; opacity: 0.6; }',
            '  .mode-btn:hover { background: var(--vscode-list-hoverBackground); opacity: 0.9; }',
            '  .mode-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); opacity: 1; font-weight: bold; }',
            '  .section { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }',
            '  .section-header { font-weight: bold; font-size: 11px; text-transform: uppercase; opacity: 0.7; margin-bottom: 6px; cursor: pointer; display: flex; align-items: center; gap: 4px; }',
            '  .section-header:hover { opacity: 1; }',
            '  .tree-container { overflow-y: auto; }',
            '  .tree-row { display: flex; align-items: center; padding: 2px 0; font-size: 12px; cursor: pointer; white-space: nowrap; }',
            '  .tree-row:hover { background: var(--vscode-list-hoverBackground); }',
            '  .tree-indent { display: inline-block; width: 16px; flex-shrink: 0; }',
            '  .tree-toggle { display: inline-block; width: 16px; flex-shrink: 0; text-align: center; font-size: 10px; opacity: 0.7; }',
            '  .tree-label { flex: 1; overflow: hidden; text-overflow: ellipsis; }',
            '  .tree-dir { opacity: 0.9; }',
            '  .tree-file { opacity: 0.8; }',
            '  .tree-count { font-size: 10px; opacity: 0.5; margin-left: 6px; }',
            '  .tree-badge-new { color: #4ade80; font-size: 10px; font-weight: bold; margin-left: 6px; }',
            '  .tree-badge-mod { color: #fbbf24; font-size: 10px; font-weight: bold; margin-left: 6px; }',
            '  .tree-meta { font-size: 10px; opacity: 0.4; margin-left: 6px; }',
            '  .validation-item { display: flex; align-items: flex-start; gap: 6px; padding: 4px 0; font-size: 12px; }',
            '  .validation-icon { flex-shrink: 0; }',
            '  .validation-error { color: #f87171; }',
            '  .validation-warning { color: #fbbf24; }',
            '  .validation-ok { color: #4ade80; }',
            '  .status { padding: 10px; text-align: center; font-size: 12px; }',
            '  .building-status { background: var(--vscode-inputValidation-infoBackground, #063b49); border: 1px solid var(--vscode-inputValidation-infoBorder, #007acc); border-radius: 4px; margin: 8px; font-weight: bold; }',
            '  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--vscode-foreground); border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; margin-right: 8px; vertical-align: middle; }',
            '  @keyframes spin { to { transform: rotate(360deg); } }',
            '  .empty { padding: 20px; text-align: center; opacity: 0.6; font-size: 12px; }',
            '  .sync-row { display: flex; align-items: center; gap: 6px; font-size: 11px; margin-bottom: 6px; padding: 4px 8px; border-radius: 3px; background: var(--vscode-editorWidget-background, #252526); }',
            '  .sync-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }',
            '  .sync-dot.synced { background: #4ade80; }',
            '  .sync-dot.stale { background: #fbbf24; }',
            '  .sync-dot.unknown { background: #6b7280; }',
            '  .sync-label { font-weight: bold; min-width: 28px; }',
            '  .sync-text { opacity: 0.8; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
            '</style>',
            '</head>',
            '<body>',
            '<div class="header">',
            '  <div class="mode-toggle">',
            '    <button class="mode-btn" id="modeWorking" onclick="setMode(\'working\')">Working</button>',
            '    <button class="mode-btn" id="modeRnd" onclick="setMode(\'rnd\')">R&amp;D</button>',
            '  </div>',
            '  <div id="syncIndicators">',
            '    <div class="sync-row"><span class="sync-dot unknown" id="syncDotWorking"></span><span class="sync-label">WRK</span><span class="sync-text" id="syncTextWorking">--</span></div>',
            '    <div class="sync-row"><span class="sync-dot unknown" id="syncDotRnd"></span><span class="sync-label">R&amp;D</span><span class="sync-text" id="syncTextRnd">--</span></div>',
            '  </div>',
            '  <div class="target"><span>Target:</span> <input type="text" class="target-input" id="outputPath" value="' + outputPath.replace(/"/g, '&quot;') + '"></div>',
            '  <div class="stats">',
            '    <span class="stat" id="fileCount">Files: 0</span>',
            '    <span class="stat" id="totalSize">Size: 0 KB</span>',
            '  </div>',
            '  <div class="buttons">',
            '    <button class="build-btn" id="buildBtn" onclick="build()">Build TRE</button>',
            '    <button class="force-btn" id="forceBtn" onclick="forceBuild()" style="display:none">Force Build</button>',
            '    <button class="fix-btn" id="fixBtn" onclick="fixCRC()" style="display:none">Fix CRC</button>',
            '    <button id="validateBtn" onclick="validate()">Validate</button>',
            '    <button id="refreshBtn" onclick="refresh()">Refresh</button>',
            '    <button id="resetBtn" onclick="resetView()">Reset</button>',
            '  </div>',
            '</div>',
            '<div id="status" class="status" style="display:none"></div>',
            '<div class="section" id="validationSection" style="display:none">',
            '  <div class="section-header" onclick="toggleSection(\'validations\')">',
            '    <span id="validationToggle">&#x25BC;</span> Validation Results',
            '  </div>',
            '  <div id="validations"></div>',
            '</div>',
            '<div class="section">',
            '  <div class="section-header" onclick="toggleSection(\'files\')">',
            '    <span id="filesToggle">&#x25BC;</span> <span id="filesSectionLabel">Working Files</span>',
            '  </div>',
            '  <div class="tree-container" id="fileTree"></div>',
            '</div>',
            '<script>',
            'const vscode = acquireVsCodeApi();',
            'let files = [];',
            'let validations = [];',
            'let sectionsCollapsed = { files: false, validations: false };',
            'let collapsedDirs = {};',
            'let currentMode = "working";',
            '',
            'document.getElementById("outputPath").addEventListener("change", function() { vscode.postMessage({ command: "setOutputPath", path: this.value.trim() }); });',
            'function build() { vscode.postMessage({ command: "build" }); }',
            'function forceBuild() { vscode.postMessage({ command: "forceBuild" }); }',
            'function fixCRC() { vscode.postMessage({ command: "fixCRC" }); }',
            'function refresh() { vscode.postMessage({ command: "refresh" }); }',
            'function validate() { vscode.postMessage({ command: "validate" }); }',
            'function resetView() { vscode.postMessage({ command: "reset" }); }',
            'function openFile(p) { vscode.postMessage({ command: "openFile", path: p }); }',
            'function setMode(mode) { vscode.postMessage({ command: "setMode", mode: mode }); }',
            '',
            'function updateSyncIndicators(syncStatus) {',
            '  if (!syncStatus) return;',
            '  var modes = ["working", "rnd"];',
            '  var ids = { working: "Working", rnd: "Rnd" };',
            '  for (var i = 0; i < modes.length; i++) {',
            '    var m = modes[i];',
            '    var info = syncStatus[m];',
            '    if (!info) continue;',
            '    var dot = document.getElementById("syncDot" + ids[m]);',
            '    var text = document.getElementById("syncText" + ids[m]);',
            '    if (dot) { dot.className = "sync-dot " + info.status; }',
            '    if (text) { text.textContent = info.label; }',
            '  }',
            '}',
            '',
            'function updateModeUI(mode) {',
            '  currentMode = mode;',
            '  var wBtn = document.getElementById("modeWorking");',
            '  var rBtn = document.getElementById("modeRnd");',
            '  wBtn.className = "mode-btn" + (mode === "working" ? " active" : "");',
            '  rBtn.className = "mode-btn" + (mode === "rnd" ? " active" : "");',
            '  var label = document.getElementById("filesSectionLabel");',
            '  if (label) { label.textContent = mode === "rnd" ? "R&D Files" : "Working Files"; }',
            '}',
            '',
            'function setAllButtonsDisabled(disabled) {',
            '  var btns = ["buildBtn", "forceBtn", "fixBtn", "validateBtn", "refreshBtn", "resetBtn", "modeWorking", "modeRnd"];',
            '  for (var i = 0; i < btns.length; i++) {',
            '    var el = document.getElementById(btns[i]);',
            '    if (el) { el.disabled = disabled; }',
            '  }',
            '  var pathInput = document.getElementById("outputPath");',
            '  if (pathInput) { pathInput.disabled = disabled; }',
            '}',
            '',
            'function toggleSection(section) {',
            '  sectionsCollapsed[section] = !sectionsCollapsed[section];',
            '  renderTree();',
            '  renderValidations();',
            '}',
            '',
            'function toggleDir(dirPath) {',
            '  collapsedDirs[dirPath] = !collapsedDirs[dirPath];',
            '  renderTree();',
            '}',
            '',
            'function formatSize(bytes) {',
            '  if (bytes < 1024) return bytes + " B";',
            '  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";',
            '  return (bytes / (1024 * 1024)).toFixed(1) + " MB";',
            '}',
            '',
            'function buildTree(files) {',
            '  var root = { dirs: {}, files: [] };',
            '  for (var i = 0; i < files.length; i++) {',
            '    var parts = files[i].relativePath.split("/");',
            '    var node = root;',
            '    for (var j = 0; j < parts.length - 1; j++) {',
            '      if (!node.dirs[parts[j]]) { node.dirs[parts[j]] = { dirs: {}, files: [] }; }',
            '      node = node.dirs[parts[j]];',
            '    }',
            '    node.files.push(files[i]);',
            '  }',
            '  return root;',
            '}',
            '',
            'function countFiles(node) {',
            '  var c = node.files.length;',
            '  var keys = Object.keys(node.dirs);',
            '  for (var i = 0; i < keys.length; i++) { c += countFiles(node.dirs[keys[i]]); }',
            '  return c;',
            '}',
            '',
            'function renderNode(node, depth, pathPrefix, html) {',
            '  var dirNames = Object.keys(node.dirs).sort();',
            '  for (var d = 0; d < dirNames.length; d++) {',
            '    var name = dirNames[d];',
            '    var dirPath = pathPrefix ? pathPrefix + "/" + name : name;',
            '    var child = node.dirs[name];',
            '    var count = countFiles(child);',
            '    var isCollapsed = !!collapsedDirs[dirPath];',
            '    var indent = "";',
            '    for (var i = 0; i < depth; i++) { indent += "<span class=\\"tree-indent\\"></span>"; }',
            '    var arrow = isCollapsed ? "&#x25B6;" : "&#x25BC;";',
            '    html.push("<div class=\\"tree-row\\" data-dir=\\"" + dirPath + "\\">" + indent + "<span class=\\"tree-toggle\\">" + arrow + "</span><span class=\\"tree-label tree-dir\\">" + name + "/</span><span class=\\"tree-count\\">" + count + "</span></div>");',
            '    if (!isCollapsed) {',
            '      renderNode(child, depth + 1, dirPath, html);',
            '    }',
            '  }',
            '  for (var f = 0; f < node.files.length; f++) {',
            '    var file = node.files[f];',
            '    var fname = file.relativePath.split("/").pop();',
            '    var indent = "";',
            '    for (var i = 0; i < depth; i++) { indent += "<span class=\\"tree-indent\\"></span>"; }',
            '    indent += "<span class=\\"tree-indent\\"></span>";',
            '    var badge = "";',
            '    if (file.changeStatus === "new") { badge = "<span class=\\"tree-badge-new\\">NEW</span>"; }',
            '    else if (file.changeStatus === "modified") { badge = "<span class=\\"tree-badge-mod\\">MOD</span>"; }',
            '    html.push("<div class=\\"tree-row\\" data-file=\\"" + file.relativePath + "\\">" + indent + "<span class=\\"tree-label tree-file\\">" + fname + "</span>" + badge + "</div>");',
            '  }',
            '}',
            '',
            'function renderTree() {',
            '  var container = document.getElementById("fileTree");',
            '  var toggle = document.getElementById("filesToggle");',
            '  toggle.innerHTML = sectionsCollapsed.files ? "&#x25B6;" : "&#x25BC;";',
            '  if (sectionsCollapsed.files) { container.innerHTML = ""; return; }',
            '  if (files.length === 0) { container.innerHTML = "<div class=\\"empty\\">No files in working folder</div>"; return; }',
            '  var tree = buildTree(files);',
            '  var html = [];',
            '  renderNode(tree, 0, "", html);',
            '  container.innerHTML = html.join("\\n");',
            '  var totalSize = 0, newCount = 0, modCount = 0;',
            '  for (var i = 0; i < files.length; i++) {',
            '    totalSize += files[i].size;',
            '    if (files[i].changeStatus === "new") newCount++;',
            '    else if (files[i].changeStatus === "modified") modCount++;',
            '  }',
            '  var changeText = "";',
            '  if (newCount > 0 || modCount > 0) {',
            '    var parts = [];',
            '    if (newCount > 0) parts.push(newCount + " new");',
            '    if (modCount > 0) parts.push(modCount + " mod");',
            '    changeText = " (" + parts.join(", ") + ")";',
            '  }',
            '  document.getElementById("fileCount").textContent = "Files: " + files.length + changeText;',
            '  document.getElementById("totalSize").textContent = "Size: " + formatSize(totalSize);',
            '}',
            '',
            'document.addEventListener("click", function(e) {',
            '  var row = e.target.closest(".tree-row");',
            '  if (!row) return;',
            '  if (row.dataset.dir) { toggleDir(row.dataset.dir); }',
            '  else if (row.dataset.file) { openFile(row.dataset.file); }',
            '});',
            '',
            'function renderValidations() {',
            '  var section = document.getElementById("validationSection");',
            '  var container = document.getElementById("validations");',
            '  var toggle = document.getElementById("validationToggle");',
            '  if (validations.length === 0) { section.style.display = "none"; return; }',
            '  section.style.display = "block";',
            '  toggle.innerHTML = sectionsCollapsed.validations ? "&#x25B6;" : "&#x25BC;";',
            '  if (sectionsCollapsed.validations) { container.innerHTML = ""; return; }',
            '  var html = [];',
            '  for (var i = 0; i < validations.length; i++) {',
            '    var v = validations[i];',
            '    var cls = v.severity === "error" ? "validation-error" : v.severity === "warning" ? "validation-warning" : "validation-ok";',
            '    var icon = v.severity === "error" ? "&#x274C;" : v.severity === "warning" ? "&#x26A0;&#xFE0F;" : "&#x2705;";',
            '    html.push("<div class=\\"validation-item\\"><span class=\\"validation-icon " + cls + "\\">" + icon + "</span><span>" + v.message + "</span></div>");',
            '  }',
            '  container.innerHTML = html.join("\\n");',
            '}',
            '',
            'window.addEventListener("message", function(event) {',
            '  var message = event.data;',
            '  switch (message.type) {',
            '    case "update":',
            '      files = message.files || [];',
            '      validations = message.validations || [];',
            '      setAllButtonsDisabled(message.isBuilding);',
            '      if (!message.isBuilding) { document.getElementById("status").style.display = "none"; }',
            '      if (message.mode) { updateModeUI(message.mode); }',
            '      if (message.outputPath) { document.getElementById("outputPath").value = message.outputPath; }',
            '      if (message.syncStatus) { updateSyncIndicators(message.syncStatus); }',
            '      var hasErrors = false;',
            '      for (var i = 0; i < validations.length; i++) { if (validations[i].severity === "error") { hasErrors = true; break; } }',
            '      document.getElementById("forceBtn").style.display = hasErrors ? "inline-block" : "none";',
            '      document.getElementById("fixBtn").style.display = hasErrors ? "inline-block" : "none";',
            '      renderTree();',
            '      renderValidations();',
            '      break;',
            '    case "building":',
            '      document.getElementById("status").style.display = "block";',
            '      document.getElementById("status").innerHTML = "<span class=\\"spinner\\"></span>Building TRE...";',
            '      document.getElementById("status").className = "status building-status";',
            '      setAllButtonsDisabled(true);',
            '      break;',
            '    case "validating":',
            '      document.getElementById("status").style.display = "block";',
            '      document.getElementById("status").innerHTML = "<span class=\\"spinner\\"></span>Running validations...";',
            '      setAllButtonsDisabled(true);',
            '      break;',
            '    case "buildStatus":',
            '      document.getElementById("status").innerHTML = "<span class=\\"spinner\\"></span>" + message.status;',
            '      break;',
            '  }',
            '});',
            '',
            'refresh();',
            '</script>',
            '</body>',
            '</html>',
        ];

        return lines.join('\n');
    }
}
