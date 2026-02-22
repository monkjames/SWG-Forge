import * as vscode from 'vscode';
import { NpcPlannerPanel } from './npcPlannerPanel';

export function activate(context: vscode.ExtensionContext) {
    console.log('Building NPC Planner extension activated');

    context.subscriptions.push(
        vscode.commands.registerCommand('buildingNpcPlanner.openPlanner', async () => {
            const panel = NpcPlannerPanel.createOrShow(context.extensionUri);
        })
    );
}

export function deactivate() {}
