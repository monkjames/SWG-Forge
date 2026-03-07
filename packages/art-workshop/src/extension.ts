import * as vscode from 'vscode';
import { ArtWorkshopPanel } from './artWorkshopPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Art Workshop extension activated');

    context.subscriptions.push(
        vscode.commands.registerCommand('artWorkshop.open', () => {
            ArtWorkshopPanel.createOrShow(context.extensionUri);
        })
    );
}

export function deactivate() {}
