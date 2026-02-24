import * as vscode from 'vscode';
import { CockpitEditorProvider } from './cockpitEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(CockpitEditorProvider.register(context));
    console.log('SWG Cockpit Editor activated');
}

export function deactivate() {}
