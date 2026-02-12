import * as vscode from 'vscode';
import { PaletteEditorProvider } from './paletteEditorProvider';
import { PaletteBrowsePanel } from './paletteBrowsePanel';

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(PaletteEditorProvider.register(context));

    context.subscriptions.push(
        vscode.commands.registerCommand('paletteEditor.browse', () => {
            PaletteBrowsePanel.createOrShow(context.extensionUri);
        })
    );

    console.log('Palette Editor extension activated');
}

export function deactivate() {}
