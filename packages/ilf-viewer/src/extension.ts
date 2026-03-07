import * as vscode from 'vscode';
import { ILFViewerProvider } from './ilfViewerProvider';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(ILFViewerProvider.register(context));
    console.log('ILF Viewer extension activated');
}

export function deactivate() {}
