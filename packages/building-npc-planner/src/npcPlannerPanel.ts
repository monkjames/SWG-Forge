/**
 * Building NPC Planner Webview Panel
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parsePOB, PobData, Cell, getCellBounds, calculateCellPositions, CellPosition, CellConnection, parseFLR, FloorData } from '@swgemu/core';

interface PatrolWaypoint {
    id: string;
    x: number;
    y: number;
    z: number;
    waitTime: number;
}

interface PatrolPath {
    id: string;
    name: string;
    cellIndex: number;
    waypoints: PatrolWaypoint[];
    mode: 'loop' | 'pingpong';
    color: string;
}

interface SpawnPoint {
    id: string;
    x: number;
    y: number;
    z: number;
    heading: number;
    mobileTemplate: string;
    tier: number;
    patrolPathId?: string;
}

interface CellSpawnData {
    cellIndex: number;
    cellName: string;
    spawns: SpawnPoint[];
    patrolPaths?: PatrolPath[];
}

export class NpcPlannerPanel {
    public static currentPanel: NpcPlannerPanel | undefined;
    public static readonly viewType = 'npcPlanner';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _workspaceRoot: string = '';
    private _pobData: PobData | null = null;
    private _spawnData: Map<number, CellSpawnData> = new Map();
    private _patrolPaths: Map<number, PatrolPath[]> = new Map();
    private _screenplayName: string = '';

    public static createOrShow(extensionUri: vscode.Uri): NpcPlannerPanel {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (NpcPlannerPanel.currentPanel) {
            NpcPlannerPanel.currentPanel._panel.reveal(column);
            return NpcPlannerPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            NpcPlannerPanel.viewType,
            'Building NPC Planner',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        NpcPlannerPanel.currentPanel = new NpcPlannerPanel(panel, extensionUri);
        return NpcPlannerPanel.currentPanel;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

        this._panel.webview.html = this._getHtml();
        this._panel.webview.onDidReceiveMessage(m => this._handleMessage(m), null, this._disposables);
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Send initial message to populate POB file list
        this._sendPobFileList();
    }

    public dispose(): void {
        NpcPlannerPanel.currentPanel = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }

    private _sendPobFileList(): void {
        const config = vscode.workspace.getConfiguration('swgForge');
        const treWorkingPath = config.get<string>('tre.workingPath', 'tre/working');
        const treInfinityPath = config.get<string>('tre.referencePath', 'tre/infinity');
        const treVanillaPath = config.get<string>('tre.vanillaPath', 'tre/vanilla');

        // Search all three TRE directories for POB files
        const searchDirs = [
            path.join(this._workspaceRoot, treWorkingPath, 'object/building'),
            path.join(this._workspaceRoot, treInfinityPath, 'object/building'),
            path.join(this._workspaceRoot, treVanillaPath, 'object/building'),
        ];

        const seen = new Set<string>();
        let pobFiles: string[] = [];
        for (const pobDir of searchDirs) {
            if (fs.existsSync(pobDir)) {
                const found = this._findPobFiles(pobDir);
                for (const f of found) {
                    // Deduplicate by the object-relative path (e.g., object/building/general/foo.pob)
                    const objRelative = f.replace(/^.*?(object\/building\/)/, '$1');
                    if (!seen.has(objRelative)) {
                        seen.add(objRelative);
                        pobFiles.push(f);
                    }
                }
            }
        }

        this._panel.webview.postMessage({
            type: 'pobFileList',
            files: pobFiles
        });
    }

    private _findPobFiles(dir: string): string[] {
        const files: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...this._findPobFiles(fullPath));
            } else if (entry.name.endsWith('.pob') || entry.name.endsWith('.iff')) {
                // Make path relative to workspace
                const relativePath = path.relative(this._workspaceRoot, fullPath);
                files.push(relativePath);
            }
        }

        return files;
    }

    private async _handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'loadPob':
                await this._loadPobFile(message.path);
                break;

            case 'setScreenplayName':
                this._screenplayName = message.name;
                break;

            case 'updateSpawnData':
                this._updateSpawnData(message.data);
                break;

            case 'exportScreenplay':
                await this._exportScreenplay();
                break;

            case 'addSpawnPoint':
                this._addSpawnPoint(message.cellIndex, message.spawn);
                break;

            case 'removeSpawnPoint':
                this._removeSpawnPoint(message.cellIndex, message.spawnId);
                break;

            case 'updateSpawnPoint':
                this._updateSpawnPoint(message.cellIndex, message.spawn);
                break;

            case 'addPatrolPath':
                this._addPatrolPath(message.cellIndex, message.path);
                break;

            case 'removePatrolPath':
                this._removePatrolPath(message.cellIndex, message.pathId);
                break;

            case 'updatePatrolPath':
                this._updatePatrolPath(message.cellIndex, message.path);
                break;

            case 'addPatrolWaypoint':
                this._addPatrolWaypoint(message.cellIndex, message.pathId, message.waypoint);
                break;

            case 'removePatrolWaypoint':
                this._removePatrolWaypoint(message.cellIndex, message.pathId, message.waypointId);
                break;
        }
    }

    private async _loadPobFile(relativePath: string): Promise<void> {
        try {
            const fullPath = path.join(this._workspaceRoot, relativePath);
            const data = fs.readFileSync(fullPath);
            this._pobData = parsePOB(data);

            // Clear existing data
            this._spawnData.clear();
            this._patrolPaths.clear();

            // Calculate 3D cell positions for stick diagram
            const { positions, connections } = calculateCellPositions(this._pobData);

            // Convert positions Map to array for JSON serialization
            const positionsArray = Array.from(positions.values());

            // Load floor geometry for each cell
            const config = vscode.workspace.getConfiguration('swgForge');
            const treWorkingPath = config.get<string>('tre.workingPath', 'tre/working');

            const cellsWithFloors = this._pobData.cells.map((cell, index) => {
                let floorGeometry = null;

                if (cell.floor_file) {
                    try {
                        // Search multiple TRE directories for floor files
                        const treVanillaPath = config.get<string>('tre.vanillaPath', 'tre/vanilla');
                        const searchPaths = [
                            path.join(this._workspaceRoot, treWorkingPath, cell.floor_file),
                            path.join(this._workspaceRoot, treVanillaPath, cell.floor_file)
                        ];

                        let floorPath = '';
                        for (const candidate of searchPaths) {
                            if (fs.existsSync(candidate)) {
                                floorPath = candidate;
                                break;
                            }
                        }

                        if (floorPath) {
                            const floorData = fs.readFileSync(floorPath);
                            const floorParsed = parseFLR(floorData);

                            // Extract portal edges (doorways) from triangle data
                            const portalEdges: { v1: number; v2: number; portalId: number }[] = [];
                            for (const tri of floorParsed.tris) {
                                // Edge 1 (corner1-corner2)
                                if (tri.portalId1 >= 0) {
                                    portalEdges.push({ v1: tri.corner1, v2: tri.corner2, portalId: tri.portalId1 });
                                }
                                // Edge 2 (corner2-corner3)
                                if (tri.portalId2 >= 0) {
                                    portalEdges.push({ v1: tri.corner2, v2: tri.corner3, portalId: tri.portalId2 });
                                }
                                // Edge 3 (corner3-corner1)
                                if (tri.portalId3 >= 0) {
                                    portalEdges.push({ v1: tri.corner3, v2: tri.corner1, portalId: tri.portalId3 });
                                }
                            }

                            floorGeometry = {
                                vertices: floorParsed.verts.map(v => ({ x: v.x, y: v.y, z: v.z })),
                                triangles: floorParsed.tris.map(t => ({
                                    v1: t.corner1,
                                    v2: t.corner2,
                                    v3: t.corner3
                                })),
                                bounds: floorParsed.bounds,
                                portalEdges
                            };
                        }
                    } catch (error) {
                        console.warn(`Failed to load floor for cell ${index}: ${error}`);
                    }
                }

                return {
                    index,
                    name: cell.name,
                    appearance_file: cell.appearance_file,
                    floor_file: cell.floor_file,
                    portals: cell.portals,
                    bounds: getCellBounds(cell),
                    floorGeometry
                };
            });

            // Send POB data to webview
            this._panel.webview.postMessage({
                type: 'pobLoaded',
                pob: {
                    version: this._pobData.version,
                    cells: cellsWithFloors,
                    cellPositions: positionsArray,
                    cellConnections: connections
                }
            });

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to load POB file: ${error.message}`);
            this._panel.webview.postMessage({
                type: 'error',
                message: error.message
            });
        }
    }

    private _updateSpawnData(data: CellSpawnData[]): void {
        this._spawnData.clear();
        this._patrolPaths.clear();
        for (const cellData of data) {
            this._spawnData.set(cellData.cellIndex, cellData);
            if (cellData.patrolPaths) {
                this._patrolPaths.set(cellData.cellIndex, cellData.patrolPaths);
            }
        }
    }

    private _addSpawnPoint(cellIndex: number, spawn: SpawnPoint): void {
        let cellData = this._spawnData.get(cellIndex);
        if (!cellData) {
            cellData = {
                cellIndex,
                cellName: this._pobData?.cells[cellIndex]?.name || `cell${cellIndex}`,
                spawns: []
            };
            this._spawnData.set(cellIndex, cellData);
        }
        cellData.spawns.push(spawn);
    }

    private _removeSpawnPoint(cellIndex: number, spawnId: string): void {
        const cellData = this._spawnData.get(cellIndex);
        if (cellData) {
            cellData.spawns = cellData.spawns.filter(s => s.id !== spawnId);
        }
    }

    private _updateSpawnPoint(cellIndex: number, spawn: SpawnPoint): void {
        const cellData = this._spawnData.get(cellIndex);
        if (cellData) {
            const index = cellData.spawns.findIndex(s => s.id === spawn.id);
            if (index >= 0) {
                cellData.spawns[index] = spawn;
            }
        }
    }

    private _addPatrolPath(cellIndex: number, patrolPath: PatrolPath): void {
        let paths = this._patrolPaths.get(cellIndex);
        if (!paths) {
            paths = [];
            this._patrolPaths.set(cellIndex, paths);
        }
        paths.push(patrolPath);
    }

    private _removePatrolPath(cellIndex: number, pathId: string): void {
        const paths = this._patrolPaths.get(cellIndex);
        if (paths) {
            const idx = paths.findIndex(p => p.id === pathId);
            if (idx >= 0) { paths.splice(idx, 1); }
        }
        // Clear patrolPathId from any spawn that referenced this path
        const cellData = this._spawnData.get(cellIndex);
        if (cellData) {
            for (const spawn of cellData.spawns) {
                if (spawn.patrolPathId === pathId) {
                    spawn.patrolPathId = undefined;
                }
            }
        }
    }

    private _updatePatrolPath(cellIndex: number, patrolPath: PatrolPath): void {
        const paths = this._patrolPaths.get(cellIndex);
        if (paths) {
            const idx = paths.findIndex(p => p.id === patrolPath.id);
            if (idx >= 0) { paths[idx] = patrolPath; }
        }
    }

    private _addPatrolWaypoint(cellIndex: number, pathId: string, waypoint: PatrolWaypoint): void {
        const paths = this._patrolPaths.get(cellIndex);
        if (paths) {
            const p = paths.find(pp => pp.id === pathId);
            if (p) { p.waypoints.push(waypoint); }
        }
    }

    private _removePatrolWaypoint(cellIndex: number, pathId: string, waypointId: string): void {
        const paths = this._patrolPaths.get(cellIndex);
        if (paths) {
            const p = paths.find(pp => pp.id === pathId);
            if (p) { p.waypoints = p.waypoints.filter(w => w.id !== waypointId); }
        }
    }

    private async _exportScreenplay(): Promise<void> {
        if (!this._screenplayName) {
            vscode.window.showErrorMessage('Please enter a screenplay name first');
            return;
        }

        if (!this._pobData) {
            vscode.window.showErrorMessage('No POB file loaded');
            return;
        }

        const config = vscode.workspace.getConfiguration('swgForge');
        const scriptsPath = config.get<string>('serverScriptsPath', 'infinity4.0.0/MMOCoreORB/bin/scripts');
        const customScriptsFolder = config.get<string>('customScriptsFolder', 'custom_scripts');

        const screenplayDir = path.join(this._workspaceRoot, scriptsPath, customScriptsFolder, 'screenplays/caves');
        const screenplayPath = path.join(screenplayDir, `${this._screenplayName}.lua`);

        // Check if file already exists
        if (fs.existsSync(screenplayPath)) {
            const overwrite = await vscode.window.showWarningMessage(
                `Screenplay ${this._screenplayName}.lua already exists. Overwrite?`,
                'Yes', 'No'
            );
            if (overwrite !== 'Yes') {
                return;
            }
        }

        // Generate Lua screenplay
        const luaContent = this._generateScreenplay();

        // Ensure directory exists
        if (!fs.existsSync(screenplayDir)) {
            fs.mkdirSync(screenplayDir, { recursive: true });
        }

        // Write file
        fs.writeFileSync(screenplayPath, luaContent, 'utf-8');

        vscode.window.showInformationMessage(`Screenplay created: ${screenplayPath}`);

        // Open the file
        const doc = await vscode.workspace.openTextDocument(screenplayPath);
        await vscode.window.showTextDocument(doc);
    }

    private _hasPatrolPaths(): boolean {
        for (const [, paths] of this._patrolPaths) {
            if (paths.length > 0) { return true; }
        }
        return false;
    }

    private _generateScreenplay(): string {
        const name = this._screenplayName;
        const lines: string[] = [];
        const hasPatrols = this._hasPatrolPaths();

        lines.push(`-- ${name} Screenplay`);
        lines.push(`-- Generated by Building NPC Planner\n`);
        lines.push(`${name} = ScreenPlay:new {`);
        lines.push(`\tspawnPoints = {`);

        // Generate spawn arrays per cell
        for (const [cellIndex, cellData] of this._spawnData) {
            if (cellData.spawns.length === 0) continue;

            lines.push(`\t\t-- ${cellData.cellName} (Cell ${cellIndex})`);
            lines.push(`\t\t[${cellIndex}] = {`);

            for (const spawn of cellData.spawns) {
                lines.push(`\t\t\t{`);
                lines.push(`\t\t\t\ttemplate = "${spawn.mobileTemplate}",`);
                lines.push(`\t\t\t\tx = ${spawn.x.toFixed(2)},`);
                lines.push(`\t\t\t\tz = ${spawn.z.toFixed(2)},`);
                lines.push(`\t\t\t\ty = ${spawn.y.toFixed(2)},`);
                lines.push(`\t\t\t\theading = ${spawn.heading},`);
                lines.push(`\t\t\t\tcellIndex = ${cellIndex},`);
                lines.push(`\t\t\t\ttier = ${spawn.tier},`);
                if (spawn.patrolPathId) {
                    // Find path name
                    const paths = this._patrolPaths.get(cellIndex) || [];
                    const pp = paths.find(p => p.id === spawn.patrolPathId);
                    if (pp) {
                        lines.push(`\t\t\t\tpatrolPath = "${pp.name}",`);
                    }
                }
                lines.push(`\t\t\t},`);
            }

            lines.push(`\t\t},`);
        }

        lines.push(`\t},`);

        // Generate patrol path data if any paths exist
        if (hasPatrols) {
            lines.push(`\tpatrolPaths = {`);
            for (const [cellIndex, paths] of this._patrolPaths) {
                if (paths.length === 0) continue;
                lines.push(`\t\t[${cellIndex}] = {`);
                for (const pp of paths) {
                    if (pp.waypoints.length === 0) continue;
                    lines.push(`\t\t\t["${pp.name}"] = {`);
                    lines.push(`\t\t\t\tmode = "${pp.mode}",`);
                    lines.push(`\t\t\t\twaypoints = {`);
                    for (const wp of pp.waypoints) {
                        lines.push(`\t\t\t\t\t{x = ${wp.x.toFixed(2)}, z = ${wp.z.toFixed(2)}, y = ${wp.y.toFixed(2)}, waitTime = ${wp.waitTime}},`);
                    }
                    lines.push(`\t\t\t\t},`);
                    lines.push(`\t\t\t},`);
                }
                lines.push(`\t\t},`);
            }
            lines.push(`\t},`);
        }

        lines.push(`}\n`);

        lines.push(`registerScreenPlay("${name}", true)\n`);

        // start()
        lines.push(`function ${name}:start()`);
        lines.push(`\tif (not isZoneEnabled("${name}")) then`);
        lines.push(`\t\treturn`);
        lines.push(`\tend\n`);
        lines.push(`\tself:spawnMobiles()`);
        lines.push(`end\n`);

        // spawnMobiles()
        lines.push(`function ${name}:spawnMobiles()`);
        lines.push(`\tlocal pSceneObject = getSceneObject(self.buildingId)`);
        lines.push(`\tif (pSceneObject == nil) then`);
        lines.push(`\t\treturn`);
        lines.push(`\tend\n`);
        lines.push(`\tfor cellIndex, spawns in pairs(self.spawnPoints) do`);
        lines.push(`\t\tfor i, spawn in ipairs(spawns) do`);
        lines.push(`\t\t\tlocal pCell = getCell(pSceneObject, cellIndex)`);
        lines.push(`\t\t\tif (pCell ~= nil) then`);
        lines.push(`\t\t\t\tlocal pMobile = spawnMobile("zone", spawn.template, 0, spawn.x, spawn.z, spawn.y, spawn.heading, pCell)`);
        lines.push(`\t\t\t\tif (pMobile ~= nil) then`);
        lines.push(`\t\t\t\t\tcreateObserver(OBJECTDESTRUCTION, "${name}", "notifyMobileDead", pMobile)`);
        if (hasPatrols) {
            lines.push(`\t\t\t\t\tif (spawn.patrolPath ~= nil) then`);
            lines.push(`\t\t\t\t\t\tself:setupPatrol(pMobile, cellIndex, spawn.patrolPath)`);
            lines.push(`\t\t\t\t\tend`);
        }
        lines.push(`\t\t\t\tend`);
        lines.push(`\t\t\tend`);
        lines.push(`\t\tend`);
        lines.push(`\tend`);
        lines.push(`end\n`);

        // notifyMobileDead()
        lines.push(`function ${name}:notifyMobileDead(pMobile, pKiller)`);
        lines.push(`\tif (pMobile == nil) then`);
        lines.push(`\t\treturn 1`);
        lines.push(`\tend\n`);
        lines.push(`\tlocal cellId = SceneObject(pMobile):getParentID()`);
        lines.push(`\tlocal x = SceneObject(pMobile):getPositionX()`);
        lines.push(`\tlocal z = SceneObject(pMobile):getPositionZ()`);
        lines.push(`\tlocal y = SceneObject(pMobile):getPositionY()`);
        lines.push(`\tlocal heading = SceneObject(pMobile):getDirectionAngle()`);
        lines.push(`\tlocal template = SceneObject(pMobile):getObjectName()\n`);
        if (hasPatrols) {
            lines.push(`\tlocal patrolPath = readStringData(SceneObject(pMobile):getObjectID() .. ":patrolPath")`);
            lines.push(`\tlocal cellIndex = readData(SceneObject(pMobile):getObjectID() .. ":patrolCellIndex")\n`);
            lines.push(`\t-- 5 minute respawn timer`);
            lines.push(`\tcreateEvent(300000, "${name}", "respawnMobile", pMobile, template .. ":" .. cellId .. ":" .. x .. ":" .. z .. ":" .. y .. ":" .. heading .. ":" .. cellIndex .. ":" .. patrolPath)`);
        } else {
            lines.push(`\t-- 5 minute respawn timer`);
            lines.push(`\tcreateEvent(300000, "${name}", "respawnMobile", pMobile, template .. ":" .. cellId .. ":" .. x .. ":" .. z .. ":" .. y .. ":" .. heading)`);
        }
        lines.push(`\treturn 0`);
        lines.push(`end\n`);

        // respawnMobile()
        lines.push(`function ${name}:respawnMobile(pSceneObject, args)`);
        lines.push(`\tlocal parts = {}`);
        lines.push(`\tfor part in string.gmatch(args, "[^:]+") do`);
        lines.push(`\t\ttable.insert(parts, part)`);
        lines.push(`\tend\n`);
        lines.push(`\tlocal template = parts[1]`);
        lines.push(`\tlocal cellId = tonumber(parts[2])`);
        lines.push(`\tlocal x = tonumber(parts[3])`);
        lines.push(`\tlocal z = tonumber(parts[4])`);
        lines.push(`\tlocal y = tonumber(parts[5])`);
        lines.push(`\tlocal heading = tonumber(parts[6])\n`);
        if (hasPatrols) {
            lines.push(`\tlocal cellIndex = tonumber(parts[7]) or 0`);
            lines.push(`\tlocal patrolPath = parts[8] or ""\n`);
        }
        lines.push(`\tlocal pCell = getSceneObject(cellId)`);
        lines.push(`\tif (pCell ~= nil) then`);
        lines.push(`\t\tlocal pMobile = spawnMobile("zone", template, 0, x, z, y, heading, pCell)`);
        lines.push(`\t\tif (pMobile ~= nil) then`);
        lines.push(`\t\t\tcreateObserver(OBJECTDESTRUCTION, "${name}", "notifyMobileDead", pMobile)`);
        if (hasPatrols) {
            lines.push(`\t\t\tif (patrolPath ~= nil and patrolPath ~= "") then`);
            lines.push(`\t\t\t\tself:setupPatrol(pMobile, cellIndex, patrolPath)`);
            lines.push(`\t\t\tend`);
        }
        lines.push(`\t\tend`);
        lines.push(`\tend`);
        lines.push(`\treturn 0`);
        lines.push(`end`);

        // Patrol functions (only if patrol paths exist)
        if (hasPatrols) {
            lines.push('');
            lines.push(`-- ============================================================`);
            lines.push(`-- Patrol System`);
            lines.push(`-- ============================================================\n`);

            // setupPatrol()
            lines.push(`function ${name}:setupPatrol(pMobile, cellIndex, pathName)`);
            lines.push(`\tif (pMobile == nil) then`);
            lines.push(`\t\treturn`);
            lines.push(`\tend\n`);
            lines.push(`\tlocal pathData = self.patrolPaths[cellIndex]`);
            lines.push(`\tif (pathData == nil) then`);
            lines.push(`\t\treturn`);
            lines.push(`\tend\n`);
            lines.push(`\tlocal path = pathData[pathName]`);
            lines.push(`\tif (path == nil or #path.waypoints == 0) then`);
            lines.push(`\t\treturn`);
            lines.push(`\tend\n`);
            lines.push(`\tlocal oid = SceneObject(pMobile):getObjectID()`);
            lines.push(`\twriteStringData(oid .. ":patrolPath", pathName)`);
            lines.push(`\twriteData(oid .. ":patrolCellIndex", cellIndex)`);
            lines.push(`\twriteData(oid .. ":patrolWpIndex", 1)`);
            lines.push(`\twriteStringData(oid .. ":patrolMode", path.mode)\n`);
            lines.push(`\t-- Store waypoint count for bounds checking`);
            lines.push(`\twriteData(oid .. ":patrolWpCount", #path.waypoints)`);
            lines.push(`\twriteData(oid .. ":patrolDirection", 1) -- 1=forward, -1=reverse (for pingpong)\n`);
            lines.push(`\t-- Start patrol after a short random delay`);
            lines.push(`\tlocal startDelay = getRandomNumber(3, 10) * 1000`);
            lines.push(`\tcreateEvent(startDelay, "${name}", "doPatrolStep", pMobile, "")`);
            lines.push(`\tcreateObserver(STARTCOMBAT, "${name}", "onPatrolCombat", pMobile)`);
            lines.push(`end\n`);

            // doPatrolStep()
            lines.push(`function ${name}:doPatrolStep(pMobile)`);
            lines.push(`\tif (pMobile == nil) then`);
            lines.push(`\t\treturn`);
            lines.push(`\tend\n`);
            lines.push(`\tif (CreatureObject(pMobile):isDead()) then`);
            lines.push(`\t\treturn`);
            lines.push(`\tend\n`);
            lines.push(`\tif (CreatureObject(pMobile):isInCombat()) then`);
            lines.push(`\t\treturn`);
            lines.push(`\tend\n`);
            lines.push(`\tlocal oid = SceneObject(pMobile):getObjectID()`);
            lines.push(`\tlocal pathName = readStringData(oid .. ":patrolPath")`);
            lines.push(`\tlocal cellIndex = readData(oid .. ":patrolCellIndex")`);
            lines.push(`\tlocal wpIndex = readData(oid .. ":patrolWpIndex")`);
            lines.push(`\tlocal wpCount = readData(oid .. ":patrolWpCount")\n`);
            lines.push(`\tif (pathName == "" or wpCount == 0) then`);
            lines.push(`\t\treturn`);
            lines.push(`\tend\n`);
            lines.push(`\tlocal pathData = self.patrolPaths[cellIndex]`);
            lines.push(`\tif (pathData == nil) then`);
            lines.push(`\t\treturn`);
            lines.push(`\tend\n`);
            lines.push(`\tlocal path = pathData[pathName]`);
            lines.push(`\tif (path == nil) then`);
            lines.push(`\t\treturn`);
            lines.push(`\tend\n`);
            lines.push(`\tlocal wp = path.waypoints[wpIndex]`);
            lines.push(`\tif (wp == nil) then`);
            lines.push(`\t\treturn`);
            lines.push(`\tend\n`);
            lines.push(`\t-- Move to waypoint`);
            lines.push(`\tlocal cellId = SceneObject(pMobile):getParentID()`);
            lines.push(`\tAiAgent(pMobile):setAiTemplate("walkPatrol")`);
            lines.push(`\tAiAgent(pMobile):setFollowState(4)`);
            lines.push(`\tAiAgent(pMobile):stopWaiting()`);
            lines.push(`\tAiAgent(pMobile):setWait(0)`);
            lines.push(`\tAiAgent(pMobile):setNextPosition(wp.x, wp.z, wp.y, cellId)`);
            lines.push(`\tAiAgent(pMobile):executeBehavior()\n`);
            lines.push(`\t-- Advance waypoint index`);
            lines.push(`\tlocal mode = readStringData(oid .. ":patrolMode")`);
            lines.push(`\tlocal direction = readData(oid .. ":patrolDirection")\n`);
            lines.push(`\tif (mode == "pingpong") then`);
            lines.push(`\t\tlocal nextWp = wpIndex + direction`);
            lines.push(`\t\tif (nextWp > wpCount) then`);
            lines.push(`\t\t\tdirection = -1`);
            lines.push(`\t\t\tnextWp = wpIndex + direction`);
            lines.push(`\t\t\twriteData(oid .. ":patrolDirection", direction)`);
            lines.push(`\t\telseif (nextWp < 1) then`);
            lines.push(`\t\t\tdirection = 1`);
            lines.push(`\t\t\tnextWp = wpIndex + direction`);
            lines.push(`\t\t\twriteData(oid .. ":patrolDirection", direction)`);
            lines.push(`\t\tend`);
            lines.push(`\t\twriteData(oid .. ":patrolWpIndex", nextWp)`);
            lines.push(`\telse`);
            lines.push(`\t\t-- loop mode`);
            lines.push(`\t\tlocal nextWp = wpIndex + 1`);
            lines.push(`\t\tif (nextWp > wpCount) then`);
            lines.push(`\t\t\tnextWp = 1`);
            lines.push(`\t\tend`);
            lines.push(`\t\twriteData(oid .. ":patrolWpIndex", nextWp)`);
            lines.push(`\tend\n`);
            lines.push(`\t-- Schedule next step (wait at waypoint + travel time estimate)`);
            lines.push(`\tlocal waitMs = (wp.waitTime or 0) * 1000`);
            lines.push(`\tlocal travelMs = 3000 -- base travel time estimate`);
            lines.push(`\tcreateEvent(waitMs + travelMs, "${name}", "doPatrolStep", pMobile, "")`);
            lines.push(`end\n`);

            // onPatrolCombat()
            lines.push(`function ${name}:onPatrolCombat(pMobile, pAttacker)`);
            lines.push(`\tif (pMobile == nil) then`);
            lines.push(`\t\treturn 1`);
            lines.push(`\tend\n`);
            lines.push(`\t-- Combat will naturally interrupt the patrol.`);
            lines.push(`\t-- After combat ends, restart patrol with a delay.`);
            lines.push(`\tcreateObserver(DEFENDERREMOVED, "${name}", "onPatrolCombatEnd", pMobile)`);
            lines.push(`\treturn 0`);
            lines.push(`end\n`);

            // onPatrolCombatEnd()
            lines.push(`function ${name}:onPatrolCombatEnd(pMobile, pDefender)`);
            lines.push(`\tif (pMobile == nil) then`);
            lines.push(`\t\treturn 1`);
            lines.push(`\tend\n`);
            lines.push(`\tif (CreatureObject(pMobile):isDead()) then`);
            lines.push(`\t\treturn 1`);
            lines.push(`\tend\n`);
            lines.push(`\tif (not CreatureObject(pMobile):isInCombat()) then`);
            lines.push(`\t\t-- Resume patrol after 10 seconds`);
            lines.push(`\t\tcreateEvent(10000, "${name}", "doPatrolStep", pMobile, "")`);
            lines.push(`\t\treturn 1`);
            lines.push(`\tend\n`);
            lines.push(`\treturn 0`);
            lines.push(`end`);
        }

        return lines.join('\n');
    }

    private _getHtml(): string {
        const lines = [
            '<!DOCTYPE html>',
            '<html lang="en">',
            '<head>',
            '    <meta charset="UTF-8">',
            '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
            '    <title>Building NPC Planner</title>',
            '    <style>',
            '        body { font-family: var(--vscode-font-family); padding: 10px; margin: 0; }',
            '        .container { display: flex; flex-direction: column; gap: 12px; }',
            '        .section { border: 1px solid var(--vscode-panel-border); padding: 10px; }',
            '        .section-title { font-weight: bold; margin-bottom: 8px; }',
            '        select, input, button { padding: 4px 6px; margin: 2px 0; }',
            '        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }',
            '        button:hover { background: var(--vscode-button-hoverBackground); }',
            '        .cell-list { list-style: none; padding: 0; max-height: 200px; overflow-y: auto; }',
            '        .cell-item { padding: 6px 8px; margin: 1px 0; cursor: pointer; border: 1px solid transparent; font-size: 12px; }',
            '        .cell-item:hover { background: var(--vscode-list-hoverBackground); }',
            '        .cell-item.selected { background: var(--vscode-list-activeSelectionBackground); border-color: var(--vscode-focusBorder); }',
            '        .canvas-container { position: relative; border: 1px solid var(--vscode-panel-border); }',
            '        canvas { cursor: crosshair; background: #1e1e1e; }',
            '        .spawn-list { list-style: none; padding: 0; }',
            '        .spawn-item { padding: 4px 6px; margin: 1px 0; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--vscode-panel-border); font-size: 12px; }',
            '        .error { color: var(--vscode-errorForeground); }',
            '        .success { color: var(--vscode-testing-iconPassed); }',
            '        .brush-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
            '        .brush-table td { padding: 3px 4px; vertical-align: middle; }',
            '        .brush-table input[type="text"] { width: 100%; box-sizing: border-box; }',
            '        .brush-table input[type="number"] { width: 60px; }',
            '        .brush-color { width: 14px; height: 14px; border-radius: 50%; display: inline-block; border: 2px solid transparent; }',
            '        .brush-row { cursor: pointer; }',
            '        .brush-row:hover { background: var(--vscode-list-hoverBackground); }',
            '        .brush-row.active { background: var(--vscode-list-activeSelectionBackground); }',
            '        .brush-row.active .brush-color { border-color: #fff; }',
            '        .dims-label { font-size: 10px; color: var(--vscode-descriptionForeground); }',
            // Mode toggle styles
            '        .mode-toggle { display: flex; gap: 4px; margin-bottom: 8px; }',
            '        .mode-btn { padding: 6px 14px; font-size: 12px; border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); cursor: pointer; }',
            '        .mode-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }',
            // Patrol path list styles
            '        .path-list { list-style: none; padding: 0; }',
            '        .path-item { padding: 6px 8px; margin: 2px 0; border: 1px solid var(--vscode-panel-border); font-size: 12px; cursor: pointer; }',
            '        .path-item:hover { background: var(--vscode-list-hoverBackground); }',
            '        .path-item.active { background: var(--vscode-list-activeSelectionBackground); border-color: var(--vscode-focusBorder); }',
            '        .path-item-header { display: flex; justify-content: space-between; align-items: center; }',
            '        .path-item-details { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 11px; }',
            '        .path-item-details label { color: var(--vscode-descriptionForeground); }',
            '        .path-item-details select, .path-item-details input { font-size: 11px; padding: 2px 4px; }',
            '        .path-dot { width: 12px; height: 12px; display: inline-block; margin-right: 6px; }',
            '    </style>',
            '</head>',
            '<body>',
            '    <div class="container">',
            '        <div class="section">',
            '            <div class="section-title">1. Load POB Building</div>',
            '            <select id="pobSelect" style="width: 100%;"><option value="">-- Select POB file --</option></select>',
            '        </div>',
            '',
            '        <div class="section">',
            '            <div class="section-title">2. Screenplay Name</div>',
            '            <input type="text" id="screenplayName" placeholder="e.g., my_cave_dungeon" style="width: 100%;" />',
            '        </div>',
            '',
            '        <div class="section" id="stickDiagramSection" style="display: none;">',
            '            <div class="section-title">3. Building Layout</div>',
            '            <div class="canvas-container">',
            '                <canvas id="stickCanvas" width="600" height="400"></canvas>',
            '            </div>',
            '            <div class="dims-label" style="margin-top: 4px;">Click a cell node to select it. Cyan = selected.</div>',
            '        </div>',
            '',
            '        <div class="section">',
            '            <div class="section-title">4. Select Cell</div>',
            '            <ul id="cellList" class="cell-list"></ul>',
            '        </div>',
            '',
            '        <div class="section" id="brushSection" style="display: none;">',
            '            <div class="section-title">5. NPC Brushes</div>',
            '            <table class="brush-table" id="brushTable">',
            '                <tr style="font-weight:bold; font-size:11px; color:var(--vscode-descriptionForeground);">',
            '                    <td></td><td></td><td>Mobile Template</td><td>Heading</td>',
            '                </tr>',
            '            </table>',
            '            <div class="dims-label" style="margin-top: 4px;">Select a brush, then click on the map to place. Right-click a spawn to delete it.</div>',
            '        </div>',
            '',
            '        <div class="section" id="canvasSection" style="display: none;">',
            // Mode toggle
            '            <div class="mode-toggle">',
            '                <button class="mode-btn active" id="modeSpawn" onclick="setMode(\'spawn\')">Spawn Mode</button>',
            '                <button class="mode-btn" id="modePath" onclick="setMode(\'path\')">Path Mode</button>',
            '            </div>',
            '            <div class="section-title">6. Cell Map <span id="cellDims" class="dims-label"></span></div>',
            '            <div class="canvas-container">',
            '                <canvas id="cellCanvas" width="600" height="600"></canvas>',
            '            </div>',
            // Spawn list (shown in spawn mode)
            '            <div id="spawnModePanel">',
            '                <div class="section-title" style="margin-top: 8px;">Spawn Points</div>',
            '                <ul id="spawnList" class="spawn-list"></ul>',
            '            </div>',
            // Path list (shown in path mode)
            '            <div id="pathModePanel" style="display: none;">',
            '                <div class="section-title" style="margin-top: 8px;">Patrol Paths <button id="addPathBtn" style="font-size:11px; padding:2px 8px; margin-left:8px;">+ New Path</button></div>',
            '                <div class="dims-label" style="margin-bottom: 6px;">Select a path, then click on the map to add waypoints. Right-click a waypoint to remove it.</div>',
            '                <ul id="pathList" class="path-list"></ul>',
            '            </div>',
            '        </div>',
            '',
            '        <div class="section">',
            '            <button id="exportBtn" disabled>Export Screenplay</button>',
            '            <div id="statusMessage"></div>',
            '        </div>',
            '    </div>',
            '',
            '    <script>',
            '        var vscode = acquireVsCodeApi();',
            '        var pobData = null;',
            '        var selectedCellIndex = null;',
            '        var spawns = new Map();',
            '        var canvas, ctx;',
            '        var activeBrush = 0;',
            '        var currentScale = 10;',
            '        var currentCenterX = 0;',
            '        var currentCenterZ = 0;',
            '        var currentMode = "spawn";',
            '',
            '        // Patrol path state',
            '        var patrolPaths = new Map();',
            '        var activePathId = null;',
            '        var PATH_COLORS = ["#00CCFF","#FF6600","#66FF33","#FF33CC","#FFCC00","#33FFCC","#CC66FF","#FF3366"];',
            '        var pathCounter = 0;',
            '',
            '        var BRUSH_COLORS = [',
            '            "#FF4444", "#4488FF", "#44CC44", "#FFDD44",',
            '            "#AA44FF", "#FF8844", "#44DDDD", "#FF44AA",',
            '            "#88DD44", "#44DDAA", "#DD44DD", "#FFD700"',
            '        ];',
            '',
            '        var brushes = [];',
            '        for (var bi = 0; bi < 12; bi++) {',
            '            brushes.push({ template: "", heading: 0 });',
            '        }',
            '',
            // ---- MODE TOGGLE ----
            '        function setMode(mode) {',
            '            currentMode = mode;',
            '            document.getElementById("modeSpawn").classList.toggle("active", mode === "spawn");',
            '            document.getElementById("modePath").classList.toggle("active", mode === "path");',
            '            document.getElementById("spawnModePanel").style.display = mode === "spawn" ? "block" : "none";',
            '            document.getElementById("pathModePanel").style.display = mode === "path" ? "block" : "none";',
            '            if (canvas) canvas.style.cursor = mode === "path" ? "copy" : "crosshair";',
            '            renderCanvas();',
            '        }',
            '',
            // ---- PATROL PATH FUNCTIONS ----
            '        function getCellPaths() {',
            '            return patrolPaths.get(selectedCellIndex) || [];',
            '        }',
            '',
            '        function getActivePath() {',
            '            var paths = getCellPaths();',
            '            for (var i = 0; i < paths.length; i++) {',
            '                if (paths[i].id === activePathId) return paths[i];',
            '            }',
            '            return null;',
            '        }',
            '',
            '        function createNewPath() {',
            '            if (selectedCellIndex === null) return;',
            '            pathCounter++;',
            '            var colorIdx = (getCellPaths().length) % PATH_COLORS.length;',
            '            var newPath = {',
            '                id: "path_" + Date.now(),',
            '                name: "patrol_" + pathCounter,',
            '                cellIndex: selectedCellIndex,',
            '                waypoints: [],',
            '                mode: "loop",',
            '                color: PATH_COLORS[colorIdx]',
            '            };',
            '            if (!patrolPaths.has(selectedCellIndex)) patrolPaths.set(selectedCellIndex, []);',
            '            patrolPaths.get(selectedCellIndex).push(newPath);',
            '            activePathId = newPath.id;',
            '            vscode.postMessage({ type: "addPatrolPath", cellIndex: selectedCellIndex, path: newPath });',
            '            renderPathList();',
            '            renderCanvas();',
            '        }',
            '',
            '        function selectPath(pathId) {',
            '            activePathId = pathId;',
            '            renderPathList();',
            '            renderCanvas();',
            '        }',
            '',
            '        function deletePath(pathId) {',
            '            var paths = getCellPaths();',
            '            for (var i = 0; i < paths.length; i++) {',
            '                if (paths[i].id === pathId) {',
            '                    paths.splice(i, 1);',
            '                    break;',
            '                }',
            '            }',
            '            // Unlink spawns that referenced this path',
            '            var cellSpawns = spawns.get(selectedCellIndex) || [];',
            '            for (var si = 0; si < cellSpawns.length; si++) {',
            '                if (cellSpawns[si].patrolPathId === pathId) {',
            '                    cellSpawns[si].patrolPathId = undefined;',
            '                }',
            '            }',
            '            if (activePathId === pathId) activePathId = null;',
            '            vscode.postMessage({ type: "removePatrolPath", cellIndex: selectedCellIndex, pathId: pathId });',
            '            renderPathList();',
            '            renderSpawnList();',
            '            renderCanvas();',
            '        }',
            '',
            '        function updatePathProp(pathId, prop, value) {',
            '            var paths = getCellPaths();',
            '            for (var i = 0; i < paths.length; i++) {',
            '                if (paths[i].id === pathId) {',
            '                    paths[i][prop] = value;',
            '                    vscode.postMessage({ type: "updatePatrolPath", cellIndex: selectedCellIndex, path: paths[i] });',
            '                    break;',
            '                }',
            '            }',
            '            if (prop === "name") renderSpawnList();',
            '            renderCanvas();',
            '        }',
            '',
            '        function renderPathList() {',
            '            var list = document.getElementById("pathList");',
            '            list.innerHTML = "";',
            '            var paths = getCellPaths();',
            '            for (var pi = 0; pi < paths.length; pi++) {',
            '                var pp = paths[pi];',
            '                var li = document.createElement("li");',
            '                li.className = "path-item" + (pp.id === activePathId ? " active" : "");',
            '',
            '                var header = document.createElement("div");',
            '                header.className = "path-item-header";',
            '',
            '                var leftSpan = document.createElement("span");',
            '                var dot = document.createElement("span");',
            '                dot.className = "path-dot";',
            '                dot.style.backgroundColor = pp.color;',
            '                dot.style.display = "inline-block";',
            '                dot.style.width = "12px";',
            '                dot.style.height = "12px";',
            '                dot.style.marginRight = "6px";',
            '                leftSpan.appendChild(dot);',
            '                leftSpan.appendChild(document.createTextNode(pp.name + " (" + pp.waypoints.length + " pts)"));',
            '',
            '                var delBtn = document.createElement("button");',
            '                delBtn.textContent = "X";',
            '                delBtn.style.padding = "1px 6px";',
            '                delBtn.style.fontSize = "11px";',
            '',
            '                header.appendChild(leftSpan);',
            '                header.appendChild(delBtn);',
            '                li.appendChild(header);',
            '',
            '                // Details row',
            '                var details = document.createElement("div");',
            '                details.className = "path-item-details";',
            '',
            '                var nameLabel = document.createElement("label");',
            '                nameLabel.textContent = "Name:";',
            '                var nameInp = document.createElement("input");',
            '                nameInp.type = "text";',
            '                nameInp.value = pp.name;',
            '                nameInp.style.width = "100px";',
            '',
            '                var modeLabel = document.createElement("label");',
            '                modeLabel.textContent = "Mode:";',
            '                var modeSelect = document.createElement("select");',
            '                var optLoop = document.createElement("option");',
            '                optLoop.value = "loop"; optLoop.textContent = "Loop";',
            '                if (pp.mode === "loop") optLoop.selected = true;',
            '                var optPP = document.createElement("option");',
            '                optPP.value = "pingpong"; optPP.textContent = "Ping-Pong";',
            '                if (pp.mode === "pingpong") optPP.selected = true;',
            '                modeSelect.appendChild(optLoop);',
            '                modeSelect.appendChild(optPP);',
            '',
            '                var waitLabel = document.createElement("label");',
            '                waitLabel.textContent = "Wait(s):";',
            '                var waitInp = document.createElement("input");',
            '                waitInp.type = "number";',
            '                waitInp.value = (pp.waypoints.length > 0 ? pp.waypoints[0].waitTime : 0).toString();',
            '                waitInp.min = "0";',
            '                waitInp.max = "300";',
            '                waitInp.style.width = "50px";',
            '',
            '                details.appendChild(nameLabel);',
            '                details.appendChild(nameInp);',
            '                details.appendChild(modeLabel);',
            '                details.appendChild(modeSelect);',
            '                details.appendChild(waitLabel);',
            '                details.appendChild(waitInp);',
            '                li.appendChild(details);',
            '',
            '                (function(pathObj, liEl, nameEl, modeEl, waitEl, delEl) {',
            '                    liEl.onclick = function(e) {',
            '                        if (e.target.tagName !== "INPUT" && e.target.tagName !== "SELECT" && e.target.tagName !== "BUTTON") {',
            '                            selectPath(pathObj.id);',
            '                        }',
            '                    };',
            '                    nameEl.oninput = function() { updatePathProp(pathObj.id, "name", nameEl.value); };',
            '                    modeEl.onchange = function() { updatePathProp(pathObj.id, "mode", modeEl.value); };',
            '                    waitEl.oninput = function() {',
            '                        var wt = parseInt(waitEl.value) || 0;',
            '                        for (var wi = 0; wi < pathObj.waypoints.length; wi++) {',
            '                            pathObj.waypoints[wi].waitTime = wt;',
            '                        }',
            '                        vscode.postMessage({ type: "updatePatrolPath", cellIndex: selectedCellIndex, path: pathObj });',
            '                    };',
            '                    delEl.onclick = function(e) { e.stopPropagation(); deletePath(pathObj.id); };',
            '                })(pp, li, nameInp, modeSelect, waitInp, delBtn);',
            '',
            '                list.appendChild(li);',
            '            }',
            '        }',
            '',
            '        function initBrushTable() {',
            '            var table = document.getElementById("brushTable");',
            '            for (var i = 0; i < 12; i++) {',
            '                var tr = document.createElement("tr");',
            '                tr.className = "brush-row" + (i === 0 ? " active" : "");',
            '                tr.setAttribute("data-brush", i.toString());',
            '',
            '                var tdRadio = document.createElement("td");',
            '                var radio = document.createElement("input");',
            '                radio.type = "radio";',
            '                radio.name = "brush";',
            '                radio.value = i.toString();',
            '                if (i === 0) radio.checked = true;',
            '                tdRadio.appendChild(radio);',
            '',
            '                var tdColor = document.createElement("td");',
            '                var dot = document.createElement("span");',
            '                dot.className = "brush-color";',
            '                dot.style.backgroundColor = BRUSH_COLORS[i];',
            '                tdColor.appendChild(dot);',
            '',
            '                var tdTemplate = document.createElement("td");',
            '                var inp = document.createElement("input");',
            '                inp.type = "text";',
            '                inp.placeholder = "e.g., stormtrooper";',
            '                inp.setAttribute("data-brush-tpl", i.toString());',
            '                tdTemplate.appendChild(inp);',
            '',
            '                var tdHeading = document.createElement("td");',
            '                var headInp = document.createElement("input");',
            '                headInp.type = "number";',
            '                headInp.value = "0";',
            '                headInp.min = "-180";',
            '                headInp.max = "180";',
            '                headInp.setAttribute("data-brush-head", i.toString());',
            '                tdHeading.appendChild(headInp);',
            '',
            '                tr.appendChild(tdRadio);',
            '                tr.appendChild(tdColor);',
            '                tr.appendChild(tdTemplate);',
            '                tr.appendChild(tdHeading);',
            '                table.appendChild(tr);',
            '',
            '                (function(idx, radioEl, tplInp, headEl, row) {',
            '                    radioEl.onchange = function() { selectBrush(idx); };',
            '                    row.onclick = function(e) {',
            '                        if (e.target.tagName !== "INPUT") { radioEl.checked = true; selectBrush(idx); }',
            '                    };',
            '                    tplInp.oninput = function() { brushes[idx].template = tplInp.value; };',
            '                    headEl.oninput = function() { brushes[idx].heading = parseInt(headEl.value) || 0; };',
            '                })(i, radio, inp, headInp, tr);',
            '            }',
            '        }',
            '',
            '        function selectBrush(idx) {',
            '            activeBrush = idx;',
            '            var rows = document.querySelectorAll(".brush-row");',
            '            for (var r = 0; r < rows.length; r++) {',
            '                rows[r].classList.toggle("active", parseInt(rows[r].getAttribute("data-brush")) === idx);',
            '            }',
            '        }',
            '',
            '        initBrushTable();',
            '',
            '        document.getElementById("addPathBtn").onclick = function() { createNewPath(); };',
            '',
            '        window.addEventListener("message", function(event) {',
            '            var message = event.data;',
            '            switch (message.type) {',
            '                case "pobFileList": populatePobSelect(message.files); break;',
            '                case "pobLoaded": handlePobLoaded(message.pob); break;',
            '                case "error": showStatus(message.message, "error"); break;',
            '            }',
            '        });',
            '',
            '        function populatePobSelect(files) {',
            '            var select = document.getElementById("pobSelect");',
            '            for (var fi = 0; fi < files.length; fi++) {',
            '                var option = document.createElement("option");',
            '                option.value = files[fi];',
            '                option.textContent = files[fi];',
            '                select.appendChild(option);',
            '            }',
            '        }',
            '',
            '        function handlePobLoaded(pob) {',
            '            pobData = pob;',
            '            spawns.clear();',
            '            patrolPaths.clear();',
            '            pathCounter = 0;',
            '            activePathId = null;',
            '            renderCellList();',
            '            if (pob.cellPositions && pob.cellConnections) {',
            '                document.getElementById("stickDiagramSection").style.display = "block";',
            '                renderStickDiagram();',
            '            }',
            '            document.getElementById("brushSection").style.display = "block";',
            '            showStatus("POB loaded: " + pob.cells.length + " cells", "success");',
            '            document.getElementById("exportBtn").disabled = false;',
            '        }',
            '',
            '        function renderCellList() {',
            '            var list = document.getElementById("cellList");',
            '            list.innerHTML = "";',
            '            for (var ci = 0; ci < pobData.cells.length; ci++) {',
            '                var li = document.createElement("li");',
            '                li.className = "cell-item";',
            '                li.textContent = "Cell " + ci + ": " + pobData.cells[ci].name;',
            '                li.setAttribute("data-cell", ci.toString());',
            '                (function(idx) { li.onclick = function() { selectCell(idx); }; })(ci);',
            '                list.appendChild(li);',
            '            }',
            '        }',
            '',
            '        function selectCell(index) {',
            '            selectedCellIndex = index;',
            '            activePathId = null;',
            '            var items = document.querySelectorAll(".cell-item");',
            '            for (var ii = 0; ii < items.length; ii++) {',
            '                items[ii].classList.toggle("selected", parseInt(items[ii].getAttribute("data-cell")) === index);',
            '            }',
            '            document.getElementById("canvasSection").style.display = "block";',
            '            renderCanvas();',
            '            renderPathList();',
            '            renderStickDiagram();',
            '        }',
            '',
            // ---- STICK DIAGRAM ----
            '        function renderStickDiagram() {',
            '            var stickCanvas = document.getElementById("stickCanvas");',
            '            if (!stickCanvas) return;',
            '            var stickCtx = stickCanvas.getContext("2d");',
            '            var cellPositions = pobData.cellPositions;',
            '            var cellConnections = pobData.cellConnections;',
            '            stickCtx.clearRect(0, 0, stickCanvas.width, stickCanvas.height);',
            '            stickCtx.fillStyle = "#1e1e1e";',
            '            stickCtx.fillRect(0, 0, stickCanvas.width, stickCanvas.height);',
            '            if (!cellPositions || cellPositions.length === 0) return;',
            '            var minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity, minZ=Infinity, maxZ=-Infinity;',
            '            for (var si=0; si<cellPositions.length; si++) {',
            '                var p=cellPositions[si];',
            '                if(p.x<minX)minX=p.x; if(p.x>maxX)maxX=p.x;',
            '                if(p.y<minY)minY=p.y; if(p.y>maxY)maxY=p.y;',
            '                if(p.z<minZ)minZ=p.z; if(p.z>maxZ)maxZ=p.z;',
            '            }',
            '            var rangeX=maxX-minX||1, rangeY=maxY-minY||1, rangeZ=maxZ-minZ||1;',
            '            var maxRange=Math.max(rangeX,rangeY,rangeZ);',
            '            function proj(x,y,z) {',
            '                var sc=250/maxRange;',
            '                var ix=(x-minX)*sc-(y-minY)*sc;',
            '                var iy=(x-minX)*sc*0.5+(y-minY)*sc*0.5-(z-minZ)*sc;',
            '                return { sx:300+ix, sy:200-iy };',
            '            }',
            '            if (cellConnections) {',
            '                var drawn={};',
            '                for (var ei=0; ei<cellConnections.length; ei++) {',
            '                    var c=cellConnections[ei];',
            '                    var ek=Math.min(c.from,c.to)+"_"+Math.max(c.from,c.to);',
            '                    if(drawn[ek]) continue; drawn[ek]=true;',
            '                    var fp=null,tp=null;',
            '                    for(var fi=0;fi<cellPositions.length;fi++){if(cellPositions[fi].cellIndex===c.from)fp=cellPositions[fi];if(cellPositions[fi].cellIndex===c.to)tp=cellPositions[fi];}',
            '                    if(fp&&tp){',
            '                        var f2=proj(fp.x,fp.y,fp.z),t2=proj(tp.x,tp.y,tp.z);',
            '                        stickCtx.strokeStyle="#555";stickCtx.lineWidth=2;stickCtx.beginPath();stickCtx.moveTo(f2.sx,f2.sy);stickCtx.lineTo(t2.sx,t2.sy);stickCtx.stroke();',
            '                    }',
            '                }',
            '            }',
            '            var clickRegs=[];',
            '            for(var ni=0;ni<cellPositions.length;ni++){',
            '                var pos=cellPositions[ni];',
            '                var pp=proj(pos.x,pos.y,pos.z);',
            '                var sel=pos.cellIndex===selectedCellIndex;',
            '                stickCtx.fillStyle=sel?"#00FFFF":"#888";',
            '                stickCtx.strokeStyle=sel?"#00FFFF":"#AAA";',
            '                stickCtx.lineWidth=sel?3:2;',
            '                stickCtx.beginPath();stickCtx.arc(pp.sx,pp.sy,sel?8:6,0,Math.PI*2);stickCtx.fill();stickCtx.stroke();',
            '                stickCtx.fillStyle=sel?"#00FFFF":"#AAA";stickCtx.font="11px monospace";',
            '                stickCtx.fillText(pos.cellIndex+": "+pos.cellName,pp.sx+12,pp.sy+4);',
            '                clickRegs.push({ci:pos.cellIndex,x:pp.sx,y:pp.sy});',
            '            }',
            '            stickCanvas.onclick=function(ev){',
            '                var r=stickCanvas.getBoundingClientRect(),cx=ev.clientX-r.left,cy=ev.clientY-r.top;',
            '                for(var ri=0;ri<clickRegs.length;ri++){',
            '                    var d=Math.sqrt(Math.pow(cx-clickRegs[ri].x,2)+Math.pow(cy-clickRegs[ri].y,2));',
            '                    if(d<=12){selectCell(clickRegs[ri].ci);return;}',
            '                }',
            '            };',
            '            stickCanvas.style.cursor="pointer";',
            '        }',
            '',
            // ---- CANVAS COORDINATE HELPERS (hoisted for reuse) ----
            '        var toCanvasFn = null;',
            '        var toWorldFn = null;',
            '',
            // ---- CELL CANVAS ----
            '        function renderCanvas() {',
            '            if (!canvas) {',
            '                canvas = document.getElementById("cellCanvas");',
            '                ctx = canvas.getContext("2d");',
            '                canvas.onclick = handleCanvasClick;',
            '                canvas.oncontextmenu = handleCanvasRightClick;',
            '            }',
            '            var cell = pobData.cells[selectedCellIndex];',
            '            ctx.clearRect(0, 0, canvas.width, canvas.height);',
            '            ctx.fillStyle = "#2d2d2d";',
            '            ctx.fillRect(0, 0, canvas.width, canvas.height);',
            '',
            '            var hasFloor = cell.floorGeometry && cell.floorGeometry.vertices.length > 0;',
            '            var floorBounds = hasFloor ? cell.floorGeometry.bounds : { minX:-20, maxX:20, minZ:-20, maxZ:20, minY:0, maxY:0 };',
            '            var rangeX = floorBounds.maxX - floorBounds.minX || 1;',
            '            var rangeZ = floorBounds.maxZ - floorBounds.minZ || 1;',
            '            var maxRange = Math.max(rangeX, rangeZ);',
            '            var scale = 500 / maxRange;',
            '            var cxCenter = (floorBounds.minX + floorBounds.maxX) / 2;',
            '            var czCenter = (floorBounds.minZ + floorBounds.maxZ) / 2;',
            '            currentScale = scale;',
            '            currentCenterX = cxCenter;',
            '            currentCenterZ = czCenter;',
            '',
            '            toCanvasFn = function(wx, wz) {',
            '                return { x: 300 + (wx - cxCenter) * scale, y: 300 - (wz - czCenter) * scale };',
            '            };',
            '            toWorldFn = function(canvasX, canvasY) {',
            '                return { x: (canvasX - 300) / scale + cxCenter, z: (300 - canvasY) / scale + czCenter };',
            '            };',
            '            var toCanvas = toCanvasFn;',
            '',
            '            if (hasFloor) {',
            '                var geom = cell.floorGeometry;',
            '                ctx.strokeStyle = "#444";',
            '                ctx.lineWidth = 1;',
            '                for (var ti = 0; ti < geom.triangles.length; ti++) {',
            '                    var tri = geom.triangles[ti];',
            '                    var v1 = geom.vertices[tri.v1], v2 = geom.vertices[tri.v2], v3 = geom.vertices[tri.v3];',
            '                    if (!v1 || !v2 || !v3) continue;',
            '                    var p1 = toCanvas(v1.x, v1.z), p2 = toCanvas(v2.x, v2.z), p3 = toCanvas(v3.x, v3.z);',
            '                    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.closePath(); ctx.stroke();',
            '                }',
            '                ctx.strokeStyle = "#777"; ctx.lineWidth = 2;',
            '                var bMin = toCanvas(floorBounds.minX, floorBounds.minZ);',
            '                var bMax = toCanvas(floorBounds.maxX, floorBounds.maxZ);',
            '                ctx.strokeRect(bMax.x < bMin.x ? bMax.x : bMin.x, bMax.y < bMin.y ? bMax.y : bMin.y, Math.abs(bMax.x - bMin.x), Math.abs(bMax.y - bMin.y));',
            '',
            '                // Draw portal edges (doorways) in bright color',
            '                if (geom.portalEdges && geom.portalEdges.length > 0) {',
            '                    ctx.lineWidth = 3;',
            '                    var portalMidpoints = {};',
            '                    for (var pe = 0; pe < geom.portalEdges.length; pe++) {',
            '                        var edge = geom.portalEdges[pe];',
            '                        var ev1 = geom.vertices[edge.v1], ev2 = geom.vertices[edge.v2];',
            '                        if (!ev1 || !ev2) continue;',
            '                        var ep1 = toCanvas(ev1.x, ev1.z), ep2 = toCanvas(ev2.x, ev2.z);',
            '                        ctx.strokeStyle = "#44FF88";',
            '                        ctx.beginPath(); ctx.moveTo(ep1.x, ep1.y); ctx.lineTo(ep2.x, ep2.y); ctx.stroke();',
            '',
            '                        var pid = edge.portalId;',
            '                        if (!portalMidpoints[pid]) portalMidpoints[pid] = { sumX: 0, sumY: 0, count: 0 };',
            '                        portalMidpoints[pid].sumX += (ep1.x + ep2.x) / 2;',
            '                        portalMidpoints[pid].sumY += (ep1.y + ep2.y) / 2;',
            '                        portalMidpoints[pid].count++;',
            '                    }',
            '',
            '                    ctx.font = "bold 11px monospace"; ctx.fillStyle = "#44FF88";',
            '                    var cellPortals = cell.portals || [];',
            '                    for (var pid in portalMidpoints) {',
            '                        var mp = portalMidpoints[pid];',
            '                        var mx = mp.sumX / mp.count;',
            '                        var my = mp.sumY / mp.count;',
            '                        var label = "Door";',
            '                        for (var cpi = 0; cpi < cellPortals.length; cpi++) {',
            '                            if (cellPortals[cpi].id === parseInt(pid)) {',
            '                                var toCellIdx = cellPortals[cpi].connecting_cell;',
            '                                if (pobData.cells[toCellIdx]) label = pobData.cells[toCellIdx].name;',
            '                                break;',
            '                            }',
            '                        }',
            '                        ctx.fillText(label, mx + 4, my - 4);',
            '                    }',
            '                }',
            '            } else {',
            '                ctx.strokeStyle = "#555"; ctx.strokeRect(50, 50, 500, 500);',
            '                ctx.strokeStyle = "#333";',
            '                for (var gi = 1; gi < 10; gi++) {',
            '                    ctx.beginPath(); ctx.moveTo(50+gi*50, 50); ctx.lineTo(50+gi*50, 550); ctx.stroke();',
            '                    ctx.beginPath(); ctx.moveTo(50, 50+gi*50); ctx.lineTo(550, 50+gi*50); ctx.stroke();',
            '                }',
            '            }',
            '',
            '            // Dimensions labels',
            '            ctx.fillStyle = "#888"; ctx.font = "11px monospace";',
            '            ctx.fillText("X: " + floorBounds.minX.toFixed(1) + " to " + floorBounds.maxX.toFixed(1) + " (" + rangeX.toFixed(1) + "m)", 10, 590);',
            '            ctx.fillText("Z: " + floorBounds.minZ.toFixed(1) + " to " + floorBounds.maxZ.toFixed(1) + " (" + rangeZ.toFixed(1) + "m)", 10, 578);',
            '            ctx.fillText("Y(height): " + floorBounds.minY.toFixed(1) + " to " + floorBounds.maxY.toFixed(1), 350, 590);',
            '',
            '            // Axis tick marks',
            '            ctx.fillStyle = "#666"; ctx.font = "9px monospace";',
            '            var step = Math.pow(10, Math.floor(Math.log10(maxRange/4)));',
            '            if (maxRange / step > 8) step *= 2;',
            '            var xStart = Math.ceil(floorBounds.minX / step) * step;',
            '            for (var tx = xStart; tx <= floorBounds.maxX; tx += step) {',
            '                var tp = toCanvas(tx, czCenter);',
            '                ctx.fillText(tx.toFixed(0), tp.x - 8, 565);',
            '                ctx.beginPath(); ctx.strokeStyle="#333"; ctx.moveTo(tp.x, 50); ctx.lineTo(tp.x, 555); ctx.stroke();',
            '            }',
            '            var zStart = Math.ceil(floorBounds.minZ / step) * step;',
            '            for (var tz = zStart; tz <= floorBounds.maxZ; tz += step) {',
            '                var tzp = toCanvas(cxCenter, tz);',
            '                ctx.fillText(tz.toFixed(0), 5, tzp.y + 3);',
            '                ctx.beginPath(); ctx.strokeStyle="#333"; ctx.moveTo(30, tzp.y); ctx.lineTo(580, tzp.y); ctx.stroke();',
            '            }',
            '',
            // ---- DRAW PATROL PATHS ----
            '            var allPaths = getCellPaths();',
            '            for (var pi = 0; pi < allPaths.length; pi++) {',
            '                var pp = allPaths[pi];',
            '                if (pp.waypoints.length === 0) continue;',
            '                var isActive = pp.id === activePathId && currentMode === "path";',
            '                var pColor = pp.color;',
            '                var pAlpha = isActive ? 1.0 : 0.5;',
            '',
            '                // Draw connecting lines',
            '                ctx.strokeStyle = pColor;',
            '                ctx.lineWidth = isActive ? 2.5 : 1.5;',
            '                ctx.globalAlpha = pAlpha;',
            '                ctx.setLineDash([6, 4]);',
            '                for (var wi = 0; wi < pp.waypoints.length - 1; wi++) {',
            '                    var w1 = toCanvas(pp.waypoints[wi].x, pp.waypoints[wi].y);',
            '                    var w2 = toCanvas(pp.waypoints[wi + 1].x, pp.waypoints[wi + 1].y);',
            '                    ctx.beginPath(); ctx.moveTo(w1.x, w1.y); ctx.lineTo(w2.x, w2.y); ctx.stroke();',
            '                    // Direction arrow at midpoint',
            '                    var mx = (w1.x + w2.x) / 2;',
            '                    var my = (w1.y + w2.y) / 2;',
            '                    var angle = Math.atan2(w2.y - w1.y, w2.x - w1.x);',
            '                    ctx.setLineDash([]);',
            '                    ctx.beginPath();',
            '                    ctx.moveTo(mx + Math.cos(angle) * 5, my + Math.sin(angle) * 5);',
            '                    ctx.lineTo(mx + Math.cos(angle + 2.5) * 5, my + Math.sin(angle + 2.5) * 5);',
            '                    ctx.moveTo(mx + Math.cos(angle) * 5, my + Math.sin(angle) * 5);',
            '                    ctx.lineTo(mx + Math.cos(angle - 2.5) * 5, my + Math.sin(angle - 2.5) * 5);',
            '                    ctx.stroke();',
            '                    ctx.setLineDash([6, 4]);',
            '                }',
            '',
            '                // Closing line for loop mode',
            '                if (pp.mode === "loop" && pp.waypoints.length > 1) {',
            '                    var wLast = toCanvas(pp.waypoints[pp.waypoints.length - 1].x, pp.waypoints[pp.waypoints.length - 1].y);',
            '                    var wFirst = toCanvas(pp.waypoints[0].x, pp.waypoints[0].y);',
            '                    ctx.beginPath(); ctx.moveTo(wLast.x, wLast.y); ctx.lineTo(wFirst.x, wFirst.y); ctx.stroke();',
            '                }',
            '',
            '                ctx.setLineDash([]);',
            '',
            '                // Draw waypoint diamonds',
            '                for (var wi = 0; wi < pp.waypoints.length; wi++) {',
            '                    var wp = pp.waypoints[wi];',
            '                    var wPos = toCanvas(wp.x, wp.y);',
            '                    var sz = isActive ? 7 : 5;',
            '',
            '                    ctx.fillStyle = pColor;',
            '                    ctx.beginPath();',
            '                    ctx.moveTo(wPos.x, wPos.y - sz);',
            '                    ctx.lineTo(wPos.x + sz, wPos.y);',
            '                    ctx.lineTo(wPos.x, wPos.y + sz);',
            '                    ctx.lineTo(wPos.x - sz, wPos.y);',
            '                    ctx.closePath();',
            '                    ctx.fill();',
            '                    ctx.strokeStyle = "#fff";',
            '                    ctx.lineWidth = 1;',
            '                    ctx.stroke();',
            '',
            '                    // Waypoint number',
            '                    ctx.fillStyle = "#fff";',
            '                    ctx.font = "bold 9px monospace";',
            '                    ctx.textAlign = "center";',
            '                    ctx.fillText((wi + 1).toString(), wPos.x, wPos.y - sz - 3);',
            '                    ctx.textAlign = "left";',
            '                }',
            '                ctx.globalAlpha = 1.0;',
            '            }',
            '',
            // ---- DRAW SPAWN-TO-PATH LINKS ----
            '            var cellSpawns = spawns.get(selectedCellIndex) || [];',
            '            for (var si = 0; si < cellSpawns.length; si++) {',
            '                var sp = cellSpawns[si];',
            '                if (sp.patrolPathId) {',
            '                    var linkedPath = null;',
            '                    for (var lpi = 0; lpi < allPaths.length; lpi++) {',
            '                        if (allPaths[lpi].id === sp.patrolPathId) { linkedPath = allPaths[lpi]; break; }',
            '                    }',
            '                    if (linkedPath && linkedPath.waypoints.length > 0) {',
            '                        var spPos = toCanvas(sp.x, sp.y);',
            '                        var wp1Pos = toCanvas(linkedPath.waypoints[0].x, linkedPath.waypoints[0].y);',
            '                        ctx.strokeStyle = linkedPath.color;',
            '                        ctx.lineWidth = 1;',
            '                        ctx.globalAlpha = 0.4;',
            '                        ctx.setLineDash([3, 3]);',
            '                        ctx.beginPath(); ctx.moveTo(spPos.x, spPos.y); ctx.lineTo(wp1Pos.x, wp1Pos.y); ctx.stroke();',
            '                        ctx.setLineDash([]);',
            '                        ctx.globalAlpha = 1.0;',
            '                    }',
            '                }',
            '            }',
            '',
            '            // Draw spawn points with direction arrows',
            '            for (var si = 0; si < cellSpawns.length; si++) {',
            '                var sp = cellSpawns[si];',
            '                var sPos = toCanvas(sp.x, sp.y);',
            '                var brushIdx = sp.tier - 1;',
            '                var color = BRUSH_COLORS[brushIdx] || "#888";',
            '',
            '                // Circle',
            '                ctx.fillStyle = color;',
            '                ctx.beginPath(); ctx.arc(sPos.x, sPos.y, 7, 0, Math.PI * 2); ctx.fill();',
            '                ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();',
            '',
            '                // Direction arrow (heading: 0=north, 90=east, etc.)',
            '                var headRad = (sp.heading - 90) * Math.PI / 180;',
            '                var arrowLen = 14;',
            '                var ax = sPos.x + Math.cos(headRad) * arrowLen;',
            '                var ay = sPos.y + Math.sin(headRad) * arrowLen;',
            '                ctx.strokeStyle = color; ctx.lineWidth = 2;',
            '                ctx.beginPath(); ctx.moveTo(sPos.x, sPos.y); ctx.lineTo(ax, ay); ctx.stroke();',
            '                // Arrowhead',
            '                var ha1 = headRad + 2.5; var ha2 = headRad - 2.5;',
            '                ctx.beginPath(); ctx.moveTo(ax, ay);',
            '                ctx.lineTo(ax - Math.cos(ha1)*5, ay - Math.sin(ha1)*5);',
            '                ctx.moveTo(ax, ay);',
            '                ctx.lineTo(ax - Math.cos(ha2)*5, ay - Math.sin(ha2)*5);',
            '                ctx.stroke();',
            '            }',
            '',
            '            // Cell info in header',
            '            var dimsEl = document.getElementById("cellDims");',
            '            if (dimsEl) dimsEl.textContent = "- " + cell.name + " (Cell " + selectedCellIndex + ") - " + rangeX.toFixed(1) + "m x " + rangeZ.toFixed(1) + "m";',
            '',
            '            renderSpawnList();',
            '        }',
            '',
            '        function handleCanvasClick(event) {',
            '            if (selectedCellIndex === null) return;',
            '',
            '            var rect = canvas.getBoundingClientRect();',
            '            var cx = event.clientX - rect.left;',
            '            var cy = event.clientY - rect.top;',
            '            if (!toWorldFn) return;',
            '            var world = toWorldFn(cx, cy);',
            '',
            '            if (currentMode === "path") {',
            '                // Add waypoint to active path',
            '                if (!activePathId) {',
            '                    showStatus("Create or select a path first", "error");',
            '                    return;',
            '                }',
            '                var wp = {',
            '                    id: "wp_" + Date.now(),',
            '                    x: parseFloat(world.x.toFixed(2)),',
            '                    y: parseFloat(world.z.toFixed(2)),',
            '                    z: 0,',
            '                    waitTime: 0',
            '                };',
            '                // Inherit wait time from path',
            '                var activePath = getActivePath();',
            '                if (activePath && activePath.waypoints.length > 0) {',
            '                    wp.waitTime = activePath.waypoints[0].waitTime;',
            '                }',
            '                if (activePath) {',
            '                    activePath.waypoints.push(wp);',
            '                    vscode.postMessage({ type: "addPatrolWaypoint", cellIndex: selectedCellIndex, pathId: activePathId, waypoint: wp });',
            '                    renderPathList();',
            '                    renderCanvas();',
            '                }',
            '                return;',
            '            }',
            '',
            '            // Spawn mode',
            '            var brush = brushes[activeBrush];',
            '            var template = brush.template || "mobile_" + (activeBrush + 1);',
            '            var heading = brush.heading;',
            '',
            '            var spawn = {',
            '                id: Date.now().toString(),',
            '                x: parseFloat(world.x.toFixed(2)),',
            '                y: parseFloat(world.z.toFixed(2)),',
            '                z: 0,',
            '                heading: heading,',
            '                mobileTemplate: template,',
            '                tier: activeBrush + 1',
            '            };',
            '',
            '            if (!spawns.has(selectedCellIndex)) spawns.set(selectedCellIndex, []);',
            '            spawns.get(selectedCellIndex).push(spawn);',
            '            vscode.postMessage({ type: "addSpawnPoint", cellIndex: selectedCellIndex, spawn: spawn });',
            '            renderCanvas();',
            '        }',
            '',
            '        function handleCanvasRightClick(event) {',
            '            event.preventDefault();',
            '            if (selectedCellIndex === null) return;',
            '            var rect = canvas.getBoundingClientRect();',
            '            var cx = event.clientX - rect.left;',
            '            var cy = event.clientY - rect.top;',
            '',
            '            if (currentMode === "path") {',
            '                // Remove waypoint from active path',
            '                var activePath = getActivePath();',
            '                if (!activePath) return;',
            '                for (var wi = activePath.waypoints.length - 1; wi >= 0; wi--) {',
            '                    var wp = activePath.waypoints[wi];',
            '                    var wPos = toCanvasFn(wp.x, wp.y);',
            '                    var dist = Math.sqrt(Math.pow(cx - wPos.x, 2) + Math.pow(cy - wPos.y, 2));',
            '                    if (dist <= 10) {',
            '                        vscode.postMessage({ type: "removePatrolWaypoint", cellIndex: selectedCellIndex, pathId: activePathId, waypointId: wp.id });',
            '                        activePath.waypoints.splice(wi, 1);',
            '                        renderPathList();',
            '                        renderCanvas();',
            '                        return;',
            '                    }',
            '                }',
            '                return;',
            '            }',
            '',
            '            // Spawn mode - remove spawn',
            '            var cellSpawns = spawns.get(selectedCellIndex) || [];',
            '            for (var di = cellSpawns.length - 1; di >= 0; di--) {',
            '                var sp = cellSpawns[di];',
            '                var spx = toCanvasFn(sp.x, sp.y);',
            '                var dist = Math.sqrt(Math.pow(cx - spx.x, 2) + Math.pow(cy - spx.y, 2));',
            '                if (dist <= 10) {',
            '                    vscode.postMessage({ type: "removeSpawnPoint", cellIndex: selectedCellIndex, spawnId: sp.id });',
            '                    cellSpawns.splice(di, 1);',
            '                    renderCanvas();',
            '                    return;',
            '                }',
            '            }',
            '        }',
            '',
            '        function renderSpawnList() {',
            '            var list = document.getElementById("spawnList");',
            '            list.innerHTML = "";',
            '            var cellSpawns = spawns.get(selectedCellIndex) || [];',
            '            var allPaths = getCellPaths();',
            '            for (var si = 0; si < cellSpawns.length; si++) {',
            '                var sp = cellSpawns[si];',
            '                var brushIdx = sp.tier - 1;',
            '                var color = BRUSH_COLORS[brushIdx] || "#888";',
            '                var li = document.createElement("li");',
            '                li.className = "spawn-item";',
            '',
            '                var spanInfo = document.createElement("span");',
            '                var dot = document.createElement("span");',
            '                dot.style.display = "inline-block";',
            '                dot.style.width = "10px";',
            '                dot.style.height = "10px";',
            '                dot.style.borderRadius = "50%";',
            '                dot.style.backgroundColor = color;',
            '                dot.style.marginRight = "6px";',
            '                spanInfo.appendChild(dot);',
            '                spanInfo.appendChild(document.createTextNode(sp.mobileTemplate + " @ (" + sp.x + ", " + sp.y + ")"));',
            '',
            '                var rightDiv = document.createElement("div");',
            '                rightDiv.style.display = "flex";',
            '                rightDiv.style.alignItems = "center";',
            '                rightDiv.style.gap = "4px";',
            '',
            '                // Patrol path dropdown',
            '                if (allPaths.length > 0) {',
            '                    var pathSelect = document.createElement("select");',
            '                    pathSelect.style.fontSize = "11px";',
            '                    pathSelect.style.padding = "1px 2px";',
            '                    var optNone = document.createElement("option");',
            '                    optNone.value = ""; optNone.textContent = "No patrol";',
            '                    pathSelect.appendChild(optNone);',
            '                    for (var ppi = 0; ppi < allPaths.length; ppi++) {',
            '                        var opt = document.createElement("option");',
            '                        opt.value = allPaths[ppi].id;',
            '                        opt.textContent = allPaths[ppi].name;',
            '                        if (sp.patrolPathId === allPaths[ppi].id) opt.selected = true;',
            '                        pathSelect.appendChild(opt);',
            '                    }',
            '                    (function(spawnObj, selectEl) {',
            '                        selectEl.onchange = function() {',
            '                            spawnObj.patrolPathId = selectEl.value || undefined;',
            '                            vscode.postMessage({ type: "updateSpawnPoint", cellIndex: selectedCellIndex, spawn: spawnObj });',
            '                            renderCanvas();',
            '                        };',
            '                    })(sp, pathSelect);',
            '                    rightDiv.appendChild(pathSelect);',
            '                }',
            '',
            '                var delBtn = document.createElement("button");',
            '                delBtn.textContent = "X";',
            '                delBtn.style.padding = "1px 6px";',
            '                (function(idx) { delBtn.onclick = function() { removeSpawn(idx); }; })(si);',
            '                rightDiv.appendChild(delBtn);',
            '',
            '                li.appendChild(spanInfo);',
            '                li.appendChild(rightDiv);',
            '                list.appendChild(li);',
            '            }',
            '        }',
            '',
            '        function removeSpawn(index) {',
            '            var cellSpawns = spawns.get(selectedCellIndex);',
            '            var sp = cellSpawns[index];',
            '            cellSpawns.splice(index, 1);',
            '            vscode.postMessage({ type: "removeSpawnPoint", cellIndex: selectedCellIndex, spawnId: sp.id });',
            '            renderCanvas();',
            '        }',
            '',
            '        function showStatus(message, type) {',
            '            var st = document.getElementById("statusMessage");',
            '            st.textContent = message; st.className = type;',
            '        }',
            '',
            '        document.getElementById("pobSelect").onchange = function(e) {',
            '            if (e.target.value) vscode.postMessage({ type: "loadPob", path: e.target.value });',
            '        };',
            '        document.getElementById("screenplayName").oninput = function(e) {',
            '            vscode.postMessage({ type: "setScreenplayName", name: e.target.value });',
            '        };',
            '        document.getElementById("exportBtn").onclick = function() {',
            '            var spawnData = [];',
            '            spawns.forEach(function(cellSpawns, cellIndex) {',
            '                var cellPaths = patrolPaths.get(cellIndex) || [];',
            '                spawnData.push({ cellIndex: cellIndex, cellName: pobData.cells[cellIndex].name, spawns: cellSpawns, patrolPaths: cellPaths.length > 0 ? cellPaths : undefined });',
            '            });',
            '            // Also include cells that only have paths but no spawns',
            '            patrolPaths.forEach(function(paths, cellIndex) {',
            '                if (!spawns.has(cellIndex) && paths.length > 0) {',
            '                    spawnData.push({ cellIndex: cellIndex, cellName: pobData.cells[cellIndex].name, spawns: [], patrolPaths: paths });',
            '                }',
            '            });',
            '            vscode.postMessage({ type: "updateSpawnData", data: spawnData });',
            '            vscode.postMessage({ type: "exportScreenplay" });',
            '        };',
            '    </script>',
            '</body>',
            '</html>'
        ];

        return lines.join('\n');
    }
}
