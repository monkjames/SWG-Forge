import * as vscode from 'vscode';
import { ForgePanel } from './forgePanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Object Forge extension activated');

    context.subscriptions.push(
        vscode.commands.registerCommand('objectForge.open', () => {
            ForgePanel.createOrShow(context.extensionUri);
        })
    );
}

export function deactivate() {}
