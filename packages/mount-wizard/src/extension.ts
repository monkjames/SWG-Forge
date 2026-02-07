import * as vscode from 'vscode';
import * as fs from 'fs';
import { MountWizardPanel } from './mountWizardPanel';

const CREATURE_MOB_TYPES = ['MOB_HERBIVORE', 'MOB_CARNIVORE', '"creature"'];

function checkIsCreature(filePath: string): boolean {
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/mobType\s*=\s*(.+?)\s*,?\s*$/m);
    if (!match) return true; // allow if missing (custom mobiles may omit it)
    const mobType = match[1].trim();
    return CREATURE_MOB_TYPES.some(t => mobType === t);
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Mount Wizard extension activated');

    // Register "Add Mount" command (context menu on mobile .lua files)
    context.subscriptions.push(
        vscode.commands.registerCommand('mountWizard.addMount', async (uri: vscode.Uri) => {
            let filePath = uri?.fsPath;
            if (!filePath && vscode.window.activeTextEditor) {
                filePath = vscode.window.activeTextEditor.document.uri.fsPath;
            }

            if (!filePath) {
                vscode.window.showErrorMessage('No mobile template file selected');
                return;
            }

            if (!checkIsCreature(filePath)) {
                vscode.window.showErrorMessage('Only creatures (MOB_HERBIVORE / MOB_CARNIVORE) can be mounts. This mobile is an NPC, droid, or vehicle.');
                return;
            }

            const panel = MountWizardPanel.createOrShow(context.extensionUri);
            panel.loadMobile(filePath);
        })
    );

    // Register "Validate Mount" command - opens same wizard (pre-fills existing data)
    context.subscriptions.push(
        vscode.commands.registerCommand('mountWizard.validateMount', async (uri: vscode.Uri) => {
            let filePath = uri?.fsPath;
            if (!filePath && vscode.window.activeTextEditor) {
                filePath = vscode.window.activeTextEditor.document.uri.fsPath;
            }

            if (!filePath) {
                vscode.window.showErrorMessage('No mobile template file selected');
                return;
            }

            if (!checkIsCreature(filePath)) {
                vscode.window.showErrorMessage('Only creatures (MOB_HERBIVORE / MOB_CARNIVORE) can be mounts. This mobile is an NPC, droid, or vehicle.');
                return;
            }

            const panel = MountWizardPanel.createOrShow(context.extensionUri);
            panel.loadMobile(filePath);
        })
    );
}

export function deactivate() {}
