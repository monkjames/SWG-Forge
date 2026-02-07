import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WorkshopPanel } from './workshopPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Crafting Workshop extension activated');

    // Register command to open workshop
    context.subscriptions.push(
        vscode.commands.registerCommand('craftingWorkshop.open', () => {
            WorkshopPanel.createOrShow(context.extensionUri);
        })
    );

    // Register command to open from schematic file
    context.subscriptions.push(
        vscode.commands.registerCommand('craftingWorkshop.openFromSchematic', async (uri: vscode.Uri) => {
            // If no URI provided, use active editor
            let schematicPath = uri?.fsPath;
            if (!schematicPath && vscode.window.activeTextEditor) {
                schematicPath = vscode.window.activeTextEditor.document.uri.fsPath;
            }

            if (!schematicPath) {
                vscode.window.showErrorMessage('No schematic file selected');
                return;
            }

            // Open workshop and load the schematic
            const panel = WorkshopPanel.createOrShow(context.extensionUri);

            // Give the webview time to initialize
            setTimeout(() => {
                panel.loadSchematic(schematicPath);
            }, 500);
        })
    );
}

export function deactivate() {}
