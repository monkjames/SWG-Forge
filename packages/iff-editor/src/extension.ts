import * as vscode from 'vscode';
import { IFFEditorProvider } from './iffEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(IFFEditorProvider.register(context));
    console.log('IFF Editor extension activated');
}

export function deactivate() {
    // Nothing to clean up
}
