import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface ForgeTool {
    name: string;
    description: string;
    command?: string;
    fileTypes?: string;
    howToUse?: string;
}

const STANDALONE_TOOLS: ForgeTool[] = [
    {
        name: 'Armor Forge',
        description: 'Generate complete armor sets — Lua templates, TRE entries, CRC registrations, and ACM customization.',
        command: 'armorForge.open'
    },
    {
        name: 'Art Workshop',
        description: 'Generate in-game art objects (paintings, rugs, banners, tapestries) from DDS textures.',
        command: 'artWorkshop.open'
    },
    {
        name: 'Crafting Workshop',
        description: 'Simulate crafting, edit experimental formulas, set Blue Frog defaults, and run health checks on schematics.',
        command: 'craftingWorkshop.open'
    },
    {
        name: 'ACM Editor',
        description: 'Browse palettes, manage asset customization, and register new objects in the Asset Customization Manager.',
        command: 'acmEditor.open'
    },
    {
        name: 'Palette Browser',
        description: 'Browse all .pal palette files across your workspace.',
        command: 'paletteEditor.browse'
    },
    {
        name: 'Object Creator',
        description: 'Create new objects from existing appearance chains — IFF, STF, CRC, and Lua in one wizard.',
        command: 'objectCreator.open'
    },
];

const SIDEBAR_TOOLS: ForgeTool[] = [
    {
        name: 'TRE Builder',
        description: 'Build TRE archives from tre/working. Appears in the activity bar when tre/working exists.',
        howToUse: 'Look for the package icon in the activity bar (left sidebar). Use the toolbar buttons to build, validate, and refresh.'
    },
];

const CONTEXT_MENU_TOOLS: ForgeTool[] = [
    {
        name: 'Appearance Chain',
        description: 'Resolve and edit full appearance chains (APT \u2192 LOD \u2192 MSH \u2192 SHT \u2192 DDS) with inline IFF trees and bulk save.',
        fileTypes: '.apt, .sat, .lod, .msh, .mgn, .sht, .iff',
        howToUse: 'Right-click an appearance file in the explorer and select "Analyze Appearance Chain".'
    },
    {
        name: 'Mount Wizard',
        description: 'Automate converting creatures and speeders into tameable mounts.',
        fileTypes: '.lua (in mobile/ folders)',
        howToUse: 'Right-click a .lua file in a mobile/ folder and select "Add Mount" or "Validate Mount".'
    },
    {
        name: 'Crafting Workshop (from file)',
        description: 'Open a draft schematic directly in the Crafting Workshop.',
        fileTypes: '.iff or .lua (in draft_schematic/ folders)',
        howToUse: 'Right-click a draft schematic file and select "Open in Crafting Workshop".'
    },
];

const FILE_TOOLS: ForgeTool[] = [
    {
        name: 'IFF Editor',
        description: 'Visual tree browser for IFF binary files with template-based chunk parsing and editing.',
        fileTypes: '.iff, .apt, .sat, .lod, .msh, .mgn, .lmg, .sht, .pob, .flr, .ans, .skt, .prt, .cmp',
        howToUse: 'Open any IFF-based file from the explorer. The editor activates automatically.'
    },
    {
        name: 'STF Editor',
        description: 'Two-column table editor for SWG string table files with search, pagination, and duplicate detection.',
        fileTypes: '.stf',
        howToUse: 'Open any .stf file from the explorer. The editor activates automatically.'
    },
    {
        name: 'CRC Editor',
        description: 'Visual table editor for CRC-to-path mappings in the object template CRC string table.',
        fileTypes: '*crc_string_table.iff',
        howToUse: 'Open any file named *crc_string_table.iff from the explorer.'
    },
    {
        name: 'Datatable Editor',
        description: 'Spreadsheet-style editor for datatable IFF files.',
        fileTypes: 'datatables/**/*.iff',
        howToUse: 'Open any .iff file inside a datatables/ folder. The editor activates automatically.'
    },
    {
        name: 'DDS Editor',
        description: 'View and edit DXT1/DXT5 textures with mipmap display.',
        fileTypes: '.dds',
        howToUse: 'Open any .dds file from the explorer. The editor activates automatically.'
    },
    {
        name: 'Palette Editor',
        description: 'Visual color grid editor for SWG RIFF PAL palette files.',
        fileTypes: '.pal',
        howToUse: 'Open any .pal file from the explorer. The editor activates automatically.'
    },
    {
        name: 'TRN Viewer',
        description: 'View and query SWG terrain files — check boundaries at specific coordinates.',
        fileTypes: '.trn',
        howToUse: 'Open any .trn file from the explorer. The viewer activates automatically.'
    },
];

export class ForgeHub {
    public static currentPanel: ForgeHub | undefined;
    public static readonly viewType = 'swgForge.hub';

    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(): ForgeHub {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (ForgeHub.currentPanel) {
            ForgeHub.currentPanel._panel.reveal(column);
            return ForgeHub.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            ForgeHub.viewType,
            'SWG Forge',
            column || vscode.ViewColumn.One,
            { enableScripts: true }
        );

        ForgeHub.currentPanel = new ForgeHub(panel);
        return ForgeHub.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(
            msg => {
                if (msg.type === 'runCommand' && msg.command) {
                    if (msg.args !== undefined) {
                        vscode.commands.executeCommand(msg.command, msg.args);
                    } else {
                        vscode.commands.executeCommand(msg.command);
                    }
                } else if (msg.type === 'saveConfig') {
                    this._saveConfig(msg.key, msg.value);
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose(): void {
        ForgeHub.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) { d.dispose(); }
        }
    }

    private _getConfigGroups(): { name: string; items: { key: string; label: string; value: string; exists: boolean | null }[] }[] {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const forge = vscode.workspace.getConfiguration('swgForge');
        const treBuilder = vscode.workspace.getConfiguration('treBuilder');

        const checkPath = (rel: string): boolean | null => {
            if (!wsRoot || !rel) { return null; }
            try { return fs.existsSync(path.join(wsRoot, rel)); }
            catch { return null; }
        };

        const ssp = forge.get<string>('serverScriptsPath', 'infinity4.0.0/MMOCoreORB/bin/scripts')!;
        const scp = forge.get<string>('serverConfPath', 'infinity4.0.0/MMOCoreORB/bin/conf')!;
        const csf = forge.get<string>('customScriptsFolder', 'custom_scripts')!;
        const twp = forge.get<string>('tre.workingPath', 'tre/working')!;
        const tvp = forge.get<string>('tre.vanillaPath', 'tre/vanilla')!;
        const trp = forge.get<string>('tre.referencePath', 'tre/infinity')!;
        const top = treBuilder.get<string>('outputPath', 'tre4/infinity_wicked_special.tre')!;

        return [
            {
                name: 'Server',
                items: [
                    { key: 'swgForge.serverScriptsPath', label: 'Scripts Path', value: ssp, exists: checkPath(ssp) },
                    { key: 'swgForge.serverConfPath', label: 'Config Path', value: scp, exists: checkPath(scp) },
                    { key: 'swgForge.customScriptsFolder', label: 'Custom Folder', value: csf, exists: checkPath(path.join(ssp, csf)) },
                ]
            },
            {
                name: 'TRE',
                items: [
                    { key: 'swgForge.tre.workingPath', label: 'Working', value: twp, exists: checkPath(twp) },
                    { key: 'swgForge.tre.vanillaPath', label: 'Vanilla', value: tvp, exists: checkPath(tvp) },
                    { key: 'swgForge.tre.referencePath', label: 'Reference', value: trp, exists: checkPath(trp) },
                    { key: 'treBuilder.outputPath', label: 'Build Output', value: top, exists: checkPath(top) },
                ]
            }
        ];
    }

    private async _saveConfig(key: string, value: string): Promise<void> {
        const dotIdx = key.indexOf('.');
        if (dotIdx === -1) { return; }
        const namespace = key.substring(0, dotIdx);
        const settingKey = key.substring(dotIdx + 1);
        await vscode.workspace.getConfiguration(namespace).update(settingKey, value, vscode.ConfigurationTarget.Workspace);
        this._panel.webview.postMessage({ type: 'configUpdate', groups: this._getConfigGroups() });
    }

    private _getHtml(): string {
        const lines: string[] = [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '<meta charset="UTF-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '<title>SWG Forge</title>',
            '<style>',
            '  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; max-width: 900px; margin: 0 auto; }',
            '  h1 { font-size: 1.6em; margin-bottom: 4px; }',
            '  .subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 24px; font-size: 0.95em; }',
            '  h2 { font-size: 1.15em; margin-top: 28px; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-widget-border); }',
            '  .tool-grid { display: flex; flex-direction: column; gap: 8px; }',
            '  .tool-card { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border-radius: 6px; background: var(--vscode-editor-inactiveSelectionBackground); }',
            '  .tool-card:hover { background: var(--vscode-list-hoverBackground); }',
            '  .tool-body { flex: 1; min-width: 0; }',
            '  .tool-name { font-weight: 600; font-size: 0.95em; }',
            '  .tool-desc { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 2px; }',
            '  .tool-how { font-size: 0.82em; margin-top: 4px; color: var(--vscode-textLink-foreground); }',
            '  .tool-files { font-size: 0.8em; margin-top: 3px; color: var(--vscode-descriptionForeground); font-style: italic; }',
            '  .open-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; border-radius: 3px; cursor: pointer; font-size: 0.82em; flex-shrink: 0; margin-top: 2px; }',
            '  .open-btn:hover { background: var(--vscode-button-hoverBackground); }',
            '  .config-toggle { cursor: pointer; user-select: none; }',
            '  .config-toggle:hover { opacity: 1; }',
            '  .config-group { margin-bottom: 14px; }',
            '  .config-group-label { font-size: 0.78em; text-transform: uppercase; opacity: 0.5; margin-bottom: 4px; letter-spacing: 0.05em; }',
            '  .config-row { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }',
            '  .config-label { font-size: 0.85em; width: 110px; flex-shrink: 0; opacity: 0.8; }',
            '  .config-input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 8px; font-size: 0.82em; font-family: var(--vscode-editor-font-family); border-radius: 2px; }',
            '  .config-input:focus { outline: 1px solid var(--vscode-focusBorder); }',
            '  .config-dot { font-size: 10px; width: 14px; text-align: center; flex-shrink: 0; }',
            '  .config-actions { display: flex; gap: 8px; margin-top: 8px; }',
            '  .settings-btn { background: none; color: var(--vscode-textLink-foreground); border: none; padding: 0; cursor: pointer; font-size: 0.82em; text-decoration: underline; }',
            '  .settings-btn:hover { color: var(--vscode-textLink-activeForeground); }',
            '</style>',
            '</head>',
            '<body>',
            '<h1>SWG Forge</h1>',
            '<div class="subtitle">Development tools for Star Wars Galaxies Emulator</div>',
        ];

        // Configuration section
        const groups = this._getConfigGroups();
        lines.push('<h2 class="config-toggle" id="configToggleHeader">&#x25B6; Configuration</h2>');
        lines.push('<div id="configSection" style="display:none">');
        for (const group of groups) {
            lines.push('  <div class="config-group">');
            lines.push('    <div class="config-group-label">' + group.name + '</div>');
            for (const item of group.items) {
                const color = item.exists === true ? '#4ade80' : item.exists === false ? '#f87171' : '#666';
                lines.push('    <div class="config-row">');
                lines.push('      <span class="config-label">' + item.label + '</span>');
                lines.push('      <input class="config-input" data-config-key="' + item.key + '" value="' + item.value.replace(/"/g, '&quot;') + '" />');
                lines.push('      <span class="config-dot" data-config-dot="' + item.key + '" style="color:' + color + '">&#x25CF;</span>');
                lines.push('    </div>');
            }
            lines.push('  </div>');
        }
        lines.push('  <div class="config-actions">');
        lines.push('    <button class="settings-btn" id="openSettingsBtn">Open in VS Code Settings</button>');
        lines.push('  </div>');
        lines.push('</div>');

        // Standalone tools
        lines.push('<h2>Tools</h2>');
        lines.push('<div class="tool-grid">');
        for (const tool of STANDALONE_TOOLS) {
            lines.push('  <div class="tool-card">');
            lines.push('    <div class="tool-body">');
            lines.push('      <div class="tool-name">' + tool.name + '</div>');
            lines.push('      <div class="tool-desc">' + tool.description + '</div>');
            lines.push('    </div>');
            lines.push('    <button class="open-btn" data-command="' + tool.command + '">Open</button>');
            lines.push('  </div>');
        }
        lines.push('</div>');

        // Sidebar tools
        lines.push('<h2>Sidebar</h2>');
        lines.push('<div class="tool-grid">');
        for (const tool of SIDEBAR_TOOLS) {
            lines.push('  <div class="tool-card">');
            lines.push('    <div class="tool-body">');
            lines.push('      <div class="tool-name">' + tool.name + '</div>');
            lines.push('      <div class="tool-desc">' + tool.description + '</div>');
            lines.push('      <div class="tool-how">' + tool.howToUse + '</div>');
            lines.push('    </div>');
            lines.push('  </div>');
        }
        lines.push('</div>');

        // Context menu tools
        lines.push('<h2>Context Menu Actions</h2>');
        lines.push('<div class="tool-grid">');
        for (const tool of CONTEXT_MENU_TOOLS) {
            lines.push('  <div class="tool-card">');
            lines.push('    <div class="tool-body">');
            lines.push('      <div class="tool-name">' + tool.name + '</div>');
            lines.push('      <div class="tool-desc">' + tool.description + '</div>');
            lines.push('      <div class="tool-files">Files: ' + tool.fileTypes + '</div>');
            lines.push('      <div class="tool-how">' + tool.howToUse + '</div>');
            lines.push('    </div>');
            lines.push('  </div>');
        }
        lines.push('</div>');

        // File-based editors
        lines.push('<h2>File Editors</h2>');
        lines.push('<div class="tool-grid">');
        for (const tool of FILE_TOOLS) {
            lines.push('  <div class="tool-card">');
            lines.push('    <div class="tool-body">');
            lines.push('      <div class="tool-name">' + tool.name + '</div>');
            lines.push('      <div class="tool-desc">' + tool.description + '</div>');
            lines.push('      <div class="tool-files">Files: ' + tool.fileTypes + '</div>');
            lines.push('      <div class="tool-how">' + tool.howToUse + '</div>');
            lines.push('    </div>');
            lines.push('  </div>');
        }
        lines.push('</div>');

        lines.push('<script>');
        lines.push('  var vscode = acquireVsCodeApi();');
        lines.push('  document.querySelectorAll(".open-btn").forEach(function(btn) {');
        lines.push('    btn.addEventListener("click", function() {');
        lines.push('      vscode.postMessage({ type: "runCommand", command: btn.dataset.command });');
        lines.push('    });');
        lines.push('  });');
        lines.push('');
        lines.push('  // Config toggle');
        lines.push('  document.getElementById("configToggleHeader").addEventListener("click", function() {');
        lines.push('    var section = document.getElementById("configSection");');
        lines.push('    var visible = section.style.display !== "none";');
        lines.push('    section.style.display = visible ? "none" : "block";');
        lines.push('    this.innerHTML = (visible ? "&#x25B6;" : "&#x25BC;") + " Configuration";');
        lines.push('  });');
        lines.push('');
        lines.push('  // Config save on change');
        lines.push('  document.querySelectorAll(".config-input").forEach(function(input) {');
        lines.push('    input.addEventListener("change", function() {');
        lines.push('      vscode.postMessage({ type: "saveConfig", key: input.dataset.configKey, value: input.value });');
        lines.push('    });');
        lines.push('  });');
        lines.push('');
        lines.push('  // Open in VS Code Settings');
        lines.push('  document.getElementById("openSettingsBtn").addEventListener("click", function() {');
        lines.push('    vscode.postMessage({ type: "runCommand", command: "workbench.action.openSettings", args: "swgForge" });');
        lines.push('  });');
        lines.push('');
        lines.push('  // Handle config updates from extension');
        lines.push('  window.addEventListener("message", function(event) {');
        lines.push('    var msg = event.data;');
        lines.push('    if (msg.type === "configUpdate" && msg.groups) {');
        lines.push('      msg.groups.forEach(function(g) {');
        lines.push('        g.items.forEach(function(item) {');
        lines.push('          var dot = document.querySelector("[data-config-dot=\\"" + item.key + "\\"]");');
        lines.push('          if (dot) { dot.style.color = item.exists === true ? "#4ade80" : item.exists === false ? "#f87171" : "#666"; }');
        lines.push('        });');
        lines.push('      });');
        lines.push('    }');
        lines.push('  });');
        lines.push('</script>');
        lines.push('</body>');
        lines.push('</html>');

        return lines.join('\n');
    }
}
