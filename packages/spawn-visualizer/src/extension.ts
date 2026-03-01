import * as vscode from 'vscode';
import { SpawnVisualizerPanel } from './spawnVisualizerPanel';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('spawnVisualizer.open', () => {
            SpawnVisualizerPanel.createOrShow(context);
        })
    );
}

export function deactivate() {}
