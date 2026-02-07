import * as vscode from 'vscode';
import { DatatableEditorProvider } from './datatableEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    // Register the custom editor provider
    context.subscriptions.push(DatatableEditorProvider.register(context));

    console.log('Datatable Editor extension activated');
}

export function deactivate() {
    // Nothing to clean up
}
