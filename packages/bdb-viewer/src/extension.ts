import * as vscode from 'vscode';
import { BDBViewerProvider } from './bdbViewerProvider';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(BDBViewerProvider.register(context));
    console.log('BDB Viewer extension activated');
}

export function deactivate() {}
