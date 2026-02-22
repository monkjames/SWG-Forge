import * as vscode from 'vscode';
import { ForgePanel } from './forgePanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Walkway Builder extension activated');

    context.subscriptions.push(
        vscode.commands.registerCommand('walkwayBuilder.open', () => {
            ForgePanel.createOrShow(context.extensionUri);
        })
    );
}

export function deactivate() {}
