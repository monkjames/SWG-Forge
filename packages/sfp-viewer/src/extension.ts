import * as vscode from 'vscode';
import { SFPViewerProvider } from './sfpViewerProvider';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(SFPViewerProvider.register(context));
    console.log('SFP Viewer extension activated');
}

export function deactivate() {}
