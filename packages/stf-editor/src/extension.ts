import * as vscode from 'vscode';
import { STFEditorProvider } from './stfEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    // Register the custom editor provider
    context.subscriptions.push(STFEditorProvider.register(context));

    console.log('STF Editor extension activated');
}

export function deactivate() {
    // Nothing to clean up
}
