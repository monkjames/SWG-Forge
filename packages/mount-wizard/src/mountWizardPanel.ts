/**
 * Mount Wizard Webview Panel
 * Singleton panel with form -> preview -> apply workflow
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const DEBUG_LOG = '/tmp/mount-wizard-debug.log';
function debugLog(msg: string): void {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
}
import { parseMobileTemplate } from './mobileParser';
import { resolveAppearanceChain, findObjectTemplateInfo } from './appearanceChain';
import { injectHardpointsToFile } from './mgnHardpoint';
import { addValidScaleRange, addLogicalSaddleNameMap, addRiderPoseMap, addSaddleAppearanceMap, getExistingSaddleNames, getScaleRange, getSaddleNameForAppearance, getMountSpeedData } from './datatableEditor';
import { createControlDevice, getAvailableDevices } from './controlDevice';
import { updateMobileTemplate, updateSlotDescriptor, addMountSpeedData } from './luaEditor';
import {
    MountWizardConfig, MobileTemplate, AppearanceChain, SaddleHardpoint,
    FileChange, ValidationResult, MOUNT_REFERENCES, MountType,
} from './types';

export class MountWizardPanel {
    public static currentPanel: MountWizardPanel | undefined;
    public static readonly viewType = 'mountWizard';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _mobileTemplate: MobileTemplate | null = null;
    private _appearanceChain: AppearanceChain | null = null;
    private _workspaceRoot: string = '';

    public static createOrShow(extensionUri: vscode.Uri): MountWizardPanel {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (MountWizardPanel.currentPanel) {
            debugLog('createOrShow: reusing existing panel');
            MountWizardPanel.currentPanel._panel.reveal(column);
            // Webview is already ready on reuse
            MountWizardPanel.currentPanel._webviewReady = true;
            return MountWizardPanel.currentPanel;
        }
        debugLog('createOrShow: creating NEW panel');

        const panel = vscode.window.createWebviewPanel(
            MountWizardPanel.viewType, 'Mount Wizard',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        MountWizardPanel.currentPanel = new MountWizardPanel(panel, extensionUri);
        return MountWizardPanel.currentPanel;
    }

    private _pendingFilePath: string | null = null;
    private _webviewReady = false;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        this._panel.webview.html = this._getHtml();
        this._panel.webview.onDidReceiveMessage(m => this._handleMessage(m), null, this._disposables);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose(): void {
        MountWizardPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    public loadMobile(filePath: string): void {
        debugLog(`loadMobile called: webviewReady=${this._webviewReady}, filePath=${filePath}`);
        if (!this._webviewReady) {
            this._pendingFilePath = filePath;
            debugLog('loadMobile: queued as pending (webview not ready)');
            return;
        }
        this._doLoadMobile(filePath);
    }

    private _doLoadMobile(filePath: string): void {
        debugLog(`_doLoadMobile START: ${filePath}`);
        try {
            this._mobileTemplate = parseMobileTemplate(filePath);
            debugLog(`parsed mobile: ${this._mobileTemplate.creatureName}, templates=${this._mobileTemplate.objectTemplates.length}`);
        } catch (error: any) {
            const msg = `Failed to parse mobile template: ${error.message}`;
            vscode.window.showErrorMessage(msg);
            this._panel.webview.postMessage({ type: 'error', message: msg });
            return;
        }

        // Resolve appearance chain (non-fatal - form can still show without it)
        if (this._mobileTemplate.objectTemplates.length > 0) {
            try {
                this._appearanceChain = resolveAppearanceChain(
                    this._workspaceRoot,
                    this._mobileTemplate.objectTemplates[0]
                );
            } catch (error: any) {
                console.warn(`Appearance chain resolution failed: ${error.message}`);
                this._appearanceChain = null;
            }
        }

        // Get dropdown data (non-fatal)
        let saddleNames: string[] = [];
        let petDevices: string[] = [];
        let vehicleDevices: string[] = [];
        try {
            saddleNames = getExistingSaddleNames(this._workspaceRoot);
            petDevices = getAvailableDevices(this._workspaceRoot, 'creature');
            vehicleDevices = getAvailableDevices(this._workspaceRoot, 'speeder');
        } catch (error: any) {
            console.warn(`Failed to load dropdown data: ${error.message}`);
        }

        const warnings: string[] = [];
        if (!this._appearanceChain) {
            warnings.push('Could not resolve appearance chain (SAT -> LMG -> MGN). MGN files will not be shown.');
        }
        if (saddleNames.length === 0) {
            warnings.push('No existing saddle names found in datatables.');
        }

        // Gather existing mount data for pre-fill (edit mode)
        let existingData: any = null;
        let detectedMountType: string | null = null;
        try {
            const appearanceName = this._appearanceChain?.appearanceFilename || '';
            if (appearanceName) {
                const speedData = getMountSpeedData(this._workspaceRoot, appearanceName);
                const scaleRange = getScaleRange(this._workspaceRoot, appearanceName);
                const saddleName = getSaddleNameForAppearance(this._workspaceRoot, appearanceName);

                if (speedData || scaleRange || saddleName) {
                    existingData = {
                        speedData,
                        scaleRange,
                        saddleName,
                        isExistingMount: true,
                    };
                }
            }

            // Determine mount type from existing control device path
            if (this._mobileTemplate.controlDeviceTemplate) {
                detectedMountType = this._mobileTemplate.controlDeviceTemplate.includes('/vehicle/')
                    ? 'speeder' : 'creature';
            }
        } catch (error: any) {
            console.warn(`Failed to gather existing mount data: ${error.message}`);
        }

        debugLog(`posting 'loaded' message to webview, appearance=${this._appearanceChain?.appearanceFilename || 'null'}`);
        this._panel.webview.postMessage({
            type: 'loaded',
            mobile: this._mobileTemplate,
            appearance: this._appearanceChain ? {
                satPath: this._appearanceChain.satPath,
                mgnFiles: this._appearanceChain.mgnFiles.map(m => ({
                    relativePath: m.relativePath,
                    source: m.source,
                    hasHpts: m.hasHpts,
                    hardpoints: m.hardpoints,
                })),
                appearanceFilename: this._appearanceChain.appearanceFilename,
                slotDescriptor: this._appearanceChain.slotDescriptorFilename,
            } : null,
            mountReferences: MOUNT_REFERENCES,
            saddleNames,
            petDevices,
            vehicleDevices,
            warnings,
            existingData,
            detectedMountType,
        });
    }

    /**
     * Run validation check on a mobile template
     */
    public validateMobile(filePath: string): void {
        try {
            this._mobileTemplate = parseMobileTemplate(filePath);
            if (this._mobileTemplate.objectTemplates.length > 0) {
                this._appearanceChain = resolveAppearanceChain(
                    this._workspaceRoot,
                    this._mobileTemplate.objectTemplates[0]
                );
            }

            const results = this._runValidation();
            this._panel.webview.postMessage({ type: 'validation', results });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Validation failed: ${error.message}`);
        }
    }

    private _runValidation(): ValidationResult[] {
        const results: ValidationResult[] = [];
        const m = this._mobileTemplate;
        const a = this._appearanceChain;

        if (!m) return [{ label: 'Mobile Template', status: 'missing', detail: 'Could not parse' }];

        // Taming
        results.push({
            label: 'Taming Chance',
            status: m.tamingChance > 0 ? 'ok' : 'missing',
            detail: m.tamingChance > 0 ? `${m.tamingChance}` : 'tamingChance is 0 or missing',
            filePath: m.filePath,
        });

        // Control device
        results.push({
            label: 'Control Device Template',
            status: m.controlDeviceTemplate ? 'ok' : 'missing',
            detail: m.controlDeviceTemplate || 'Not set',
            filePath: m.filePath,
        });

        // Slot descriptor
        if (a) {
            results.push({
                label: 'Slot Descriptor',
                status: a.slotDescriptorFilename.includes('mount_rider') ? 'ok' : 'missing',
                detail: a.slotDescriptorFilename || 'Not found',
            });
        }

        // MGN HPTS
        if (a) {
            const allHaveHpts = a.mgnFiles.every(f => f.hasHpts);
            const someHaveHpts = a.mgnFiles.some(f => f.hasHpts);
            results.push({
                label: 'MGN Hardpoints (HPTS)',
                status: allHaveHpts ? 'ok' : someHaveHpts ? 'warning' : 'missing',
                detail: `${a.mgnFiles.filter(f => f.hasHpts).length}/${a.mgnFiles.length} MGN files have HPTS`,
            });
        }

        // Mount speed data
        const petManagerPath = path.join(this._workspaceRoot, 'infinity4.0.0/MMOCoreORB/bin/scripts/managers/pet_manager.lua');
        try {
            const pmContent = require('fs').readFileSync(petManagerPath, 'utf-8');
            const inSpeedData = a ? pmContent.includes(`"${a.appearanceFilename}"`) : false;
            results.push({
                label: 'Mount Speed Data',
                status: inSpeedData ? 'ok' : 'missing',
                detail: inSpeedData ? 'Found in pet_manager.lua' : 'Not in mountSpeedData',
                filePath: petManagerPath,
            });
        } catch {
            results.push({ label: 'Mount Speed Data', status: 'missing', detail: 'pet_manager.lua not found' });
        }

        return results;
    }

    private _handleMessage(message: any): void {
        switch (message.type) {
            case 'ready':
                debugLog(`handleMessage: ready received, pendingFilePath=${this._pendingFilePath}`);
                this._webviewReady = true;
                if (this._pendingFilePath) {
                    const fp = this._pendingFilePath;
                    this._pendingFilePath = null;
                    this._doLoadMobile(fp);
                }
                break;
            case 'applyChanges':
                this._applyChanges(message.config as MountWizardConfig);
                break;
            case 'previewChanges':
                this._previewChanges(message.config as MountWizardConfig);
                break;
            case 'reapplyHptsOnly':
                this._reapplyHptsOnly(message.config as MountWizardConfig);
                break;
        }
    }

    /**
     * Re-apply HPTS only - for the iterative saddle positioning workflow.
     * Only touches MGN files, skips everything else.
     */
    private async _reapplyHptsOnly(config: MountWizardConfig): Promise<void> {
        const a = this._appearanceChain;
        if (!a) return;

        const results: string[] = [];
        const errors: string[] = [];
        let mgnCount = 0;

        for (const mgn of a.mgnFiles) {
            if (config.selectedMgnFiles.includes(mgn.relativePath)) {
                try {
                    injectHardpointsToFile(this._workspaceRoot, mgn.relativePath, [config.hardpoint]);
                    mgnCount++;
                } catch (e: any) {
                    errors.push(`MGN ${mgn.relativePath}: ${e.message}`);
                }
            }
        }

        results.push(`Re-applied HPTS to ${mgnCount} MGN files`);

        this._panel.webview.postMessage({
            type: 'hptsReapplied',
            results,
            errors,
            success: errors.length === 0,
        });

        if (errors.length === 0) {
            vscode.window.showInformationMessage(`HPTS re-applied to ${mgnCount} MGN files`);
        } else {
            vscode.window.showWarningMessage(`HPTS re-applied with ${errors.length} error(s)`);
        }
    }

    private _previewChanges(config: MountWizardConfig): void {
        const changes = this._buildChangeList(config);
        this._panel.webview.postMessage({ type: 'preview', changes });
    }

    private _buildChangeList(config: MountWizardConfig): FileChange[] {
        const changes: FileChange[] = [];
        const m = this._mobileTemplate;
        const a = this._appearanceChain;
        if (!m) return changes;

        // Mobile template changes
        const mobileChanges: string[] = [];
        if (config.mountType === 'creature' && m.tamingChance !== config.tamingChance) {
            mobileChanges.push(`tamingChance = ${config.tamingChance}`);
        }
        mobileChanges.push(`controlDeviceTemplate = ".../${config.controlDeviceName}.iff"`);
        changes.push({
            filePath: m.filePath,
            displayPath: path.basename(m.filePath),
            changeType: 'modify',
            description: mobileChanges.join(', '),
            category: 'lua',
        });

        // Slot descriptor
        if (a) {
            const templateInfo = findObjectTemplateInfo(this._workspaceRoot, m.objectTemplates[0]);
            if (templateInfo) {
                changes.push({
                    filePath: templateInfo.objectsLuaPath,
                    displayPath: 'object/mobile/objects.lua',
                    changeType: 'modify',
                    description: 'slotDescriptor -> mount_rider.iff',
                    category: 'lua',
                });
            }
        }

        // Pet manager
        changes.push({
            filePath: path.join(this._workspaceRoot, 'infinity4.0.0/MMOCoreORB/bin/scripts/managers/pet_manager.lua'),
            displayPath: 'managers/pet_manager.lua',
            changeType: 'modify',
            description: `mountSpeedData: speed=${config.runSpeed}, gallop=${config.gallopMultiplier}`,
            category: 'lua',
        });

        // Control device files
        const devType = config.mountType === 'creature' ? 'pet' : 'vehicle';
        changes.push({
            filePath: path.join(this._workspaceRoot, `tre/working/object/intangible/${devType}/shared_${config.controlDeviceName}.iff`),
            displayPath: `intangible/${devType}/shared_${config.controlDeviceName}.iff`,
            changeType: 'create',
            description: `Clone from ${config.cloneFromDevice}`,
            category: 'tre',
        });

        changes.push({
            filePath: '',
            displayPath: `custom_scripts/.../intangible/${devType}/${config.controlDeviceName}.lua`,
            changeType: 'create',
            description: 'Server template',
            category: 'lua',
        });

        changes.push({
            filePath: '',
            displayPath: `custom_scripts/.../intangible/${devType}/objects.lua`,
            changeType: 'modify',
            description: 'Add SharedIntangibleObjectTemplate',
            category: 'lua',
        });

        changes.push({
            filePath: '',
            displayPath: `custom_scripts/.../intangible/${devType}/serverobjects.lua`,
            changeType: 'modify',
            description: 'Add includeFile()',
            category: 'lua',
        });

        // MGN files
        if (a) {
            for (const mgn of a.mgnFiles) {
                if (config.selectedMgnFiles.includes(mgn.relativePath)) {
                    changes.push({
                        filePath: mgn.absolutePath,
                        displayPath: mgn.relativePath,
                        changeType: mgn.source !== 'working' ? 'copy_and_modify' : 'modify',
                        description: `+HPTS saddle (${config.hardpoint.parentJoint})`,
                        category: 'tre',
                    });
                }
            }
        }

        // Datatables
        changes.push({
            filePath: '',
            displayPath: 'datatables/mount/valid_scale_range.iff',
            changeType: 'modify',
            description: `Add scale range ${config.scaleMin} - ${config.scaleMax}`,
            category: 'tre',
        });

        changes.push({
            filePath: '',
            displayPath: 'datatables/mount/logical_saddle_name_map.iff',
            changeType: 'modify',
            description: `Map to ${config.existingSaddleName}`,
            category: 'tre',
        });

        // CRC table
        changes.push({
            filePath: '',
            displayPath: 'misc/object_template_crc_string_table.iff',
            changeType: 'modify',
            description: 'Add control device CRC entry',
            category: 'tre',
        });

        return changes;
    }

    private async _applyChanges(config: MountWizardConfig): Promise<void> {
        const m = this._mobileTemplate;
        const a = this._appearanceChain;
        if (!m) return;

        const results: string[] = [];
        const errors: string[] = [];

        try {
            // 1. Update mobile template
            updateMobileTemplate(m.filePath, config.mountType, config.tamingChance, config.controlDeviceName);
            results.push(`Updated ${path.basename(m.filePath)}`);

            // 2. Update slot descriptor
            if (m.objectTemplates.length > 0) {
                const templateInfo = findObjectTemplateInfo(this._workspaceRoot, m.objectTemplates[0]);
                if (templateInfo) {
                    const slotResult = updateSlotDescriptor(this._workspaceRoot, templateInfo.sharedVarName);
                    if (slotResult.updated) results.push('Updated slotDescriptor -> mount_rider.iff');
                }
            }

            // 3. Add mount speed data
            if (a) {
                addMountSpeedData(
                    this._workspaceRoot, a.appearanceFilename,
                    config.runSpeed, config.gallopMultiplier, config.gallopDuration, config.gallopCooldown
                );
                results.push('Added mountSpeedData entry');
            }

            // 4. Create control device
            const deviceResult = createControlDevice(
                this._workspaceRoot, config.mountType, config.controlDeviceName,
                config.cloneFromDevice, a?.appearanceFilename || ''
            );
            results.push(`Created control device (${deviceResult.createdFiles.length} new, ${deviceResult.modifiedFiles.length} modified)`);

            // 5. Inject HPTS into MGN files
            if (a) {
                let mgnCount = 0;
                for (const mgn of a.mgnFiles) {
                    if (config.selectedMgnFiles.includes(mgn.relativePath)) {
                        try {
                            injectHardpointsToFile(this._workspaceRoot, mgn.relativePath, [config.hardpoint]);
                            mgnCount++;
                        } catch (e: any) {
                            errors.push(`MGN ${mgn.relativePath}: ${e.message}`);
                        }
                    }
                }
                results.push(`Injected HPTS into ${mgnCount} MGN files`);
            }

            // 6. Update datatables
            if (a) {
                addValidScaleRange(this._workspaceRoot, a.appearanceFilename, 1, config.scaleMin, config.scaleMax);
                addLogicalSaddleNameMap(this._workspaceRoot, a.appearanceFilename, config.existingSaddleName);
                results.push('Updated mount datatables');

                if (config.saddleType === 'new') {
                    addRiderPoseMap(this._workspaceRoot, config.existingSaddleName, 1, config.existingSaddleName.replace('lookup/', ''));
                    addSaddleAppearanceMap(this._workspaceRoot, config.existingSaddleName, 1, config.existingSaddleName);
                    results.push('Added new saddle type entries');
                }
            }

            this._panel.webview.postMessage({
                type: 'applied',
                results,
                errors,
                success: errors.length === 0,
            });

            if (errors.length > 0) {
                vscode.window.showWarningMessage(`Mount created with ${errors.length} warning(s)`);
            } else {
                vscode.window.showInformationMessage(`Mount created successfully for ${m.creatureName}!`);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to apply changes: ${error.message}`);
            this._panel.webview.postMessage({
                type: 'applied',
                results,
                errors: [...errors, error.message],
                success: false,
            });
        }
    }

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
        h.push('.form-group { margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }');
        h.push('.form-group label { min-width: 140px; text-align: right; color: var(--vscode-descriptionForeground); }');
        h.push('.form-group input, .form-group select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 8px; font-family: inherit; font-size: inherit; }');
        h.push('.form-group input[type="number"] { width: 80px; }');
        h.push('.form-group input[type="text"] { width: 200px; }');
        h.push('.form-group select { min-width: 200px; }');
        h.push('.radio-group { display: flex; gap: 16px; }');
        h.push('.radio-group label { min-width: auto; display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--vscode-foreground); }');
        h.push('.checkbox-list { list-style: none; padding: 0; margin: 4px 0 0 148px; }');
        h.push('.checkbox-list li { display: flex; align-items: center; gap: 6px; margin: 2px 0; }');
        h.push('.checkbox-list .source { font-size: 0.85em; color: var(--vscode-descriptionForeground); }');
        h.push('.checkbox-list .hpts-badge { font-size: 0.75em; padding: 1px 5px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }');
        h.push('button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; font-family: inherit; font-size: inherit; margin: 4px; }');
        h.push('button:hover { background: var(--vscode-button-hoverBackground); }');
        h.push('button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }');
        h.push('button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }');
        h.push('.button-bar { margin-top: 20px; text-align: center; }');
        h.push('.change-list { list-style: none; padding: 0; }');
        h.push('.change-list li { padding: 4px 8px; margin: 2px 0; display: flex; gap: 8px; align-items: baseline; }');
        h.push('.change-icon { width: 14px; text-align: center; }');
        h.push('.change-icon.create { color: var(--vscode-gitDecoration-addedResourceForeground); }');
        h.push('.change-icon.modify { color: var(--vscode-gitDecoration-modifiedResourceForeground); }');
        h.push('.change-icon.copy_and_modify { color: var(--vscode-gitDecoration-renamedResourceForeground); }');
        h.push('.change-path { font-family: var(--vscode-editor-font-family); }');
        h.push('.change-desc { color: var(--vscode-descriptionForeground); font-size: 0.9em; }');
        h.push('.result-ok { color: var(--vscode-gitDecoration-addedResourceForeground); }');
        h.push('.result-error { color: var(--vscode-errorForeground); }');
        h.push('.result-item { padding: 2px 0; }');
        h.push('.validation-list { list-style: none; padding: 0; }');
        h.push('.validation-list li { padding: 4px 8px; display: flex; gap: 8px; align-items: center; }');
        h.push('.status-ok { color: var(--vscode-gitDecoration-addedResourceForeground); }');
        h.push('.status-missing { color: var(--vscode-errorForeground); }');
        h.push('.status-warning { color: var(--vscode-editorWarning-foreground); }');
        h.push('.section-status { font-size: 0.85em; font-weight: normal; margin-left: 6px; }');
        h.push('.section-status.ok { color: var(--vscode-gitDecoration-addedResourceForeground); }');
        h.push('.section-status.missing { color: var(--vscode-descriptionForeground); opacity: 0.6; }');
        h.push('#view-form, #view-preview, #view-results, #view-validation, #view-error { display: none; }');
        h.push('.active { display: block !important; }');
        h.push('.loading { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }');
    }

    private _pushBody(h: string[]): void {
        h.push('<div id="view-loading" class="loading active">Loading mobile template...</div>');
        h.push('<div id="view-error" style="display:none; padding:20px;">');
        h.push('  <h2 style="color:var(--vscode-errorForeground);">Error</h2>');
        h.push('  <p id="error-message" style="margin:16px 0;"></p>');
        h.push('  <div class="button-bar"><button class="secondary" onclick="window.close()">Close</button></div>');
        h.push('</div>');
        h.push('<div id="view-validation">');
        h.push('  <h2>Mount Validation</h2>');
        h.push('  <ul id="validation-list" class="validation-list"></ul>');
        h.push('  <div class="button-bar"><button class="secondary" onclick="window.close()">Close</button></div>');
        h.push('</div>');
        h.push('<div id="view-form">');
        h.push('  <h2>Mount Wizard: <span id="creature-name"></span></h2>');
        h.push('  <div id="mount-status" style="display:none; padding:8px 12px; margin-bottom:12px; border-radius:4px; font-size:0.9em;"></div>');
        h.push('  <div id="warnings" style="display:none; background:var(--vscode-inputValidation-warningBackground); border:1px solid var(--vscode-inputValidation-warningBorder); padding:8px 12px; margin-bottom:12px; border-radius:4px; font-size:0.9em;"></div>');
        h.push('  <h3>Mount Type</h3>');
        h.push('  <div class="form-group"><label>Type:</label>');
        h.push('    <div class="radio-group">');
        h.push('      <label><input type="radio" name="mountType" value="creature" checked> Creature</label>');
        h.push('      <label><input type="radio" name="mountType" value="speeder"> Speeder</label>');
        h.push('    </div></div>');
        h.push('  <div id="taming-section">');
        h.push('    <h3>Taming <span id="status-taming" class="section-status"></span></h3>');
        h.push('    <div class="form-group"><label>Taming Chance:</label>');
        h.push('      <input type="number" id="tamingChance" value="0.25" step="0.05" min="0" max="1"></div>');
        h.push('  </div>');
        h.push('  <h3>Saddle Hardpoint (HPTS) <span id="status-hpts" class="section-status"></span></h3>');
        h.push('  <div class="form-group"><label>Copy from:</label>');
        h.push('    <select id="copyFrom" onchange="copyFromMount()"><option value="">-- Select reference mount --</option></select></div>');
        h.push('  <div class="form-group"><label>Parent Joint:</label>');
        h.push('    <select id="parentJoint"><option value="root">root</option><option value="shoulder">shoulder</option><option value="spine1">spine1</option><option value="spine2">spine2</option></select></div>');
        h.push('  <div class="form-group" style="margin-top:8px;"><label style="color:var(--vscode-foreground)">Rider Facing:</label></div>');
        h.push('  <div class="form-group">');
        h.push('    <label>ox:</label><input type="number" id="ox" value="0" step="0.01">');
        h.push('    <label style="min-width:auto">oy:</label><input type="number" id="oy" value="0" step="0.01">');
        h.push('    <label style="min-width:auto">oz:</label><input type="number" id="oz" value="0" step="0.01">');
        h.push('    <label style="min-width:auto">ow:</label><input type="number" id="ow" value="1" step="0.01">');
        h.push('  </div>');
        h.push('  <div class="form-group" style="margin-left:148px; font-size:0.85em; color:var(--vscode-descriptionForeground);">Forward: ox=0 ow=1 | 90-deg: ox=0.707 ow=0.707 | Use SIE to find values</div>');
        h.push('  <div class="form-group" style="margin-top:8px;"><label style="color:var(--vscode-foreground)">Saddle Position:</label></div>');
        h.push('  <div class="form-group"><label>Right/Left:</label><input type="number" id="posRL" value="0" step="0.01"></div>');
        h.push('  <div class="form-group"><label>Up/Down:</label><input type="number" id="posUD" value="0.109" step="0.01"></div>');
        h.push('  <div class="form-group"><label>Forward/Back:</label><input type="number" id="posFB" value="0.131" step="0.01"></div>');
        h.push('  <div class="form-group" style="margin-left:148px; font-size:0.85em; color:var(--vscode-descriptionForeground);">These are trial-and-error. Tweak and re-apply until it looks right.</div>');
        h.push('  <div class="form-group" style="margin-left:148px; margin-top:4px;">');
        h.push('    <button class="secondary" onclick="reapplyHpts()" title="Re-write HPTS to all selected MGN files without touching anything else">Re-apply HPTS Only</button>');
        h.push('    <span id="reapply-status" style="font-size:0.85em; color:var(--vscode-descriptionForeground);"></span></div>');
        h.push('  <h3>Mount Speed <span id="status-speed" class="section-status"></span></h3>');
        h.push('  <div class="form-group"><label>Run Speed:</label><input type="number" id="runSpeed" value="15" step="1" min="1"></div>');
        h.push('  <div class="form-group"><label>Gallop Multiplier:</label><input type="number" id="gallopMult" value="1.33" step="0.01" min="1"></div>');
        h.push('  <div class="form-group"><label>Gallop Duration:</label><input type="number" id="gallopDuration" value="300" step="10"></div>');
        h.push('  <div class="form-group"><label>Gallop Cooldown:</label><input type="number" id="gallopCooldown" value="600" step="10"></div>');
        h.push('  <h3>Saddle Type <span id="status-saddle" class="section-status"></span></h3>');
        h.push('  <div class="form-group"><label>Use existing:</label><select id="saddleName"></select></div>');
        h.push('  <h3>Control Device <span id="status-device" class="section-status"></span></h3>');
        h.push('  <div class="form-group"><label>Device Name:</label><input type="text" id="controlDeviceName" value=""></div>');
        h.push('  <div class="form-group"><label>Clone from:</label><select id="cloneFrom"></select></div>');
        h.push('  <h3>Scale Range <span id="status-scale" class="section-status"></span></h3>');
        h.push('  <div class="form-group"><label>Min Scale:</label><input type="number" id="scaleMin" value="0.9" step="0.01" min="0">');
        h.push('    <label style="min-width:auto">Max:</label><input type="number" id="scaleMax" value="1.1" step="0.01" min="0"></div>');
        h.push('  <h3>MGN Files</h3>');
        h.push('  <ul id="mgn-list" class="checkbox-list"></ul>');
        h.push('  <div class="button-bar"><button onclick="previewChanges()">Preview Changes</button></div>');
        h.push('</div>');
        h.push('<div id="view-preview">');
        h.push('  <h2>Changes Preview</h2>');
        h.push('  <h3>Lua Changes</h3><ul id="lua-changes" class="change-list"></ul>');
        h.push('  <h3>TRE Changes</h3><ul id="tre-changes" class="change-list"></ul>');
        h.push('  <div class="button-bar">');
        h.push('    <button onclick="applyChanges()">Apply All</button>');
        h.push('    <button class="secondary" onclick="showForm()">Back</button>');
        h.push('    <button class="secondary" onclick="window.close()">Cancel</button></div>');
        h.push('</div>');
        h.push('<div id="view-results">');
        h.push('  <h2>Results</h2><div id="results-content"></div>');
        h.push('  <div class="button-bar"><button class="secondary" onclick="window.close()">Close</button></div>');
        h.push('</div>');
    }

    private _pushScript(h: string[]): void {
        h.push('var vscode = acquireVsCodeApi();');
        h.push('var currentState = {};');
        h.push('');
        h.push('function showView(viewId) {');
        h.push('  document.querySelectorAll("[id^=view-]").forEach(function(el) { el.classList.remove("active"); });');
        h.push('  document.getElementById(viewId).classList.add("active");');
        h.push('}');
        h.push('function showForm() { showView("view-form"); }');
        h.push('');
        h.push('document.querySelectorAll("input[name=mountType]").forEach(function(radio) {');
        h.push('  radio.addEventListener("change", function() {');
        h.push('    var isCreature = radio.value === "creature";');
        h.push('    document.getElementById("taming-section").style.display = isCreature ? "" : "none";');
        h.push('    updateCloneFromDropdown();');
        h.push('  });');
        h.push('});');
        h.push('');
        h.push('function getMountType() {');
        h.push('  return document.querySelector("input[name=mountType]:checked").value;');
        h.push('}');
        h.push('');
        h.push('function updateCloneFromDropdown() {');
        h.push('  var select = document.getElementById("cloneFrom");');
        h.push('  var devices = getMountType() === "creature" ? currentState.petDevices : currentState.vehicleDevices;');
        h.push('  select.innerHTML = "";');
        h.push('  if (devices) {');
        h.push('    devices.forEach(function(d) {');
        h.push('      var opt = document.createElement("option");');
        h.push('      opt.value = d; opt.textContent = d;');
        h.push('      select.appendChild(opt);');
        h.push('    });');
        h.push('  }');
        h.push('}');
        h.push('');
        h.push('function copyFromMount() {');
        h.push('  var select = document.getElementById("copyFrom");');
        h.push('  var ref = null;');
        h.push('  if (currentState.mountReferences) {');
        h.push('    for (var i = 0; i < currentState.mountReferences.length; i++) {');
        h.push('      if (currentState.mountReferences[i].name === select.value) { ref = currentState.mountReferences[i]; break; }');
        h.push('    }');
        h.push('  }');
        h.push('  if (!ref) return;');
        h.push('  document.getElementById("parentJoint").value = ref.parentJoint;');
        h.push('  document.getElementById("ox").value = ref.quaternion[1];');
        h.push('  document.getElementById("oy").value = ref.quaternion[2];');
        h.push('  document.getElementById("oz").value = ref.quaternion[3];');
        h.push('  document.getElementById("ow").value = ref.quaternion[0];');
        h.push('  document.getElementById("posRL").value = ref.position[0];');
        h.push('  document.getElementById("posUD").value = ref.position[1];');
        h.push('  document.getElementById("posFB").value = ref.position[2];');
        h.push('}');
        h.push('');
        h.push('function reapplyHpts() {');
        h.push('  document.getElementById("reapply-status").textContent = "Applying...";');
        h.push('  vscode.postMessage({ type: "reapplyHptsOnly", config: getConfig() });');
        h.push('}');
        h.push('');
        h.push('function getConfig() {');
        h.push('  return {');
        h.push('    mountType: getMountType(),');
        h.push('    tamingChance: parseFloat(document.getElementById("tamingChance").value) || 0.25,');
        h.push('    hardpoint: {');
        h.push('      name: "saddle",');
        h.push('      parentJoint: document.getElementById("parentJoint").value,');
        h.push('      quaternion: [');
        h.push('        parseFloat(document.getElementById("ow").value) || 0,');
        h.push('        parseFloat(document.getElementById("ox").value) || 0,');
        h.push('        parseFloat(document.getElementById("oy").value) || 0,');
        h.push('        parseFloat(document.getElementById("oz").value) || 0 ],');
        h.push('      position: [');
        h.push('        parseFloat(document.getElementById("posRL").value) || 0,');
        h.push('        parseFloat(document.getElementById("posUD").value) || 0,');
        h.push('        parseFloat(document.getElementById("posFB").value) || 0 ]');
        h.push('    },');
        h.push('    runSpeed: parseInt(document.getElementById("runSpeed").value) || 15,');
        h.push('    gallopMultiplier: parseFloat(document.getElementById("gallopMult").value) || 1.33,');
        h.push('    gallopDuration: parseInt(document.getElementById("gallopDuration").value) || 300,');
        h.push('    gallopCooldown: parseInt(document.getElementById("gallopCooldown").value) || 600,');
        h.push('    saddleType: "existing",');
        h.push('    existingSaddleName: document.getElementById("saddleName").value || "",');
        h.push('    controlDeviceName: document.getElementById("controlDeviceName").value || "",');
        h.push('    cloneFromDevice: document.getElementById("cloneFrom").value || "",');
        h.push('    selectedMgnFiles: getSelectedMgns(),');
        h.push('    scaleMin: parseFloat(document.getElementById("scaleMin").value) || 0.9,');
        h.push('    scaleMax: parseFloat(document.getElementById("scaleMax").value) || 1.1');
        h.push('  };');
        h.push('}');
        h.push('');
        h.push('function getSelectedMgns() {');
        h.push('  var cbs = document.querySelectorAll("#mgn-list input[type=checkbox]:checked");');
        h.push('  return Array.from(cbs).map(function(cb) { return cb.value; });');
        h.push('}');
        h.push('');
        h.push('function previewChanges() { vscode.postMessage({ type: "previewChanges", config: getConfig() }); }');
        h.push('function applyChanges() {');
        h.push('  showView("view-loading");');
        h.push('  document.getElementById("view-loading").textContent = "Applying changes...";');
        h.push('  vscode.postMessage({ type: "applyChanges", config: getConfig() });');
        h.push('}');
        h.push('');
        h.push('window.addEventListener("message", function(event) {');
        h.push('  var msg = event.data;');
        h.push('  switch (msg.type) {');
        h.push('    case "loaded":');
        h.push('      currentState = msg;');
        h.push('      try { populateForm(msg); showView("view-form"); }');
        h.push('      catch (e) { document.getElementById("error-message").textContent = "Form error: " + e.message; showView("view-error"); }');
        h.push('      break;');
        h.push('    case "error":');
        h.push('      document.getElementById("error-message").textContent = msg.message; showView("view-error"); break;');
        h.push('    case "preview":');
        h.push('      showPreview(msg.changes); showView("view-preview"); break;');
        h.push('    case "applied":');
        h.push('      showResults(msg); showView("view-results"); break;');
        h.push('    case "hptsReapplied":');
        h.push('      document.getElementById("reapply-status").textContent = msg.success ? "Done! Check in-game." : "Errors: " + msg.errors.join(", "); break;');
        h.push('    case "validation":');
        h.push('      showValidation(msg.results); showView("view-validation"); break;');
        h.push('  }');
        h.push('});');
        h.push('');
        h.push('function populateForm(data) {');
        h.push('  var m = data.mobile, a = data.appearance, existing = data.existingData;');
        h.push('  var isExisting = existing && existing.isExistingMount;');
        h.push('  var statusDiv = document.getElementById("mount-status");');
        h.push('  if (isExisting) {');
        h.push('    statusDiv.style.display = "block";');
        h.push('    statusDiv.style.background = "var(--vscode-inputValidation-infoBackground)";');
        h.push('    statusDiv.style.border = "1px solid var(--vscode-inputValidation-infoBorder)";');
        h.push('    var parts = ["Existing mount detected."];');
        h.push('    if (existing.speedData) parts.push("Speed: " + existing.speedData.runSpeed);');
        h.push('    if (existing.scaleRange) parts.push("Scale: " + existing.scaleRange.min + "-" + existing.scaleRange.max);');
        h.push('    if (existing.saddleName) parts.push("Saddle: " + existing.saddleName);');
        h.push('    statusDiv.textContent = parts.join(" | ");');
        h.push('  } else { statusDiv.style.display = "none"; }');
        h.push('  var warningsDiv = document.getElementById("warnings");');
        h.push('  if (data.warnings && data.warnings.length > 0) {');
        h.push('    warningsDiv.innerHTML = data.warnings.join("<br>"); warningsDiv.style.display = "block";');
        h.push('  } else { warningsDiv.style.display = "none"; }');
        h.push('  document.getElementById("creature-name").textContent = m.creatureName;');
        h.push('  document.getElementById("tamingChance").value = m.tamingChance || 0.25;');
        h.push('  if (data.detectedMountType) {');
        h.push('    var r = document.querySelector("input[name=mountType][value=" + data.detectedMountType + "]");');
        h.push('    if (r) { r.checked = true; document.getElementById("taming-section").style.display = data.detectedMountType === "creature" ? "" : "none"; }');
        h.push('  }');
        h.push('  if (m.controlDeviceTemplate) {');
        h.push('    var dn = m.controlDeviceTemplate.replace(/^.*\\//, "").replace(/\\.iff$/, "");');
        h.push('    document.getElementById("controlDeviceName").value = dn;');
        h.push('  } else { document.getElementById("controlDeviceName").value = m.creatureName + "_mnt"; }');
        h.push('  if (existing && existing.speedData) {');
        h.push('    document.getElementById("runSpeed").value = existing.speedData.runSpeed;');
        h.push('    document.getElementById("gallopMult").value = existing.speedData.gallopMultiplier;');
        h.push('    document.getElementById("gallopDuration").value = existing.speedData.gallopDuration;');
        h.push('    document.getElementById("gallopCooldown").value = existing.speedData.gallopCooldown;');
        h.push('  }');
        h.push('  if (existing && existing.scaleRange) {');
        h.push('    document.getElementById("scaleMin").value = existing.scaleRange.min;');
        h.push('    document.getElementById("scaleMax").value = existing.scaleRange.max;');
        h.push('  }');
        h.push('  var copyFromSel = document.getElementById("copyFrom");');
        h.push('  copyFromSel.innerHTML = "<option value=\\"\\">-- Select reference mount --<\\/option>";');
        h.push('  if (data.mountReferences) {');
        h.push('    data.mountReferences.forEach(function(ref) {');
        h.push('      var opt = document.createElement("option");');
        h.push('      opt.value = ref.name; opt.textContent = ref.name + " (" + ref.parentJoint + ")";');
        h.push('      copyFromSel.appendChild(opt);');
        h.push('    });');
        h.push('  }');
        h.push('  var saddleSel = document.getElementById("saddleName");');
        h.push('  saddleSel.innerHTML = "";');
        h.push('  if (data.saddleNames) {');
        h.push('    data.saddleNames.forEach(function(name) {');
        h.push('      var opt = document.createElement("option");');
        h.push('      opt.value = name; opt.textContent = name;');
        h.push('      saddleSel.appendChild(opt);');
        h.push('    });');
        h.push('  }');
        h.push('  if (existing && existing.saddleName) { saddleSel.value = existing.saddleName; }');
        h.push('  currentState.petDevices = data.petDevices;');
        h.push('  currentState.vehicleDevices = data.vehicleDevices;');
        h.push('  updateCloneFromDropdown();');
        h.push('  if (m.controlDeviceTemplate) {');
        h.push('    var dn2 = m.controlDeviceTemplate.replace(/^.*\\//, "").replace(/\\.iff$/, "");');
        h.push('    var cs = document.getElementById("cloneFrom");');
        h.push('    var opts = cs.querySelectorAll("option");');
        h.push('    for (var i = 0; i < opts.length; i++) { if (opts[i].value === dn2) { cs.value = dn2; break; } }');
        h.push('  }');
        h.push('  var mgnList = document.getElementById("mgn-list");');
        h.push('  mgnList.innerHTML = "";');
        h.push('  if (a && a.mgnFiles) {');
        h.push('    a.mgnFiles.forEach(function(mgn) {');
        h.push('      var li = document.createElement("li");');
        h.push('      var cb = document.createElement("input");');
        h.push('      cb.type = "checkbox"; cb.checked = true; cb.value = mgn.relativePath;');
        h.push('      li.appendChild(cb);');
        h.push('      var lbl = document.createElement("span"); lbl.textContent = mgn.relativePath; li.appendChild(lbl);');
        h.push('      var src = document.createElement("span"); src.className = "source"; src.textContent = "(" + mgn.source + ")"; li.appendChild(src);');
        h.push('      if (mgn.hasHpts) { var badge = document.createElement("span"); badge.className = "hpts-badge"; badge.textContent = "HAS HPTS"; li.appendChild(badge); }');
        h.push('      mgnList.appendChild(li);');
        h.push('    });');
        h.push('    var existingHpts = null;');
        h.push('    for (var j = 0; j < a.mgnFiles.length; j++) {');
        h.push('      if (a.mgnFiles[j].hasHpts && a.mgnFiles[j].hardpoints && a.mgnFiles[j].hardpoints.length > 0) { existingHpts = a.mgnFiles[j]; break; }');
        h.push('    }');
        h.push('    if (existingHpts) {');
        h.push('      var hp = existingHpts.hardpoints[0];');
        h.push('      document.getElementById("parentJoint").value = hp.parentJoint || "root";');
        h.push('      document.getElementById("ox").value = hp.quaternion[1];');
        h.push('      document.getElementById("oy").value = hp.quaternion[2];');
        h.push('      document.getElementById("oz").value = hp.quaternion[3];');
        h.push('      document.getElementById("ow").value = hp.quaternion[0];');
        h.push('      document.getElementById("posRL").value = hp.position[0];');
        h.push('      document.getElementById("posUD").value = hp.position[1];');
        h.push('      document.getElementById("posFB").value = hp.position[2];');
        h.push('    }');
        h.push('  }');
        h.push('  setStatus("status-taming", m.tamingChance > 0);');
        h.push('  setStatus("status-device", !!m.controlDeviceTemplate);');
        h.push('  setStatus("status-speed", !!(existing && existing.speedData));');
        h.push('  setStatus("status-scale", !!(existing && existing.scaleRange));');
        h.push('  setStatus("status-saddle", !!(existing && existing.saddleName));');
        h.push('  var hasHpts = a && a.mgnFiles && a.mgnFiles.some(function(f) { return f.hasHpts; });');
        h.push('  setStatus("status-hpts", !!hasHpts);');
        h.push('}');
        h.push('');
        h.push('function setStatus(id, ok) {');
        h.push('  var el = document.getElementById(id);');
        h.push('  if (!el) return;');
        h.push('  el.className = "section-status " + (ok ? "ok" : "missing");');
        h.push('  el.innerHTML = ok ? "&#10004;" : "&#10007;";');
        h.push('}');
        h.push('');
        h.push('function showPreview(changes) {');
        h.push('  var luaList = document.getElementById("lua-changes");');
        h.push('  var treList = document.getElementById("tre-changes");');
        h.push('  luaList.innerHTML = ""; treList.innerHTML = "";');
        h.push('  changes.forEach(function(c) {');
        h.push('    var li = document.createElement("li");');
        h.push('    var icon = document.createElement("span");');
        h.push('    icon.className = "change-icon " + c.changeType;');
        h.push('    icon.textContent = c.changeType === "create" ? "+" : c.changeType === "copy_and_modify" ? "C" : "M";');
        h.push('    li.appendChild(icon);');
        h.push('    var ps = document.createElement("span"); ps.className = "change-path"; ps.textContent = c.displayPath; li.appendChild(ps);');
        h.push('    var ds = document.createElement("span"); ds.className = "change-desc"; ds.textContent = c.description; li.appendChild(ds);');
        h.push('    (c.category === "lua" ? luaList : treList).appendChild(li);');
        h.push('  });');
        h.push('}');
        h.push('');
        h.push('function showResults(data) {');
        h.push('  var content = document.getElementById("results-content");');
        h.push('  var html = "";');
        h.push('  data.results.forEach(function(r) { html += "<div class=\\"result-item result-ok\\">&#10004; " + r + "<\\/div>"; });');
        h.push('  data.errors.forEach(function(e) { html += "<div class=\\"result-item result-error\\">&#10008; " + e + "<\\/div>"; });');
        h.push('  html += "<div style=\\"margin-top:16px;font-weight:bold;\\">" + (data.success ? "Mount created successfully!" : "Completed with errors") + "<\\/div>";');
        h.push('  content.innerHTML = html;');
        h.push('}');
        h.push('');
        h.push('function showValidation(results) {');
        h.push('  var list = document.getElementById("validation-list");');
        h.push('  list.innerHTML = "";');
        h.push('  results.forEach(function(r) {');
        h.push('    var li = document.createElement("li");');
        h.push('    var icon = document.createElement("span");');
        h.push('    var sm = { ok: "&#10004;", missing: "&#10008;", warning: "&#9888;" };');
        h.push('    icon.className = "status-" + r.status; icon.innerHTML = sm[r.status]; li.appendChild(icon);');
        h.push('    var lbl = document.createElement("strong"); lbl.textContent = r.label + ": "; li.appendChild(lbl);');
        h.push('    var det = document.createElement("span"); det.textContent = r.detail; li.appendChild(det);');
        h.push('    list.appendChild(li);');
        h.push('  });');
        h.push('}');
        h.push('');
        h.push('vscode.postMessage({ type: "ready" });');
    }
}
