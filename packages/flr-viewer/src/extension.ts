import * as vscode from 'vscode';
import { FLRViewerProvider } from './flrViewerProvider';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(FLRViewerProvider.register(context));
    console.log('FLR Viewer extension activated');
}

export function deactivate() {}
