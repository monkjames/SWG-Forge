/**
 * Mobile Duplicator - Stage 2: Tabs + Tree Structure
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { scanMobiles, type ScanPaths, type MobileEntry } from './mobileScanner';
import {
    duplicateMobile,
    checkOverwrites,
    type DuplicateConfig,
    type DuplicatePaths
} from './mobileDuplicator';

export class DuplicatorPanel {
    public static currentPanel: DuplicatorPanel | undefined;
    public static readonly viewType = 'mobileDuplicator';
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _mobiles: MobileEntry[] = [];

    public static createOrShow(extensionUri: vscode.Uri): DuplicatorPanel {
        const column = vscode.window.activeTextEditor?.viewColumn;
        if (DuplicatorPanel.currentPanel) {
            DuplicatorPanel.currentPanel._panel.reveal(column);
            return DuplicatorPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel(
            DuplicatorPanel.viewType, 'Mobile Duplicator',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        DuplicatorPanel.currentPanel = new DuplicatorPanel(panel, extensionUri);
        return DuplicatorPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._panel.webview.html = this._getHtml();
        this._panel.webview.onDidReceiveMessage(m => this._handleMessage(m), null, this._disposables);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose(): void {
        DuplicatorPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    private _handleMessage(msg: any): void {
        switch (msg.type) {
            case 'ready':
                this._sendInit();
                break;
            case 'preview':
                this._generatePreview(msg.mobileIndex, msg.targetFolder, msg.newName, msg.displayName, msg.description);
                break;
            case 'duplicate':
                this._duplicate(msg.mobileIndex, msg.previewData);
                break;
        }
    }

    private _sendInit(): void {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                this._panel.webview.postMessage({ type: 'error', message: 'No workspace folder' });
                return;
            }
            const config = vscode.workspace.getConfiguration('swgForge');
            const scriptsPath = path.join(workspaceRoot, config.get<string>('serverScriptsPath', 'infinity_wicked/MMOCoreORB/bin/scripts'));
            const customScriptsPath = path.join(scriptsPath, config.get<string>('customScriptsFolder', 'custom_scripts'));
            const treWorking = path.join(workspaceRoot, config.get<string>('tre.workingPath', 'tre/working'));
            const treInfinity = path.join(workspaceRoot, config.get<string>('tre.referencePath', 'tre/infinity'));
            const treVanilla = path.join(workspaceRoot, config.get<string>('tre.vanillaPath', 'tre/vanilla'));

            const scanPaths: ScanPaths = { scriptsPath, customScriptsPath, treWorking, treInfinity, treVanilla };
            this._mobiles = scanMobiles(scanPaths);

            // Keep original array index for backend lookup
            const customMobiles = this._mobiles
                .map((m, originalIndex) => ({ ...m, originalIndex }))
                .filter(m => m.isCustom)
                .map((m, i) => ({ ...m, index: i }));
            const vanillaMobiles = this._mobiles
                .map((m, originalIndex) => ({ ...m, originalIndex }))
                .filter(m => !m.isCustom)
                .map((m, i) => ({ ...m, index: i + customMobiles.length }));

            // Extract unique folders from custom mobiles (for target folder dropdown)
            const folders = Array.from(new Set(
                this._mobiles.filter(m => m.isCustom).map(m => m.folder)
            )).sort();

            this._panel.webview.postMessage({
                type: 'init',
                customMobiles,
                vanillaMobiles,
                folders
            });
        } catch (err: any) {
            this._panel.webview.postMessage({ type: 'error', message: err.message || String(err) });
        }
    }

    private _generatePreview(mobileIndex: number, targetFolder: string, newName: string, displayName: string, description: string): void {
        // Find the mobile by its originalIndex
        const allMobiles = [...this._mobiles];
        let mobile: any;
        let searchIndex = 0;

        for (const m of allMobiles) {
            if (m.isCustom) {
                const customIndex = this._mobiles.filter((x, i) => i <= searchIndex && x.isCustom).length - 1;
                if (customIndex === mobileIndex) {
                    mobile = m;
                    break;
                }
            } else {
                const customCount = this._mobiles.filter(x => x.isCustom).length;
                const vanillaIndex = this._mobiles.filter((x, i) => i <= searchIndex && !x.isCustom).length - 1;
                if (customCount + vanillaIndex === mobileIndex) {
                    mobile = m;
                    break;
                }
            }
            searchIndex++;
        }

        if (!mobile) {
            this._panel.webview.postMessage({ type: 'error', message: 'Mobile not found' });
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        const config = vscode.workspace.getConfiguration('swgForge');
        const scriptsPath = path.join(workspaceRoot, config.get<string>('serverScriptsPath', 'infinity_wicked/MMOCoreORB/bin/scripts'));
        const customScriptsPath = path.join(scriptsPath, config.get<string>('customScriptsFolder', 'custom_scripts'));
        const treWorking = path.join(workspaceRoot, config.get<string>('tre.workingPath', 'tre/working'));
        const treInfinity = path.join(workspaceRoot, config.get<string>('tre.referencePath', 'tre/infinity'));
        const treVanilla = path.join(workspaceRoot, config.get<string>('tre.vanillaPath', 'tre/vanilla'));

        const duplicateConfig: DuplicateConfig = {
            sourceMobilePath: mobile.path,
            targetFolder: targetFolder,
            newCreatureName: newName,
            displayName,
            description,
            objectTemplatePath: mobile.objectTemplatePath,
            appearancePath: mobile.appearancePath,
            isCustom: true
        };

        const paths: DuplicatePaths = {
            scriptsPath,
            customScriptsPath,
            treWorking,
            treInfinity,
            treVanilla
        };

        // Check for overwrites
        const overwriteCheck = checkOverwrites(duplicateConfig, paths);

        const files = {
            created: [] as string[],
            modified: [] as string[],
            errors: [] as string[]
        };

        if (overwriteCheck.willOverwrite) {
            files.errors.push('⚠️ WARNING: Would overwrite existing files:');
            files.errors.push(...overwriteCheck.existingFiles.map(f => '  • ' + path.relative(workspaceRoot, f)));
        } else {
            // === SERVER FILES (relative to bin/) ===

            // Mobile Lua file
            files.created.push(`custom_scripts/mobile/${targetFolder}/${newName}.lua`);

            // serverobjects.lua registration
            const serverObjPath = path.join(customScriptsPath, 'mobile', targetFolder, 'serverobjects.lua');
            if (fs.existsSync(serverObjPath)) {
                files.modified.push(`custom_scripts/mobile/${targetFolder}/serverobjects.lua`);
            } else {
                files.created.push(`custom_scripts/mobile/${targetFolder}/serverobjects.lua`);
            }

            // Object template Lua (if exists)
            if (mobile.objectTemplatePath) {
                const objDir = path.dirname(mobile.objectTemplatePath);
                files.created.push(`custom_scripts/${objDir}/${newName}.lua`);

                // objects.lua registration
                const objsLuaPath = path.join(customScriptsPath, objDir, 'objects.lua');
                if (fs.existsSync(objsLuaPath)) {
                    files.modified.push(`custom_scripts/${objDir}/objects.lua`);
                } else {
                    files.created.push(`custom_scripts/${objDir}/objects.lua`);
                }
            }

            // === TRE FILES (relative to tre root) ===

            // Object template IFF (if exists)
            if (mobile.objectTemplatePath) {
                const objDir = path.dirname(mobile.objectTemplatePath);
                files.created.push(`object/${objDir}/shared_${newName}.iff`);
            }

            // Appearance chain (if exists) - stays in SAME folder as source
            if (mobile.appearancePath) {
                const ext = path.extname(mobile.appearancePath);
                const baseName = path.basename(mobile.appearancePath, ext);
                const appearDir = path.dirname(mobile.appearancePath);

                // Main appearance file (SAT or APT) - same folder as source
                files.created.push(`appearance/${appearDir}/${newName}${ext}`);

                // Appearance chain files - cloned to same folders as source
                if (ext === '.sat') {
                    files.created.push(`appearance/${appearDir}/${newName}_l*.lod (LOD files in same folder)`);
                    files.created.push(`appearance/${appearDir}/${newName}_l*.msh (mesh files in same folder)`);
                    files.created.push(`appearance/${appearDir}/${newName}_*.sht (shader files in same folder)`);
                    // Note: DDS textures location depends on shader references
                } else if (ext === '.apt') {
                    files.created.push(`appearance/${appearDir}/${newName}_l*.lod (LOD files in same folder)`);
                    files.created.push(`appearance/${appearDir}/${newName}_l*.msh (mesh files in same folder)`);
                }
            }

            // CRC table (if has object template)
            if (mobile.objectTemplatePath) {
                files.modified.push('misc/object_template_crc_string_table.iff');
            }

            // STF file
            if (overwriteCheck.stfStatus === 'exists') {
                files.modified.push('string/en/mob/creature_names.stf');
            } else {
                files.created.push('string/en/mob/creature_names.stf');
            }
        }

        // STF information
        let stfInfo = '';
        if (overwriteCheck.stfStatus === 'exists') {
            stfInfo = 'Will modify existing creature_names.stf';
        } else if (overwriteCheck.stfStatus === 'will_copy') {
            stfInfo = 'Will copy creature_names.stf from reference';
        } else {
            stfInfo = 'Will create new creature_names.stf';
        }

        this._panel.webview.postMessage({
            type: 'preview',
            mobile: {
                name: mobile.name,
                path: mobile.relativePath,
            },
            preview: {
                targetFolder,
                creatureName: newName,
                displayName,
                description,
                files,
                stfInfo,
                stfEntries: overwriteCheck.stfEntries,
                canDuplicate: !overwriteCheck.willOverwrite
            },
        });
    }

    private _duplicate(mobileIndex: number, previewData: any): void {
        try {
            // Find the mobile using same logic as preview
            const allMobiles = [...this._mobiles];
            let mobile: any;
            let searchIndex = 0;

            for (const m of allMobiles) {
                if (m.isCustom) {
                    const customIndex = this._mobiles.filter((x, i) => i <= searchIndex && x.isCustom).length - 1;
                    if (customIndex === mobileIndex) {
                        mobile = m;
                        break;
                    }
                } else {
                    const customCount = this._mobiles.filter(x => x.isCustom).length;
                    const vanillaIndex = this._mobiles.filter((x, i) => i <= searchIndex && !x.isCustom).length - 1;
                    if (customCount + vanillaIndex === mobileIndex) {
                        mobile = m;
                        break;
                    }
                }
                searchIndex++;
            }

            if (!mobile) {
                this._panel.webview.postMessage({
                    type: 'duplicated',
                    success: false,
                    created: [],
                    modified: [],
                    errors: ['Mobile not found']
                });
                return;
            }

            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                this._panel.webview.postMessage({
                    type: 'duplicated',
                    success: false,
                    created: [],
                    modified: [],
                    errors: ['No workspace folder']
                });
                return;
            }

            const config = vscode.workspace.getConfiguration('swgForge');
            const scriptsPath = path.join(workspaceRoot, config.get<string>('serverScriptsPath', 'infinity_wicked/MMOCoreORB/bin/scripts'));
            const customScriptsPath = path.join(scriptsPath, config.get<string>('customScriptsFolder', 'custom_scripts'));
            const treWorking = path.join(workspaceRoot, config.get<string>('tre.workingPath', 'tre/working'));
            const treInfinity = path.join(workspaceRoot, config.get<string>('tre.referencePath', 'tre/infinity'));
            const treVanilla = path.join(workspaceRoot, config.get<string>('tre.vanillaPath', 'tre/vanilla'));

            const duplicateConfig: DuplicateConfig = {
                sourceMobilePath: mobile.path,
                targetFolder: previewData.targetFolder,
                newCreatureName: previewData.creatureName,
                displayName: previewData.displayName,
                description: previewData.description,
                objectTemplatePath: mobile.objectTemplatePath,
                appearancePath: mobile.appearancePath,
                isCustom: true
            };

            const paths: DuplicatePaths = {
                scriptsPath,
                customScriptsPath,
                treWorking,
                treInfinity,
                treVanilla
            };

            // Perform duplication
            const result = duplicateMobile(duplicateConfig, paths);

            // Convert absolute paths to relative
            const created = result.created.map(f => path.relative(workspaceRoot, f));
            const modified = result.modified.map(f => path.relative(workspaceRoot, f));

            this._panel.webview.postMessage({
                type: 'duplicated',
                success: result.errors.length === 0,
                created,
                modified,
                errors: result.errors,
            });

            if (result.errors.length === 0) {
                vscode.window.showInformationMessage(`Mobile Duplicator: Created ${previewData.creatureName}!`);
            } else {
                vscode.window.showErrorMessage(`Mobile Duplicator: Duplication failed. Check the errors in the panel.`);
            }

        } catch (err: any) {
            this._panel.webview.postMessage({
                type: 'duplicated',
                success: false,
                created: [],
                modified: [],
                errors: [err.message || String(err)]
            });
            vscode.window.showErrorMessage(`Mobile Duplicator: ${err.message || String(err)}`);
        }
    }

    private _getHtml(): string {
        const h: string[] = [];
        h.push('<!DOCTYPE html><html><head><meta charset="UTF-8">');
        h.push('<style>');
        h.push('body{font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0}');
        h.push('h2{margin:0 0 16px;font-size:1.3em}');
        h.push('.tabs{display:flex;gap:4px;margin-bottom:8px;border-bottom:1px solid var(--vscode-widget-border)}');
        h.push('.tab{padding:6px 16px;cursor:pointer;background:transparent;border:none;color:var(--vscode-descriptionForeground);font-family:inherit;font-size:0.95em;border-bottom:2px solid transparent}');
        h.push('.tab:hover{background:var(--vscode-list-hoverBackground)}');
        h.push('.tab.active{color:var(--vscode-textLink-foreground);border-bottom-color:var(--vscode-textLink-foreground)}');
        h.push('.folder-tree{max-height:450px;overflow-y:auto;border:1px solid var(--vscode-widget-border);padding:8px;font-family:var(--vscode-editor-font-family);font-size:0.9em}');
        h.push('.tree-node{display:flex;align-items:center;padding:2px 0}');
        h.push('.tree-icon{width:16px;text-align:center;cursor:pointer;user-select:none;color:var(--vscode-descriptionForeground)}');
        h.push('.tree-label{flex:1;padding:2px 4px;cursor:pointer}');
        h.push('.tree-label:hover{background:var(--vscode-list-hoverBackground)}');
        h.push('.tree-label.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}');
        h.push('.tree-children{margin-left:16px;display:none}');
        h.push('.tree-children.expanded{display:block}');
        h.push('#status{margin-top:12px;padding:8px;background:var(--vscode-editor-inactiveSelectionBackground);font-size:0.9em}');
        h.push('.search-box{margin-bottom:8px}');
        h.push('.search-box input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:6px 10px;font-family:inherit;font-size:inherit;width:100%;box-sizing:border-box}');
        h.push('.hidden{display:none!important}');
        h.push('.step{display:none}');
        h.push('.step.active{display:block}');
        h.push('.form-group{margin:12px 0}');
        h.push('.form-group label{display:block;font-weight:600;margin-bottom:4px;font-size:0.95em}');
        h.push('.form-group input,.form-group textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:6px 10px;font-family:inherit;font-size:inherit;width:100%;box-sizing:border-box}');
        h.push('.form-group textarea{min-height:80px;resize:vertical}');
        h.push('.button-bar{margin-top:16px;display:flex;gap:8px}');
        h.push('button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:8px 16px;cursor:pointer;font-family:inherit;font-size:inherit}');
        h.push('button:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}');
        h.push('button:disabled{opacity:0.4;cursor:not-allowed}');
        h.push('button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}');
        h.push('button.secondary:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}');
        h.push('.preview-section{margin:16px 0}');
        h.push('.preview-label{font-weight:600;margin-bottom:6px}');
        h.push('.preview-value{margin-left:12px;margin-bottom:4px}');
        h.push('.file-list{margin-left:12px;font-family:var(--vscode-editor-font-family);font-size:0.9em}');
        h.push('.file-list-item{padding:4px}');
        h.push('.file-created{color:var(--vscode-gitDecoration-addedResourceForeground)}');
        h.push('.file-modified{color:var(--vscode-gitDecoration-modifiedResourceForeground)}');
        h.push('</style>');
        h.push('</head><body>');
        h.push('<div id="step-select" class="step active">');
        h.push('<h2>Mobile Duplicator - Step 1: Select Mobile</h2>');
        h.push('<div class="search-box"><input type="text" id="search-input" placeholder="Search mobiles..."></div>');
        h.push('<div id="mobile-tree" class="folder-tree"></div>');
        h.push('<div id="status">Loading...</div>');
        h.push('<div class="button-bar"><button id="btn-next" disabled>Next: Configure Names</button></div>');
        h.push('</div>');
        h.push('<div id="step-configure" class="step">');
        h.push('<h2>Mobile Duplicator - Step 2: Configure Names</h2>');
        h.push('<div class="form-group"><label>Target Folder (custom_scripts/mobile/):</label><select id="target-folder"></select></div>');
        h.push('<div class="form-group"><label>Creature Name:</label><input type="text" id="new-name" placeholder="my_mutant_rancor"></div>');
        h.push('<div class="form-group"><label>Display Name:</label><input type="text" id="display-name" placeholder="Mutant Rancor"></div>');
        h.push('<div class="form-group"><label>Description:</label><textarea id="description" placeholder="A genetically modified rancor"></textarea></div>');
        h.push('<div class="button-bar"><button class="secondary" id="btn-back-2">Back</button><button id="btn-preview">Next: Preview</button></div>');
        h.push('</div>');
        h.push('<div id="step-preview" class="step">');
        h.push('<h2>Mobile Duplicator - Step 3: Preview</h2>');
        h.push('<div id="preview-content"></div>');
        h.push('<div class="button-bar"><button class="secondary" id="btn-back-3">Back</button><button id="btn-duplicate">Duplicate</button></div>');
        h.push('</div>');
        h.push('<div id="step-results" class="step">');
        h.push('<h2>Results</h2>');
        h.push('<div id="results-content"></div>');
        h.push('<div class="button-bar"><button id="btn-reset">Duplicate Another</button></div>');
        h.push('</div>');
        h.push('<script>');
        this._pushScript(h);
        h.push('<\/script></body></html>');
        return h.join('\n');
    }

    private _pushScript(h: string[]): void {
        h.push('var vscode=acquireVsCodeApi();');
        h.push('var state={customMobiles:[],vanillaMobiles:[],folders:[],allNodes:[],selectedIndex:-1,currentStep:"select"};');
        h.push('');

        // Build unified tree with Custom/Vanilla as root nodes
        h.push('function buildUnifiedTree(){');
        h.push('  var container=document.getElementById("mobile-tree");');
        h.push('  container.innerHTML="";');
        h.push('  state.allNodes=[];');
        h.push('  if(state.customMobiles.length>0){');
        h.push('    buildRootNode(container,"Custom",state.customMobiles);');
        h.push('  }');
        h.push('  if(state.vanillaMobiles.length>0){');
        h.push('    buildRootNode(container,"Vanilla",state.vanillaMobiles);');
        h.push('  }');
        h.push('}');
        h.push('');
        h.push('function buildRootNode(parent,rootName,mobiles){');
        h.push('  var tree={};');
        h.push('  var mobilesMap={};');
        h.push('  mobiles.forEach(function(m){');
        h.push('    var folder=m.folder;');
        h.push('    if(!mobilesMap[folder])mobilesMap[folder]=[];');
        h.push('    mobilesMap[folder].push(m);');
        h.push('    var parts=folder.split("/");');
        h.push('    var node=tree;');
        h.push('    for(var j=0;j<parts.length;j++){');
        h.push('      if(!node[parts[j]]){node[parts[j]]={};}');
        h.push('      node=node[parts[j]];');
        h.push('    }');
        h.push('  });');
        h.push('  var rootDiv=document.createElement("div");');
        h.push('  var rootHeader=document.createElement("div");');
        h.push('  rootHeader.className="tree-node";');
        h.push('  var rootIcon=document.createElement("span");');
        h.push('  rootIcon.className="tree-icon";');
        h.push('  rootIcon.textContent="\\u25B6";');
        h.push('  var rootLabel=document.createElement("span");');
        h.push('  rootLabel.className="tree-label";');
        h.push('  rootLabel.textContent=rootName+" ("+mobiles.length+")";');
        h.push('  rootHeader.appendChild(rootIcon);');
        h.push('  rootHeader.appendChild(rootLabel);');
        h.push('  rootDiv.appendChild(rootHeader);');
        h.push('  var rootChildren=document.createElement("div");');
        h.push('  rootChildren.className="tree-children";');
        h.push('  rootIcon.onclick=function(e){');
        h.push('    var isExpanded=rootChildren.classList.contains("expanded");');
        h.push('    rootChildren.classList.toggle("expanded");');
        h.push('    rootIcon.textContent=isExpanded?"\\u25B6":"\\u25BC";');
        h.push('    e.stopPropagation();');
        h.push('  };');
        h.push('  rootDiv.dataset.isRoot="true";');
        h.push('  rootDiv.dataset.path=rootName;');
        h.push('  renderMobileTreeNode(rootChildren,tree,"",mobilesMap,rootDiv);');
        h.push('  rootDiv.appendChild(rootChildren);');
        h.push('  parent.appendChild(rootDiv);');
        h.push('  state.allNodes.push(rootDiv);');
        h.push('}');
        h.push('');

        h.push('function renderMobileTreeNode(parent,node,path,mobilesMap,rootDiv){');
        h.push('  var keys=Object.keys(node).sort();');
        h.push('  keys.forEach(function(key){');
        h.push('    var fullPath=path?path+"/"+key:key;');
        h.push('    var hasChildren=Object.keys(node[key]).length>0;');
        h.push('    var hasMobiles=mobilesMap[fullPath]&&mobilesMap[fullPath].length>0;');
        h.push('    if(!hasChildren&&!hasMobiles)return;');
        h.push('    var nodeDiv=document.createElement("div");');
        h.push('    var nodeHeader=document.createElement("div");');
        h.push('    nodeHeader.className="tree-node";');
        h.push('    var icon=document.createElement("span");');
        h.push('    icon.className="tree-icon";');
        h.push('    var hasContent=hasChildren||hasMobiles;');
        h.push('    icon.textContent=hasContent?"\\u25B6":"  ";');
        h.push('    if(hasContent){');
        h.push('      icon.onclick=function(e){');
        h.push('        var children=nodeDiv.querySelector(".tree-children");');
        h.push('        if(!children)return;');
        h.push('        var isExpanded=children.classList.contains("expanded");');
        h.push('        children.classList.toggle("expanded");');
        h.push('        icon.textContent=isExpanded?"\\u25B6":"\\u25BC";');
        h.push('        e.stopPropagation();');
        h.push('      };');
        h.push('    }');
        h.push('    var label=document.createElement("span");');
        h.push('    label.className="tree-label";');
        h.push('    label.textContent=key;');
        h.push('    nodeHeader.appendChild(icon);');
        h.push('    nodeHeader.appendChild(label);');
        h.push('    nodeDiv.appendChild(nodeHeader);');
        h.push('    nodeDiv.dataset.path=fullPath;');
        h.push('    nodeDiv.dataset.searchText=(key+" "+fullPath).toLowerCase();');
        h.push('    state.allNodes.push(nodeDiv);');
        h.push('    if(hasChildren){');
        h.push('      var children=document.createElement("div");');
        h.push('      children.className="tree-children";');
        h.push('      renderMobileTreeNode(children,node[key],fullPath,mobilesMap,rootDiv);');
        h.push('      nodeDiv.appendChild(children);');
        h.push('    }');
        h.push('    if(hasMobiles){');
        h.push('      if(!children){');
        h.push('        var children=document.createElement("div");');
        h.push('        children.className="tree-children";');
        h.push('        nodeDiv.appendChild(children);');
        h.push('      }');
        h.push('      mobilesMap[fullPath].forEach(function(mob){');
        h.push('        var leafDiv=document.createElement("div");');
        h.push('        leafDiv.className="tree-node";');
        h.push('        leafDiv.dataset.path=fullPath+"/"+mob.name;');
        h.push('        leafDiv.dataset.searchText=mob.name.toLowerCase();');
        h.push('        leafDiv.dataset.isMobile="true";');
        h.push('        state.allNodes.push(leafDiv);');
        h.push('        var leafIcon=document.createElement("span");');
        h.push('        leafIcon.className="tree-icon";');
        h.push('        leafIcon.textContent="  ";');
        h.push('        var leafLabel=document.createElement("span");');
        h.push('        leafLabel.className="tree-label";');
        h.push('        leafLabel.textContent=mob.name;');
        h.push('        leafLabel.onclick=function(){');
        h.push('          state.selectedIndex=mob.index;');
        h.push('          document.querySelectorAll(".tree-label").forEach(function(el){el.classList.remove("selected");});');
        h.push('          leafLabel.classList.add("selected");');
        h.push('          document.getElementById("status").textContent="Selected: "+mob.name+" ("+mob.relativePath+")";');
        h.push('          document.getElementById("btn-next").disabled=false;');
        h.push('          document.getElementById("new-name").value=mob.name+"_copy";');
        h.push('          document.getElementById("display-name").value=mob.name.replace(/_/g," ");');
        h.push('        };');
        h.push('        leafDiv.appendChild(leafIcon);');
        h.push('        leafDiv.appendChild(leafLabel);');
        h.push('        children.appendChild(leafDiv);');
        h.push('      });');
        h.push('    }');
        h.push('    parent.appendChild(nodeDiv);');
        h.push('  });');
        h.push('}');
        h.push('');

        // Search filtering with auto-expand
        h.push('document.getElementById("search-input").oninput=function(){');
        h.push('  var query=this.value.toLowerCase().trim();');
        h.push('  if(!query){');
        h.push('    state.allNodes.forEach(function(node){');
        h.push('      node.classList.remove("hidden");');
        h.push('      var children=node.querySelector(".tree-children");');
        h.push('      if(children)children.classList.remove("expanded");');
        h.push('      var icon=node.querySelector(".tree-icon");');
        h.push('      if(icon&&icon.textContent!=="  ")icon.textContent="\\u25B6";');
        h.push('    });');
        h.push('    document.getElementById("status").textContent="Loaded "+state.customMobiles.length+" custom + "+state.vanillaMobiles.length+" vanilla mobiles. Click a mobile to select it.";');
        h.push('    return;');
        h.push('  }');
        h.push('  var matchCount=0;');
        h.push('  var matchingPaths={};');
        h.push('  state.allNodes.forEach(function(node){');
        h.push('    var searchText=node.dataset.searchText||"";');
        h.push('    var isMobile=node.dataset.isMobile==="true";');
        h.push('    var matches=searchText.indexOf(query)>=0;');
        h.push('    if(matches&&isMobile){');
        h.push('      matchCount++;');
        h.push('      var path=node.dataset.path||"";');
        h.push('      var pathParts=path.split("/");');
        h.push('      for(var i=0;i<pathParts.length;i++){');
        h.push('        var partial=pathParts.slice(0,i+1).join("/");');
        h.push('        matchingPaths[partial]=true;');
        h.push('      }');
        h.push('    }');
        h.push('    node.classList.toggle("hidden",!matches&&isMobile);');
        h.push('  });');
        h.push('  state.allNodes.forEach(function(node){');
        h.push('    var path=node.dataset.path||"";');
        h.push('    var isMobile=node.dataset.isMobile==="true";');
        h.push('    var isRoot=node.dataset.isRoot==="true";');
        h.push('    if(isRoot){');
        h.push('      node.classList.remove("hidden");');
        h.push('      var hasMatches=false;');
        h.push('      for(var p in matchingPaths){');
        h.push('        if(matchingPaths[p]){hasMatches=true;break;}');
        h.push('      }');
        h.push('      if(hasMatches){');
        h.push('        var children=node.querySelector(".tree-children");');
        h.push('        if(children)children.classList.add("expanded");');
        h.push('        var icon=node.querySelector(".tree-icon");');
        h.push('        if(icon)icon.textContent="\\u25BC";');
        h.push('      }');
        h.push('    }else if(!isMobile&&matchingPaths[path]){');
        h.push('      node.classList.remove("hidden");');
        h.push('      var children=node.querySelector(".tree-children");');
        h.push('      if(children)children.classList.add("expanded");');
        h.push('      var icon=node.querySelector(".tree-icon");');
        h.push('      if(icon&&icon.textContent!=="  ")icon.textContent="\\u25BC";');
        h.push('    }else if(!isMobile&&!isRoot){');
        h.push('      node.classList.add("hidden");');
        h.push('    }');
        h.push('  });');
        h.push('  document.getElementById("status").textContent="Found "+matchCount+" matching mobile"+(matchCount===1?"":"s");');
        h.push('};');
        h.push('');

        // Populate folder dropdown
        h.push('function populateFolderDropdown(){');
        h.push('  var select=document.getElementById("target-folder");');
        h.push('  select.innerHTML="";');
        h.push('  state.folders.forEach(function(folder){');
        h.push('    var option=document.createElement("option");');
        h.push('    option.value=folder;');
        h.push('    option.textContent=folder;');
        h.push('    select.appendChild(option);');
        h.push('  });');
        h.push('}');
        h.push('');

        // Wizard navigation
        h.push('function showStep(stepId){');
        h.push('  document.querySelectorAll(".step").forEach(function(s){s.classList.remove("active");});');
        h.push('  document.getElementById(stepId).classList.add("active");');
        h.push('  state.currentStep=stepId.replace("step-","");');
        h.push('}');
        h.push('document.getElementById("btn-next").onclick=function(){showStep("step-configure");};');
        h.push('document.getElementById("btn-back-2").onclick=function(){showStep("step-select");};');
        h.push('document.getElementById("btn-back-3").onclick=function(){showStep("step-configure");};');
        h.push('document.getElementById("btn-preview").onclick=function(){');
        h.push('  var targetFolder=document.getElementById("target-folder").value;');
        h.push('  var newName=document.getElementById("new-name").value.trim();');
        h.push('  var displayName=document.getElementById("display-name").value.trim();');
        h.push('  var description=document.getElementById("description").value.trim();');
        h.push('  if(!targetFolder||!newName||!displayName){alert("Please fill in target folder, creature name and display name");return;}');
        h.push('  vscode.postMessage({type:"preview",mobileIndex:state.selectedIndex,targetFolder:targetFolder,newName:newName,displayName:displayName,description:description});');
        h.push('};');
        h.push('document.getElementById("btn-duplicate").onclick=function(){');
        h.push('  document.getElementById("btn-duplicate").disabled=true;');
        h.push('  document.getElementById("btn-duplicate").textContent="Duplicating...";');
        h.push('  var previewData={');
        h.push('    targetFolder:document.getElementById("target-folder").value,');
        h.push('    creatureName:document.getElementById("new-name").value.trim(),');
        h.push('    displayName:document.getElementById("display-name").value.trim(),');
        h.push('    description:document.getElementById("description").value.trim()');
        h.push('  };');
        h.push('  vscode.postMessage({type:"duplicate",mobileIndex:state.selectedIndex,previewData:previewData});');
        h.push('};');
        h.push('document.getElementById("btn-reset").onclick=function(){');
        h.push('  state.selectedIndex=-1;');
        h.push('  document.getElementById("new-name").value="";');
        h.push('  document.getElementById("display-name").value="";');
        h.push('  document.getElementById("description").value="";');
        h.push('  document.getElementById("btn-next").disabled=true;');
        h.push('  document.getElementById("btn-duplicate").disabled=false;');
        h.push('  document.getElementById("btn-duplicate").textContent="Duplicate";');
        h.push('  document.querySelectorAll(".tree-label").forEach(function(el){el.classList.remove("selected");});');
        h.push('  showStep("step-select");');
        h.push('};');
        h.push('');

        // Show preview
        h.push('function showPreview(data){');
        h.push('  var html="";');
        h.push('  html+="<div class=\\"preview-section\\">";');
        h.push('  html+="<div class=\\"preview-label\\">Source Mobile:</div>";');
        h.push('  html+="<div class=\\"preview-value\\">"+data.mobile.path+"</div>";');
        h.push('  html+="</div>";');
        h.push('  html+="<div class=\\"preview-section\\">";');
        h.push('  html+="<div class=\\"preview-label\\">New Creature:</div>";');
        h.push('  html+="<div class=\\"preview-value\\"><strong>Target Folder:</strong> custom_scripts/mobile/"+data.preview.targetFolder+"</div>";');
        h.push('  html+="<div class=\\"preview-value\\"><strong>Name:</strong> "+data.preview.creatureName+"</div>";');
        h.push('  html+="<div class=\\"preview-value\\"><strong>Display:</strong> "+data.preview.displayName+"</div>";');
        h.push('  html+="<div class=\\"preview-value\\"><strong>Description:</strong> "+(data.preview.description||"(none)")+"</div>";');
        h.push('  html+="</div>";');
        h.push('  if(data.preview.files.errors && data.preview.files.errors.length>0){');
        h.push('    html+="<div class=\\"preview-section\\" style=\\"border:2px solid var(--vscode-errorForeground);background:var(--vscode-inputValidation-errorBackground);\\">";');
        h.push('    data.preview.files.errors.forEach(function(e){');
        h.push('      html+="<div style=\\"color:var(--vscode-errorForeground);\\">"+e+"</div>";');
        h.push('    });');
        h.push('    html+="</div>";');
        h.push('  }');
        h.push('  html+="<div class=\\"preview-section\\">";');
        h.push('  html+="<div class=\\"preview-label\\">Server Files (bin/):</div>";');
        h.push('  html+="<div class=\\"file-list\\">";');
        h.push('  var serverCreated=data.preview.files.created.filter(function(f){return f.startsWith("custom_scripts/");});');
        h.push('  var serverModified=data.preview.files.modified.filter(function(f){return f.startsWith("custom_scripts/");});');
        h.push('  if(serverCreated.length===0&&serverModified.length===0){html+="<div class=\\"preview-value\\" style=\\"opacity:0.6;\\">(none)</div>";}');
        h.push('  serverCreated.forEach(function(f){');
        h.push('    html+="<div class=\\"file-list-item file-created\\">+ "+f+"</div>";');
        h.push('  });');
        h.push('  serverModified.forEach(function(f){');
        h.push('    html+="<div class=\\"file-list-item file-modified\\">M "+f+"</div>";');
        h.push('  });');
        h.push('  html+="</div></div>";');
        h.push('  html+="<div class=\\"preview-section\\">";');
        h.push('  html+="<div class=\\"preview-label\\">TRE Files (tre/working/):</div>";');
        h.push('  html+="<div class=\\"file-list\\">";');
        h.push('  var treCreated=data.preview.files.created.filter(function(f){return !f.startsWith("custom_scripts/");});');
        h.push('  var treModified=data.preview.files.modified.filter(function(f){return !f.startsWith("custom_scripts/");});');
        h.push('  if(treCreated.length===0&&treModified.length===0){html+="<div class=\\"preview-value\\" style=\\"opacity:0.6;\\">(none)</div>";}');
        h.push('  treCreated.forEach(function(f){');
        h.push('    html+="<div class=\\"file-list-item file-created\\">+ "+f+"</div>";');
        h.push('  });');
        h.push('  treModified.forEach(function(f){');
        h.push('    html+="<div class=\\"file-list-item file-modified\\">M "+f+"</div>";');
        h.push('  });');
        h.push('  html+="</div></div>";');
        h.push('  if(data.preview.stfInfo){');
        h.push('    html+="<div class=\\"preview-section\\" style=\\"border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-selectionBackground);\\">";');
        h.push('    html+="<div class=\\"preview-label\\">STF String Entries:</div>";');
        h.push('    html+="<div class=\\"preview-value\\" style=\\"font-style:italic;margin-bottom:8px;\\">"+data.preview.stfInfo+"</div>";');
        h.push('    if(data.preview.stfEntries){');
        h.push('      data.preview.stfEntries.forEach(function(entry){');
        h.push('        html+="<div class=\\"preview-value\\" style=\\"font-family:monospace;padding:4px;background:var(--vscode-editor-background);\\">";');
        h.push('        html+="<strong>"+entry.id+"</strong> = \\\""+entry.value+"\\\\"');
        h.push('        html+="</div>";');
        h.push('      });');
        h.push('    }');
        h.push('    html+="</div>";');
        h.push('  }');
        h.push('  document.getElementById("preview-content").innerHTML=html;');
        h.push('  var dupBtn=document.getElementById("btn-duplicate");');
        h.push('  if(data.preview.canDuplicate===false){');
        h.push('    dupBtn.disabled=true;');
        h.push('    dupBtn.title="Cannot duplicate: would overwrite existing files";');
        h.push('  }else{');
        h.push('    dupBtn.disabled=false;');
        h.push('    dupBtn.title="";');
        h.push('  }');
        h.push('  showStep("step-preview");');
        h.push('}');
        h.push('');

        // Show results
        h.push('function showResults(data){');
        h.push('  var html="";');
        h.push('  if(data.errors.length>0){');
        h.push('    var title=data.success?"Warnings":"Errors";');
        h.push('    html+="<h3 style=\\"color:var(--vscode-errorForeground)\\">"+title+"</h3><ul>";');
        h.push('    data.errors.forEach(function(e){html+="<li style=\\"color:var(--vscode-errorForeground)\\">! "+e+"<\\/li>";});');
        h.push('    html+="<\\/ul>";');
        h.push('  }');
        h.push('  if(data.created.length>0){');
        h.push('    html+="<h3>Created</h3><ul>";');
        h.push('    data.created.forEach(function(f){html+="<li style=\\"color:var(--vscode-gitDecoration-addedResourceForeground)\\">+ "+f+"<\\/li>";});');
        h.push('    html+="<\\/ul>";');
        h.push('  }');
        h.push('  if(data.modified.length>0){');
        h.push('    html+="<h3>Modified</h3><ul>";');
        h.push('    data.modified.forEach(function(f){html+="<li style=\\"color:var(--vscode-gitDecoration-modifiedResourceForeground)\\">M "+f+"<\\/li>";});');
        h.push('    html+="<\\/ul>";');
        h.push('  }');
        h.push('  var statusBg=data.success?"var(--vscode-editor-inactiveSelectionBackground)":"var(--vscode-inputValidation-errorBackground)";');
        h.push('  var statusColor=data.success?"":"var(--vscode-errorForeground)";');
        h.push('  var statusMsg=data.success?"Mobile duplicated successfully!":"Duplication failed. See errors above.";');
        h.push('  html+="<div style=\\"margin-top:20px;padding:12px;background:"+statusBg+";color:"+statusColor+";font-weight:bold;\\">"+statusMsg+"<\\/div>";');
        h.push('  document.getElementById("results-content").innerHTML=html;');
        h.push('  showStep("step-results");');
        h.push('}');
        h.push('');

        // Message handler
        h.push('window.addEventListener("message",function(e){');
        h.push('  var msg=e.data;');
        h.push('  if(msg.type==="init"){');
        h.push('    state.customMobiles=msg.customMobiles;');
        h.push('    state.vanillaMobiles=msg.vanillaMobiles;');
        h.push('    state.folders=msg.folders;');
        h.push('    buildUnifiedTree();');
        h.push('    populateFolderDropdown();');
        h.push('    document.getElementById("status").textContent="Loaded "+msg.customMobiles.length+" custom + "+msg.vanillaMobiles.length+" vanilla mobiles. Select any to duplicate into custom folder.";');
        h.push('  }');
        h.push('  if(msg.type==="preview"){');
        h.push('    showPreview(msg);');
        h.push('  }');
        h.push('  if(msg.type==="duplicated"){');
        h.push('    showResults(msg);');
        h.push('  }');
        h.push('  if(msg.type==="error"){');
        h.push('    alert("Error: "+msg.message);');
        h.push('  }');
        h.push('});');
        h.push('vscode.postMessage({type:"ready"});');
    }
}
