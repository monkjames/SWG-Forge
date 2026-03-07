import * as vscode from 'vscode';
import * as fs from 'fs';
import {
    SimulationScenario, CombatantConfig,
    createDefaultScenario, createDefaultResists,
    ALL_DAMAGE_TYPES, DAMAGE_TYPE_NAMES, DAMAGE_TYPE_KEYS,
    WEAPON_TYPE_NAMES, ARMOR_RATING_NAMES, AP_LEVEL_NAMES
} from './combatTypes';
import { runSimulation } from './combatMath';

export class CombatPanel {
    public static currentPanel: CombatPanel | undefined;
    public static readonly viewType = 'combatSimulator';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _scenario: SimulationScenario;
    private _currentFilePath: string | undefined;

    public static createOrShow(extensionUri: vscode.Uri): CombatPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (CombatPanel.currentPanel) {
            CombatPanel.currentPanel._panel.reveal(column);
            return CombatPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            CombatPanel.viewType,
            'Combat Simulator',
            column || vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        CombatPanel.currentPanel = new CombatPanel(panel, extensionUri);
        return CombatPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._scenario = createDefaultScenario();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            msg => this._handleMessage(msg),
            null,
            this._disposables
        );

        this._updateWebview();
    }

    public dispose() {
        CombatPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private _updateWebview() {
        this._panel.webview.html = this._getHtml();
    }

    private _recalculate() {
        const aVsD = runSimulation(this._scenario.attacker, this._scenario.defender);
        const dVsA = runSimulation(this._scenario.defender, this._scenario.attacker);
        this._panel.webview.postMessage({
            type: 'results',
            aVsD, dVsA,
            scenario: this._scenario
        });
    }

    private async _handleMessage(msg: any) {
        switch (msg.type) {
            case 'ready':
                this._recalculate();
                break;
            case 'update': {
                const { side, field, value } = msg;
                const config = side === 'attacker' ? this._scenario.attacker : this._scenario.defender;
                if (field.startsWith('armorResists.')) {
                    const key = field.split('.')[1] as keyof typeof config.armorResists;
                    config.armorResists[key] = parseFloat(value) || 0;
                } else {
                    (config as any)[field] = value;
                }
                this._recalculate();
                break;
            }
            case 'updateName':
                this._scenario.name = msg.value;
                break;
            case 'swap': {
                const tmp = this._scenario.attacker;
                this._scenario.attacker = this._scenario.defender;
                this._scenario.defender = tmp;
                this._scenario.attacker.name = 'Attacker';
                this._scenario.defender.name = 'Defender';
                this._updateWebview();
                setTimeout(() => this._recalculate(), 100);
                break;
            }
            case 'reset':
                this._scenario = createDefaultScenario();
                this._currentFilePath = undefined;
                this._updateWebview();
                setTimeout(() => this._recalculate(), 100);
                break;
            case 'save':
                if (this._currentFilePath) {
                    this._doSave(this._currentFilePath);
                } else {
                    this._saveAs();
                }
                break;
            case 'saveAs':
                this._saveAs();
                break;
            case 'load':
                this._loadScenario();
                break;
        }
    }

    private _doSave(filePath: string) {
        this._scenario.savedAt = new Date().toISOString();
        fs.writeFileSync(filePath, JSON.stringify(this._scenario, null, 2), 'utf-8');
        this._currentFilePath = filePath;
        vscode.window.showInformationMessage('Scenario saved: ' + filePath);
    }

    private async _saveAs() {
        const defaultUri = this._currentFilePath
            ? vscode.Uri.file(this._currentFilePath)
            : vscode.workspace.workspaceFolders?.[0]?.uri;
        const result = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'Combat Scenarios': ['json'] },
            title: 'Save Combat Scenario'
        });
        if (result) {
            this._doSave(result.fsPath);
        }
    }

    private async _loadScenario() {
        const result = await vscode.window.showOpenDialog({
            filters: { 'Combat Scenarios': ['json'] },
            title: 'Load Combat Scenario',
            canSelectMany: false
        });
        if (result && result[0]) {
            try {
                const data = fs.readFileSync(result[0].fsPath, 'utf-8');
                const loaded = JSON.parse(data) as SimulationScenario;
                // Ensure all fields exist (merge with defaults)
                const def = createDefaultScenario();
                this._scenario = {
                    name: loaded.name || def.name,
                    attacker: { ...def.attacker, ...loaded.attacker, armorResists: { ...createDefaultResists(), ...(loaded.attacker?.armorResists || {}) } },
                    defender: { ...def.defender, ...loaded.defender, armorResists: { ...createDefaultResists(), ...(loaded.defender?.armorResists || {}) } },
                    savedAt: loaded.savedAt
                };
                this._currentFilePath = result[0].fsPath;
                this._updateWebview();
                setTimeout(() => this._recalculate(), 100);
                vscode.window.showInformationMessage('Loaded: ' + result[0].fsPath);
            } catch (e: any) {
                vscode.window.showErrorMessage('Failed to load scenario: ' + e.message);
            }
        }
    }

    // ========================================================================
    // HTML GENERATION
    // ========================================================================

    private _getHtml(): string {
        const a = this._scenario.attacker;
        const d = this._scenario.defender;
        const lines: string[] = [];

        lines.push('<!DOCTYPE html>');
        lines.push('<html lang="en">');
        lines.push('<head>');
        lines.push('<meta charset="UTF-8">');
        lines.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
        lines.push('<title>Combat Simulator</title>');
        lines.push('<style>');
        lines.push(this._getCss());
        lines.push('</style>');
        lines.push('</head>');
        lines.push('<body>');

        // Toolbar
        lines.push('<div class="toolbar">');
        lines.push('  <h1>Combat Simulator</h1>');
        lines.push('  <div class="toolbar-actions">');
        lines.push('    <button onclick="send({type:\'save\'})">Save</button>');
        lines.push('    <button onclick="send({type:\'saveAs\'})">Save As</button>');
        lines.push('    <button onclick="send({type:\'load\'})">Load</button>');
        lines.push('    <button onclick="send({type:\'swap\'})">Swap A/D</button>');
        lines.push('    <button onclick="send({type:\'reset\'})">Reset</button>');
        lines.push('  </div>');
        lines.push('</div>');

        // Scenario name
        lines.push('<div class="scenario-name">');
        lines.push('  <label>Scenario:</label>');
        lines.push('  <input type="text" value="' + this._esc(this._scenario.name) + '" onchange="send({type:\'updateName\',value:this.value})" />');
        lines.push('</div>');

        // Headline banner (populated by JS on recalculate)
        lines.push('<div id="headline-banner"></div>');

        // Two-column combatant area
        lines.push('<div class="columns">');
        lines.push(this._renderCombatantInputs('attacker', a));
        lines.push(this._renderCombatantInputs('defender', d));
        lines.push('</div>');

        // Results area (populated by JS)
        lines.push('<div id="results-area"></div>');

        // Script
        lines.push('<script>');
        lines.push(this._getScript());
        lines.push('</script>');
        lines.push('</body>');
        lines.push('</html>');

        return lines.join('\n');
    }

    private _renderCombatantInputs(side: string, c: CombatantConfig): string {
        const lines: string[] = [];
        const S = side; // short alias

        lines.push('<div class="combatant-col">');
        lines.push('<h2>' + (side === 'attacker' ? 'Attacker' : 'Defender') + '</h2>');

        // Player checkbox
        lines.push('<div class="field-row">');
        lines.push('  <label><input type="checkbox" ' + (c.isPlayer ? 'checked' : '') + ' onchange="upd(\'' + S + '\',\'isPlayer\',this.checked)" /> Player</label>');
        lines.push('</div>');

        // -- Weapon --
        lines.push('<div class="section">');
        lines.push('<h3>Weapon</h3>');
        lines.push(this._selectField(S, 'weaponType', c.weaponType, WEAPON_TYPE_NAMES));
        lines.push(this._selectField(S, 'attackType', c.attackType, { melee: 'Melee', ranged: 'Ranged', force: 'Force' }));
        lines.push(this._numField(S, 'minDamage', 'Min Damage', c.minDamage));
        lines.push(this._numField(S, 'maxDamage', 'Max Damage', c.maxDamage));
        lines.push(this._numField(S, 'attackSpeed', 'Attack Speed (s)', c.attackSpeed, 0.1));
        lines.push(this._selectFieldNum(S, 'damageType', 'Damage Type', c.damageType, DAMAGE_TYPE_NAMES));
        lines.push(this._selectFieldNum(S, 'armorPiercing', 'Armor Piercing', c.armorPiercing, AP_LEVEL_NAMES));

        // Force attack
        lines.push('<div class="field-row">');
        lines.push('  <label><input type="checkbox" ' + (c.isForceAttack ? 'checked' : '') + ' onchange="upd(\'' + S + '\',\'isForceAttack\',this.checked)" /> Force Attack</label>');
        lines.push('</div>');
        lines.push(this._numField(S, 'forceMinDamage', 'Force Min Dmg', c.forceMinDamage));
        lines.push(this._numField(S, 'forceMaxDamage', 'Force Max Dmg', c.forceMaxDamage));
        lines.push('</div>'); // section

        // -- Command Mods --
        lines.push('<div class="section">');
        lines.push('<h3>Command Modifiers</h3>');
        lines.push(this._numField(S, 'damageMultiplier', 'Damage Multiplier', c.damageMultiplier, 0.1));
        lines.push(this._numField(S, 'speedMultiplier', 'Speed Ratio', c.speedMultiplier, 0.1));
        lines.push(this._numField(S, 'damageBonus', 'Flat Damage Bonus', c.damageBonus));
        lines.push('</div>');

        // -- Armor --
        lines.push('<div class="section">');
        lines.push('<h3>Armor</h3>');
        lines.push(this._selectFieldNum(S, 'armorRating', 'Rating', c.armorRating, ARMOR_RATING_NAMES));
        lines.push('<div class="field-row">');
        lines.push('  <label><input type="checkbox" ' + (c.wearingArmor ? 'checked' : '') + ' onchange="upd(\'' + S + '\',\'wearingArmor\',this.checked)" /> Wearing Armor</label>');
        lines.push('</div>');
        lines.push('<div class="resist-grid">');
        for (const dt of ALL_DAMAGE_TYPES) {
            const key = DAMAGE_TYPE_KEYS[dt];
            const val = (c.armorResists as any)[key] || 0;
            lines.push('<div class="resist-cell">');
            lines.push('  <label>' + DAMAGE_TYPE_NAMES[dt] + '</label>');
            lines.push('  <input type="number" value="' + val + '" onchange="upd(\'' + S + '\',\'armorResists.' + key + '\',parseFloat(this.value)||0)" />');
            lines.push('</div>');
        }
        lines.push('</div>');
        lines.push('</div>');

        // -- Pools --
        lines.push('<div class="section">');
        lines.push('<h3>HAM Pools</h3>');
        lines.push(this._numField(S, 'health', 'Health', c.health));
        lines.push(this._numField(S, 'action', 'Action', c.action));
        lines.push(this._numField(S, 'mind', 'Mind', c.mind));
        lines.push('</div>');

        // -- Skill Mods --
        lines.push('<div class="section">');
        lines.push('<h3>Skill Mods</h3>');
        lines.push(this._numField(S, 'accuracy', 'Accuracy', c.accuracy));
        lines.push(this._numField(S, 'defense', 'Defense', c.defense));
        lines.push(this._numField(S, 'speedMod', 'Speed Mod', c.speedMod));
        lines.push(this._numField(S, 'combatHaste', 'Combat Haste %', c.combatHaste));
        lines.push('</div>');

        // -- Jedi Defenses --
        lines.push('<div class="section">');
        lines.push('<h3>Jedi Defenses</h3>');
        lines.push(this._numField(S, 'saberBlock', 'Saber Block %', c.saberBlock));
        lines.push(this._numField(S, 'forceArmor', 'Force Armor %', c.forceArmor));
        lines.push(this._numField(S, 'forceShield', 'Force Shield %', c.forceShield));
        lines.push(this._numField(S, 'jediToughness', 'Jedi Toughness %', c.jediToughness));
        lines.push('</div>');

        // -- States --
        lines.push('<div class="section">');
        lines.push('<h3>States</h3>');
        lines.push('<div class="field-row">');
        lines.push('  <label><input type="checkbox" ' + (c.isIntimidated ? 'checked' : '') + ' onchange="upd(\'' + S + '\',\'isIntimidated\',this.checked)" /> Intimidated</label>');
        lines.push('  <input type="number" class="small-input" value="' + c.intimidateDivisor + '" step="0.05" onchange="upd(\'' + S + '\',\'intimidateDivisor\',parseFloat(this.value)||1)" title="Divisor" />');
        lines.push('</div>');
        lines.push('<div class="field-row">');
        lines.push('  <label><input type="checkbox" ' + (c.isKnockedDown ? 'checked' : '') + ' onchange="upd(\'' + S + '\',\'isKnockedDown\',this.checked)" /> Knocked Down</label>');
        lines.push('</div>');
        lines.push(this._numField(S, 'warcryDelay', 'Warcry Delay (s)', c.warcryDelay, 0.1));
        lines.push('</div>');

        // -- HAM Costs --
        lines.push('<div class="section">');
        lines.push('<h3>HAM Attack Costs</h3>');
        lines.push('<div class="cost-grid">');
        lines.push('<div><label>Base</label></div><div><label>Multiplier</label></div><div><label>Stat</label></div>');
        lines.push('<div>' + this._inlineNum(S, 'healthAttackCost', c.healthAttackCost) + '</div>');
        lines.push('<div>' + this._inlineNum(S, 'healthCostMultiplier', c.healthCostMultiplier, 0.1) + '</div>');
        lines.push('<div>' + this._inlineNum(S, 'strength', c.strength) + ' STR</div>');
        lines.push('<div>' + this._inlineNum(S, 'actionAttackCost', c.actionAttackCost) + '</div>');
        lines.push('<div>' + this._inlineNum(S, 'actionCostMultiplier', c.actionCostMultiplier, 0.1) + '</div>');
        lines.push('<div>' + this._inlineNum(S, 'quickness', c.quickness) + ' QUI</div>');
        lines.push('<div>' + this._inlineNum(S, 'mindAttackCost', c.mindAttackCost) + '</div>');
        lines.push('<div>' + this._inlineNum(S, 'mindCostMultiplier', c.mindCostMultiplier, 0.1) + '</div>');
        lines.push('<div>' + this._inlineNum(S, 'focus', c.focus) + ' FOC</div>');
        lines.push('</div>');
        lines.push('</div>');

        // -- Force --
        lines.push('<div class="section">');
        lines.push('<h3>Force</h3>');
        lines.push(this._numField(S, 'forcePool', 'Force Pool', c.forcePool));
        lines.push(this._numField(S, 'weaponForceCost', 'Weapon Force Cost', c.weaponForceCost, 0.5));
        lines.push(this._numField(S, 'forceCostMultiplier', 'Cmd Force Multiplier', c.forceCostMultiplier, 0.1));
        lines.push('<div class="field-row">');
        lines.push('  <label><input type="checkbox" ' + (c.isPvp ? 'checked' : '') + ' onchange="upd(\'' + S + '\',\'isPvp\',this.checked)" /> PvP (min force cost 5)</label>');
        lines.push('</div>');
        lines.push(this._numField(S, 'huntedLevel', 'BH Hunted Level', c.huntedLevel));

        lines.push('<h4>Force Regen</h4>');
        lines.push(this._numField(S, 'forceRegenBase', 'Base Regen', c.forceRegenBase));
        lines.push(this._numField(S, 'frsControlManipulation', 'FRS Ctrl+Manip', c.frsControlManipulation));
        lines.push(this._numField(S, 'forceRegenMultiplier', 'Regen Multiplier', c.forceRegenMultiplier));
        lines.push(this._numField(S, 'forceRegenDivisor', 'Regen Divisor', c.forceRegenDivisor));
        lines.push('</div>');

        lines.push('</div>'); // combatant-col
        return lines.join('\n');
    }

    // Helper: number input field
    private _numField(side: string, field: string, label: string, value: number, step: number = 1): string {
        return [
            '<div class="field-row">',
            '  <label>' + label + '</label>',
            '  <input type="number" value="' + value + '" step="' + step + '" onchange="upd(\'' + side + '\',\'' + field + '\',parseFloat(this.value)||0)" />',
            '</div>'
        ].join('\n');
    }

    // Helper: inline small number input
    private _inlineNum(side: string, field: string, value: number, step: number = 1): string {
        return '<input type="number" class="small-input" value="' + value + '" step="' + step + '" onchange="upd(\'' + side + '\',\'' + field + '\',parseFloat(this.value)||0)" />';
    }

    // Helper: select field with string values
    private _selectField(side: string, field: string, value: string, options: Record<string, string>): string {
        const opts = Object.entries(options).map(([k, v]) =>
            '<option value="' + k + '"' + (k === value ? ' selected' : '') + '>' + v + '</option>'
        ).join('');
        return [
            '<div class="field-row">',
            '  <label>' + field.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()) + '</label>',
            '  <select onchange="upd(\'' + side + '\',\'' + field + '\',this.value)">' + opts + '</select>',
            '</div>'
        ].join('\n');
    }

    // Helper: select field with numeric values
    private _selectFieldNum(side: string, field: string, label: string, value: number, options: Record<number, string>): string {
        const opts = Object.entries(options).map(([k, v]) =>
            '<option value="' + k + '"' + (parseInt(k) === value ? ' selected' : '') + '>' + v + '</option>'
        ).join('');
        return [
            '<div class="field-row">',
            '  <label>' + label + '</label>',
            '  <select onchange="upd(\'' + side + '\',\'' + field + '\',parseInt(this.value))">' + opts + '</select>',
            '</div>'
        ].join('\n');
    }

    private _esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ========================================================================
    // CSS
    // ========================================================================

    private _getCss(): string {
        return [
            '* { box-sizing: border-box; margin: 0; padding: 0; }',
            'body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; }',
            '',
            '.toolbar { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }',
            '.toolbar h1 { font-size: 16px; font-weight: 600; }',
            '.toolbar-actions { display: flex; gap: 6px; }',
            '.toolbar-actions button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; font-size: 12px; }',
            '.toolbar-actions button:hover { background: var(--vscode-button-hoverBackground); }',
            '',
            '.scenario-name { margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }',
            '.scenario-name input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 3px 6px; width: 250px; }',
            '',
            // Headline banner
            '#headline-banner { position: sticky; top: 0; z-index: 100; margin-bottom: 16px; }',
            '.headline { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; padding: 12px 16px; border: 2px solid var(--vscode-textLink-foreground); background: var(--vscode-editor-background); box-shadow: 0 2px 8px rgba(0,0,0,0.3); }',
            '.headline-side { text-align: center; }',
            '.headline-side .hl-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }',
            '.headline-side .hl-dps { font-size: 28px; font-weight: 700; font-family: var(--vscode-editor-font-family); line-height: 1.1; }',
            '.headline-side .hl-sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }',
            '.headline-side .hl-detail { font-size: 11px; margin-top: 1px; }',
            '.headline-vs { font-size: 14px; font-weight: 600; color: var(--vscode-descriptionForeground); text-align: center; }',
            '.hl-sustainable { color: var(--vscode-testing-iconPassed, #4ec9b0); }',
            '.hl-unsustainable { color: var(--vscode-testing-iconFailed, #f44747); }',
            '',
            '.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }',
            '.combatant-col { border: 1px solid var(--vscode-panel-border); padding: 10px; }',
            '.combatant-col h2 { font-size: 14px; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-panel-border); }',
            '',
            '.section { margin-bottom: 10px; padding: 8px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-panel-border); }',
            '.section h3 { font-size: 12px; font-weight: 600; margin-bottom: 6px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; }',
            '.section h4 { font-size: 11px; font-weight: 600; margin: 6px 0 4px 0; color: var(--vscode-descriptionForeground); }',
            '',
            '.field-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 3px; gap: 6px; }',
            '.field-row label { font-size: 12px; min-width: 100px; }',
            '.field-row input[type="number"], .field-row select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 2px 4px; width: 90px; font-size: 12px; }',
            '.field-row select { width: 120px; }',
            '.small-input { width: 60px !important; }',
            '',
            '.resist-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; }',
            '.resist-cell { display: flex; align-items: center; gap: 4px; }',
            '.resist-cell label { font-size: 11px; min-width: 70px; }',
            '.resist-cell input { width: 50px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 2px; font-size: 11px; }',
            '',
            '.cost-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 3px; align-items: center; }',
            '.cost-grid label { font-size: 11px; font-weight: 600; }',
            '.cost-grid input { width: 60px; }',
            '',
            // Results styles
            '#results-area { border-top: 2px solid var(--vscode-panel-border); padding-top: 12px; }',
            '.results-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }',
            '.result-col { border: 1px solid var(--vscode-panel-border); padding: 10px; }',
            '.result-col h2 { font-size: 14px; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid var(--vscode-panel-border); }',
            '',
            '.step { margin-bottom: 10px; padding: 8px; border: 1px solid var(--vscode-panel-border); }',
            '.step-header { font-size: 12px; font-weight: 600; color: var(--vscode-textLink-foreground); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }',
            '.step-src { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.7; margin-bottom: 3px; font-family: var(--vscode-editor-font-family); }',
            '.step-formula { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; margin-bottom: 4px; padding: 3px 6px; background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.1)); border-left: 2px solid var(--vscode-textLink-foreground); }',
            '.step-eq { font-size: 12px; font-family: var(--vscode-editor-font-family); margin: 3px 0; padding: 2px 6px; background: var(--vscode-textBlockQuote-background, rgba(127,127,127,0.05)); }',
            '.step-eq .var-name { color: var(--vscode-textLink-foreground); }',
            '.step-eq .var-val { color: var(--vscode-foreground); font-weight: 600; }',
            '.step-eq .op { color: var(--vscode-descriptionForeground); }',
            '.step-calc { font-size: 12px; font-family: var(--vscode-editor-font-family); margin: 2px 0; }',
            '.step-result { font-size: 13px; font-weight: 600; margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--vscode-panel-border); }',
            '.step-note { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }',
            '.step-na { font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; }',
            '',
            '.summary-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
            '.summary-table td { padding: 3px 6px; border-bottom: 1px solid var(--vscode-panel-border); }',
            '.summary-table td:first-child { font-weight: 600; }',
            '.summary-table td:last-child { text-align: right; font-family: var(--vscode-editor-font-family); }',
            '.summary-table .separator td { border-bottom: 2px solid var(--vscode-panel-border); padding: 1px; }',
            '.val-good { color: var(--vscode-testing-iconPassed, #4ec9b0); }',
            '.val-bad { color: var(--vscode-testing-iconFailed, #f44747); }',
            '.val-neutral { color: var(--vscode-foreground); }'
        ].join('\n');
    }

    // ========================================================================
    // SCRIPT
    // ========================================================================

    private _getScript(): string {
        return [
            'var vscode = acquireVsCodeApi();',
            '',
            'function send(msg) { vscode.postMessage(msg); }',
            '',
            'function upd(side, field, value) {',
            '  send({ type: "update", side: side, field: field, value: value });',
            '}',
            '',
            'function fmt(n, d) {',
            '  if (n === Infinity || n === -Infinity || isNaN(n)) return "--";',
            '  d = d === undefined ? 1 : d;',
            '  return n.toFixed(d);',
            '}',
            '',
            'function renderHeadline(aVsD, dVsA, scenario) {',
            '  var banner = document.getElementById("headline-banner");',
            '  var h = [];',
            '  h.push("<div class=\\"headline\\">");',
            '',
            '  // Left: Attacker DPS against Defender',
            '  var aSust = aVsD.step7.sustainable;',
            '  var aCls = aSust ? "hl-sustainable" : "hl-unsustainable";',
            '  h.push("<div class=\\"headline-side\\">");',
            '  h.push("<div class=\\"hl-label\\">" + scenario.attacker.name + " DPS</div>");',
            '  h.push("<div class=\\"hl-dps " + aCls + "\\">" + fmt(aVsD.summary.effectiveDPS) + "</div>");',
            '  h.push("<div class=\\"hl-sub\\">raw " + fmt(aVsD.summary.rawDPS) + " &middot; " + fmt(aVsD.summary.hitChance) + "% hit &middot; " + fmt(aVsD.summary.attackSpeed, 2) + "s</div>");',
            '  h.push("<div class=\\"hl-detail\\">TTK <b>" + fmt(aVsD.summary.ttkHealth) + "s</b> health &middot; <b>" + fmt(aVsD.summary.ttkAllHam) + "s</b> all HAM</div>");',
            '  if (aVsD.step7.effectiveForceCost > 0) {',
            '    h.push("<div class=\\"hl-detail " + aCls + "\\">Force: " + (aVsD.step7.netForcePerSec >= 0 ? "+" : "") + fmt(aVsD.step7.netForcePerSec, 2) + "/s " + (aSust ? "" : "(OOF " + fmt(aVsD.summary.timeToOof) + "s)") + "</div>");',
            '  }',
            '  h.push("</div>");',
            '',
            '  // Center: VS',
            '  h.push("<div class=\\"headline-vs\\">VS</div>");',
            '',
            '  // Right: Defender DPS against Attacker',
            '  var dSust = dVsA.step7.sustainable;',
            '  var dCls = dSust ? "hl-sustainable" : "hl-unsustainable";',
            '  h.push("<div class=\\"headline-side\\">");',
            '  h.push("<div class=\\"hl-label\\">" + scenario.defender.name + " DPS</div>");',
            '  h.push("<div class=\\"hl-dps " + dCls + "\\">" + fmt(dVsA.summary.effectiveDPS) + "</div>");',
            '  h.push("<div class=\\"hl-sub\\">raw " + fmt(dVsA.summary.rawDPS) + " &middot; " + fmt(dVsA.summary.hitChance) + "% hit &middot; " + fmt(dVsA.summary.attackSpeed, 2) + "s</div>");',
            '  h.push("<div class=\\"hl-detail\\">TTK <b>" + fmt(dVsA.summary.ttkHealth) + "s</b> health &middot; <b>" + fmt(dVsA.summary.ttkAllHam) + "s</b> all HAM</div>");',
            '  if (dVsA.step7.effectiveForceCost > 0) {',
            '    h.push("<div class=\\"hl-detail " + dCls + "\\">Force: " + (dVsA.step7.netForcePerSec >= 0 ? "+" : "") + fmt(dVsA.step7.netForcePerSec, 2) + "/s " + (dSust ? "" : "(OOF " + fmt(dVsA.summary.timeToOof) + "s)") + "</div>");',
            '  }',
            '  h.push("</div>");',
            '',
            '  h.push("</div>");',
            '  banner.innerHTML = h.join("\\n");',
            '}',
            '',
            'function renderResults(aVsD, dVsA, scenario) {',
            '  renderHeadline(aVsD, dVsA, scenario);',
            '  var area = document.getElementById("results-area");',
            '  var h = [];',
            '  h.push("<div class=\\"results-columns\\">");',
            '  h.push(renderOneSide("Attacker vs Defender", aVsD, scenario.attacker, scenario.defender));',
            '  h.push(renderOneSide("Defender vs Attacker", dVsA, scenario.defender, scenario.attacker));',
            '  h.push("</div>");',
            '  area.innerHTML = h.join("\\n");',
            '}',
            '',
            '// Helper: wrap variable name + value in styled spans',
            'function v(name, val) { return "<span class=\\"var-name\\">" + name + "</span><span class=\\"op\\">=</span><span class=\\"var-val\\">" + val + "</span>"; }',
            'function op(s) { return "<span class=\\"op\\">" + s + "</span>"; }',
            '',
            'function renderOneSide(title, r, atk, def) {',
            '  var h = [];',
            '  h.push("<div class=\\"result-col\\">");',
            '  h.push("<h2>" + title + "</h2>");',
            '',
            '  // ── Step 1: Base Damage ──',
            '  h.push("<div class=\\"step\\">");',
            '  h.push("<div class=\\"step-header\\">Step 1: Base Damage</div>");',
            '  h.push("<div class=\\"step-src\\">CombatManager.cpp:1203-1315</div>");',
            '  h.push("<div class=\\"step-formula\\">baseDamage = avg(minDamage, maxDamage) " + op("&times;") + " damageMultiplier</div>");',
            '  h.push("<div class=\\"step-eq\\">" + v("minDamage", atk.isForceAttack ? fmt(atk.forceMinDamage,0) : fmt(atk.minDamage,0)) + " &nbsp; " + v("maxDamage", atk.isForceAttack ? fmt(atk.forceMaxDamage,0) : fmt(atk.maxDamage,0)) + " &nbsp; " + v("damageMultiplier", fmt(atk.damageMultiplier,2)) + "</div>");',
            '  h.push("<div class=\\"step-eq\\">avg = (" + (atk.isForceAttack ? fmt(atk.forceMinDamage,0) : fmt(atk.minDamage,0)) + " + " + (atk.isForceAttack ? fmt(atk.forceMaxDamage,0) : fmt(atk.maxDamage,0)) + ") / 2 = <b>" + fmt(r.step1.avgWeaponDamage) + "</b></div>");',
            '  h.push("<div class=\\"step-eq\\">" + fmt(r.step1.avgWeaponDamage) + " &times; " + fmt(atk.damageMultiplier,2) + " = <b>" + fmt(r.step1.afterMultiplier) + "</b></div>");',
            '  if (atk.isForceAttack) h.push("<div class=\\"step-note\\">Using force attack damage (overrides weapon)</div>");',
            '  h.push("<div class=\\"step-result\\">baseDamage = " + fmt(r.step1.afterMultiplier) + "</div>");',
            '  h.push("</div>");',
            '',
            '  // ── Step 2: Damage Modifiers ──',
            '  h.push("<div class=\\"step\\">");',
            '  h.push("<div class=\\"step-header\\">Step 2: Damage Modifiers</div>");',
            '  h.push("<div class=\\"step-src\\">CombatManager.cpp:1289 (player), 1310 (melee), 1321 (KD), 1974 (intimidate)</div>");',
            '  h.push("<div class=\\"step-formula\\">damage &times; playerBonus &times; meleeBonus + flatBonus &times; kdMult &divide; intimidateDivisor</div>");',
            '  var dmg2 = r.step1.afterMultiplier;',
            '  if (r.step2.playerBonus > 1) {',
            '    h.push("<div class=\\"step-eq\\">" + v("playerBonus", "1.5") + " " + op("(isPlayer, always 1.5x)") + "</div>");',
            '    h.push("<div class=\\"step-eq\\">" + fmt(dmg2) + " &times; 1.50 = <b>" + fmt(r.step2.afterPlayerBonus) + "</b></div>");',
            '    dmg2 = r.step2.afterPlayerBonus;',
            '  }',
            '  if (r.step2.meleeBonus > 1) {',
            '    h.push("<div class=\\"step-eq\\">" + v("meleeBonus", "1.25") + " " + op("(melee non-Force, always 1.25x)") + "</div>");',
            '    h.push("<div class=\\"step-eq\\">" + fmt(dmg2) + " &times; 1.25 = <b>" + fmt(r.step2.afterMeleeBonus) + "</b></div>");',
            '    dmg2 = r.step2.afterMeleeBonus;',
            '  }',
            '  if (atk.damageBonus !== 0) {',
            '    h.push("<div class=\\"step-eq\\">" + v("damageBonus", fmt(atk.damageBonus,0)) + "</div>");',
            '    h.push("<div class=\\"step-eq\\">" + fmt(dmg2) + " + " + fmt(atk.damageBonus,0) + " = <b>" + fmt(r.step2.afterFlatBonus) + "</b></div>");',
            '    dmg2 = r.step2.afterFlatBonus;',
            '  }',
            '  if (r.step2.knockdownMult > 1) {',
            '    h.push("<div class=\\"step-eq\\">" + v("knockdownMult", fmt(r.step2.knockdownMult,2)) + " " + op("(1.5x PvP, 1.2x NPC&rarr;Player)") + "</div>");',
            '    h.push("<div class=\\"step-eq\\">" + fmt(dmg2) + " &times; " + fmt(r.step2.knockdownMult,2) + " = <b>" + fmt(r.step2.afterKnockdown) + "</b></div>");',
            '    dmg2 = r.step2.afterKnockdown;',
            '  }',
            '  if (r.step2.intimidateDivisor > 1) {',
            '    h.push("<div class=\\"step-eq\\">" + v("intimidateDivisor", fmt(r.step2.intimidateDivisor,2)) + " " + op("(private_damage_divisor_intimidate)") + "</div>");',
            '    h.push("<div class=\\"step-eq\\">" + fmt(dmg2) + " &divide; " + fmt(r.step2.intimidateDivisor,2) + " = <b>" + fmt(r.step2.afterIntimidate) + "</b></div>");',
            '  }',
            '  h.push("<div class=\\"step-result\\">damage = " + fmt(r.step2.finalDamage) + "</div>");',
            '  h.push("</div>");',
            '',
            '  // ── Step 3: Armor Mitigation ──',
            '  h.push("<div class=\\"step\\">");',
            '  h.push("<div class=\\"step-header\\">Step 3: Armor Mitigation</div>");',
            '  h.push("<div class=\\"step-src\\">CombatManager.cpp:3870-3903 (AP), 3541 (resist)</div>");',
            '  h.push("<div class=\\"step-formula\\">If AP > AR: apMult = pow(1.25, AP - AR)<br>If AR > AP: apMult = pow(0.50, AR - AP)<br>damage = damage &times; apMult &times; (1 - resist/100)</div>");',
            '  h.push("<div class=\\"step-eq\\">" + v("armorPiercing", atk.armorPiercing) + " &nbsp; " + v("armorRating", def.armorRating) + " &nbsp;&rarr; " + v("apMult", fmt(r.step3.apMultiplier,3)) + "</div>");',
            '  h.push("<div class=\\"step-eq\\">" + v("resist[" + atk.damageType + "]", fmt(r.step3.activeResist) + "%") + "</div>");',
            '  h.push("<div class=\\"step-eq\\">" + fmt(r.step2.finalDamage) + " &times; " + fmt(r.step3.apMultiplier,3) + " &times; (1 - " + fmt(r.step3.activeResist,0) + "/100) = <b>" + fmt(r.step3.damageAfterArmor) + "</b></div>");',
            '  h.push("<div class=\\"step-result\\">damage = " + fmt(r.step3.damageAfterArmor) + "</div>");',
            '  h.push("</div>");',
            '',
            '  // ── Step 4: Force Defenses ──',
            '  h.push("<div class=\\"step\\">");',
            '  h.push("<div class=\\"step-header\\">Step 4: Force Defenses</div>");',
            '  h.push("<div class=\\"step-src\\">CombatManager.cpp:3568-3576 (FA), 3582-3590 (FS), 3342-3344 (JT), 3132-3186 (SB)</div>");',
            '  h.push("<div class=\\"step-formula\\">Force Armor: dmg &times; (1 - FA/100) &mdash; requires: no armor, non-Force attack<br>Force Shield: dmg &times; (1 - FS/100) &mdash; requires: no armor, Force attack only<br>Jedi Toughness: dmg &times; (1 - JT/100) &mdash; requires: no armor, non-LS dmg, non-Force<br>Saber Block: reduces effective hit chance &mdash; ranged attacks only, PvE cap 85%</div>");',
            '  var anyFD = r.step4.forceArmorApplies || r.step4.forceShieldApplies || r.step4.jediToughnessApplies || r.step4.saberBlockApplies;',
            '  var prevFD = r.step3.damageAfterArmor;',
            '  if (!anyFD) {',
            '    h.push("<div class=\\"step-na\\">No force defenses apply (wearingArmor=" + def.wearingArmor + ", isForceAttack=" + atk.isForceAttack + ", damageType=" + atk.damageType + ", attackType=" + atk.attackType + ")</div>");',
            '  } else {',
            '    if (r.step4.forceArmorApplies) {',
            '      h.push("<div class=\\"step-eq\\">" + v("forceArmor", fmt(r.step4.forceArmorPct) + "%") + " " + op("(no armor + non-Force)") + "</div>");',
            '      h.push("<div class=\\"step-eq\\">" + fmt(prevFD) + " &times; (1 - " + fmt(r.step4.forceArmorPct,0) + "/100) = <b>" + fmt(r.step4.damageAfterForceArmor) + "</b></div>");',
            '      prevFD = r.step4.damageAfterForceArmor;',
            '    }',
            '    if (r.step4.forceShieldApplies) {',
            '      h.push("<div class=\\"step-eq\\">" + v("forceShield", fmt(r.step4.forceShieldPct) + "%") + " " + op("(no armor + Force attack)") + "</div>");',
            '      h.push("<div class=\\"step-eq\\">" + fmt(prevFD) + " &times; (1 - " + fmt(r.step4.forceShieldPct,0) + "/100) = <b>" + fmt(r.step4.damageAfterForceShield) + "</b></div>");',
            '      prevFD = r.step4.damageAfterForceShield;',
            '    }',
            '    if (r.step4.jediToughnessApplies) {',
            '      h.push("<div class=\\"step-eq\\">" + v("jediToughness", fmt(r.step4.jediToughnessPct) + "%") + " " + op("(no armor, non-LS, non-Force)") + "</div>");',
            '      h.push("<div class=\\"step-eq\\">" + fmt(prevFD) + " &times; (1 - " + fmt(r.step4.jediToughnessPct,0) + "/100) = <b>" + fmt(r.step4.damageAfterJediToughness) + "</b></div>");',
            '    }',
            '    if (r.step4.saberBlockApplies) {',
            '      h.push("<div class=\\"step-eq\\">" + v("saberBlock", fmt(r.step4.saberBlockPct) + "%") + " " + op("(ranged only, PvE cap 85%) &mdash; applied to hit chance in summary") + "</div>");',
            '    }',
            '  }',
            '  h.push("<div class=\\"step-result\\">damage = " + fmt(r.step4.finalDamage) + "</div>");',
            '  h.push("</div>");',
            '',
            '  // ── Step 5: Hit Chance ──',
            '  h.push("<div class=\\"step\\">");',
            '  h.push("<div class=\\"step-header\\">Step 5: Hit Chance</div>");',
            '  h.push("<div class=\\"step-src\\">CombatManager.cpp:3264-3287, CombatManager.h:77-82</div>");',
            '  h.push("<div class=\\"step-formula\\">roll = (accuracy - defense) / toHitScale<br>toHit = toHitBase(75) + stepwise adjustment (step=25, maxSteps=3)<br>Clamp to [0, 100]</div>");',
            '  h.push("<div class=\\"step-eq\\">" + v("accuracy", fmt(r.step5.attackerAccuracy,0)) + " &nbsp; " + v("defense", fmt(r.step5.defenderDefense,0)) + "</div>");',
            '  if (r.step5.defenderIntimidated) {',
            '    h.push("<div class=\\"step-eq\\">" + op("Defender intimidated: ") + v("effectiveDefense", fmt(r.step5.defenderDefense,0) + " &times; 0.55 = " + fmt(r.step5.effectiveDefense,0)) + "</div>");',
            '    h.push("<div class=\\"step-src\\">CombatManager.cpp:2982-2983 &mdash; secondary defense &times; 0.55</div>");',
            '  }',
            '  h.push("<div class=\\"step-eq\\">roll = (" + fmt(r.step5.attackerAccuracy,0) + " - " + fmt(r.step5.effectiveDefense,0) + ") / 50 = <b>" + fmt((r.step5.attackerAccuracy - r.step5.effectiveDefense) / 50, 2) + "</b></div>");',
            '  h.push("<div class=\\"step-result\\">hitChance = " + fmt(r.step5.hitChance) + "%</div>");',
            '  h.push("</div>");',
            '',
            '  // ── Step 6: Attack Speed ──',
            '  h.push("<div class=\\"step\\">");',
            '  h.push("<div class=\\"step-header\\">Step 6: Attack Speed</div>");',
            '  h.push("<div class=\\"step-src\\">CombatManager.cpp:4009-4023</div>");',
            '  h.push("<div class=\\"step-formula\\">speed = (1 - speedMod/100) &times; speedRatio &times; weaponSpeed<br>speed -= speed &times; (combatHaste/100)<br>speed += warcryDelay<br>speed = max(speed, 1.0)</div>");',
            '  h.push("<div class=\\"step-eq\\">" + v("weaponSpeed", fmt(atk.attackSpeed,2)) + " &nbsp; " + v("speedMod", fmt(atk.speedMod,0)) + " &nbsp; " + v("speedRatio", fmt(atk.speedMultiplier,2)) + "</div>");',
            '  h.push("<div class=\\"step-eq\\">(1 - " + fmt(atk.speedMod,0) + "/100) &times; " + fmt(atk.speedMultiplier,2) + " &times; " + fmt(atk.attackSpeed,2) + " = <b>" + fmt(r.step6.afterSpeedMod, 2) + "s</b></div>");',
            '  if (atk.combatHaste > 0) {',
            '    h.push("<div class=\\"step-eq\\">" + v("combatHaste", fmt(atk.combatHaste,0) + "%") + " &rarr; " + fmt(r.step6.afterSpeedMod,2) + " - (" + fmt(r.step6.afterSpeedMod,2) + " &times; " + fmt(atk.combatHaste,0) + "/100) = <b>" + fmt(r.step6.afterHaste, 2) + "s</b></div>");',
            '  }',
            '  if (atk.warcryDelay > 0) {',
            '    h.push("<div class=\\"step-eq\\">" + v("warcryDelay", fmt(atk.warcryDelay,2) + "s") + " &rarr; " + fmt(r.step6.afterHaste,2) + " + " + fmt(atk.warcryDelay,2) + " = <b>" + fmt(r.step6.afterWarcry, 2) + "s</b></div>");',
            '  }',
            '  h.push("<div class=\\"step-eq\\">max(" + fmt(r.step6.afterWarcry,2) + ", 1.0) = <b>" + fmt(r.step6.finalSpeed, 2) + "s</b></div>");',
            '  h.push("<div class=\\"step-result\\">attackSpeed = " + fmt(r.step6.finalSpeed, 2) + "s</div>");',
            '  h.push("</div>");',
            '',
            '  // ── Step 7: HAM & Force Costs ──',
            '  h.push("<div class=\\"step\\">");',
            '  h.push("<div class=\\"step-header\\">Step 7: HAM & Force Costs</div>");',
            '  h.push("<div class=\\"step-src\\">CombatManager.cpp:4106-4166 (costs), CreatureObjectImpl.cpp:3920-3927 (adjustment), PlayerObjectImpl.cpp:2555-2597 (force regen)</div>");',
            '',
            '  // HAM cost formula',
            '  h.push("<div class=\\"step-formula\\">hamCost = baseCost &times; cmdMultiplier<br>adjusted = hamCost - ((secondaryStat - 300) / 1200) &times; hamCost</div>");',
            '  h.push("<div class=\\"step-eq\\"><b>Health:</b> " + v("base", fmt(atk.healthAttackCost,0)) + " &times; " + v("mult", fmt(atk.healthCostMultiplier,2)) + " = " + fmt(r.step7.healthCostBase,1) + " &rarr; adj(" + v("STR", fmt(atk.strength,0)) + ") = <b>" + fmt(r.step7.healthCostAdjusted, 1) + "</b></div>");',
            '  h.push("<div class=\\"step-eq\\"><b>Action:</b> " + v("base", fmt(atk.actionAttackCost,0)) + " &times; " + v("mult", fmt(atk.actionCostMultiplier,2)) + " = " + fmt(r.step7.actionCostBase,1) + " &rarr; adj(" + v("QUI", fmt(atk.quickness,0)) + ") = <b>" + fmt(r.step7.actionCostAdjusted, 1) + "</b></div>");',
            '  h.push("<div class=\\"step-eq\\"><b>Mind:</b> " + v("base", fmt(atk.mindAttackCost,0)) + " &times; " + v("mult", fmt(atk.mindCostMultiplier,2)) + " = " + fmt(r.step7.mindCostBase,1) + " &rarr; adj(" + v("FOC", fmt(atk.focus,0)) + ") = <b>" + fmt(r.step7.mindCostAdjusted, 1) + "</b></div>");',
            '  h.push("<div class=\\"step-eq\\">HAM drain/sec: " + fmt(r.step7.hamDrainPerSec[0], 2) + " H / " + fmt(r.step7.hamDrainPerSec[1], 2) + " A / " + fmt(r.step7.hamDrainPerSec[2], 2) + " M</div>");',
            '',
            '  // Force cost formula',
            '  h.push("<div class=\\"step-formula\\">forceCost = max(weaponForceCost, pvpMin) &times; cmdMultiplier<br>pvpMin = isPvP ? 5 + huntedLevel &times; 1.5 : 1</div>");',
            '  h.push("<div class=\\"step-eq\\">" + v("weaponForceCost", fmt(atk.weaponForceCost,1)) + " &nbsp; " + v("cmdMult", fmt(atk.forceCostMultiplier,2)) + " &nbsp; " + v("isPvP", atk.isPvp) + "</div>");',
            '  h.push("<div class=\\"step-eq\\">effective = " + fmt(r.step7.weaponForceCost,1) + " &times; " + fmt(atk.forceCostMultiplier,2) + " = <b>" + fmt(r.step7.effectiveForceCost, 1) + "</b> /atk &rarr; <b>" + fmt(r.step7.forceDrainPerSec, 2) + "</b>/s</div>");',
            '',
            '  // Force regen formula',
            '  h.push("<div class=\\"step-formula\\">regen = (baseRegen + frsBonus/10) &times; regenMult / regenDiv<br>tickAmount = 5, tickInterval = 10 / (regen / 5) seconds</div>");',
            '  h.push("<div class=\\"step-eq\\">" + v("baseRegen", fmt(atk.forceRegenBase,0)) + " &nbsp; " + v("frsCtrl+Manip", fmt(atk.frsControlManipulation,0)) + " &nbsp; " + v("mult", fmt(atk.forceRegenMultiplier,0)) + " &nbsp; " + v("div", fmt(atk.forceRegenDivisor,0)) + "</div>");',
            '  h.push("<div class=\\"step-eq\\">regen = (" + fmt(atk.forceRegenBase,0) + " + " + fmt(atk.frsControlManipulation,0) + "/10) &times; " + fmt(atk.forceRegenMultiplier,0) + " / " + fmt(atk.forceRegenDivisor,0) + " = <b>" + fmt(r.step7.effectiveForceRegen, 1) + "</b></div>");',
            '  h.push("<div class=\\"step-eq\\">tick " + fmt(r.step7.forceTickAmount, 0) + " every " + fmt(r.step7.forceTickInterval, 2) + "s = <b>" + fmt(r.step7.forceRegenPerSec, 2) + "</b>/s</div>");',
            '',
            '  var netCls = r.step7.netForcePerSec >= 0 ? "val-good" : "val-bad";',
            '  h.push("<div class=\\"step-result\\">Net force: <span class=\\"" + netCls + "\\">" + fmt(r.step7.forceRegenPerSec,2) + " - " + fmt(r.step7.forceDrainPerSec,2) + " = " + (r.step7.netForcePerSec >= 0 ? "+" : "") + fmt(r.step7.netForcePerSec, 2) + "/s " + (r.step7.sustainable ? "(sustainable)" : "(UNSUSTAINABLE)") + "</span></div>");',
            '  h.push("</div>");',
            '',
            '  // ── Summary ──',
            '  h.push("<div class=\\"step\\">");',
            '  h.push("<div class=\\"step-header\\">Summary</div>");',
            '  h.push("<div class=\\"step-formula\\">effectiveDmg = damage &times; hitChance" + (r.step4.saberBlockApplies ? " &times; (1 - saberBlock/100)" : "") + "<br>DPS = effectiveDmg / attackSpeed<br>TTK = pool / effectiveDPS</div>");',
            '  h.push("<table class=\\"summary-table\\">");',
            '  h.push("<tr><td>Avg Damage/Hit</td><td>" + fmt(r.summary.avgDamagePerHit) + "</td></tr>");',
            '  h.push("<tr><td>Hit Chance</td><td>" + fmt(r.summary.hitChance) + "%" + (r.step4.saberBlockApplies ? " (&times;" + fmt(1-r.step4.saberBlockPct/100,2) + " saber block)" : "") + "</td></tr>");',
            '  h.push("<tr><td>Effective Dmg/Hit</td><td>" + fmt(r.summary.effectiveDmgPerHit) + "</td></tr>");',
            '  h.push("<tr><td>Attack Speed</td><td>" + fmt(r.summary.attackSpeed, 2) + "s</td></tr>");',
            '  h.push("<tr class=\\"separator\\"><td></td><td></td></tr>");',
            '  h.push("<tr><td>Raw DPS</td><td>" + fmt(r.summary.rawDPS) + "</td></tr>");',
            '  h.push("<tr><td>Effective DPS</td><td class=\\"val-good\\">" + fmt(r.summary.effectiveDPS) + "</td></tr>");',
            '  h.push("<tr class=\\"separator\\"><td></td><td></td></tr>");',
            '  h.push("<tr><td>HAM Cost/s (H/A/M)</td><td>" + fmt(r.summary.hamCostPerSec[0], 2) + " / " + fmt(r.summary.hamCostPerSec[1], 2) + " / " + fmt(r.summary.hamCostPerSec[2], 2) + "</td></tr>");',
            '  h.push("<tr><td>Force Cost/s</td><td>" + fmt(r.summary.forceCostPerSec, 2) + "</td></tr>");',
            '  h.push("<tr><td>Force Regen/s</td><td>" + fmt(r.summary.forceRegenPerSec, 2) + "</td></tr>");',
            '  var netCls2 = r.summary.netForcePerSec >= 0 ? "val-good" : "val-bad";',
            '  h.push("<tr><td>Net Force/s</td><td class=\\"" + netCls2 + "\\">" + (r.summary.netForcePerSec >= 0 ? "+" : "") + fmt(r.summary.netForcePerSec, 2) + "</td></tr>");',
            '  h.push("<tr class=\\"separator\\"><td></td><td></td></tr>");',
            '  h.push("<tr><td>TTK (Health " + fmt(def.health,0) + ")</td><td>" + fmt(r.summary.ttkHealth) + "s</td></tr>");',
            '  h.push("<tr><td>TTK (All HAM " + fmt(def.health+def.action+def.mind,0) + ")</td><td>" + fmt(r.summary.ttkAllHam) + "s</td></tr>");',
            '  h.push("<tr><td>Time to OOF (" + fmt(atk.forcePool,0) + ")</td><td>" + fmt(r.summary.timeToOof) + "s</td></tr>");',
            '  h.push("</table>");',
            '  h.push("</div>");',
            '',
            '  h.push("</div>");',
            '  return h.join("\\n");',
            '}',
            '',
            'window.addEventListener("message", function(event) {',
            '  var msg = event.data;',
            '  if (msg.type === "results") {',
            '    renderResults(msg.aVsD, msg.dVsA, msg.scenario);',
            '  }',
            '});',
            '',
            'send({ type: "ready" });'
        ].join('\n');
    }
}
