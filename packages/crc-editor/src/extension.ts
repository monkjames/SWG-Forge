import * as vscode from 'vscode';
import { CRCEditorProvider } from './crcEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('CRC Editor extension activated');

    context.subscriptions.push(
        CRCEditorProvider.register(context)
    );
}

export function deactivate() {}
