import * as vscode from 'vscode';
import { TREBuilderProvider } from './treBuilderProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('TRE Builder extension activated');

    // Register the webview provider for the sidebar
    const provider = new TREBuilderProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('treBuilderFiles', provider)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('treBuilder.build', () => {
            provider.build();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('treBuilder.refresh', () => {
            provider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('treBuilder.validate', () => {
            provider.validate();
        })
    );
}

export function deactivate() {}
