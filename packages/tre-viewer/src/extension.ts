import * as vscode from 'vscode';
import { TREViewerProvider } from './treViewerProvider';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(TREViewerProvider.register(context));
    console.log('TRE Viewer extension activated');
}

export function deactivate() {}
