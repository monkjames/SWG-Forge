import * as vscode from 'vscode';
import * as path from 'path';
import { ForgeHub } from './forgeHub';

/**
 * SWG Forge configuration helper.
 *
 * Provides resolved workspace paths for all SWG Forge extensions.
 * Other extensions can read these same settings via:
 *   vscode.workspace.getConfiguration('swgForge')
 *
 * Or use the convenience functions exported here.
 */

export interface SWGForgePaths {
    /** Absolute path to server scripts directory */
    serverScripts: string;
    /** Absolute path to server conf directory */
    serverConf: string;
    /** Name of custom scripts subfolder (e.g., "custom_scripts") */
    customScriptsFolder: string;
    /** Absolute path to custom scripts directory */
    customScripts: string;
    /** Absolute path to editable TRE working directory */
    treWorking: string;
    /** Absolute path to read-only vanilla TRE directory */
    treVanilla: string;
    /** Absolute path to read-only server-specific TRE directory */
    treReference: string;
    /** Workspace root */
    workspaceRoot: string;
}

/**
 * Get resolved SWG Forge paths from workspace configuration.
 */
export function getForgeConfig(): SWGForgePaths | null {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { return null; }

    const config = vscode.workspace.getConfiguration('swgForge');

    const serverScripts = path.join(workspaceRoot, config.get<string>('serverScriptsPath', 'infinity_wicked/MMOCoreORB/bin/scripts'));
    const serverConf = path.join(workspaceRoot, config.get<string>('serverConfPath', 'infinity_wicked/MMOCoreORB/bin/conf'));
    const customScriptsFolder = config.get<string>('customScriptsFolder', 'custom_scripts');
    const customScripts = customScriptsFolder
        ? path.join(serverScripts, customScriptsFolder)
        : serverScripts;

    return {
        serverScripts,
        serverConf,
        customScriptsFolder,
        customScripts,
        treWorking: path.join(workspaceRoot, config.get<string>('tre.workingPath', 'tre/working')),
        treVanilla: path.join(workspaceRoot, config.get<string>('tre.vanillaPath', 'tre/vanilla')),
        treReference: path.join(workspaceRoot, config.get<string>('tre.referencePath', 'tre/infinity')),
        workspaceRoot
    };
}

export function activate(context: vscode.ExtensionContext) {
    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('swgForge.open', () => {
            ForgeHub.createOrShow();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('swgForge.showConfig', () => {
            const paths = getForgeConfig();
            if (!paths) {
                vscode.window.showWarningMessage('No workspace folder open.');
                return;
            }

            const lines = [
                'SWG Forge Configuration:',
                '',
                `Server Scripts:    ${paths.serverScripts}`,
                `Server Conf:       ${paths.serverConf}`,
                `Custom Scripts:    ${paths.customScripts}`,
                `TRE Working:       ${paths.treWorking}`,
                `TRE Vanilla:       ${paths.treVanilla}`,
                `TRE Reference:     ${paths.treReference}`,
            ];

            const doc = vscode.workspace.openTextDocument({
                content: lines.join('\n'),
                language: 'text'
            });
            doc.then(d => vscode.window.showTextDocument(d));
        })
    );

    // Status bar button
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(rocket) SWG Forge';
    statusBarItem.tooltip = 'Open SWG: Forge toolkit';
    statusBarItem.command = 'swgForge.open';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
}

export function deactivate() {}
