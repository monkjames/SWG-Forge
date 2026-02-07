import * as vscode from 'vscode';
import { ACMPanel } from './acmPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('ACM Editor extension activated');

    context.subscriptions.push(
        vscode.commands.registerCommand('acmEditor.open', (uri?: vscode.Uri) => {
            ACMPanel.createOrShow(context.extensionUri, uri?.fsPath);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('acmEditor.addAssets', () => {
            const panel = ACMPanel.createOrShow(context.extensionUri);
            // Panel will show the "Add Assets" view
            setTimeout(() => panel.showAddAssets(), 300);
        })
    );
}

export function deactivate() {}
