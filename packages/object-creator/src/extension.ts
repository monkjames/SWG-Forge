import * as vscode from 'vscode';
import { CreatorPanel } from './creatorPanel';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('objectCreator.open', () => {
            CreatorPanel.createOrShow(context.extensionUri);
        })
    );
}

export function deactivate() {}
