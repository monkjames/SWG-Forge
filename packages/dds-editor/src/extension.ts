import * as vscode from 'vscode';
import { DDSEditorProvider } from './ddsEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(DDSEditorProvider.register(context));
    console.log('DDS Editor extension activated');
}

export function deactivate() {}
