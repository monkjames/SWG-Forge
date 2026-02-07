import * as vscode from 'vscode';
import { ChainPanel } from './chainPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('SWG Appearance Chain Editor activated');

    context.subscriptions.push(
        vscode.commands.registerCommand('swgemu.analyzeAppearanceChain', async (uri?: vscode.Uri) => {
            let filePath = uri?.fsPath;

            // If no URI from context menu, use active editor
            if (!filePath && vscode.window.activeTextEditor) {
                filePath = vscode.window.activeTextEditor.document.uri.fsPath;
            }

            if (!filePath) {
                vscode.window.showErrorMessage('No file selected for appearance chain analysis');
                return;
            }

            const panel = ChainPanel.createOrShow(context.extensionUri);

            // Give webview time to initialize on first open
            setTimeout(() => {
                panel.analyzeFile(filePath!);
            }, 300);
        })
    );
}

export function deactivate() {}
