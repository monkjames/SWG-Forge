import * as vscode from 'vscode';
import { CombatPanel } from './combatPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Combat Simulator extension activated');

    context.subscriptions.push(
        vscode.commands.registerCommand('combatSim.open', () => {
            CombatPanel.createOrShow(context.extensionUri);
        })
    );
}

export function deactivate() {}
