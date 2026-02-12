import * as vscode from 'vscode';
import { ForgePanel } from './forgePanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Armor Forge extension activated');

    context.subscriptions.push(
        vscode.commands.registerCommand('armorForge.open', () => {
            ForgePanel.createOrShow(context.extensionUri);
        })
    );
}

export function deactivate() {}
