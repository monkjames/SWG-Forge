import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SchematicLoader, SchematicProject } from './schematicLoader';
import * as CraftingMath from './craftingMath';

export class WorkshopPanel {
    public static currentPanel: WorkshopPanel | undefined;
    public static readonly viewType = 'craftingWorkshop';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _project: SchematicProject | null = null;
    private _session: CraftingMath.CraftingSession | null = null;

    public static createOrShow(extensionUri: vscode.Uri): WorkshopPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (WorkshopPanel.currentPanel) {
            WorkshopPanel.currentPanel._panel.reveal(column);
            return WorkshopPanel.currentPanel;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            WorkshopPanel.viewType,
            'Crafting Workshop',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        WorkshopPanel.currentPanel = new WorkshopPanel(panel, extensionUri);
        return WorkshopPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Set initial HTML content
        this._updateWebview();

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );

        // Handle panel disposal
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public loadSchematic(schematicPath: string): void {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        try {
            this._project = SchematicLoader.loadProject(schematicPath, workspaceRoot);

            // Initialize crafting session
            this._initializeSession();

            // Send project data to webview
            this._panel.webview.postMessage({
                type: 'projectLoaded',
                project: this._serializeProject()
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to load schematic: ${error.message}`);
        }
    }

    private _initializeSession(): void {
        if (!this._project) return;

        // Default resource stats (matches UI default of 500)
        const defaultResourceStats: CraftingMath.ResourceStats = {
            OQ: 500, CR: 500, CD: 500, DR: 500, HR: 500,
            MA: 500, PE: 500, SR: 500, UT: 500, FL: 500
        };

        // Convert project data to session format
        const slots: CraftingMath.IngredientSlot[] = this._project.schematic.slots.map(slot => ({
            name: slot.titleName,
            slotType: slot.slotType as CraftingMath.SlotType,
            quantity: slot.quantity,
            contribution: slot.contribution / 100,  // Convert to 0-1
            // Initialize resource slots with default stats
            resource: slot.slotType === 0 ? { ...defaultResourceStats } : undefined,
            component: undefined
        }));

        // Get parsed attribute weights from target template (these have the actual formulas)
        const parsedAttributeWeights = this._project.targetTemplate?.attributeWeights || [];

        // Convert to experimental properties format for the session
        const experimentalProperties: CraftingMath.ExperimentalProperty[] = [];
        const resourceWeights: CraftingMath.ResourceWeight[] = [];

        for (const aw of parsedAttributeWeights) {
            // Find the index in experimentalSubGroupTitles to get min/max/precision
            const subIdx = this._project.targetTemplate?.experimentalSubGroupTitles?.indexOf(aw.attribute) ?? -1;

            experimentalProperties.push({
                attribute: aw.attribute,
                group: aw.group,
                min: subIdx >= 0 ? (this._project.targetTemplate?.experimentalMin?.[subIdx] || 0) : 0,
                max: subIdx >= 0 ? (this._project.targetTemplate?.experimentalMax?.[subIdx] || 100) : 100,
                precision: subIdx >= 0 ? (this._project.targetTemplate?.experimentalPrecision?.[subIdx] || 0) : 0,
                combineType: subIdx >= 0 ? (this._project.targetTemplate?.experimentalCombineType?.[subIdx] || 0) : 0,
                weight: 1
            });

            // Convert ResourceWeightInfo[] to Record<string, number> format
            const weights: Record<string, number> = {};
            for (const rw of aw.resourceWeights) {
                weights[rw.stat] = rw.weight;
            }

            resourceWeights.push({
                attribute: aw.attribute,
                group: aw.group,
                weights
            });
        }

        this._session = CraftingMath.createSession(
            this._project.schematic.customObjectName,
            slots,
            resourceWeights,
            experimentalProperties
        );
    }

    private _serializeProject(): any {
        if (!this._project) return null;

        // Convert Set to Array for JSON serialization
        const targetTemplate = this._project.targetTemplate ? {
            ...this._project.targetTemplate,
            blueFrogInferred: Array.from(this._project.targetTemplate.blueFrogInferred || [])
        } : null;

        return {
            schematicName: this._project.schematic.customObjectName,
            schematicIffPath: this._project.schematicIffPath,
            schematicLuaPath: this._project.schematicLuaPath,
            targetTemplatePath: this._project.targetTemplatePath,
            slots: this._project.schematic.slots,
            targetTemplate,
            session: this._session ? {
                assemblySkill: this._session.assemblySkill,
                experimentationSkill: this._session.experimentationSkill,
                toolEffectiveness: this._session.toolEffectiveness
            } : null
        };
    }

    private async _handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'ready':
                // Webview is ready
                break;

            case 'setResourceStats':
                // Set resource stats for a slot (merge with existing)
                if (this._session && message.slotIndex !== undefined) {
                    const slot = this._session.slots[message.slotIndex];
                    slot.resource = { ...(slot.resource || {}), ...message.stats };
                    this._updateSimulation();
                }
                break;

            case 'setComponentStats':
                // Set component stats for a slot (merge with existing)
                if (this._session && message.slotIndex !== undefined) {
                    const slot = this._session.slots[message.slotIndex];
                    slot.component = { ...(slot.component || {}), ...message.stats };
                    this._updateSimulation();
                }
                break;

            case 'setSkills':
                // Update player skills
                if (this._session) {
                    this._session.assemblySkill = message.assemblySkill || 100;
                    this._session.experimentationSkill = message.experimentationSkill || 100;
                    this._session.toolEffectiveness = message.toolEffectiveness || 0;
                }
                break;

            case 'runSimulation':
                this._runSimulation(message.experimentationAttempts || []);
                break;

            case 'applyChanges':
                await this._applyChanges(message.formulas);
                break;

            case 'openFile':
                if (message.path) {
                    const uri = vscode.Uri.file(message.path);
                    await vscode.window.showTextDocument(uri);
                }
                break;

            case 'saveBlueFrogDefaults':
                await this._saveBlueFrogDefaults(message.defaults);
                break;

            case 'runValidation':
                this._runValidation();
                break;
        }
    }

    private _runValidation(): void {
        if (!this._project) return;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const report = SchematicLoader.validateProject(this._project, workspaceRoot);

        this._panel.webview.postMessage({
            type: 'validationComplete',
            report
        });
    }

    private _updateSimulation(): void {
        if (!this._session) return;

        // Recalculate with current inputs
        this._session.attributes.clear();

        const result = CraftingMath.simulateCrafting(this._session, []);

        // Get experimentation rows with bubble counts
        const experimentationRows = CraftingMath.getExperimentationRows(this._session);

        this._panel.webview.postMessage({
            type: 'simulationUpdated',
            assemblyResult: CraftingMath.resultToString(result.assemblyResult),
            attributes: Array.from(result.finalAttributes.entries()).map(([, attr]) => ({
                ...attr,
                formattedValue: CraftingMath.formatValue(attr.currentValue, attr.precision)
            })),
            experimentationRows
        });
    }

    private _runSimulation(experimentationAttempts: Array<{group: string; points: number}>): void {
        if (!this._session) return;

        // Reset attributes for fresh simulation
        this._session.attributes.clear();

        const result = CraftingMath.simulateCrafting(this._session, experimentationAttempts);

        // Get experimentation rows with bubble counts
        const experimentationRows = CraftingMath.getExperimentationRows(this._session);

        this._panel.webview.postMessage({
            type: 'simulationComplete',
            assemblyResult: CraftingMath.resultToString(result.assemblyResult),
            experimentResults: result.experimentResults.map(r => ({
                group: r.group,
                result: CraftingMath.resultToString(r.result),
                points: r.points
            })),
            attributes: Array.from(result.finalAttributes.entries()).map(([, attr]) => ({
                ...attr,
                formattedValue: CraftingMath.formatValue(attr.currentValue, attr.precision)
            })),
            experimentationRows
        });
    }

    private async _applyChanges(formulas: any[]): Promise<void> {
        if (!this._project) {
            vscode.window.showErrorMessage('No project loaded');
            return;
        }

        if (!this._project.targetTemplatePath) {
            vscode.window.showErrorMessage('No target template file found');
            return;
        }

        if (!formulas || formulas.length === 0) {
            vscode.window.showWarningMessage('No formula changes to apply');
            return;
        }

        try {
            // Read current file
            const filePath = this._project.targetTemplatePath;
            const content = fs.readFileSync(filePath, 'utf8');

            // Build the new arrays from formulas
            // We need to preserve any "null" placeholder entries and add our formulas
            const numProps: number[] = [];
            const expProps: string[] = [];
            const expWeights: number[] = [];
            const groupTitles: string[] = [];
            const subGroupTitles: string[] = [];
            const expMin: number[] = [];
            const expMax: number[] = [];
            const expPrecision: number[] = [];
            const expCombineType: number[] = [];

            // Get existing arrays to preserve structure (like leading nulls)
            const existingNumProps = this._project.targetTemplate?.numberExperimentalProperties || [];

            // Count how many leading "null" entries there are
            let leadingNulls = 0;
            const existingSubGroups = this._project.targetTemplate?.experimentalSubGroupTitles || [];
            for (const sg of existingSubGroups) {
                if (sg === 'null' || sg === '') leadingNulls++;
                else break;
            }

            // Add leading null entries
            for (let i = 0; i < leadingNulls; i++) {
                numProps.push(existingNumProps[i] || 1);
                expProps.push('XX');
                expWeights.push(1);
                groupTitles.push('null');
                subGroupTitles.push('null');
                expMin.push(0);
                expMax.push(0);
                expPrecision.push(0);
                expCombineType.push(0);
            }

            // Add formulas
            for (const formula of formulas) {
                numProps.push(formula.resourceWeights.length);
                groupTitles.push(formula.group || 'exp_effectiveness');
                subGroupTitles.push(formula.attribute);
                expMin.push(formula.min || 0);
                expMax.push(formula.max || 100);
                expPrecision.push(formula.precision || 0);
                expCombineType.push(1); // LINEARCOMBINE

                for (const rw of formula.resourceWeights) {
                    expProps.push(rw.stat);
                    expWeights.push(rw.weight);
                }
            }

            // Format arrays for Lua
            const formatNumArray = (arr: number[]) => '{' + arr.join(', ') + '}';
            const formatStrArray = (arr: string[]) => '{"' + arr.join('", "') + '"}';

            // Generate documentation comment block
            const commentBlock = this._generateFormulaComment(formulas);

            // Build replacement patterns
            const replacements: [RegExp, string][] = [
                [/numberExperimentalProperties\s*=\s*\{[^}]*\}/m, `numberExperimentalProperties = ${formatNumArray(numProps)}`],
                [/experimentalProperties\s*=\s*\{[^}]*\}/m, `experimentalProperties = ${formatStrArray(expProps)}`],
                [/experimentalWeights\s*=\s*\{[^}]*\}/m, `experimentalWeights = ${formatNumArray(expWeights)}`],
                [/experimentalGroupTitles\s*=\s*\{[^}]*\}/m, `experimentalGroupTitles = ${formatStrArray(groupTitles)}`],
                [/experimentalSubGroupTitles\s*=\s*\{[^}]*\}/m, `experimentalSubGroupTitles = ${formatStrArray(subGroupTitles)}`],
                [/experimentalMin\s*=\s*\{[^}]*\}/m, `experimentalMin = ${formatNumArray(expMin)}`],
                [/experimentalMax\s*=\s*\{[^}]*\}/m, `experimentalMax = ${formatNumArray(expMax)}`],
                [/experimentalPrecision\s*=\s*\{[^}]*\}/m, `experimentalPrecision = ${formatNumArray(expPrecision)}`],
                [/experimentalCombineType\s*=\s*\{[^}]*\}/m, `experimentalCombineType = ${formatNumArray(expCombineType)}`],
            ];

            let newContent = content;

            // Remove any existing Crafting Workshop comment block
            newContent = newContent.replace(/\n?\t*-- \[Crafting Workshop\][\s\S]*?-- \[\/Crafting Workshop\]\n?/gm, '\n');

            // Apply replacements
            for (const [pattern, replacement] of replacements) {
                newContent = newContent.replace(pattern, replacement);
            }

            // Insert comment block before numberExperimentalProperties
            newContent = newContent.replace(
                /(\n\t*)(numberExperimentalProperties\s*=)/m,
                `$1${commentBlock}$1$2`
            );

            // Write back to file
            fs.writeFileSync(filePath, newContent, 'utf8');

            // Reload the project using the original schematic path (not target template)
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            const reloadPath = this._project.schematicLuaPath || this._project.schematicIffPath;
            if (reloadPath) {
                this._project = SchematicLoader.loadProject(reloadPath, workspaceRoot);
                this._initializeSession();
            }

            // Reset unsaved changes flag
            this._panel.webview.postMessage({ type: 'changesSaved' });

            // Notify webview with updated project
            this._panel.webview.postMessage({
                type: 'projectLoaded',
                project: this._serializeProject()
            });

            vscode.window.showInformationMessage(`Saved changes to ${path.basename(filePath)}`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to save changes: ${error.message}`);
        }
    }

    private async _saveBlueFrogDefaults(defaults: Record<string, number>): Promise<void> {
        if (!this._project || !this._project.targetTemplatePath) {
            vscode.window.showErrorMessage('No target template file found');
            return;
        }

        if (!defaults || Object.keys(defaults).length === 0) {
            vscode.window.showWarningMessage('No blue frog values to save');
            return;
        }

        try {
            const filePath = this._project.targetTemplatePath;
            let content = fs.readFileSync(filePath, 'utf8');

            // Update each blue frog property
            for (const [prop, value] of Object.entries(defaults)) {
                // Match property assignment: prop = number (handles integers and floats)
                const regex = new RegExp(`(\\b${prop}\\s*=\\s*)(-?[\\d.]+)`, 'gm');
                if (regex.test(content)) {
                    // Reset regex lastIndex before replace
                    regex.lastIndex = 0;
                    content = content.replace(regex, `$1${value}`);
                }
            }

            fs.writeFileSync(filePath, content, 'utf8');

            // Reload the project
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            const reloadPath = this._project.schematicLuaPath || this._project.schematicIffPath;
            if (reloadPath) {
                this._project = SchematicLoader.loadProject(reloadPath, workspaceRoot);
                this._initializeSession();
            }

            // Notify webview
            this._panel.webview.postMessage({ type: 'blueFrogSaved' });
            this._panel.webview.postMessage({
                type: 'projectLoaded',
                project: this._serializeProject()
            });

            vscode.window.showInformationMessage(`Saved blue frog defaults to ${path.basename(filePath)}`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to save blue frog defaults: ${error.message}`);
        }
    }

    private _generateFormulaComment(formulas: any[]): string {
        const lines: string[] = [];
        const date = new Date().toISOString().split('T')[0];

        lines.push('-- [Crafting Workshop]');
        lines.push(`-- Generated by Crafting Workshop on ${date}`);
        lines.push('--');
        lines.push('-- CRAFTING FORMULAS:');
        lines.push('-- Each attribute below shows which resource stats contribute and their weight.');
        lines.push('-- Higher weight = more influence on final value. Percentages show relative contribution.');
        lines.push('--');

        // Resource stat legend
        lines.push('-- Resource Stats: OQ=Overall Quality, CR=Cold Resist, CD=Conductivity, DR=Decay Resist,');
        lines.push('--                 HR=Heat Resist, MA=Malleability, PE=Potential Energy, SR=Shock Resist,');
        lines.push('--                 UT=Unit Toughness, FL=Flavor');
        lines.push('--');

        // Generate a visual grid for each formula
        for (const formula of formulas) {
            const totalWeight = formula.resourceWeights.reduce((sum: number, rw: any) => sum + rw.weight, 0);
            const statsWithPct = formula.resourceWeights.map((rw: any) => {
                const pct = totalWeight > 0 ? Math.round((rw.weight / totalWeight) * 100) : 0;
                return `${rw.stat}:${pct}%`;
            });

            lines.push(`-- ┌─ ${formula.attribute.toUpperCase()} ─────────────────────────────────`);
            lines.push(`-- │  Range: ${formula.min || 0} - ${formula.max || 100}${formula.precision > 0 ? ` (${formula.precision} decimals)` : ''}`);
            lines.push(`-- │  Formula: ${statsWithPct.join(' + ')}`);

            // Visual weight bar for each stat
            for (const rw of formula.resourceWeights) {
                const pct = totalWeight > 0 ? Math.round((rw.weight / totalWeight) * 100) : 0;
                const barLength = Math.round(pct / 5); // Scale to ~20 chars max
                const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength);
                lines.push(`-- │    ${rw.stat}: [${bar}] ${pct}% (weight: ${rw.weight})`);
            }
            lines.push('-- └──────────────────────────────────────────');
            lines.push('--');
        }

        lines.push('-- [/Crafting Workshop]');

        return lines.join('\n\t') + '\n\t';
    }

    private _updateWebview(): void {
        this._panel.webview.html = this._getHtmlContent();
    }

    private _getHtmlContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Crafting Workshop</title>
    <style>
        :root {
            --bg-primary: var(--vscode-editor-background);
            --bg-secondary: var(--vscode-sideBar-background);
            --fg-primary: var(--vscode-editor-foreground);
            --fg-secondary: var(--vscode-descriptionForeground);
            --border: var(--vscode-panel-border);
            --accent: var(--vscode-button-background);
            --accent-hover: var(--vscode-button-hoverBackground);
            --success: #4ec9b0;
            --warning: #dcdcaa;
            --error: #f14c4c;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--fg-primary);
            background: var(--bg-primary);
            padding: 16px;
        }

        .workshop-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--border);
        }

        .workshop-header h1 {
            font-size: 18px;
            font-weight: 500;
        }

        .header-actions {
            display: flex;
            gap: 8px;
        }

        .btn {
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            background: var(--accent);
            color: var(--vscode-button-foreground);
        }

        .btn:hover {
            background: var(--accent-hover);
        }

        .btn-success {
            background: var(--success);
        }

        .workshop-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
        }

        .panel {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 12px;
        }

        .panel-header {
            font-size: 14px;
            font-weight: 500;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--border);
        }

        .slot-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .slot-card {
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 10px;
        }

        .slot-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .slot-name {
            font-weight: 500;
        }

        .slot-type {
            font-size: 10px;
            padding: 2px 6px;
            border-radius: 3px;
            background: var(--accent);
            opacity: 0.7;
        }

        .stat-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 4px;
        }

        .stat-input {
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .stat-input label {
            font-size: 9px;
            color: var(--fg-secondary);
            margin-bottom: 2px;
        }

        .stat-input input {
            width: 100%;
            padding: 4px;
            border: 1px solid var(--border);
            border-radius: 3px;
            background: var(--bg-secondary);
            color: var(--fg-primary);
            text-align: center;
            font-size: 11px;
        }

        /* Tier 1: Used in crafting formula - GREEN */
        .stat-input.used {
            background: rgba(78, 201, 176, 0.15);
            border-radius: 4px;
            padding: 2px;
        }

        .stat-input.used label {
            color: var(--success);
            font-weight: 600;
        }

        .stat-input.used input {
            border-color: var(--success);
            background: rgba(78, 201, 176, 0.1);
        }

        .stat-input.used .stat-pct {
            font-size: 7px;
            color: var(--success);
            margin-top: 2px;
            line-height: 1.3;
            cursor: help;
        }

        /* Tier 2: Exists for resource but not used - GREY */
        .stat-input.exists {
            opacity: 0.6;
        }

        .stat-input.exists label {
            color: var(--fg-secondary);
        }

        .stat-input.exists input {
            background: var(--bg-primary);
            border-color: var(--border);
        }

        /* Tier 3: Formula wants it but resource doesn't have it - WARNING */
        .stat-input.missing {
            background: rgba(255, 140, 0, 0.15);
            border-radius: 4px;
            padding: 2px;
        }

        .stat-input.missing label {
            color: var(--warning);
            font-weight: 500;
        }

        .stat-input.missing input {
            border-color: var(--warning);
            background: rgba(255, 140, 0, 0.1);
        }

        .stat-input.missing .stat-pct {
            font-size: 7px;
            color: var(--warning);
            margin-top: 2px;
        }

        /* Tier 4: Doesn't exist and not used - VERY DIM */
        .stat-input.not-applicable {
            opacity: 0.25;
        }

        .stat-input.not-applicable input {
            background: var(--bg-primary);
        }

        .results-panel {
            grid-column: 1 / -1;
        }

        .attribute-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 8px;
        }

        .attribute-card {
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 8px;
        }

        .attribute-name {
            font-size: 11px;
            color: var(--fg-secondary);
            margin-bottom: 4px;
        }

        .attribute-value {
            font-size: 16px;
            font-weight: 500;
        }

        .attribute-bar {
            height: 4px;
            background: var(--border);
            border-radius: 2px;
            margin-top: 6px;
            overflow: hidden;
        }

        .attribute-bar-fill {
            height: 100%;
            background: var(--success);
            transition: width 0.3s;
        }

        .attribute-range {
            display: flex;
            justify-content: space-between;
            font-size: 9px;
            color: var(--fg-secondary);
            margin-top: 2px;
        }

        /* Experimentation Rows */
        .exp-rows-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .exp-row-card {
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 10px;
        }

        .exp-row-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .exp-row-name {
            font-weight: 500;
            font-size: 12px;
        }

        .exp-row-attrs {
            font-size: 10px;
            color: var(--fg-secondary);
        }

        .bubble-row {
            display: flex;
            gap: 3px;
            align-items: center;
        }

        .bubble {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            border: 1px solid var(--border);
            background: var(--bg-secondary);
        }

        .bubble.filled {
            background: var(--success);
            border-color: var(--success);
        }

        .bubble.current {
            background: var(--accent);
            border-color: var(--accent);
        }

        .bubble-count {
            margin-left: 8px;
            font-size: 11px;
            color: var(--fg-secondary);
        }

        .exp-row-info {
            display: flex;
            justify-content: space-between;
            font-size: 10px;
            color: var(--fg-secondary);
            margin-top: 6px;
        }

        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--fg-secondary);
        }

        .skills-row {
            display: flex;
            gap: 12px;
            margin-bottom: 12px;
        }

        .skill-input {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .skill-input label {
            font-size: 11px;
            color: var(--fg-secondary);
        }

        .skill-input input {
            width: 60px;
            padding: 4px;
            border: 1px solid var(--border);
            border-radius: 3px;
            background: var(--bg-secondary);
            color: var(--fg-primary);
            text-align: center;
        }

        .simulation-controls {
            display: flex;
            gap: 8px;
            margin-top: 12px;
        }

        .file-links {
            display: flex;
            gap: 8px;
            margin-top: 8px;
        }

        .file-link {
            font-size: 10px;
            color: var(--accent);
            cursor: pointer;
            text-decoration: underline;
        }

        .file-link:hover {
            opacity: 0.8;
        }

        /* Formula Editor Styles */
        .formula-editor {
            margin-top: 16px;
        }

        .formula-card {
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 12px;
            margin-bottom: 12px;
        }

        .formula-card.editing {
            border-color: var(--accent);
            box-shadow: 0 0 0 1px var(--accent);
        }

        .formula-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }

        .formula-name {
            font-weight: 600;
            font-size: 13px;
        }

        .formula-name input {
            background: transparent;
            border: 1px solid transparent;
            color: var(--fg-primary);
            font-weight: 600;
            font-size: 13px;
            padding: 2px 6px;
            border-radius: 3px;
            width: 120px;
        }

        .formula-name input:hover {
            border-color: var(--border);
        }

        .formula-name input:focus {
            border-color: var(--accent);
            outline: none;
            background: var(--bg-secondary);
        }

        .formula-group {
            font-size: 10px;
            color: var(--fg-secondary);
            background: var(--bg-secondary);
            padding: 2px 6px;
            border-radius: 3px;
        }

        .formula-range {
            display: flex;
            gap: 12px;
            margin-bottom: 12px;
            font-size: 11px;
        }

        .formula-range label {
            color: var(--fg-secondary);
        }

        .formula-range input {
            width: 60px;
            padding: 3px 6px;
            border: 1px solid var(--border);
            border-radius: 3px;
            background: var(--bg-secondary);
            color: var(--fg-primary);
            text-align: center;
        }

        .formula-weights {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .weight-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .weight-stat {
            width: 32px;
            font-weight: 600;
            font-size: 11px;
            color: var(--success);
        }

        .weight-slider-container {
            flex: 1;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .weight-slider {
            flex: 1;
            height: 6px;
            -webkit-appearance: none;
            background: var(--border);
            border-radius: 3px;
            outline: none;
        }

        .weight-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 14px;
            height: 14px;
            background: var(--success);
            border-radius: 50%;
            cursor: pointer;
        }

        .weight-value {
            width: 40px;
            padding: 2px 4px;
            border: 1px solid var(--border);
            border-radius: 3px;
            background: var(--bg-secondary);
            color: var(--fg-primary);
            text-align: center;
            font-size: 10px;
        }

        .weight-pct {
            width: 36px;
            font-size: 10px;
            color: var(--fg-secondary);
            text-align: right;
        }

        .weight-remove {
            background: none;
            border: none;
            color: var(--error);
            cursor: pointer;
            font-size: 14px;
            padding: 0 4px;
            opacity: 0.6;
        }

        .weight-remove:hover {
            opacity: 1;
        }

        .add-stat-row {
            display: flex;
            gap: 8px;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px dashed var(--border);
        }

        .add-stat-select {
            flex: 1;
            padding: 4px 8px;
            border: 1px solid var(--border);
            border-radius: 3px;
            background: var(--bg-secondary);
            color: var(--fg-primary);
            font-size: 11px;
        }

        .add-stat-btn {
            padding: 4px 12px;
            background: var(--accent);
            border: none;
            border-radius: 3px;
            color: var(--vscode-button-foreground);
            font-size: 11px;
            cursor: pointer;
        }

        .add-stat-btn:hover {
            background: var(--accent-hover);
        }

        .add-attribute-btn {
            width: 100%;
            padding: 10px;
            margin-top: 8px;
            background: transparent;
            border: 2px dashed var(--border);
            border-radius: 6px;
            color: var(--fg-secondary);
            font-size: 12px;
            cursor: pointer;
        }

        .add-attribute-btn:hover {
            border-color: var(--accent);
            color: var(--accent);
        }

        .formula-actions {
            display: flex;
            gap: 8px;
            margin-top: 8px;
        }

        .formula-actions button {
            padding: 2px 8px;
            font-size: 10px;
            border-radius: 3px;
            cursor: pointer;
        }

        .btn-delete {
            background: transparent;
            border: 1px solid var(--error);
            color: var(--error);
        }

        .btn-delete:hover {
            background: var(--error);
            color: white;
        }

        /* Tab Navigation */
        .tab-nav {
            display: flex;
            border-bottom: 1px solid var(--border);
            margin-bottom: 16px;
            gap: 4px;
        }

        .tab-btn {
            padding: 10px 20px;
            border: none;
            background: transparent;
            color: var(--fg-secondary);
            cursor: pointer;
            font-size: 12px;
            border-bottom: 2px solid transparent;
            margin-bottom: -1px;
            transition: all 0.2s;
        }

        .tab-btn:hover {
            color: var(--fg-primary);
            background: var(--bg-secondary);
        }

        .tab-btn.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
            font-weight: 500;
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }

        /* Blue Frog Tab Styles */
        .bluefrog-description {
            font-size: 11px;
            color: var(--fg-secondary);
            margin-bottom: 16px;
            padding: 10px;
            background: var(--bg-primary);
            border-radius: 4px;
            border-left: 3px solid var(--accent);
        }

        .bluefrog-section {
            margin-bottom: 20px;
        }

        .bluefrog-section-title {
            font-size: 11px;
            font-weight: 600;
            color: var(--accent);
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .bluefrog-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
            gap: 10px;
        }

        .bluefrog-field {
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 4px;
            padding: 10px;
        }

        .bluefrog-field.has-warning {
            border-color: var(--warning);
            background: rgba(220, 220, 170, 0.08);
        }

        .bluefrog-field-label {
            font-size: 10px;
            color: var(--fg-secondary);
            margin-bottom: 6px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .bluefrog-field-link {
            font-size: 9px;
            color: var(--accent);
            cursor: pointer;
            text-decoration: underline;
        }

        .bluefrog-field-link:hover {
            opacity: 0.8;
        }

        .bluefrog-field input {
            width: 100%;
            padding: 6px 8px;
            border: 1px solid var(--border);
            border-radius: 3px;
            background: var(--bg-secondary);
            color: var(--fg-primary);
            font-size: 12px;
        }

        .bluefrog-field-warning {
            font-size: 9px;
            color: var(--warning);
            margin-top: 4px;
        }

        .cross-ref-section {
            margin-top: 20px;
            padding-top: 16px;
            border-top: 1px solid var(--border);
        }

        .cross-ref-title {
            font-size: 12px;
            font-weight: 500;
            color: var(--warning);
            margin-bottom: 10px;
        }

        .warning-card {
            background: rgba(220, 220, 170, 0.1);
            border: 1px solid var(--warning);
            border-radius: 4px;
            padding: 10px;
            margin-bottom: 8px;
            font-size: 11px;
        }

        .warning-icon {
            color: var(--warning);
            margin-right: 6px;
            font-weight: bold;
        }

        .bluefrog-actions {
            margin-top: 20px;
            padding-top: 16px;
            border-top: 1px solid var(--border);
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .bluefrog-file-indicator {
            font-size: 10px;
            color: var(--fg-secondary);
        }

        .no-properties {
            color: var(--fg-secondary);
            font-size: 12px;
            padding: 20px;
            text-align: center;
        }

        /* Inferred value styles */
        .bluefrog-inferred-notice {
            background: rgba(78, 201, 176, 0.1);
            border: 1px solid var(--success);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 16px;
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .bluefrog-inferred-notice .inferred-icon {
            color: var(--success);
            margin-right: 6px;
        }

        .bluefrog-inferred-notice .inferred-hint {
            font-size: 10px;
            color: var(--fg-secondary);
            margin-left: 20px;
        }

        .bluefrog-field.is-inferred {
            border-color: var(--success);
            border-style: dashed;
            background: rgba(78, 201, 176, 0.05);
        }

        .inferred-badge {
            font-size: 8px;
            background: var(--success);
            color: var(--bg-primary);
            padding: 1px 4px;
            border-radius: 3px;
            text-transform: uppercase;
            font-weight: 600;
            vertical-align: middle;
        }

        /* Validation Tab Styles */
        .validation-description {
            font-size: 11px;
            color: var(--fg-secondary);
            margin-bottom: 16px;
            padding: 10px;
            background: var(--bg-primary);
            border-radius: 4px;
            border-left: 3px solid var(--accent);
        }

        .validation-summary {
            display: flex;
            gap: 16px;
            margin-bottom: 16px;
            padding: 12px;
            background: var(--bg-primary);
            border-radius: 4px;
        }

        .validation-stat {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .validation-stat-count {
            font-size: 20px;
            font-weight: 600;
        }

        .validation-stat-label {
            font-size: 11px;
            color: var(--fg-secondary);
        }

        .validation-stat.errors .validation-stat-count {
            color: var(--error);
        }

        .validation-stat.warnings .validation-stat-count {
            color: var(--warning);
        }

        .validation-stat.infos .validation-stat-count {
            color: var(--accent);
        }

        .validation-stat.passed .validation-stat-count {
            color: var(--success);
        }

        .validation-category {
            margin-bottom: 16px;
        }

        .validation-category-title {
            font-size: 12px;
            font-weight: 600;
            color: var(--fg-primary);
            margin-bottom: 8px;
            padding-bottom: 4px;
            border-bottom: 1px solid var(--border);
        }

        .validation-item {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 10px;
            margin-bottom: 6px;
            background: var(--bg-primary);
            border-radius: 4px;
            border-left: 3px solid var(--border);
        }

        .validation-item.error {
            border-left-color: var(--error);
            background: rgba(241, 76, 76, 0.1);
        }

        .validation-item.warning {
            border-left-color: var(--warning);
            background: rgba(220, 220, 170, 0.1);
        }

        .validation-item.info {
            border-left-color: var(--accent);
            background: rgba(78, 158, 201, 0.1);
        }

        .validation-icon {
            font-size: 14px;
            min-width: 20px;
            text-align: center;
        }

        .validation-item.error .validation-icon {
            color: var(--error);
        }

        .validation-item.warning .validation-icon {
            color: var(--warning);
        }

        .validation-item.info .validation-icon {
            color: var(--accent);
        }

        .validation-content {
            flex: 1;
        }

        .validation-message {
            font-size: 12px;
            margin-bottom: 4px;
        }

        .validation-fix {
            font-size: 10px;
            color: var(--fg-secondary);
        }

        .validation-file {
            font-size: 9px;
            color: var(--accent);
            cursor: pointer;
            text-decoration: underline;
        }

        .validation-file:hover {
            opacity: 0.8;
        }

        .validation-passed {
            text-align: center;
            padding: 24px;
            color: var(--success);
        }

        .validation-passed-icon {
            font-size: 32px;
            margin-bottom: 8px;
        }

        .validation-passed-text {
            font-size: 14px;
            font-weight: 500;
        }
    </style>
</head>
<body>
    <div class="workshop-header">
        <h1 id="schematic-name">Crafting Workshop</h1>
        <div class="header-actions">
            <button class="btn" onclick="runSimulation()">Simulate</button>
        </div>
    </div>

    <div id="empty-state" class="empty-state">
        <p>No schematic loaded</p>
        <p style="margin-top: 8px; font-size: 12px;">Right-click a draft schematic file and select "Open in Crafting Workshop"</p>
    </div>

    <div id="workshop-content" style="display: none;">
        <!-- Tab Navigation -->
        <div class="tab-nav">
            <button class="tab-btn active" onclick="switchTab('simulation')">Crafting Simulation</button>
            <button class="tab-btn" onclick="switchTab('formulas')">Formula Editor</button>
            <button class="tab-btn" onclick="switchTab('bluefrog')">Blue Frog Defaults</button>
            <button class="tab-btn" onclick="switchTab('validation')" id="validation-tab-btn">Health Check</button>
        </div>

        <!-- Tab 1: Crafting Simulation -->
        <div id="tab-simulation" class="tab-content active">
            <div class="workshop-grid">
                <div class="panel">
                    <div class="panel-header">Ingredient Slots</div>
                    <div id="slots-container" class="slot-list">
                        <!-- Slots will be populated here -->
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-header">Crafted Item Attributes</div>
                    <div id="attributes-container" class="attribute-list">
                        <!-- Attributes will be populated here -->
                    </div>
                </div>

                <div class="panel">
                    <div class="panel-header">Experimentation Rows</div>
                    <div id="exp-rows-container" class="exp-rows-list">
                        <!-- Experimentation rows will be populated here -->
                    </div>
                </div>

                <div class="panel results-panel">
                    <div class="panel-header">Player Skills</div>
                    <div class="skills-row">
                        <div class="skill-input">
                            <label>Assembly:</label>
                            <input type="number" id="assembly-skill" value="100" min="0" max="140">
                        </div>
                        <div class="skill-input">
                            <label>Experimentation:</label>
                            <input type="number" id="exp-skill" value="100" min="0" max="140">
                        </div>
                        <div class="skill-input">
                            <label>Tool:</label>
                            <input type="number" id="tool-eff" value="0" min="-15" max="15">
                        </div>
                    </div>

                    <div class="panel-header" style="margin-top: 16px;">Related Files</div>
                    <div class="file-links" id="file-links">
                        <!-- File links will be populated here -->
                    </div>
                </div>
            </div>
        </div>

        <!-- Tab 2: Formula Editor -->
        <div id="tab-formulas" class="tab-content">
            <div class="panel">
                <div class="panel-header">Crafting Formula Editor</div>
                <p style="font-size: 11px; color: var(--fg-secondary); margin-bottom: 16px;">
                    Define how resource stats contribute to crafted item attributes. Higher weight = more influence.
                </p>
                <div id="formula-container">
                    <!-- Formulas will be populated here -->
                </div>
                <button class="add-attribute-btn" onclick="addAttribute()">+ Add New Attribute</button>
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);">
                    <button class="btn btn-success" onclick="applyChanges()">Save Formula Changes</button>
                </div>
            </div>
        </div>

        <!-- Tab 3: Blue Frog Defaults -->
        <div id="tab-bluefrog" class="tab-content">
            <div class="panel">
                <div class="panel-header">Blue Frog Default Values</div>
                <div class="bluefrog-description">
                    These are the baseline values for items spawned via Blue Frog or /object createitem (non-crafted).
                    Changes here affect the default stats, not the crafting formula ranges.
                </div>
                <div id="bluefrog-editor">
                    <!-- Blue frog fields will be populated here -->
                </div>
                <div id="crossref-warnings">
                    <!-- Cross-reference warnings will be shown here -->
                </div>
                <div class="bluefrog-actions">
                    <button class="btn btn-success" id="bluefrog-save-btn" onclick="saveBlueFrogChanges()">Save Blue Frog Changes</button>
                    <span class="bluefrog-file-indicator" id="bluefrog-target-file"></span>
                </div>
            </div>
        </div>

        <!-- Tab 4: Health Check / Validation -->
        <div id="tab-validation" class="tab-content">
            <div class="panel">
                <div class="panel-header">
                    <span>Schematic Health Check</span>
                    <button class="btn" onclick="runValidation()" style="float: right; margin-top: -4px;">Re-run Check</button>
                </div>
                <div class="validation-description">
                    Validates your schematic setup to catch common mistakes before testing in-game.
                </div>
                <div id="validation-summary" class="validation-summary">
                    <!-- Summary will be populated here -->
                </div>
                <div id="validation-results">
                    <!-- Validation results will be populated here -->
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentProject = null;

        const SLOT_TYPES = ['Resource', 'Identical', 'Mixed', 'Opt. Identical', 'Opt. Mixed'];
        const RESOURCE_PROPS = ['OQ', 'CR', 'CD', 'DR', 'HR', 'MA', 'PE', 'SR', 'UT', 'FL'];

        // Resource type to applicable attributes mapping
        // Based on SWG resource class hierarchy
        const RESOURCE_ATTRIBUTES = {
            // Metals - no FL, PE
            metal: ['OQ', 'CR', 'CD', 'DR', 'HR', 'MA', 'SR', 'UT'],
            iron: ['OQ', 'CR', 'CD', 'DR', 'HR', 'MA', 'SR', 'UT'],
            steel: ['OQ', 'CR', 'CD', 'DR', 'HR', 'MA', 'SR', 'UT'],
            copper: ['OQ', 'CR', 'CD', 'DR', 'HR', 'MA', 'SR', 'UT'],
            aluminum: ['OQ', 'CR', 'CD', 'DR', 'HR', 'MA', 'SR', 'UT'],
            // Ores
            ore: ['OQ', 'CR', 'CD', 'DR', 'HR', 'MA', 'SR', 'UT'],
            // Organics/Food - have FL, PE, no resistances
            meat: ['OQ', 'DR', 'FL', 'PE'],
            seafood: ['OQ', 'DR', 'FL', 'PE'],
            fruit: ['OQ', 'DR', 'FL', 'PE'],
            vegetable: ['OQ', 'DR', 'FL', 'PE'],
            milk: ['OQ', 'DR', 'FL', 'PE'],
            egg: ['OQ', 'DR', 'FL', 'PE'],
            // Creature structural - no FL
            hide: ['OQ', 'DR', 'MA', 'SR', 'UT'],
            bone: ['OQ', 'DR', 'MA', 'SR', 'UT'],
            horn: ['OQ', 'DR', 'MA', 'SR', 'UT'],
            // Chemicals
            fiberplast: ['OQ', 'CD', 'DR', 'MA', 'SR', 'UT'],
            petrochem: ['OQ', 'CD', 'DR', 'PE'],
            chemical: ['OQ', 'CD', 'DR', 'PE', 'SR'],
            // Other
            gas: ['OQ', 'PE'],
            water: ['OQ', 'PE'],
            energy: ['OQ', 'PE'],
            radioactive: ['OQ', 'DR', 'PE'],
            crystalline: ['OQ', 'CR', 'CD', 'DR', 'HR', 'SR', 'UT'],
            gemstone: ['OQ', 'CR', 'CD', 'DR', 'HR', 'SR', 'UT'],
            softwood: ['OQ', 'CD', 'DR', 'MA', 'SR', 'UT'],
            hardwood: ['OQ', 'CD', 'DR', 'MA', 'SR', 'UT'],
            wood: ['OQ', 'CD', 'DR', 'MA', 'SR', 'UT'],
        };

        // Blue frog to experimental attribute mapping
        const BLUEFROG_EXPERIMENTAL_MAP = {
            'useCount': 'charges',
            'effectiveness': 'power',
            'minDamage': 'mindamage',
            'maxDamage': 'maxdamage',
            'attackSpeed': 'attackspeed',
            'woundsRatio': 'woundchance',
            'healthAttackCost': 'attackhealthcost',
            'actionAttackCost': 'attackactioncost',
            'mindAttackCost': 'attackmindcost',
        };

        // Blue frog state
        let editableBlueFrog = {};
        let blueFrogInferredProps = new Set();  // Track which props are inferred
        let detectedObjectType = 'unknown';
        let hasBlueFrogChanges = false;
        let currentTab = 'simulation';

        // ========================================
        // TAB SWITCHING
        // ========================================

        function switchTab(tabName) {
            // Hide all tabs
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.classList.remove('active');
            });
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.classList.remove('active');
            });

            // Show selected tab
            document.getElementById('tab-' + tabName).classList.add('active');
            document.querySelector(\`[onclick="switchTab('\${tabName}')"]\`).classList.add('active');

            currentTab = tabName;

            // Render tab content if needed
            if (tabName === 'bluefrog') {
                renderBlueFrogTab();
            }
            if (tabName === 'validation') {
                // Run validation if not already done
                if (!validationReport) {
                    runValidation();
                }
            }
        }

        // ========================================
        // BLUE FROG EDITOR
        // ========================================

        function initBlueFrog() {
            if (!currentProject?.targetTemplate?.blueFrogDefaults) {
                editableBlueFrog = {};
                blueFrogInferredProps = new Set();
                detectedObjectType = 'unknown';
                return;
            }
            // Deep copy
            editableBlueFrog = JSON.parse(JSON.stringify(
                currentProject.targetTemplate.blueFrogDefaults
            ));
            // Copy inferred props set (comes as array from serialization)
            blueFrogInferredProps = new Set(currentProject.targetTemplate.blueFrogInferred || []);
            detectedObjectType = currentProject.targetTemplate.objectType || 'unknown';
            hasBlueFrogChanges = false;
        }

        function renderBlueFrogTab() {
            const container = document.getElementById('bluefrog-editor');
            if (!container) return;

            if (Object.keys(editableBlueFrog).length === 0) {
                container.innerHTML = '<div class="no-properties">No blue frog properties found in this template.</div>';
                document.getElementById('crossref-warnings').innerHTML = '';
                return;
            }

            // Group properties by category
            const medicineProps = ['useCount', 'effectiveness', 'duration', 'medicineUse'];
            const weaponDamageProps = ['minDamage', 'maxDamage', 'attackSpeed', 'woundsRatio'];
            const weaponCostProps = ['healthAttackCost', 'actionAttackCost', 'mindAttackCost'];
            const armorProps = ['armorRating', 'kinetic', 'energy', 'electricity', 'stun', 'blast', 'heat', 'cold', 'acid', 'lightSaber'];

            let html = '';

            // Show inferred notice if values were auto-generated
            const hasInferred = blueFrogInferredProps.size > 0;
            if (hasInferred) {
                const objectTypeLabel = detectedObjectType.charAt(0).toUpperCase() + detectedObjectType.slice(1);
                html += \`<div class="bluefrog-inferred-notice">
                    <span class="inferred-icon">⚡</span>
                    <span>Values auto-generated based on detected type: <strong>\${objectTypeLabel}</strong></span>
                    <span class="inferred-hint">Values derived from experimental formula ranges. Edit and save to make explicit.</span>
                </div>\`;
            }

            // Detect item type based on which properties exist
            const hasMedicine = medicineProps.some(p => editableBlueFrog[p] !== undefined);
            const hasWeaponDamage = weaponDamageProps.some(p => editableBlueFrog[p] !== undefined);
            const hasWeaponCost = weaponCostProps.some(p => editableBlueFrog[p] !== undefined);
            const hasArmor = armorProps.some(p => editableBlueFrog[p] !== undefined);

            if (hasMedicine) {
                html += renderBlueFrogSection('Medicine Properties', medicineProps);
            }

            if (hasWeaponDamage) {
                html += renderBlueFrogSection('Weapon Damage', weaponDamageProps);
            }

            if (hasWeaponCost) {
                html += renderBlueFrogSection('Attack Costs', weaponCostProps);
            }

            if (hasArmor) {
                html += renderBlueFrogSection('Armor Resistances', armorProps);
            }

            container.innerHTML = html;

            // Update file indicator
            const fileIndicator = document.getElementById('bluefrog-target-file');
            if (fileIndicator && currentProject?.targetTemplatePath) {
                const fileName = currentProject.targetTemplatePath.split('/').pop();
                fileIndicator.textContent = 'Target: ' + fileName;
            }

            // Check for cross-reference warnings
            renderCrossRefWarnings();
            updateBlueFrogChangeIndicator();
        }

        function renderBlueFrogSection(title, props) {
            const relevantProps = props.filter(p => editableBlueFrog[p] !== undefined);
            if (relevantProps.length === 0) return '';

            let html = \`<div class="bluefrog-section">
                <div class="bluefrog-section-title">\${title}</div>
                <div class="bluefrog-grid">\`;

            for (const prop of relevantProps) {
                const expAttr = BLUEFROG_EXPERIMENTAL_MAP[prop];
                const hasExpLink = expAttr && editableFormulas.some(f => f.attribute === expAttr);
                const warning = getPropertyWarning(prop);
                const isInferred = blueFrogInferredProps.has(prop);

                html += \`<div class="bluefrog-field \${warning ? 'has-warning' : ''} \${isInferred ? 'is-inferred' : ''}">
                    <div class="bluefrog-field-label">
                        <span>\${formatPropertyName(prop)}\${isInferred ? ' <span class="inferred-badge">auto</span>' : ''}</span>
                        \${hasExpLink ? \`<span class="bluefrog-field-link" onclick="scrollToFormula('\${expAttr}')">exp: \${expAttr}</span>\` : ''}
                    </div>
                    <input type="number" step="\${prop === 'attackSpeed' ? '0.1' : '1'}"
                        value="\${editableBlueFrog[prop]}"
                        onchange="updateBlueFrogValue('\${prop}', this.value)">
                    \${warning ? \`<div class="bluefrog-field-warning">\${warning}</div>\` : ''}
                </div>\`;
            }

            html += '</div></div>';
            return html;
        }

        function formatPropertyName(prop) {
            return prop
                .replace(/([A-Z])/g, ' $1')
                .replace(/^./, str => str.toUpperCase())
                .trim();
        }

        function updateBlueFrogValue(prop, value) {
            const numValue = prop === 'attackSpeed' ? parseFloat(value) : parseInt(value);
            editableBlueFrog[prop] = numValue;
            // Remove from inferred set when user edits
            if (blueFrogInferredProps.has(prop)) {
                blueFrogInferredProps.delete(prop);
                // Re-render to update visual indicator
                renderBlueFrogTab();
            }
            hasBlueFrogChanges = true;
            renderCrossRefWarnings();
            updateBlueFrogChangeIndicator();
        }

        function getPropertyWarning(prop) {
            const expAttr = BLUEFROG_EXPERIMENTAL_MAP[prop];
            if (!expAttr) return null;

            const formula = editableFormulas.find(f => f.attribute === expAttr);
            if (!formula) return null;

            const blueFrogValue = editableBlueFrog[prop];
            if (blueFrogValue === undefined) return null;

            // Check if blue frog value is outside experimental range
            if (blueFrogValue < formula.min) {
                return \`Below exp min (\${formula.min})\`;
            }
            if (blueFrogValue > formula.max) {
                return \`Above exp max (\${formula.max})\`;
            }
            return null;
        }

        function renderCrossRefWarnings() {
            const container = document.getElementById('crossref-warnings');
            if (!container) return;

            const warnings = [];

            for (const [prop, expAttr] of Object.entries(BLUEFROG_EXPERIMENTAL_MAP)) {
                const blueFrogValue = editableBlueFrog[prop];
                if (blueFrogValue === undefined) continue;

                const formula = editableFormulas.find(f => f.attribute === expAttr);
                if (!formula) continue;

                if (blueFrogValue < formula.min || blueFrogValue > formula.max) {
                    warnings.push({
                        blueFrogProp: prop,
                        blueFrogValue,
                        expAttr,
                        expMin: formula.min,
                        expMax: formula.max
                    });
                }
            }

            if (warnings.length === 0) {
                container.innerHTML = '';
                return;
            }

            container.innerHTML = \`
                <div class="cross-ref-section">
                    <div class="cross-ref-title">Cross-Reference Warnings</div>
                    \${warnings.map(w => \`
                        <div class="warning-card">
                            <span class="warning-icon">!</span>
                            <strong>\${formatPropertyName(w.blueFrogProp)}</strong> (\${w.blueFrogValue})
                            is outside experimental range for <strong>\${w.expAttr}</strong> (\${w.expMin} - \${w.expMax}).
                            <span class="bluefrog-field-link" onclick="scrollToFormula('\${w.expAttr}')" style="margin-left: 8px;">Edit formula</span>
                        </div>
                    \`).join('')}
                </div>
            \`;
        }

        function scrollToFormula(attrName) {
            switchTab('formulas');
            const formulaIdx = editableFormulas.findIndex(f => f.attribute === attrName);
            if (formulaIdx >= 0) {
                setTimeout(() => {
                    const el = document.getElementById('formula-' + formulaIdx);
                    if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.classList.add('editing');
                        setTimeout(() => el.classList.remove('editing'), 2000);
                    }
                }, 100);
            }
        }

        function saveBlueFrogChanges() {
            vscode.postMessage({
                type: 'saveBlueFrogDefaults',
                defaults: editableBlueFrog
            });
        }

        function updateBlueFrogChangeIndicator() {
            const btn = document.getElementById('bluefrog-save-btn');
            if (btn) {
                btn.textContent = hasBlueFrogChanges ? 'Save Blue Frog Changes *' : 'Save Blue Frog Changes';
                btn.style.background = hasBlueFrogChanges ? 'var(--warning)' : '';
            }
        }

        // ========================================
        // VALIDATION TAB
        // ========================================

        let validationReport = null;

        function runValidation() {
            vscode.postMessage({ type: 'runValidation' });
        }

        function renderValidationResults(report) {
            validationReport = report;

            // Update tab badge
            const tabBtn = document.getElementById('validation-tab-btn');
            if (tabBtn) {
                if (report.errors > 0) {
                    tabBtn.innerHTML = 'Health Check <span style="color: var(--error);">(' + report.errors + ')</span>';
                } else if (report.warnings > 0) {
                    tabBtn.innerHTML = 'Health Check <span style="color: var(--warning);">(' + report.warnings + ')</span>';
                } else {
                    tabBtn.innerHTML = 'Health Check <span style="color: var(--success);">✓</span>';
                }
            }

            // Render summary
            const summaryContainer = document.getElementById('validation-summary');
            if (summaryContainer) {
                summaryContainer.innerHTML = \`
                    <div class="validation-stat \${report.passed ? 'passed' : 'errors'}">
                        <span class="validation-stat-count">\${report.passed ? '✓' : '✗'}</span>
                        <span class="validation-stat-label">\${report.passed ? 'Passed' : 'Failed'}</span>
                    </div>
                    <div class="validation-stat errors">
                        <span class="validation-stat-count">\${report.errors}</span>
                        <span class="validation-stat-label">Errors</span>
                    </div>
                    <div class="validation-stat warnings">
                        <span class="validation-stat-count">\${report.warnings}</span>
                        <span class="validation-stat-label">Warnings</span>
                    </div>
                    <div class="validation-stat infos">
                        <span class="validation-stat-count">\${report.infos}</span>
                        <span class="validation-stat-label">Info</span>
                    </div>
                \`;
            }

            // Render results grouped by category
            const resultsContainer = document.getElementById('validation-results');
            if (!resultsContainer) return;

            if (report.results.length === 0) {
                resultsContainer.innerHTML = \`
                    <div class="validation-passed">
                        <div class="validation-passed-icon">✓</div>
                        <div class="validation-passed-text">All checks passed!</div>
                    </div>
                \`;
                return;
            }

            // Group by category
            const categories = {};
            for (const result of report.results) {
                if (!categories[result.category]) {
                    categories[result.category] = [];
                }
                categories[result.category].push(result);
            }

            let html = '';
            for (const [category, results] of Object.entries(categories)) {
                html += \`<div class="validation-category">
                    <div class="validation-category-title">\${category}</div>\`;

                for (const result of results) {
                    const icon = result.severity === 'error' ? '✗' : result.severity === 'warning' ? '!' : 'i';
                    const fileLink = result.file
                        ? \`<span class="validation-file" onclick="openFile('\${result.file.replace(/\\\\/g, '/')}')">\${result.file.split('/').pop()}</span>\`
                        : '';

                    html += \`
                        <div class="validation-item \${result.severity}">
                            <span class="validation-icon">\${icon}</span>
                            <div class="validation-content">
                                <div class="validation-message">\${result.message}</div>
                                \${result.fix ? \`<div class="validation-fix">Fix: \${result.fix}</div>\` : ''}
                                \${fileLink}
                            </div>
                        </div>
                    \`;
                }

                html += '</div>';
            }

            resultsContainer.innerHTML = html;
        }

        function getApplicableProps(resourceType) {
            if (!resourceType) return RESOURCE_PROPS;
            const rt = resourceType.toLowerCase();
            // Check each known type prefix
            for (const [prefix, props] of Object.entries(RESOURCE_ATTRIBUTES)) {
                if (rt.startsWith(prefix + '_') || rt === prefix) {
                    return props;
                }
            }
            // Default to all props if unknown
            return RESOURCE_PROPS;
        }

        // Get stats that are used in crafting formulas (uses editable formulas if available)
        function getUsedStats() {
            if (editableFormulas && editableFormulas.length > 0) {
                const stats = new Set();
                for (const formula of editableFormulas) {
                    for (const rw of formula.resourceWeights) {
                        stats.add(rw.stat);
                    }
                }
                return Array.from(stats);
            }
            return currentProject?.targetTemplate?.usedResourceStats || [];
        }

        // Get weight percentage for a stat (uses editable formulas if available)
        function getStatWeightInfo(stat) {
            const formulas = (editableFormulas && editableFormulas.length > 0)
                ? editableFormulas
                : currentProject?.targetTemplate?.attributeWeights;

            if (!formulas) return null;

            const uses = [];
            for (const aw of formulas) {
                const totalWeight = aw.resourceWeights.reduce((sum, rw) => sum + rw.weight, 0);
                for (const rw of aw.resourceWeights) {
                    if (rw.stat === stat) {
                        const pct = totalWeight > 0 ? Math.round((rw.weight / totalWeight) * 100) : 0;
                        uses.push({ attr: aw.attribute, pct: pct });
                    }
                }
            }
            return uses.length > 0 ? uses : null;
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.type) {
                case 'projectLoaded':
                    currentProject = message.project;
                    renderProject();
                    break;

                case 'simulationUpdated':
                case 'simulationComplete':
                    renderAttributes(message.attributes);
                    if (message.experimentationRows) {
                        renderExperimentationRows(message.experimentationRows);
                    }
                    if (message.assemblyResult) {
                        console.log('Assembly:', message.assemblyResult);
                    }
                    break;

                case 'changesSaved':
                    hasUnsavedChanges = false;
                    updateChangeIndicator();
                    break;

                case 'blueFrogSaved':
                    hasBlueFrogChanges = false;
                    updateBlueFrogChangeIndicator();
                    break;

                case 'validationComplete':
                    renderValidationResults(message.report);
                    break;
            }
        });

        function renderProject() {
            if (!currentProject) return;

            document.getElementById('empty-state').style.display = 'none';
            document.getElementById('workshop-content').style.display = 'grid';
            document.getElementById('schematic-name').textContent = currentProject.schematicName || 'Crafting Workshop';

            // Render slots
            const slotsContainer = document.getElementById('slots-container');
            slotsContainer.innerHTML = currentProject.slots.map((slot, i) => {
                const isResource = slot.slotType === 0;
                const isComponent = slot.slotType === 1 || slot.slotType === 2;
                const componentName = slot.resourceType ? slot.resourceType.split('/').pop().replace('shared_', '').replace('.iff', '') : '';
                const applicableProps = isResource ? getApplicableProps(slot.resourceType) : [];

                return \`
                <div class="slot-card">
                    <div class="slot-header">
                        <span class="slot-name">\${slot.titleName || 'Slot ' + (i + 1)}</span>
                        <span class="slot-type">\${SLOT_TYPES[slot.slotType] || 'Unknown'} (\${slot.contribution}%)</span>
                    </div>
                    \${isResource ? \`
                        <div style="font-size: 10px; color: var(--fg-secondary); margin-bottom: 6px;">\${slot.resourceType || 'any resource'}</div>
                        <div class="stat-grid">
                            \${RESOURCE_PROPS.map(prop => {
                                const existsForResource = applicableProps.includes(prop);
                                const usedStats = getUsedStats();
                                const isUsed = usedStats.includes(prop);
                                const weightInfo = isUsed ? getStatWeightInfo(prop) : null;

                                // Four tiers:
                                // - used (green): exists AND used in formula - optimal!
                                // - missing (orange): formula wants it but resource doesn't have it - warning!
                                // - exists (grey): resource has it but formula doesn't use it
                                // - not-applicable (very dim): doesn't exist and not used
                                let tierClass = 'not-applicable';
                                if (existsForResource && isUsed) tierClass = 'used';
                                else if (!existsForResource && isUsed) tierClass = 'missing';
                                else if (existsForResource) tierClass = 'exists';

                                // Format: "attr:pct%" for each attribute this stat contributes to
                                const pctLabel = weightInfo
                                    ? weightInfo.map(w => w.attr.substring(0,3) + ':' + w.pct + '%').join(' ')
                                    : '';

                                return \`
                                <div class="stat-input \${tierClass}">
                                    <label>\${prop}</label>
                                    <input type="number" min="0" max="1000" value="\${existsForResource ? 500 : 0}"
                                        onchange="updateResourceStat(\${i}, '\${prop}', this.value)">
                                    \${weightInfo ? \`<div class="stat-pct" title="\${weightInfo.map(w => w.attr + ': ' + w.pct + '%').join(', ')}">\${pctLabel}</div>\` : ''}
                                </div>
                            \`}).join('')}
                        </div>
                    \` : \`
                        <div class="component-info">
                            <div style="font-size: 10px; color: var(--fg-secondary); margin-bottom: 6px;">
                                \${componentName || 'Component required'}
                            </div>
                            <div class="component-stats">
                                <div class="stat-input" style="display: inline-flex; margin-right: 8px;">
                                    <label>power</label>
                                    <input type="number" min="0" max="1000" value="0" style="width: 60px;"
                                        onchange="updateComponentStat(\${i}, 'power', this.value)">
                                </div>
                                <div class="stat-input" style="display: inline-flex; margin-right: 8px;">
                                    <label>charges</label>
                                    <input type="number" min="0" max="100" value="0" style="width: 60px;"
                                        onchange="updateComponentStat(\${i}, 'charges', this.value)">
                                </div>
                                <div class="stat-input" style="display: inline-flex;">
                                    <label>quality</label>
                                    <input type="number" min="0" max="100" value="0" style="width: 60px;"
                                        onchange="updateComponentStat(\${i}, 'quality', this.value)">
                                </div>
                            </div>
                            <div style="font-size: 9px; color: var(--fg-secondary); margin-top: 4px;">
                                Leave at 0 if component has no stats (complexity item)
                            </div>
                        </div>
                    \`}
                </div>
            \`}).join('');

            // Render file links
            const fileLinks = document.getElementById('file-links');
            const links = [];
            if (currentProject.schematicIffPath) {
                links.push(\`<span class="file-link" onclick="openFile('\${currentProject.schematicIffPath}')">Schematic IFF</span>\`);
            }
            if (currentProject.schematicLuaPath) {
                links.push(\`<span class="file-link" onclick="openFile('\${currentProject.schematicLuaPath}')">Schematic Lua</span>\`);
            }
            if (currentProject.targetTemplatePath) {
                links.push(\`<span class="file-link" onclick="openFile('\${currentProject.targetTemplatePath}')">Target Template</span>\`);
            }
            fileLinks.innerHTML = links.join('');

            // Initialize and render formula editor
            initFormulas();
            renderFormulas();

            // Initialize blue frog editor
            initBlueFrog();

            // Run validation in background
            validationReport = null;  // Clear old results
            runValidation();

            // Initial simulation
            runSimulation();
        }

        function renderAttributes(attributes) {
            const container = document.getElementById('attributes-container');

            if (!attributes || attributes.length === 0) {
                container.innerHTML = '<div class="empty-state">No attributes calculated yet</div>';
                return;
            }

            container.innerHTML = attributes.map(attr => {
                const pct = attr.maxPercentage > 0 ? (attr.currentPercentage / attr.maxPercentage) * 100 : 0;
                return \`
                    <div class="attribute-card">
                        <div class="attribute-name">\${attr.name}</div>
                        <div class="attribute-value">\${attr.formattedValue}</div>
                        <div class="attribute-bar">
                            <div class="attribute-bar-fill" style="width: \${pct}%"></div>
                        </div>
                        <div class="attribute-range">
                            <span>\${attr.min}</span>
                            <span>\${(attr.currentPercentage * 100).toFixed(1)}%</span>
                            <span>\${attr.max}</span>
                        </div>
                    </div>
                \`;
            }).join('');
        }

        function renderExperimentationRows(rows) {
            const container = document.getElementById('exp-rows-container');
            if (!container) return;

            if (!rows || rows.length === 0) {
                container.innerHTML = '<div class="empty-state" style="padding: 12px;">No experimentation rows available</div>';
                return;
            }

            container.innerHTML = rows.map(row => {
                // Generate bubbles - filled up to current, max shows potential
                const filledBubbles = Math.min(10, Math.floor(row.currentPercentage * 10));
                const maxBubbles = row.bubbleCount;

                let bubblesHtml = '';
                for (let i = 0; i < 10; i++) {
                    let bubbleClass = 'bubble';
                    if (i < filledBubbles) {
                        bubbleClass += ' current';  // Current progress (blue)
                    } else if (i < maxBubbles) {
                        bubbleClass += ' filled';   // Available to fill (green)
                    }
                    bubblesHtml += \`<div class="\${bubbleClass}"></div>\`;
                }

                const groupLabel = row.group.replace('exp_', '').replace(/_/g, ' ');
                const attrList = row.attributes.join(', ');

                return \`
                    <div class="exp-row-card">
                        <div class="exp-row-header">
                            <span class="exp-row-name">\${groupLabel}</span>
                            <span class="exp-row-attrs">\${attrList}</span>
                        </div>
                        <div class="bubble-row">
                            \${bubblesHtml}
                            <span class="bubble-count">\${maxBubbles}/10 bubbles</span>
                        </div>
                        <div class="exp-row-info">
                            <span>Current: \${(row.currentPercentage * 100).toFixed(1)}%</span>
                            <span>Max: \${(row.maxPercentage * 100).toFixed(1)}%</span>
                        </div>
                    </div>
                \`;
            }).join('');
        }

        function updateResourceStat(slotIndex, prop, value) {
            vscode.postMessage({
                type: 'setResourceStats',
                slotIndex,
                stats: { [prop]: parseInt(value) || 0 }
            });
        }

        function updateComponentStat(slotIndex, stat, value) {
            vscode.postMessage({
                type: 'setComponentStats',
                slotIndex,
                stats: { [stat]: parseInt(value) || 0 }
            });
        }

        function runSimulation() {
            const assemblySkill = parseInt(document.getElementById('assembly-skill').value) || 100;
            const expSkill = parseInt(document.getElementById('exp-skill').value) || 100;
            const toolEff = parseInt(document.getElementById('tool-eff').value) || 0;

            vscode.postMessage({
                type: 'setSkills',
                assemblySkill,
                experimentationSkill: expSkill,
                toolEffectiveness: toolEff
            });

            vscode.postMessage({
                type: 'runSimulation',
                experimentationAttempts: []
            });
        }

        function applyChanges() {
            vscode.postMessage({ type: 'applyChanges' });
        }

        function openFile(path) {
            vscode.postMessage({ type: 'openFile', path: path.replace(/\\\\/g, '/') });
        }

        // ========================================
        // FORMULA EDITOR
        // ========================================

        // Local editable copy of attribute weights
        let editableFormulas = [];
        let hasUnsavedChanges = false;

        function initFormulas() {
            if (!currentProject?.targetTemplate?.attributeWeights) {
                editableFormulas = [];
                return;
            }
            // Deep copy the attribute weights for editing
            editableFormulas = JSON.parse(JSON.stringify(currentProject.targetTemplate.attributeWeights));

            // Also copy min/max/precision from the target template
            const tt = currentProject.targetTemplate;
            editableFormulas.forEach((formula, idx) => {
                // Find the matching index in experimentalSubGroupTitles
                const subIdx = tt.experimentalSubGroupTitles?.indexOf(formula.attribute);
                if (subIdx !== -1 && subIdx !== undefined) {
                    formula.min = tt.experimentalMin?.[subIdx] || 0;
                    formula.max = tt.experimentalMax?.[subIdx] || 100;
                    formula.precision = tt.experimentalPrecision?.[subIdx] || 0;
                }
            });
        }

        function renderFormulas() {
            const container = document.getElementById('formula-container');
            if (!container) return;

            if (editableFormulas.length === 0) {
                container.innerHTML = '<div style="color: var(--fg-secondary); font-size: 11px; padding: 8px;">No craftable attributes defined</div>';
                return;
            }

            container.innerHTML = editableFormulas.map((formula, fIdx) => {
                // Calculate total weight for percentages
                const totalWeight = formula.resourceWeights.reduce((sum, rw) => sum + rw.weight, 0);

                return \`
                    <div class="formula-card" id="formula-\${fIdx}">
                        <div class="formula-header">
                            <div class="formula-name">
                                <input type="text" value="\${formula.attribute}"
                                    onchange="updateFormulaName(\${fIdx}, this.value)"
                                    title="Attribute name (e.g., power, damage)">
                            </div>
                            <span class="formula-group">\${formula.group || 'exp_effectiveness'}</span>
                        </div>

                        <div class="formula-range">
                            <div>
                                <label>Min:</label>
                                <input type="number" value="\${formula.min || 0}"
                                    onchange="updateFormulaRange(\${fIdx}, 'min', this.value)">
                            </div>
                            <div>
                                <label>Max:</label>
                                <input type="number" value="\${formula.max || 100}"
                                    onchange="updateFormulaRange(\${fIdx}, 'max', this.value)">
                            </div>
                            <div>
                                <label>Decimals:</label>
                                <input type="number" value="\${formula.precision || 0}" min="0" max="2"
                                    onchange="updateFormulaRange(\${fIdx}, 'precision', this.value)">
                            </div>
                        </div>

                        <div class="formula-weights">
                            \${formula.resourceWeights.map((rw, wIdx) => {
                                const pct = totalWeight > 0 ? Math.round((rw.weight / totalWeight) * 100) : 0;
                                return \`
                                    <div class="weight-row">
                                        <span class="weight-stat">\${rw.stat}</span>
                                        <div class="weight-slider-container">
                                            <input type="range" class="weight-slider" min="1" max="10" value="\${rw.weight}"
                                                oninput="updateWeight(\${fIdx}, \${wIdx}, this.value)">
                                            <input type="number" class="weight-value" min="1" max="99" value="\${rw.weight}"
                                                onchange="updateWeight(\${fIdx}, \${wIdx}, this.value)">
                                            <span class="weight-pct">\${pct}%</span>
                                        </div>
                                        <button class="weight-remove" onclick="removeStat(\${fIdx}, \${wIdx})" title="Remove stat">×</button>
                                    </div>
                                \`;
                            }).join('')}
                        </div>

                        <div class="add-stat-row">
                            <select class="add-stat-select" id="add-stat-\${fIdx}">
                                <option value="">+ Add resource stat...</option>
                                \${RESOURCE_PROPS.filter(p => !formula.resourceWeights.find(rw => rw.stat === p))
                                    .map(p => \`<option value="\${p}">\${p}</option>\`).join('')}
                            </select>
                            <button class="add-stat-btn" onclick="addStat(\${fIdx})">Add</button>
                        </div>

                        <div class="formula-actions">
                            <button class="btn-delete" onclick="removeAttribute(\${fIdx})">Delete Attribute</button>
                        </div>
                    </div>
                \`;
            }).join('');

            updateChangeIndicator();
        }

        function updateFormulaName(fIdx, name) {
            editableFormulas[fIdx].attribute = name;
            hasUnsavedChanges = true;
            updateChangeIndicator();
        }

        function updateFormulaRange(fIdx, field, value) {
            editableFormulas[fIdx][field] = parseInt(value) || 0;
            hasUnsavedChanges = true;
            updateChangeIndicator();
        }

        function updateWeight(fIdx, wIdx, value) {
            const weight = Math.max(1, Math.min(99, parseInt(value) || 1));
            editableFormulas[fIdx].resourceWeights[wIdx].weight = weight;
            hasUnsavedChanges = true;
            refreshAfterFormulaChange();
        }

        function addStat(fIdx) {
            const select = document.getElementById('add-stat-' + fIdx);
            const stat = select.value;
            if (!stat) return;

            editableFormulas[fIdx].resourceWeights.push({
                stat: stat,
                weight: 1,
                percentage: 0
            });
            hasUnsavedChanges = true;
            refreshAfterFormulaChange();
        }

        function removeStat(fIdx, wIdx) {
            if (editableFormulas[fIdx].resourceWeights.length <= 1) {
                alert('Cannot remove the last stat. Delete the attribute instead.');
                return;
            }
            editableFormulas[fIdx].resourceWeights.splice(wIdx, 1);
            hasUnsavedChanges = true;
            refreshAfterFormulaChange();
        }

        function refreshAfterFormulaChange() {
            renderFormulas();
            // Re-render slots to update highlighting based on new formulas
            renderProject();
        }

        function addAttribute() {
            const name = prompt('Enter attribute name (e.g., damage, speed, accuracy):');
            if (!name) return;

            editableFormulas.push({
                attribute: name.toLowerCase().replace(/\\s+/g, '_'),
                group: 'exp_effectiveness',
                min: 0,
                max: 100,
                precision: 0,
                resourceWeights: [{ stat: 'OQ', weight: 1, percentage: 100 }]
            });
            hasUnsavedChanges = true;
            renderFormulas();
        }

        function removeAttribute(fIdx) {
            if (!confirm('Delete this attribute? This cannot be undone.')) return;
            editableFormulas.splice(fIdx, 1);
            hasUnsavedChanges = true;
            renderFormulas();
            runSimulation();
        }

        function updateChangeIndicator() {
            const btn = document.querySelector('.btn-success');
            if (btn) {
                btn.textContent = hasUnsavedChanges ? 'Apply Changes *' : 'Apply Changes';
                btn.style.background = hasUnsavedChanges ? 'var(--warning)' : '';
            }
        }

        function applyChanges() {
            vscode.postMessage({
                type: 'applyChanges',
                formulas: editableFormulas
            });
        }

        // Notify extension that webview is ready
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }

    public dispose(): void {
        WorkshopPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
