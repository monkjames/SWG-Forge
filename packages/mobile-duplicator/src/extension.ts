import * as vscode from 'vscode';
import { DuplicatorPanel } from './duplicatorPanel';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('mobileDuplicator.open', () => {
            DuplicatorPanel.createOrShow(context.extensionUri);
        })
    );
}

export function deactivate() {}
