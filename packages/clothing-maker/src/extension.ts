import * as vscode from 'vscode';
import { ClothingPanel } from './clothingPanel';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('clothingMaker.open', () => {
            ClothingPanel.createOrShow(context.extensionUri);
        })
    );
}

export function deactivate() {}
