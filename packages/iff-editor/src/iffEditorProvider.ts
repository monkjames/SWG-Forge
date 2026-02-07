import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseIFF, serializeIFF, serializeProperty, IFFDocument, IFFNode, IFFProperty, getTreeStructure } from './iffParser';
import {
    isDraftSchematic,
    findLuaFile,
    parseIFFSlots,
    parseLuaSchematic,
    compareSchematic,
    generateLuaContent,
    parseTargetExperimentalProperties,
    validateExperimentalProperties,
    getResourceProperties,
    PROPERTY_NAMES,
    RESOURCE_PROPERTY_MAP,
    SchematicData,
    SchematicComparison,
    SlotDifference,
    IngredientSlot,
    SlotType,
    ExperimentalValidation
} from './schematicParser';

class IFFEditorDocument implements vscode.CustomDocument {
    public iffDoc: IFFDocument;

    // Schematic-specific data
    public isSchematic: boolean = false;
    public luaPath: string | null = null;
    public schematicData: SchematicComparison | null = null;
    public targetTemplateData: any = null;
    private workspaceRoot: string = '';

    constructor(
        public readonly uri: vscode.Uri,
        initialData: Uint8Array,
        workspaceRoot: string
    ) {
        this.iffDoc = parseIFF(initialData);
        this.workspaceRoot = workspaceRoot;

        // Check if this is a draft schematic
        this.isSchematic = isDraftSchematic(uri.fsPath);

        if (this.isSchematic) {
            // Find corresponding Lua file
            this.luaPath = findLuaFile(uri.fsPath, workspaceRoot);

            // Parse schematic data from both sources
            this.loadSchematicData();
        }
    }

    public loadSchematicData(): void {
        if (!this.isSchematic) return;

        // Parse IFF slots from the tree
        const iffSlots = parseIFFSlots(this.iffDoc.root);
        const iffData: SchematicData = {
            customObjectName: this.getPropertyValue('customObjectName') || '',
            craftingToolTab: this.getPropertyValueNumber('craftingToolTab'),
            complexity: this.getPropertyValueNumber('complexity'),
            size: this.getPropertyValueNumber('size'),
            factoryCrateSize: this.getPropertyValueNumber('factoryCrateSize'),
            xpType: this.getPropertyValue('xpType') || '',
            xp: this.getPropertyValueNumber('xp'),
            assemblySkill: this.getPropertyValue('assemblySkill') || '',
            experimentingSkill: this.getPropertyValue('experimentingSkill') || '',
            customizationSkill: this.getPropertyValue('customizationSkill') || '',
            slots: iffSlots,
            targetTemplate: this.getPropertyValue('targetTemplate') || '',
            additionalTemplates: []
        };

        // Parse Lua data if available
        const luaData = this.luaPath ? parseLuaSchematic(this.luaPath) : null;

        // Compare and create comparison result
        const differences = compareSchematic(iffData, luaData);

        // Find and parse target template for experimental properties
        const targetTemplate = luaData?.targetTemplate || iffData.targetTemplate;
        let targetTemplatePath: string | undefined;
        let requiredExperimentalProperties: string[] = [];
        let experimentalErrors: ExperimentalValidation[] = [];

        if (targetTemplate && this.workspaceRoot) {
            // Convert target template path to Lua path
            // e.g., "object/weapon/ranged/pistol/shared_pistol_westar31b.iff" ->
            //       ".../bin/scripts/object/weapon/ranged/pistol/pistol_westar31b.lua"
            const templateMatch = targetTemplate.match(/object\/(.+)\.iff$/i);
            if (templateMatch) {
                const relativePath = templateMatch[1].replace(/^shared_|shared_/g, '');
                const possiblePaths = [
                    path.join(this.workspaceRoot, 'infinity4.0.0/MMOCoreORB/bin/scripts/custom_scripts/object', relativePath + '.lua'),
                    path.join(this.workspaceRoot, 'infinity4.0.0/MMOCoreORB/bin/scripts/object', relativePath + '.lua'),
                ];

                for (const p of possiblePaths) {
                    if (fs.existsSync(p)) {
                        targetTemplatePath = p;
                        break;
                    }
                }

                // Parse experimental properties from target template
                if (targetTemplatePath) {
                    requiredExperimentalProperties = parseTargetExperimentalProperties(targetTemplatePath);

                    // Validate slots against required properties
                    const slotsToValidate = luaData?.slots || iffSlots;
                    if (slotsToValidate.length > 0 && requiredExperimentalProperties.length > 0) {
                        experimentalErrors = validateExperimentalProperties(slotsToValidate, requiredExperimentalProperties);
                    }
                }
            }
        }

        this.schematicData = {
            iffData,
            luaData,
            differences,
            iffPath: this.uri.fsPath,
            luaPath: this.luaPath || '',
            targetTemplatePath,
            requiredExperimentalProperties,
            experimentalErrors
        };
    }

    private getPropertyValue(name: string): string | null {
        const prop = this.iffDoc.properties.get(name);
        if (!prop) return null;

        if (prop.type === 'string') return prop.value as string;
        if (prop.type === 'stf_reference') {
            const stf = prop.value as { file: string; key: string };
            return `@${stf.file}:${stf.key}`;
        }
        return String(prop.value);
    }

    private getPropertyValueNumber(name: string): number {
        const prop = this.iffDoc.properties.get(name);
        if (!prop) return 0;
        if (typeof prop.value === 'number') return prop.value;
        return 0;
    }

    public reload(data: Uint8Array): void {
        this.iffDoc = parseIFF(data);
        if (this.isSchematic) {
            this.loadSchematicData();
        }
    }

    public dispose(): void {
        // Nothing to dispose
    }
}

export class IFFEditorProvider implements vscode.CustomEditorProvider<IFFEditorDocument> {
    public static readonly viewType = 'iffEditor.iffFile';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<IFFEditorDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly context: vscode.ExtensionContext) {}

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new IFFEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(
            IFFEditorProvider.viewType,
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false
            }
        );
    }

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<IFFEditorDocument> {
        const data = await vscode.workspace.fs.readFile(uri);

        // Get workspace root for finding Lua files
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || path.dirname(uri.fsPath);

        return new IFFEditorDocument(uri, data, workspaceRoot);
    }

    async resolveCustomEditor(
        document: IFFEditorDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        // Send initial data to webview
        const sendData = () => {
            webviewPanel.webview.postMessage({
                type: 'load',
                data: this.serializeForWebview(document)
            });
        };

        // Handle messages from webview
        webviewPanel.webview.onDidReceiveMessage(async e => {
            switch (e.type) {
                case 'ready':
                    sendData();
                    break;
                case 'updateProperty':
                    this.handlePropertyUpdate(document, e.name, e.value, e.valueType);
                    break;
                case 'getChunkData':
                    // Return full chunk data for a given offset
                    console.log('getChunkData requested for offset:', e.offset);
                    const chunkData = this.getChunkDataAtOffset(document, e.offset);
                    console.log('getChunkData returning:', chunkData ? chunkData.length + ' bytes' : 'null');
                    webviewPanel.webview.postMessage({ type: 'chunkData', offset: e.offset, data: chunkData });
                    break;
                case 'updateChunk':
                    // Apply change immediately to the chunk
                    this.updateSingleChunk(document, e.offset, e.newData);
                    // Notify webview that chunk was updated
                    webviewPanel.webview.postMessage({ type: 'chunkUpdated' });
                    break;
                case 'saveDocument':
                    // Save the document immediately
                    (async () => {
                        try {
                            const data = serializeIFF(document.iffDoc);
                            console.log('Serialized IFF, size:', data.length);
                            await vscode.workspace.fs.writeFile(document.uri, data);
                            console.log('File written successfully');
                            webviewPanel.webview.postMessage({ type: 'documentSaved' });
                        } catch (err: any) {
                            console.error('Save error:', err);
                            webviewPanel.webview.postMessage({ type: 'saveError', error: err.message });
                        }
                    })();
                    break;

                case 'updateSchematicSlot':
                    // Update a slot in both IFF and Lua
                    this.handleSchematicSlotUpdate(document, e.slotIndex, e.slotData, webviewPanel);
                    break;

                case 'addSchematicSlot':
                    // Add a new slot to both IFF and Lua
                    this.handleAddSchematicSlot(document, e.slotData, webviewPanel);
                    break;

                case 'deleteSchematicSlot':
                    // Delete a slot from both IFF and Lua
                    this.handleDeleteSchematicSlot(document, e.slotIndex, webviewPanel);
                    break;

                case 'syncLuaToIff':
                    // Sync Lua data to IFF
                    this.handleSyncLuaToIff(document, webviewPanel);
                    break;

                case 'syncIffToLua':
                    // Sync IFF data to Lua
                    this.handleSyncIffToLua(document, webviewPanel);
                    break;

                case 'saveBoth':
                    // Save both IFF and Lua files
                    this.handleSaveBoth(document, webviewPanel);
                    break;

                case 'fixUseIff':
                    // Copy IFF slot values to Lua
                    this.handleFixUseIff(document, e.slotIndex, webviewPanel);
                    break;

                case 'fixUseLua':
                    // Copy Lua slot values to IFF
                    this.handleFixUseLua(document, e.slotIndex, webviewPanel);
                    break;

                case 'fixAddToIff':
                    // Add Lua-only slot to IFF
                    this.handleFixAddToIff(document, e.slotIndex, webviewPanel);
                    break;

                case 'fixAddToLua':
                    // Add IFF-only slot to Lua
                    this.handleFixAddToLua(document, e.slotIndex, webviewPanel);
                    break;

                case 'fixRemoveLua':
                    // Remove slot from Lua only
                    this.handleFixRemoveLua(document, e.slotIndex, webviewPanel);
                    break;

                case 'fixRemoveIff':
                    // Remove slot from IFF only
                    this.handleFixRemoveIff(document, e.slotIndex, webviewPanel);
                    break;

                case 'fixResourceType':
                    // Change resource type to fix experimental property mismatch (legacy)
                    this.handleFixResourceType(document, e.slotIndex, e.resourceType, webviewPanel);
                    break;

                case 'fixExperimentalProperty':
                    // Show info about changing experimental property in target template
                    this.handleFixExperimentalProperty(document, e.slotIndex, e.propertyCode, webviewPanel);
                    break;

                case 'copyToWorkingFolder':
                    // Copy file to working folder and open it
                    this.handleCopyToWorkingFolder(document, e.targetPath, webviewPanel);
                    break;
            }
        });
    }

    private async handleCopyToWorkingFolder(
        document: IFFEditorDocument,
        targetPath: string,
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        try {
            const sourceUri = document.uri;
            const targetUri = vscode.Uri.file(targetPath);

            // Ensure target directory exists
            const targetDir = path.dirname(targetPath);
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir));

            // Copy the file
            await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: false });

            // Close current editor and open the copied file
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await vscode.commands.executeCommand('vscode.open', targetUri);
        } catch (err: any) {
            if (err.code === 'FileExists') {
                // File already exists - ask what to do
                const action = await vscode.window.showWarningMessage(
                    `File already exists in working folder: ${path.basename(targetPath)}`,
                    'Open Existing File',
                    'Overwrite'
                );

                if (action === 'Open Existing File') {
                    const targetUri = vscode.Uri.file(targetPath);
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    await vscode.commands.executeCommand('vscode.open', targetUri);
                } else if (action === 'Overwrite') {
                    const targetUri = vscode.Uri.file(targetPath);
                    await vscode.workspace.fs.copy(document.uri, targetUri, { overwrite: true });
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    await vscode.commands.executeCommand('vscode.open', targetUri);
                }
            } else {
                vscode.window.showErrorMessage(`Failed to copy file: ${err.message}`);
            }
        }
    }

    private serializeForWebview(document: IFFEditorDocument): any {
        const { root, properties, derivation } = document.iffDoc;

        // Convert tree to JSON-safe format
        const tree = this.nodeToJson(root);

        // Convert properties map to array
        const props = Array.from(properties.entries()).map(([name, prop]) => ({
            name,
            type: prop.type,
            value: prop.value,
            rawHex: this.bytesToHex(prop.rawData)
        }));

        // Check if file is in tre/working/ folder (editable) or a read-only folder
        const filePath = document.uri.fsPath;
        const isEditable = this.isInWorkingFolder(filePath);
        const workingFolderPath = this.getWorkingFolderPath(filePath);

        return {
            tree,
            properties: props,
            derivation,
            filePath: document.uri.fsPath,
            // Editability info
            isEditable,
            workingFolderPath,
            // Schematic-specific data
            isSchematic: document.isSchematic,
            schematicData: document.schematicData,
            luaPath: document.luaPath
        };
    }

    private isInWorkingFolder(filePath: string): boolean {
        // Normalize path separators
        const normalizedPath = filePath.replace(/\\/g, '/');
        return normalizedPath.includes('/tre/working/');
    }

    private getWorkingFolderPath(filePath: string): string | null {
        // If already in working folder, return null
        if (this.isInWorkingFolder(filePath)) {
            return null;
        }

        const normalizedPath = filePath.replace(/\\/g, '/');

        // Map from source folders to working folder
        // tre/vanilla/ -> tre/working/
        // tre/infinity/ -> tre/working/
        const mappings = [
            { from: '/tre/vanilla/', to: '/tre/working/' },
            { from: '/tre/infinity/', to: '/tre/working/' }
        ];

        for (const mapping of mappings) {
            if (normalizedPath.includes(mapping.from)) {
                return normalizedPath.replace(mapping.from, mapping.to);
            }
        }

        // If it's some other TRE location, try to extract relative path after tre/
        const treMatch = normalizedPath.match(/\/tre\/([^\/]+)\/(.*)/);
        if (treMatch) {
            const relativePath = treMatch[2];
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            return path.join(workspaceRoot, 'tre', 'working', relativePath).replace(/\\/g, '/');
        }

        return null;
    }

    private nodeToJson(node: IFFNode): any {
        const result: any = {
            type: node.type,
            tag: node.tag,
            offset: node.offset,
            size: node.size
        };

        if (node.formName) {
            result.formName = node.formName;
        }

        if (node.data) {
            // For chunks, include preview and hex
            result.preview = this.getDataPreview(node.data);
            result.hex = this.bytesToHex(node.data.slice(0, 64)); // First 64 bytes
            result.fullSize = node.data.length;

            // For XXXX chunks, extract the property name (first null-terminated string)
            if (node.tag === 'XXXX') {
                result.propertyName = this.extractPropertyName(node.data);
            }
        }

        if (node.children && node.children.length > 0) {
            result.children = node.children.map(c => this.nodeToJson(c));
        }

        return result;
    }

    private getDataPreview(data: Uint8Array): string {
        let str = '';
        for (let i = 0; i < Math.min(data.length, 60); i++) {
            const byte = data[i];
            if (byte >= 32 && byte < 127) {
                str += String.fromCharCode(byte);
            } else if (byte === 0) {
                str += ' ';
            } else {
                str += '.';
            }
        }
        return str.trim();
    }

    private extractPropertyName(data: Uint8Array): string {
        // Extract first null-terminated string from XXXX chunk (the property name)
        let name = '';
        for (let i = 0; i < data.length && data[i] !== 0; i++) {
            if (data[i] >= 32 && data[i] < 127) {
                name += String.fromCharCode(data[i]);
            }
        }
        return name;
    }

    private bytesToHex(data: Uint8Array): string {
        return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
    }

    private handlePropertyUpdate(
        document: IFFEditorDocument,
        name: string,
        value: any,
        valueType: string
    ): void {
        const prop = document.iffDoc.properties.get(name);
        if (!prop) return;

        const oldValue = JSON.parse(JSON.stringify(prop.value));

        // Update the property
        prop.value = value;
        prop.type = valueType as any;

        // Also update the corresponding chunk in the tree
        const newChunkData = serializeProperty(prop);
        this.updateChunkByPropertyName(document, name, newChunkData);

        // Fire change event with undo/redo
        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {
                prop.value = oldValue;
            },
            redo: () => {
                prop.value = value;
            }
        });
    }

    private updateChunkByPropertyName(document: IFFEditorDocument, propName: string, newData: Uint8Array): void {
        // Find the XXXX chunk that contains this property and update it
        const findAndUpdate = (node: IFFNode): boolean => {
            if (node.type === 'chunk' && node.tag === 'XXXX' && node.data) {
                // Check if this chunk's property name matches
                const chunkPropName = this.extractPropertyName(node.data);
                if (chunkPropName === propName) {
                    node.data = newData;
                    node.size = newData.length;
                    return true;
                }
            }
            if (node.children) {
                for (const child of node.children) {
                    if (findAndUpdate(child)) return true;
                }
            }
            return false;
        };

        findAndUpdate(document.iffDoc.root);
    }


    private getChunkDataAtOffset(document: IFFEditorDocument, offset: number): number[] | null {
        // Find chunk in tree by offset and return its raw data as array
        const findChunk = (node: IFFNode): Uint8Array | null => {
            if (node.type === 'chunk' && node.offset === offset && node.data) {
                return node.data;
            }
            if (node.children) {
                for (const child of node.children) {
                    const found = findChunk(child);
                    if (found) return found;
                }
            }
            return null;
        };

        const data = findChunk(document.iffDoc.root);
        return data ? Array.from(data) : null;
    }

    private updateSingleChunk(document: IFFEditorDocument, offset: number, newData: number[]): void {
        console.log('updateSingleChunk called, offset:', offset, 'newData length:', newData.length);

        // Find and update the chunk by offset
        const updateChunk = (node: IFFNode): boolean => {
            if (node.type === 'chunk' && node.offset === offset && node.data) {
                console.log('Found chunk at offset', offset, 'old size:', node.data.length, 'new size:', newData.length);
                node.data = new Uint8Array(newData);
                node.size = newData.length;
                return true;
            }
            if (node.children) {
                for (const child of node.children) {
                    if (updateChunk(child)) return true;
                }
            }
            return false;
        };

        const found = updateChunk(document.iffDoc.root);
        console.log('Chunk found and updated:', found);

        // Fire change event to mark document as dirty
        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {},
            redo: () => {}
        });
    }

    // ==================== Schematic Handler Methods ====================

    private handleSchematicSlotUpdate(
        document: IFFEditorDocument,
        slotIndex: number,
        slotData: IngredientSlot,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData) return;

        // Update IFF slot data
        if (document.schematicData.iffData && document.schematicData.iffData.slots[slotIndex]) {
            const iffSlot = document.schematicData.iffData.slots[slotIndex];
            iffSlot.templateName = slotData.templateName;
            iffSlot.titleName = slotData.titleName;
            iffSlot.slotType = slotData.slotType;
        }

        // Update Lua slot data
        if (document.schematicData.luaData && document.schematicData.luaData.slots[slotIndex]) {
            const luaSlot = document.schematicData.luaData.slots[slotIndex];
            luaSlot.templateName = slotData.templateName;
            luaSlot.titleName = slotData.titleName;
            luaSlot.slotType = slotData.slotType;
            luaSlot.resourceType = slotData.resourceType;
            luaSlot.quantity = slotData.quantity;
            luaSlot.contribution = slotData.contribution;
        }

        // Recalculate differences
        document.schematicData.differences = compareSchematic(
            document.schematicData.iffData,
            document.schematicData.luaData
        );

        // Notify webview of update
        webviewPanel.webview.postMessage({
            type: 'schematicUpdated',
            schematicData: document.schematicData
        });

        // Mark document as dirty
        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {},
            redo: () => {}
        });
    }

    private handleAddSchematicSlot(
        document: IFFEditorDocument,
        slotData: IngredientSlot,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData) return;

        // Add to IFF slots
        if (document.schematicData.iffData) {
            document.schematicData.iffData.slots.push({
                templateName: slotData.templateName,
                titleName: slotData.titleName,
                slotType: slotData.slotType,
                resourceType: '',
                quantity: 0,
                contribution: 100
            });
        }

        // Add to Lua slots
        if (document.schematicData.luaData) {
            document.schematicData.luaData.slots.push({
                ...slotData
            });
        }

        // Recalculate differences
        document.schematicData.differences = compareSchematic(
            document.schematicData.iffData,
            document.schematicData.luaData
        );

        // Notify webview
        webviewPanel.webview.postMessage({
            type: 'schematicUpdated',
            schematicData: document.schematicData
        });

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {},
            redo: () => {}
        });
    }

    private handleDeleteSchematicSlot(
        document: IFFEditorDocument,
        slotIndex: number,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData) return;

        // Remove from IFF slots
        if (document.schematicData.iffData && slotIndex < document.schematicData.iffData.slots.length) {
            document.schematicData.iffData.slots.splice(slotIndex, 1);
        }

        // Remove from Lua slots
        if (document.schematicData.luaData && slotIndex < document.schematicData.luaData.slots.length) {
            document.schematicData.luaData.slots.splice(slotIndex, 1);
        }

        // Recalculate differences
        document.schematicData.differences = compareSchematic(
            document.schematicData.iffData,
            document.schematicData.luaData
        );

        // Notify webview
        webviewPanel.webview.postMessage({
            type: 'schematicUpdated',
            schematicData: document.schematicData
        });

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {},
            redo: () => {}
        });
    }

    private handleSyncLuaToIff(
        document: IFFEditorDocument,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData?.luaData || !document.schematicData?.iffData) return;

        // Copy Lua slots to IFF (names and types only - IFF doesn't store resources/quantities)
        document.schematicData.iffData.slots = document.schematicData.luaData.slots.map(slot => ({
            templateName: slot.templateName,
            titleName: slot.titleName,
            slotType: slot.slotType,
            resourceType: '',  // IFF doesn't store this
            quantity: 0,       // IFF doesn't store this
            contribution: 100
        }));

        // Recalculate differences
        document.schematicData.differences = compareSchematic(
            document.schematicData.iffData,
            document.schematicData.luaData
        );

        webviewPanel.webview.postMessage({
            type: 'schematicUpdated',
            schematicData: document.schematicData
        });

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {},
            redo: () => {}
        });
    }

    private handleSyncIffToLua(
        document: IFFEditorDocument,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData?.iffData || !document.schematicData?.luaData) return;

        // Sync IFF slot names/types to Lua (preserve Lua resource/quantity data where possible)
        const iffSlots = document.schematicData.iffData.slots;
        const luaSlots = document.schematicData.luaData.slots;

        document.schematicData.luaData.slots = iffSlots.map((iffSlot, i) => ({
            templateName: iffSlot.templateName,
            titleName: iffSlot.titleName,
            slotType: iffSlot.slotType,
            resourceType: luaSlots[i]?.resourceType || '',
            quantity: luaSlots[i]?.quantity || 0,
            contribution: luaSlots[i]?.contribution || 100
        }));

        // Recalculate differences
        document.schematicData.differences = compareSchematic(
            document.schematicData.iffData,
            document.schematicData.luaData
        );

        webviewPanel.webview.postMessage({
            type: 'schematicUpdated',
            schematicData: document.schematicData
        });

        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {},
            redo: () => {}
        });
    }

    private async handleSaveBoth(
        document: IFFEditorDocument,
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        try {
            // Save IFF file
            const iffData = serializeIFF(document.iffDoc);
            await vscode.workspace.fs.writeFile(document.uri, iffData);

            // Save Lua file if it exists and we have data
            if (document.luaPath && document.schematicData?.luaData) {
                const objectName = this.extractObjectNameFromPath(document.luaPath);
                const iffRelPath = this.getIffRelativePath(document.uri.fsPath);
                const luaContent = generateLuaContent(
                    document.schematicData.luaData,
                    objectName,
                    iffRelPath
                );
                fs.writeFileSync(document.luaPath, luaContent, 'utf8');
            }

            webviewPanel.webview.postMessage({
                type: 'documentSaved',
                savedBoth: true
            });
        } catch (err: any) {
            console.error('Save error:', err);
            webviewPanel.webview.postMessage({
                type: 'saveError',
                error: err.message
            });
        }
    }

    private extractObjectNameFromPath(luaPath: string): string {
        // Extract object name from Lua path
        // e.g., "/path/to/pistol_westar31b_schematic.lua" -> "pistol_westar31b_schematic"
        const filename = path.basename(luaPath, '.lua');
        return filename;
    }

    private getIffRelativePath(iffPath: string): string {
        // Extract relative IFF path for Lua template registration
        // e.g., "object/draft_schematic/weapon/shared_pistol_westar31b_schematic.iff"
        const match = iffPath.match(/(object\/draft_schematic\/.+\.iff)$/i);
        return match ? match[1] : path.basename(iffPath);
    }

    // Fix handlers - resolve mismatches between IFF and Lua

    private handleFixUseIff(
        document: IFFEditorDocument,
        slotIndex: number,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData?.iffData || !document.schematicData?.luaData) return;

        const iffSlot = document.schematicData.iffData.slots[slotIndex];
        if (!iffSlot) return;

        // Copy IFF values to Lua slot
        if (document.schematicData.luaData.slots[slotIndex]) {
            document.schematicData.luaData.slots[slotIndex].templateName = iffSlot.templateName;
            document.schematicData.luaData.slots[slotIndex].titleName = iffSlot.titleName;
            document.schematicData.luaData.slots[slotIndex].slotType = iffSlot.slotType;
        }

        this.refreshSchematicComparison(document, webviewPanel);
    }

    private handleFixUseLua(
        document: IFFEditorDocument,
        slotIndex: number,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData?.iffData || !document.schematicData?.luaData) return;

        const luaSlot = document.schematicData.luaData.slots[slotIndex];
        if (!luaSlot) return;

        // Copy Lua values to IFF slot
        if (document.schematicData.iffData.slots[slotIndex]) {
            document.schematicData.iffData.slots[slotIndex].templateName = luaSlot.templateName;
            document.schematicData.iffData.slots[slotIndex].titleName = luaSlot.titleName;
            document.schematicData.iffData.slots[slotIndex].slotType = luaSlot.slotType;
        }

        this.refreshSchematicComparison(document, webviewPanel);
    }

    private handleFixAddToIff(
        document: IFFEditorDocument,
        slotIndex: number,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData?.iffData || !document.schematicData?.luaData) return;

        const luaSlot = document.schematicData.luaData.slots[slotIndex];
        if (!luaSlot) return;

        // Add Lua slot to IFF (IFF only stores name/type, not resource/quantity)
        const newIffSlot = {
            templateName: luaSlot.templateName,
            titleName: luaSlot.titleName,
            slotType: luaSlot.slotType,
            resourceType: '',
            quantity: 0,
            contribution: 100
        };

        // Insert at the correct position
        document.schematicData.iffData.slots.splice(slotIndex, 0, newIffSlot);

        this.refreshSchematicComparison(document, webviewPanel);
    }

    private handleFixAddToLua(
        document: IFFEditorDocument,
        slotIndex: number,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData?.iffData || !document.schematicData?.luaData) return;

        const iffSlot = document.schematicData.iffData.slots[slotIndex];
        if (!iffSlot) return;

        // Add IFF slot to Lua
        const newLuaSlot = {
            templateName: iffSlot.templateName,
            titleName: iffSlot.titleName,
            slotType: iffSlot.slotType,
            resourceType: '',
            quantity: 0,
            contribution: 100
        };

        // Insert at the correct position
        document.schematicData.luaData.slots.splice(slotIndex, 0, newLuaSlot);

        this.refreshSchematicComparison(document, webviewPanel);
    }

    private handleFixRemoveLua(
        document: IFFEditorDocument,
        slotIndex: number,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData?.luaData) return;

        // Remove slot from Lua only
        document.schematicData.luaData.slots.splice(slotIndex, 1);

        this.refreshSchematicComparison(document, webviewPanel);
    }

    private handleFixRemoveIff(
        document: IFFEditorDocument,
        slotIndex: number,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData?.iffData) return;

        // Remove slot from IFF only
        document.schematicData.iffData.slots.splice(slotIndex, 1);

        this.refreshSchematicComparison(document, webviewPanel);
    }

    private handleFixResourceType(
        document: IFFEditorDocument,
        slotIndex: number,
        resourceType: string,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData?.luaData) return;

        // Update the resource type in Lua slot
        if (document.schematicData.luaData.slots[slotIndex]) {
            document.schematicData.luaData.slots[slotIndex].resourceType = resourceType;
        }

        this.refreshSchematicComparison(document, webviewPanel);
    }

    private async handleFixExperimentalProperty(
        document: IFFEditorDocument,
        slotIndex: number,
        propertyCode: string,
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        if (!document.schematicData) return;

        const targetTemplatePath = document.schematicData.targetTemplatePath;
        const missingProps = document.schematicData.experimentalErrors?.find(
            e => e.slotIndex === slotIndex
        )?.missingProperties || [];

        const propertyName = PROPERTY_NAMES[propertyCode] || propertyCode;
        const missingNames = missingProps.map(p => PROPERTY_NAMES[p] || p).join(', ');

        if (targetTemplatePath && fs.existsSync(targetTemplatePath)) {
            const result = await vscode.window.showInformationMessage(
                `To use ${propertyCode} (${propertyName}) instead of ${missingNames}, you need to edit the target template's experimentalProperties array.`,
                'Open Target Template',
                'Cancel'
            );

            if (result === 'Open Target Template') {
                const uri = vscode.Uri.file(targetTemplatePath);
                await vscode.window.showTextDocument(uri);
            }
        } else {
            vscode.window.showWarningMessage(
                `Target template not found. To fix this, change the experimentalProperties in the crafted item's Lua file to use ${propertyCode} (${propertyName}) instead of ${missingNames}.`
            );
        }
    }

    private refreshSchematicComparison(
        document: IFFEditorDocument,
        webviewPanel: vscode.WebviewPanel
    ): void {
        if (!document.schematicData) return;

        // Recalculate differences
        document.schematicData.differences = compareSchematic(
            document.schematicData.iffData,
            document.schematicData.luaData
        );

        // Notify webview
        webviewPanel.webview.postMessage({
            type: 'schematicUpdated',
            schematicData: document.schematicData
        });

        // Mark document as dirty
        this._onDidChangeCustomDocument.fire({
            document,
            undo: () => {},
            redo: () => {}
        });
    }

    // ==================== End Schematic Handler Methods ====================

    async saveCustomDocument(
        document: IFFEditorDocument,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        const data = serializeIFF(document.iffDoc);
        await vscode.workspace.fs.writeFile(document.uri, data);
    }

    async saveCustomDocumentAs(
        document: IFFEditorDocument,
        destination: vscode.Uri,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        const data = serializeIFF(document.iffDoc);
        await vscode.workspace.fs.writeFile(destination, data);
    }

    async revertCustomDocument(
        document: IFFEditorDocument,
        _cancellation: vscode.CancellationToken
    ): Promise<void> {
        const data = await vscode.workspace.fs.readFile(document.uri);
        document.reload(data);
    }

    async backupCustomDocument(
        document: IFFEditorDocument,
        context: vscode.CustomDocumentBackupContext,
        _cancellation: vscode.CancellationToken
    ): Promise<vscode.CustomDocumentBackup> {
        const data = serializeIFF(document.iffDoc);
        await vscode.workspace.fs.writeFile(context.destination, data);
        return {
            id: context.destination.toString(),
            delete: () => vscode.workspace.fs.delete(context.destination)
        };
    }

    private getHtmlForWebview(_webview: vscode.Webview): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IFF Editor</title>
    <style>
        * {
            box-sizing: border-box;
        }

        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 16px;
            line-height: 1.4;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .header h2 {
            margin: 0;
            font-size: 14px;
            font-weight: 600;
        }

        .derivation {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }

        .tabs {
            display: flex;
            gap: 0;
            margin-bottom: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .tab {
            padding: 8px 16px;
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 13px;
            border-bottom: 2px solid transparent;
            margin-bottom: -1px;
        }

        .tab:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .tab.active {
            border-bottom-color: var(--vscode-focusBorder);
            color: var(--vscode-textLink-foreground);
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
        }

        /* Tree View */
        .tree {
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 13px;
            line-height: 1.6;
        }

        .tree-node {
            position: relative;
            padding-left: 24px;
        }

        .tree-node::before {
            content: '';
            position: absolute;
            left: 8px;
            top: 0;
            bottom: 0;
            width: 1px;
            background: var(--vscode-tree-indentGuidesStroke, rgba(255,255,255,0.1));
        }

        .tree-node.root {
            padding-left: 0;
        }

        .tree-node.root::before {
            display: none;
        }

        .tree-header {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 8px;
            cursor: pointer;
            border-radius: 4px;
            margin: 2px 0;
        }

        .tree-header:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .tree-toggle {
            width: 18px;
            height: 18px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: bold;
            color: var(--vscode-foreground);
            user-select: none;
            flex-shrink: 0;
        }

        .tree-tag {
            font-weight: 700;
            color: var(--vscode-symbolIcon-classForeground, #4EC9B0);
            padding: 1px 6px;
            background: rgba(78, 201, 176, 0.15);
            border-radius: 3px;
            flex-shrink: 0;
        }

        .tree-tag.chunk {
            color: var(--vscode-symbolIcon-fieldForeground, #9CDCFE);
            background: rgba(156, 220, 254, 0.15);
        }

        .tree-form-name {
            font-weight: 600;
            color: var(--vscode-symbolIcon-functionForeground, #DCDCAA);
        }

        .tree-size {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            flex-shrink: 0;
        }

        .tree-preview {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            max-width: 500px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            opacity: 0.8;
        }

        .tree-prop-name {
            color: var(--vscode-symbolIcon-propertyForeground, #9CDCFE);
            font-weight: 500;
        }

        .tree-children {
            display: block;
        }

        .tree-children.collapsed {
            display: none;
        }

        /* Properties View */
        .properties {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .property {
            display: grid;
            grid-template-columns: 200px 1fr;
            gap: 12px;
            padding: 8px;
            background: var(--vscode-input-background);
            border-radius: 4px;
            align-items: start;
        }

        .property:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .property-name {
            font-weight: 500;
            word-break: break-all;
        }

        .property-type {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 2px;
        }

        .property-value {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .property-value input,
        .property-value textarea {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            padding: 4px 8px;
            border-radius: 3px;
            font-family: inherit;
            font-size: inherit;
        }

        .property-value input:focus,
        .property-value textarea:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }

        .stf-reference {
            display: flex;
            gap: 4px;
            align-items: center;
        }

        .stf-reference input {
            flex: 1;
        }

        .stf-reference .separator {
            color: var(--vscode-descriptionForeground);
        }

        .stf-preview {
            font-size: 11px;
            color: var(--vscode-textLink-foreground);
        }

        .raw-hex {
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            word-break: break-all;
        }

        .search-box {
            width: 100%;
            max-width: 300px;
            padding: 6px 10px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            border-radius: 4px;
            margin-bottom: 12px;
        }

        .search-box:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }

        .hidden {
            display: none !important;
        }

        .highlight {
            background: var(--vscode-editor-findMatchHighlightBackground);
        }

        /* Split layout */
        .main-container {
            display: flex;
            gap: 16px;
            height: calc(100vh - 120px);
        }

        .tree-panel {
            flex: 1;
            overflow: auto;
            min-width: 300px;
        }

        .detail-panel {
            width: 400px;
            border-left: 1px solid var(--vscode-panel-border);
            padding-left: 16px;
            overflow: auto;
            display: none;
        }

        .detail-panel.visible {
            display: block;
        }

        .detail-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .detail-header h3 {
            margin: 0;
            font-size: 13px;
        }

        .detail-close {
            background: none;
            border: none;
            color: var(--vscode-foreground);
            cursor: pointer;
            font-size: 16px;
            padding: 4px 8px;
        }

        .detail-close:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .template-editor {
            margin-bottom: 16px;
        }

        .template-editor label {
            display: block;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }

        .template-editor input {
            width: 100%;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 12px;
        }

        .template-editor input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }

        .template-buttons {
            display: flex;
            gap: 8px;
            margin-top: 8px;
        }

        .template-buttons button {
            padding: 4px 12px;
            background: var(--vscode-button-secondaryBackground);
            border: none;
            color: var(--vscode-button-secondaryForeground);
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        }

        .template-buttons button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .template-buttons button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .template-buttons button.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .template-pills {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 8px;
        }

        .pill {
            padding: 4px 10px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border: none;
            border-radius: 12px;
            cursor: pointer;
            font-size: 11px;
            font-weight: 500;
        }

        .pill:hover {
            opacity: 0.85;
        }

        .template-display {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            min-height: 32px;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            margin-bottom: 8px;
        }

        .template-display:empty::before {
            content: 'Click types above to build template...';
            color: var(--vscode-input-placeholderForeground);
            font-size: 12px;
        }

        .template-item {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 2px 8px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border-radius: 10px;
            font-size: 11px;
        }

        .template-item .remove {
            cursor: pointer;
            font-weight: bold;
            opacity: 0.7;
        }

        .template-item .remove:hover {
            opacity: 1;
        }

        .template-saved {
            font-size: 11px;
            color: var(--vscode-testing-iconPassed, #4ec9b0);
            margin-left: 8px;
        }

        .template-fields {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .template-field {
            display: grid;
            grid-template-columns: 80px 1fr;
            gap: 8px;
            align-items: center;
            padding: 6px 8px;
            background: var(--vscode-input-background);
            border-radius: 4px;
        }

        .template-field-name {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .template-field-value {
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 12px;
            word-break: break-all;
        }

        .template-field input {
            width: 100%;
            padding: 4px 6px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 12px;
        }

        .hex-preview {
            margin-top: 16px;
            padding-top: 12px;
            border-top: 1px solid var(--vscode-panel-border);
        }

        .hex-preview h4 {
            margin: 0 0 8px 0;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .hex-content {
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            word-break: break-all;
            max-height: 150px;
            overflow: auto;
        }

        .tree-header.selected {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }

        .field-input.modified {
            border-color: var(--vscode-inputValidation-warningBorder, #cca700) !important;
            background: var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.1)) !important;
        }

        .apply-changes-bar {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            padding: 12px 16px;
            background: var(--vscode-editorWidget-background);
            border-top: 1px solid var(--vscode-panel-border);
            display: none;
            align-items: center;
            justify-content: space-between;
            z-index: 100;
        }

        .apply-changes-bar.visible {
            display: flex;
        }

        .apply-changes-bar .changes-count {
            font-size: 12px;
            color: var(--vscode-foreground);
        }

        .apply-changes-bar button {
            padding: 6px 16px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 12px;
        }

        .apply-changes-bar button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .apply-changes-bar .discard-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            margin-right: 8px;
        }

        .apply-changes-bar .save-btn {
            background: var(--vscode-testing-iconPassed, #4ec9b0);
            color: #000;
            margin-left: 8px;
        }

        .status-message {
            position: fixed;
            bottom: 60px;
            left: 50%;
            transform: translateX(-50%);
            padding: 8px 16px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            font-size: 12px;
            display: none;
            z-index: 101;
        }

        .status-message.visible {
            display: block;
        }

        .status-message.success {
            border-color: var(--vscode-testing-iconPassed, #4ec9b0);
            color: var(--vscode-testing-iconPassed, #4ec9b0);
        }

        .status-message.error {
            border-color: var(--vscode-testing-iconFailed, #f44747);
            color: var(--vscode-testing-iconFailed, #f44747);
        }

        /* Schematic Tab Styles */
        .schematic-container {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .schematic-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px;
            background: var(--vscode-input-background);
            border-radius: 6px;
        }

        .schematic-paths {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .schematic-path {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 11px;
        }

        .schematic-path .label {
            color: var(--vscode-descriptionForeground);
            min-width: 40px;
        }

        .schematic-path .path {
            font-family: var(--vscode-editor-font-family), monospace;
            color: var(--vscode-textLink-foreground);
        }

        .schematic-actions {
            display: flex;
            gap: 8px;
        }

        .schematic-actions button {
            padding: 6px 12px;
            background: var(--vscode-button-secondaryBackground);
            border: none;
            color: var(--vscode-button-secondaryForeground);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }

        .schematic-actions button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .schematic-actions button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .schematic-slots {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .slot-card {
            display: grid;
            grid-template-columns: 30px 1fr 1fr 1fr 110px 70px 50px 30px;
            gap: 10px;
            padding: 12px;
            background: var(--vscode-input-background);
            border-radius: 6px;
            align-items: center;
            border-left: 3px solid transparent;
        }

        .slot-card.match {
            border-left-color: var(--vscode-testing-iconPassed, #4ec9b0);
        }

        .slot-card.mismatch {
            border-left-color: var(--vscode-testing-iconFailed, #f44747);
            background: rgba(244, 71, 71, 0.1);
        }

        .slot-card.missing-iff {
            border-left-color: var(--vscode-inputValidation-warningBorder, #cca700);
            background: rgba(204, 167, 0, 0.1);
        }

        .slot-card.missing-lua {
            border-left-color: var(--vscode-inputValidation-infoBorder, #4fc1ff);
            background: rgba(79, 193, 255, 0.1);
        }

        .slot-card.experimental-error {
            border-left-color: #ff6b6b;
            background: rgba(255, 107, 107, 0.15);
        }

        .slot-index {
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            text-align: center;
        }

        .slot-field {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .slot-field label {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
        }

        .slot-field input, .slot-field select {
            padding: 4px 8px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            font-size: 12px;
            font-family: inherit;
        }

        .slot-field input:focus, .slot-field select:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }

        .slot-field input.error {
            border-color: var(--vscode-testing-iconFailed, #f44747);
            background: rgba(244, 71, 71, 0.1);
        }

        .slot-delete {
            background: none;
            border: none;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            font-size: 16px;
            padding: 4px;
        }

        .slot-delete:hover {
            color: var(--vscode-testing-iconFailed, #f44747);
        }

        .slot-header {
            display: grid;
            grid-template-columns: 30px 1fr 1fr 1fr 110px 70px 50px 30px;
            gap: 10px;
            padding: 8px 12px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            font-weight: 600;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .add-slot-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 12px;
            background: none;
            border: 2px dashed var(--vscode-panel-border);
            color: var(--vscode-descriptionForeground);
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
        }

        .add-slot-btn:hover {
            border-color: var(--vscode-focusBorder);
            color: var(--vscode-foreground);
        }

        .no-lua-warning {
            padding: 16px;
            background: rgba(204, 167, 0, 0.1);
            border: 1px solid var(--vscode-inputValidation-warningBorder, #cca700);
            border-radius: 6px;
            color: var(--vscode-inputValidation-warningForeground);
        }

        .slot-type-badge {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .slot-type-badge.resource { background: rgba(78, 201, 176, 0.2); color: #4ec9b0; }
        .slot-type-badge.identical { background: rgba(156, 220, 254, 0.2); color: #9cdcfe; }
        .slot-type-badge.mixed { background: rgba(220, 220, 170, 0.2); color: #dcdcaa; }
        .slot-type-badge.optional { background: rgba(206, 145, 120, 0.2); color: #ce9178; }

        .experimental-warning {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 12px;
            background: rgba(255, 107, 107, 0.15);
            border: 1px solid #ff6b6b;
            border-radius: 4px;
            font-size: 11px;
            color: #ff6b6b;
            margin-top: 4px;
        }

        .experimental-warning::before {
            content: '⚠';
        }

        .schematic-section {
            margin-top: 16px;
        }

        .schematic-section h3 {
            font-size: 13px;
            font-weight: 600;
            margin: 0 0 12px 0;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .diff-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 4px;
        }

        .diff-indicator.match { background: var(--vscode-testing-iconPassed, #4ec9b0); }
        .diff-indicator.mismatch { background: var(--vscode-testing-iconFailed, #f44747); }
        .diff-indicator.missing { background: var(--vscode-inputValidation-warningBorder, #cca700); }

        /* Fix Options */
        .fix-options {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            background: rgba(255, 255, 255, 0.05);
            border-radius: 4px;
            margin-top: 4px;
        }

        .fix-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .fix-btn {
            padding: 4px 10px;
            font-size: 11px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        .fix-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .fix-use-iff, .fix-add-to-iff {
            background: rgba(79, 193, 255, 0.2);
            color: #4fc1ff;
        }

        .fix-use-iff:hover, .fix-add-to-iff:hover {
            background: rgba(79, 193, 255, 0.3);
        }

        .fix-use-lua, .fix-add-to-lua {
            background: rgba(204, 167, 0, 0.2);
            color: #cca700;
        }

        .fix-use-lua:hover, .fix-add-to-lua:hover {
            background: rgba(204, 167, 0, 0.3);
        }

        .fix-remove-lua, .fix-remove-iff {
            background: rgba(244, 71, 71, 0.2);
            color: #f44747;
        }

        .fix-remove-lua:hover, .fix-remove-iff:hover {
            background: rgba(244, 71, 71, 0.3);
        }

        /* Experimental property fix options */
        .exp-fix-options {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-top: 8px;
            flex-wrap: wrap;
        }

        .exp-fix-options span {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .exp-fix-btn {
            padding: 3px 8px;
            font-size: 10px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            background: rgba(78, 201, 176, 0.2);
            color: #4ec9b0;
        }

        .exp-fix-btn:hover {
            background: rgba(78, 201, 176, 0.35);
        }

        /* Read-only banner */
        .readonly-banner {
            background: var(--vscode-editorWarning-foreground, #cca700);
            color: #000;
            padding: 8px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            font-size: 13px;
        }

        .readonly-banner.hidden {
            display: none;
        }

        .readonly-banner-text {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .readonly-banner-icon {
            font-size: 16px;
        }

        .readonly-banner button {
            padding: 4px 12px;
            background: #000;
            color: #fff;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
        }

        .readonly-banner button:hover {
            background: #333;
        }

        body.readonly .save-btn,
        body.readonly #save-both,
        body.readonly #sync-lua-to-iff,
        body.readonly #sync-iff-to-lua {
            opacity: 0.5;
            cursor: not-allowed;
            pointer-events: none;
        }

        body.readonly .property-value[contenteditable],
        body.readonly textarea {
            background: var(--vscode-input-background);
            opacity: 0.7;
            cursor: not-allowed;
        }
    </style>
</head>
<body>
    <div id="readonly-banner" class="readonly-banner hidden">
        <div class="readonly-banner-text">
            <span class="readonly-banner-icon">🔒</span>
            <span>This file is read-only. Copy it to the working folder to make edits.</span>
        </div>
        <button id="copy-to-working">Copy to Working Folder</button>
    </div>
    <div class="header">
        <div>
            <h2 id="filename">Loading...</h2>
            <div class="derivation" id="derivation"></div>
        </div>
    </div>

    <div class="tabs">
        <button class="tab active" data-tab="strings">Strings</button>
        <button class="tab" data-tab="tree">Tree View</button>
        <button class="tab" data-tab="properties">All Properties</button>
        <button class="tab hidden" data-tab="schematic" id="schematic-tab-btn">Schematic</button>
    </div>

    <div id="tree-tab" class="tab-content">
        <div class="main-container">
            <div class="tree-panel">
                <div id="tree" class="tree"></div>
            </div>
            <div id="detail-panel" class="detail-panel">
                <div class="detail-header">
                    <h3 id="detail-title">Chunk Details</h3>
                    <button class="detail-close" id="detail-close">&times;</button>
                </div>
                <div class="template-editor">
                    <label>Template Builder <span id="template-saved" class="template-saved"></span></label>
                    <div class="template-pills">
                        <button class="pill" data-type="string">string</button>
                        <button class="pill" data-type="byte">byte</button>
                        <button class="pill" data-type="bool">bool</button>
                        <button class="pill" data-type="short">short</button>
                        <button class="pill" data-type="ushort">ushort</button>
                        <button class="pill" data-type="int">int</button>
                        <button class="pill" data-type="uint">uint</button>
                        <button class="pill" data-type="float">float</button>
                    </div>
                    <div class="template-display" id="template-display"></div>
                    <input type="hidden" id="template-input">
                    <div class="template-buttons">
                        <button id="clear-template">Clear</button>
                        <button id="save-template" class="primary">Save for this property</button>
                    </div>
                </div>
                <div id="template-fields" class="template-fields"></div>
                <div class="hex-preview">
                    <h4>Raw Hex</h4>
                    <div id="hex-content" class="hex-content"></div>
                </div>
            </div>
        </div>
    </div>

    <div id="strings-tab" class="tab-content active">
        <input type="text" class="search-box" id="stringsSearchBox" placeholder="Search strings...">
        <div id="strings" class="properties"></div>
    </div>

    <div id="properties-tab" class="tab-content">
        <input type="text" class="search-box" id="searchBox" placeholder="Search properties...">
        <div id="properties" class="properties"></div>
    </div>

    <div id="schematic-tab" class="tab-content">
        <div class="schematic-container">
            <div class="schematic-header">
                <div class="schematic-paths">
                    <div class="schematic-path">
                        <span class="label">IFF:</span>
                        <span class="path" id="iff-path"></span>
                    </div>
                    <div class="schematic-path">
                        <span class="label">Lua:</span>
                        <span class="path" id="lua-path"></span>
                    </div>
                </div>
                <div class="schematic-actions">
                    <button id="sync-lua-to-iff" title="Copy Lua slot names to IFF">Lua → IFF</button>
                    <button id="sync-iff-to-lua" title="Copy IFF slot names to Lua">IFF → Lua</button>
                    <button id="save-both" class="primary">Save Both Files</button>
                </div>
            </div>

            <div id="no-lua-warning" class="no-lua-warning hidden">
                No corresponding Lua file found. Changes will only affect the IFF file.
                <br><br>
                <button id="create-lua-file">Create Lua File</button>
            </div>

            <div class="schematic-section">
                <h3>Ingredient Slots</h3>
                <div class="slot-header">
                    <span>#</span>
                    <span>Template Name</span>
                    <span>Title Name</span>
                    <span>Resource Type</span>
                    <span>Slot Type</span>
                    <span>Qty</span>
                    <span>%</span>
                    <span></span>
                </div>
                <div id="schematic-slots" class="schematic-slots"></div>
                <button class="add-slot-btn" id="add-slot-btn">+ Add Ingredient Slot</button>
            </div>

            <div id="experimental-errors" class="schematic-section hidden">
                <h3>Experimental Property Warnings</h3>
                <div id="experimental-errors-list"></div>
            </div>
        </div>
    </div>

    <div class="apply-changes-bar" id="apply-changes-bar">
        <span class="changes-count" id="changes-count">Unsaved changes</span>
        <div>
            <button id="save-document" class="save-btn">Save File</button>
        </div>
    </div>
    <div class="status-message" id="status-message"></div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentData = null;

        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab + '-tab').classList.add('active');
            });
        });

        // Search for strings tab
        document.getElementById('stringsSearchBox').addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            document.querySelectorAll('#strings .property').forEach(prop => {
                const name = prop.dataset.name.toLowerCase();
                const matches = !term || name.includes(term);
                prop.classList.toggle('hidden', !matches);
            });
        });

        // Search for properties tab
        document.getElementById('searchBox').addEventListener('input', (e) => {
            const term = e.target.value.toLowerCase();
            document.querySelectorAll('#properties .property').forEach(prop => {
                const name = prop.dataset.name.toLowerCase();
                const matches = !term || name.includes(term);
                prop.classList.toggle('hidden', !matches);
            });
        });

        let selectedChunk = null;
        let selectedChunkData = null;
        let templateItems = [];
        let documentDirty = false;

        // Load saved templates from localStorage
        const STORAGE_KEY = 'iff-editor-templates';
        function getSavedTemplates() {
            try {
                return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            } catch { return {}; }
        }
        function saveTemplateForProperty(propName, templateStr) {
            const templates = getSavedTemplates();
            templates[propName] = templateStr;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
        }
        function getTemplateForProperty(propName) {
            return getSavedTemplates()[propName] || '';
        }

        // Template builder functions
        function updateTemplateDisplay() {
            const display = document.getElementById('template-display');
            display.innerHTML = templateItems.map((type, i) => \`
                <span class="template-item">
                    \${type}
                    <span class="remove" data-index="\${i}">&times;</span>
                </span>
            \`).join('');

            // Update hidden input for save
            document.getElementById('template-input').value = templateItems.join(', ');

            // Add remove handlers
            display.querySelectorAll('.remove').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const index = parseInt(btn.dataset.index);
                    templateItems.splice(index, 1);
                    updateTemplateDisplay();
                    applyCurrentTemplate();
                });
            });
        }

        function loadTemplateFromString(templateStr) {
            if (!templateStr) {
                templateItems = [];
            } else {
                templateItems = templateStr.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
            }
            updateTemplateDisplay();
        }

        // Pill click handlers
        document.querySelectorAll('.pill').forEach(pill => {
            pill.addEventListener('click', () => {
                templateItems.push(pill.dataset.type);
                updateTemplateDisplay();
                applyCurrentTemplate();
            });
        });

        // Clear template button
        document.getElementById('clear-template').addEventListener('click', () => {
            templateItems = [];
            updateTemplateDisplay();
            applyCurrentTemplate();
        });

        // Save bar functions
        function updateSaveBar() {
            const bar = document.getElementById('apply-changes-bar');
            if (documentDirty) {
                bar.classList.add('visible');
            } else {
                bar.classList.remove('visible');
            }
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'load') {
                currentData = message.data;
                renderData(currentData);
            } else if (message.type === 'chunkData') {
                selectedChunkData = message.data;
                applyCurrentTemplate();
            } else if (message.type === 'chunkUpdated') {
                // Chunk was updated, mark as dirty
                documentDirty = true;
                updateSaveBar();
            } else if (message.type === 'documentSaved') {
                showStatus(message.savedBoth ? 'Both files saved!' : 'File saved successfully!', 'success');
                documentDirty = false;
                updateSaveBar();
            } else if (message.type === 'saveError') {
                showStatus('Save failed: ' + message.error, 'error');
            } else if (message.type === 'schematicUpdated') {
                // Schematic data was updated, re-render slots
                currentData.schematicData = message.schematicData;
                renderSchematicSlots(message.schematicData);
                setupSchematicEventHandlers();
                showStatus('Schematic updated', 'success');
                documentDirty = true;
                updateSaveBar();
            }
        });

        function showStatus(msg, type) {
            const el = document.getElementById('status-message');
            el.textContent = msg;
            el.className = 'status-message visible ' + (type || '');
            setTimeout(() => {
                el.classList.remove('visible');
            }, 3000);
        }

        // Save document button
        document.getElementById('save-document').addEventListener('click', () => {
            vscode.postMessage({ type: 'saveDocument' });
        });

        // Copy to working folder button
        document.getElementById('copy-to-working').addEventListener('click', () => {
            if (currentData && currentData.workingFolderPath) {
                vscode.postMessage({
                    type: 'copyToWorkingFolder',
                    targetPath: currentData.workingFolderPath
                });
            }
        });

        // Close detail panel
        document.getElementById('detail-close').addEventListener('click', () => {
            document.getElementById('detail-panel').classList.remove('visible');
            document.querySelectorAll('.tree-header.selected').forEach(el => el.classList.remove('selected'));
            selectedChunk = null;
            selectedChunkData = null;
        });

        // Save template button
        document.getElementById('save-template').addEventListener('click', () => {
            if (!selectedChunk) return;
            const templateStr = templateItems.join(', ');
            saveTemplateForProperty(selectedChunk.propName, templateStr);
            document.getElementById('template-saved').textContent = '(saved)';
            setTimeout(() => {
                document.getElementById('template-saved').textContent = '';
            }, 2000);
        });

        function showChunkDetail(header) {
            const offset = parseInt(header.dataset.offset);
            const size = parseInt(header.dataset.size);
            const hex = header.dataset.hex || '';
            const propName = header.querySelector('.tree-prop-name')?.textContent || header.querySelector('.tree-tag')?.textContent || 'Chunk';

            // Update selection
            document.querySelectorAll('.tree-header.selected').forEach(el => el.classList.remove('selected'));
            header.classList.add('selected');

            selectedChunk = { offset, size, propName };

            // Update detail panel
            document.getElementById('detail-title').textContent = propName;
            document.getElementById('hex-content').textContent = hex;
            document.getElementById('detail-panel').classList.add('visible');
            document.getElementById('template-saved').textContent = '';

            // Load saved template for this property into the builder
            const savedTemplate = getTemplateForProperty(propName);
            loadTemplateFromString(savedTemplate);

            // Request full chunk data from extension
            vscode.postMessage({ type: 'getChunkData', offset });
        }

        function parseTemplateString(templateStr) {
            // Parse "string, bool, byte, string" into fields array
            if (!templateStr.trim()) return null;
            const parts = templateStr.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
            return parts.map((type, i) => ({ type, name: \`field\${i + 1}\` }));
        }

        function applyCurrentTemplate() {
            const fieldsContainer = document.getElementById('template-fields');

            if (!selectedChunkData) {
                fieldsContainer.innerHTML = '<div style="color: var(--vscode-descriptionForeground)">No data</div>';
                return;
            }

            if (templateItems.length === 0) {
                // Show raw as editable textarea
                fieldsContainer.innerHTML = \`
                    <div class="template-field" style="grid-template-columns: 1fr;">
                        <textarea class="field-input" data-type="raw" rows="4" style="width:100%; resize:vertical;">\${bytesToAscii(selectedChunkData)}</textarea>
                    </div>\`;
                return;
            }

            const fields = templateItems.map((type, i) => ({ type, name: \`field\${i + 1}\` }));

            // Parse chunk data according to template
            const parsed = parseChunkWithTemplate(selectedChunkData, fields);
            fieldsContainer.innerHTML = parsed.map((f, i) => {
                let inputHtml;
                switch (f.type) {
                    case 'bool':
                        inputHtml = \`<select class="field-input" data-index="\${i}" data-type="\${f.type}">
                            <option value="true" \${f.value ? 'selected' : ''}>True</option>
                            <option value="false" \${!f.value ? 'selected' : ''}>False</option>
                        </select>\`;
                        break;
                    case 'byte':
                        inputHtml = \`<input type="number" class="field-input" data-index="\${i}" data-type="\${f.type}" value="\${f.value}" min="0" max="255">\`;
                        break;
                    case 'short':
                        inputHtml = \`<input type="number" class="field-input" data-index="\${i}" data-type="\${f.type}" value="\${f.value}" min="-32768" max="32767">\`;
                        break;
                    case 'ushort':
                        inputHtml = \`<input type="number" class="field-input" data-index="\${i}" data-type="\${f.type}" value="\${f.value}" min="0" max="65535">\`;
                        break;
                    case 'int':
                        inputHtml = \`<input type="number" class="field-input" data-index="\${i}" data-type="\${f.type}" value="\${f.value}" min="-2147483648" max="2147483647">\`;
                        break;
                    case 'uint':
                        inputHtml = \`<input type="number" class="field-input" data-index="\${i}" data-type="\${f.type}" value="\${f.value}" min="0" max="4294967295">\`;
                        break;
                    case 'float':
                        inputHtml = \`<input type="number" class="field-input" data-index="\${i}" data-type="\${f.type}" value="\${f.value}" step="any">\`;
                        break;
                    case 'double':
                        inputHtml = \`<input type="number" class="field-input" data-index="\${i}" data-type="\${f.type}" value="\${f.value}" step="any">\`;
                        break;
                    default: // string
                        inputHtml = \`<input type="text" class="field-input" data-index="\${i}" data-type="\${f.type}" value="\${escapeHtml(String(f.value))}">\`;
                }
                return \`
                    <div class="template-field">
                        <span class="template-field-name">\${f.type}</span>
                        \${inputHtml}
                    </div>
                \`;
            }).join('');

            // Add change handlers to all field inputs
            fieldsContainer.querySelectorAll('.field-input').forEach(input => {
                input.addEventListener('input', handleFieldChange);
                input.addEventListener('change', handleFieldChange);
            });
        }

        function handleFieldChange(e) {
            console.log('handleFieldChange called, selectedChunk:', selectedChunk);
            // Collect all current field values and serialize to binary
            const newData = serializeFieldsToBytes();
            console.log('serializeFieldsToBytes returned:', newData ? newData.length + ' bytes' : 'null');
            if (newData && selectedChunk) {
                console.log('Sending updateChunk message, offset:', selectedChunk.offset);
                // Send update immediately to extension
                vscode.postMessage({
                    type: 'updateChunk',
                    offset: selectedChunk.offset,
                    newData: newData
                });
            }
        }

        function serializeFieldsToBytes() {
            const fieldsContainer = document.getElementById('template-fields');
            const inputs = fieldsContainer.querySelectorAll('.field-input');
            const bytes = [];

            inputs.forEach((input, i) => {
                const type = input.dataset.type;
                let value;

                if (input.tagName === 'SELECT') {
                    value = input.value === 'true';
                } else if (input.type === 'number') {
                    value = parseFloat(input.value) || 0;
                } else {
                    value = input.value;
                }

                switch (type) {
                    case 'string': {
                        // Null-terminated string
                        for (let j = 0; j < value.length; j++) {
                            bytes.push(value.charCodeAt(j) & 0xFF);
                        }
                        bytes.push(0); // null terminator
                        break;
                    }
                    case 'bool': {
                        bytes.push(value ? 1 : 0);
                        break;
                    }
                    case 'byte': {
                        bytes.push(Math.max(0, Math.min(255, Math.floor(value))) & 0xFF);
                        break;
                    }
                    case 'short': {
                        const v = Math.max(-32768, Math.min(32767, Math.floor(value)));
                        bytes.push(v & 0xFF);
                        bytes.push((v >> 8) & 0xFF);
                        break;
                    }
                    case 'ushort': {
                        const v = Math.max(0, Math.min(65535, Math.floor(value)));
                        bytes.push(v & 0xFF);
                        bytes.push((v >> 8) & 0xFF);
                        break;
                    }
                    case 'int': {
                        const v = Math.floor(value);
                        bytes.push(v & 0xFF);
                        bytes.push((v >> 8) & 0xFF);
                        bytes.push((v >> 16) & 0xFF);
                        bytes.push((v >> 24) & 0xFF);
                        break;
                    }
                    case 'uint': {
                        const v = Math.max(0, Math.floor(value)) >>> 0;
                        bytes.push(v & 0xFF);
                        bytes.push((v >> 8) & 0xFF);
                        bytes.push((v >> 16) & 0xFF);
                        bytes.push((v >> 24) & 0xFF);
                        break;
                    }
                    case 'float': {
                        const buf = new ArrayBuffer(4);
                        new DataView(buf).setFloat32(0, value, true);
                        const arr = new Uint8Array(buf);
                        bytes.push(...arr);
                        break;
                    }
                    case 'double': {
                        const buf = new ArrayBuffer(8);
                        new DataView(buf).setFloat64(0, value, true);
                        const arr = new Uint8Array(buf);
                        bytes.push(...arr);
                        break;
                    }
                }
            });

            return bytes;
        }

        function parseChunkWithTemplate(data, fields) {
            const result = [];
            let offset = 0;

            for (const field of fields) {
                if (offset >= data.length) break;

                let value;
                switch (field.type) {
                    case 'string': {
                        // Null-terminated string
                        let end = offset;
                        while (end < data.length && data[end] !== 0) end++;
                        value = String.fromCharCode(...data.slice(offset, end));
                        offset = end + 1;
                        break;
                    }
                    case 'bool': {
                        value = data[offset] !== 0;
                        offset += 1;
                        break;
                    }
                    case 'byte': {
                        value = data[offset];
                        offset += 1;
                        break;
                    }
                    case 'short':
                    case 'ushort': {
                        if (offset + 2 <= data.length) {
                            const view = new DataView(new Uint8Array(data.slice(offset, offset + 2)).buffer);
                            value = field.type === 'short' ? view.getInt16(0, true) : view.getUint16(0, true);
                            offset += 2;
                        }
                        break;
                    }
                    case 'int':
                    case 'uint': {
                        if (offset + 4 <= data.length) {
                            const view = new DataView(new Uint8Array(data.slice(offset, offset + 4)).buffer);
                            value = field.type === 'int' ? view.getInt32(0, true) : view.getUint32(0, true);
                            offset += 4;
                        }
                        break;
                    }
                    case 'float': {
                        if (offset + 4 <= data.length) {
                            const view = new DataView(new Uint8Array(data.slice(offset, offset + 4)).buffer);
                            value = view.getFloat32(0, true).toFixed(4);
                            offset += 4;
                        }
                        break;
                    }
                    case 'double': {
                        if (offset + 8 <= data.length) {
                            const view = new DataView(new Uint8Array(data.slice(offset, offset + 8)).buffer);
                            value = view.getFloat64(0, true).toFixed(4);
                            offset += 8;
                        }
                        break;
                    }
                    default:
                        value = '?';
                }

                result.push({ name: field.name, type: field.type, value: value ?? '(empty)' });
            }

            return result;
        }

        function bytesToAscii(data) {
            return data.map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('');
        }

        function renderData(data) {
            // Store data globally for copy-to-working handler
            currentData = data;

            // Handle read-only state
            const banner = document.getElementById('readonly-banner');
            if (data.isEditable) {
                banner.classList.add('hidden');
                document.body.classList.remove('readonly');
            } else {
                banner.classList.remove('hidden');
                document.body.classList.add('readonly');
            }

            // Update header
            const filename = data.filePath.split(/[\\\\/]/).pop();
            document.getElementById('filename').textContent = filename;
            document.getElementById('derivation').textContent = data.derivation
                ? 'Extends: ' + data.derivation
                : '';

            // Render tree
            document.getElementById('tree').innerHTML = renderTreeNode(data.tree, true);

            // Render strings and properties
            renderStrings(data.properties);
            renderProperties(data.properties);

            // Handle schematic tab visibility and rendering
            console.log('IFF Editor: isSchematic =', data.isSchematic, 'path =', data.filePath);
            if (data.isSchematic) {
                console.log('IFF Editor: Showing schematic tab, schematicData =', data.schematicData);
                document.getElementById('schematic-tab-btn').classList.remove('hidden');
                renderSchematic(data);
            } else {
                document.getElementById('schematic-tab-btn').classList.add('hidden');
            }

            // Add tree toggle handlers
            document.querySelectorAll('.tree-header').forEach(header => {
                header.addEventListener('click', (e) => {
                    const node = header.closest('.tree-node');
                    const children = node.querySelector('.tree-children');
                    const toggle = header.querySelector('.tree-toggle');

                    // If it's a form with children, toggle expand/collapse
                    if (children) {
                        children.classList.toggle('collapsed');
                        toggle.textContent = children.classList.contains('collapsed') ? '+' : '-';
                    }

                    // If it's a chunk (has data-offset), show detail panel
                    if (header.dataset.offset) {
                        showChunkDetail(header);
                    }
                });
            });
        }

        function renderTreeNode(node, isRoot = false) {
            if (node.type === 'form') {
                const hasChildren = node.children && node.children.length > 0;
                return \`
                    <div class="tree-node \${isRoot ? 'root' : ''}">
                        <div class="tree-header">
                            <span class="tree-toggle">\${hasChildren ? '-' : ''}</span>
                            <span class="tree-tag">FORM</span>
                            <span class="tree-form-name">\${node.formName}</span>
                            <span class="tree-size">(\${node.size} bytes)</span>
                        </div>
                        \${hasChildren ? \`
                            <div class="tree-children">
                                \${node.children.map(c => renderTreeNode(c)).join('')}
                            </div>
                        \` : ''}
                    </div>
                \`;
            } else {
                const propName = node.propertyName ? \`<span class="tree-prop-name">\${escapeHtml(node.propertyName)}</span>\` : '';
                const preview = node.propertyName ? '' : \`<span class="tree-preview">\${escapeHtml(node.preview || '')}</span>\`;
                return \`
                    <div class="tree-node">
                        <div class="tree-header" data-offset="\${node.offset}" data-size="\${node.fullSize || node.size}" data-hex="\${escapeHtml(node.hex || '')}">
                            <span class="tree-toggle"></span>
                            <span class="tree-tag chunk">\${node.tag}</span>
                            \${propName}
                            <span class="tree-size">(\${node.fullSize || node.size} bytes)</span>
                            \${preview}
                        </div>
                    </div>
                \`;
            }
        }

        function renderStrings(properties) {
            // Filter to only string and stf_reference types
            const stringProps = properties.filter(p => p.type === 'string' || p.type === 'stf_reference');
            const container = document.getElementById('strings');
            container.innerHTML = stringProps.map(prop => \`
                <div class="property" data-name="\${escapeHtml(prop.name)}">
                    <div>
                        <div class="property-name">\${escapeHtml(prop.name)}</div>
                        <div class="property-type">\${prop.type}</div>
                    </div>
                    <div class="property-value">
                        \${renderPropertyValue(prop)}
                    </div>
                </div>
            \`).join('');

            // Add event handlers for editable fields
            container.querySelectorAll('input, textarea').forEach(input => {
                input.addEventListener('change', handlePropertyChange);
            });
        }

        function renderProperties(properties) {
            const container = document.getElementById('properties');
            container.innerHTML = properties.map(prop => \`
                <div class="property" data-name="\${escapeHtml(prop.name)}">
                    <div>
                        <div class="property-name">\${escapeHtml(prop.name)}</div>
                        <div class="property-type">\${prop.type}</div>
                    </div>
                    <div class="property-value">
                        \${renderPropertyValue(prop)}
                    </div>
                </div>
            \`).join('');

            // Add event handlers for editable fields
            container.querySelectorAll('input, textarea').forEach(input => {
                input.addEventListener('change', handlePropertyChange);
            });
        }

        function renderPropertyValue(prop) {
            switch (prop.type) {
                case 'stf_reference':
                    const file = prop.value?.file || '';
                    const key = prop.value?.key || '';
                    return \`
                        <div class="stf-reference">
                            <span class="separator">@</span>
                            <input type="text" data-name="\${escapeHtml(prop.name)}" data-field="file" value="\${escapeHtml(file)}" placeholder="file">
                            <span class="separator">:</span>
                            <input type="text" data-name="\${escapeHtml(prop.name)}" data-field="key" value="\${escapeHtml(key)}" placeholder="key">
                        </div>
                        <div class="stf-preview">@\${escapeHtml(file)}:\${escapeHtml(key)}</div>
                    \`;

                case 'string':
                    return \`<input type="text" data-name="\${escapeHtml(prop.name)}" data-field="value" value="\${escapeHtml(prop.value || '')}">\`;

                case 'bool':
                    return \`<input type="checkbox" data-name="\${escapeHtml(prop.name)}" data-field="value" \${prop.value ? 'checked' : ''}>\`;

                case 'int32':
                case 'float':
                    return \`<input type="number" data-name="\${escapeHtml(prop.name)}" data-field="value" value="\${prop.value || 0}" step="\${prop.type === 'float' ? '0.01' : '1'}">\`;

                case 'raw':
                default:
                    return \`<div class="raw-hex">\${escapeHtml(prop.rawHex || '')}</div>\`;
            }
        }

        function handlePropertyChange(e) {
            const input = e.target;
            const name = input.dataset.name;
            const field = input.dataset.field;

            // Find the current property
            const prop = currentData.properties.find(p => p.name === name);
            if (!prop) return;

            let newValue;
            let valueType = prop.type;

            if (prop.type === 'stf_reference') {
                // Get both file and key inputs
                const container = input.closest('.property');
                const fileInput = container.querySelector('[data-field="file"]');
                const keyInput = container.querySelector('[data-field="key"]');
                newValue = {
                    file: fileInput.value,
                    key: keyInput.value
                };
                // Update preview
                const preview = container.querySelector('.stf-preview');
                if (preview) {
                    preview.textContent = '@' + fileInput.value + ':' + keyInput.value;
                }
            } else if (prop.type === 'bool') {
                newValue = input.checked;
            } else if (prop.type === 'int32') {
                newValue = parseInt(input.value, 10) || 0;
            } else if (prop.type === 'float') {
                newValue = parseFloat(input.value) || 0;
            } else {
                newValue = input.value;
            }

            // Update local data
            prop.value = newValue;

            // Notify extension
            vscode.postMessage({
                type: 'updateProperty',
                name: name,
                value: newValue,
                valueType: valueType
            });

            // Show feedback and mark dirty
            showStatus('Updated: ' + name, 'success');
            documentDirty = true;
            updateSaveBar();
        }

        // ==================== Schematic Tab Functions ====================

        const SLOT_TYPES = {
            0: 'Resource',
            1: 'Identical',
            2: 'Mixed',
            3: 'Opt. Identical',
            4: 'Opt. Mixed'
        };

        const SLOT_TYPE_CLASSES = {
            0: 'resource',
            1: 'identical',
            2: 'mixed',
            3: 'optional',
            4: 'optional'
        };

        // Resource property map - which properties exist on which resource types
        const RESOURCE_PROPERTIES = {
            // Organic resources
            'organic': ['DR', 'FL', 'HR', 'MA', 'OQ', 'PE', 'SR', 'UT'],
            'creature_resources': ['DR', 'FL', 'HR', 'MA', 'OQ', 'PE', 'SR', 'UT'],
            'creature_food': ['FL', 'PE'],
            'creature_structural': ['DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
            'bone': ['DR', 'OQ', 'SR'],
            'hide': ['DR', 'HR', 'OQ', 'SR'],
            'meat': ['FL', 'PE'],
            'milk': ['FL', 'PE'],
            'seafood': ['FL', 'PE'],
            'egg': ['FL', 'PE', 'OQ'],

            // Flora
            'flora_resources': ['DR', 'FL', 'HR', 'MA', 'OQ', 'PE', 'SR', 'UT'],
            'fruit': ['FL', 'PE', 'OQ'],
            'vegetable': ['FL', 'PE', 'OQ'],
            'cereal': ['FL', 'PE', 'OQ'],
            'seeds': ['FL', 'PE', 'OQ'],
            'corn': ['FL', 'PE', 'OQ'],
            'rice': ['FL', 'PE', 'OQ'],
            'wheat': ['FL', 'PE', 'OQ'],
            'oats': ['FL', 'PE', 'OQ'],
            'greens': ['FL', 'PE', 'OQ'],
            'beans': ['FL', 'PE', 'OQ'],
            'tubers': ['FL', 'PE', 'OQ'],
            'fungi': ['FL', 'PE', 'OQ'],
            'wood': ['DR', 'OQ', 'SR', 'UT'],

            // Mineral
            'mineral': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
            'aluminum': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
            'copper': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
            'steel': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
            'iron': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],
            'ore': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'SR', 'UT'],

            // Gemstone
            'gemstone': ['OQ'],

            // Radioactive
            'radioactive': ['CD', 'CR', 'DR', 'HR', 'MA', 'OQ', 'PE', 'SR', 'UT'],

            // Gas
            'gas': ['OQ'],

            // Water
            'water': ['PE', 'OQ'],

            // Energy
            'energy': ['PE', 'OQ']
        };

        function renderSchematic(data) {
            if (!data.schematicData) {
                document.getElementById('schematic-slots').innerHTML = '<div class="no-lua-warning">No schematic data available.</div>';
                return;
            }

            const schematic = data.schematicData;

            // Update paths
            document.getElementById('iff-path').textContent = data.filePath.split(/[\\\\/]/).pop();
            document.getElementById('lua-path').textContent = schematic.luaPath
                ? schematic.luaPath.split(/[\\\\/]/).pop()
                : '(not found)';

            // Show/hide no-lua warning
            const noLuaWarning = document.getElementById('no-lua-warning');
            if (!schematic.luaPath) {
                noLuaWarning.classList.remove('hidden');
            } else {
                noLuaWarning.classList.add('hidden');
            }

            // Show difference summary
            const differences = schematic.differences || [];
            const mismatches = differences.filter(d => d.severity === 'mismatch').length;
            const missingIff = differences.filter(d => d.severity === 'missing_iff').length;
            const missingLua = differences.filter(d => d.severity === 'missing_lua').length;

            // Add summary to header if there are differences
            let summaryHtml = '';
            if (mismatches > 0 || missingIff > 0 || missingLua > 0) {
                summaryHtml = '<div style="display: flex; gap: 16px; margin-top: 8px; font-size: 11px;">';
                if (mismatches > 0) {
                    summaryHtml += \`<span style="color: var(--vscode-testing-iconFailed);">⚠ \${mismatches} mismatched slot(s)</span>\`;
                }
                if (missingIff > 0) {
                    summaryHtml += \`<span style="color: var(--vscode-inputValidation-warningForeground);">+ \${missingIff} in Lua only</span>\`;
                }
                if (missingLua > 0) {
                    summaryHtml += \`<span style="color: var(--vscode-inputValidation-infoForeground);">+ \${missingLua} in IFF only</span>\`;
                }
                summaryHtml += '</div>';
            } else if (schematic.luaPath) {
                summaryHtml = '<div style="color: var(--vscode-testing-iconPassed); font-size: 11px; margin-top: 8px;">✓ IFF and Lua are in sync</div>';
            }

            // Insert summary after paths
            const pathsContainer = document.querySelector('.schematic-paths');
            let existingSummary = pathsContainer.querySelector('.diff-summary');
            if (existingSummary) existingSummary.remove();
            if (summaryHtml) {
                const summaryDiv = document.createElement('div');
                summaryDiv.className = 'diff-summary';
                summaryDiv.innerHTML = summaryHtml;
                pathsContainer.appendChild(summaryDiv);
            }

            // Render slots
            renderSchematicSlots(schematic);

            // Setup event handlers
            setupSchematicEventHandlers();
        }

        function renderSchematicSlots(schematic) {
            const container = document.getElementById('schematic-slots');
            const differences = schematic.differences || [];
            const experimentalErrors = schematic.experimentalErrors || [];
            const requiredProps = schematic.requiredExperimentalProperties || [];

            // Get IFF and Lua slots - need to show ALL slots from both sources
            const iffSlots = schematic.iffData?.slots || [];
            const luaSlots = schematic.luaData?.slots || [];
            const maxSlots = Math.max(iffSlots.length, luaSlots.length);

            // Show required experimental properties if available
            const errorsSection = document.getElementById('experimental-errors');
            const errorsList = document.getElementById('experimental-errors-list');
            if (requiredProps.length > 0) {
                errorsSection.classList.remove('hidden');
                let errorsHtml = '<div style="margin-bottom: 12px; font-size: 11px; color: var(--vscode-descriptionForeground);">';
                errorsHtml += '<strong>Target requires:</strong> ' + requiredProps.join(', ');
                errorsHtml += '</div>';
                if (experimentalErrors.length > 0) {
                    errorsHtml += experimentalErrors.map(err => \`
                        <div class="experimental-warning">
                            Slot \${err.slotIndex + 1} ("\${escapeHtml(err.resourceType)}"): \${escapeHtml(err.errorMessage)}
                        </div>
                    \`).join('');
                } else {
                    errorsHtml += '<div style="color: var(--vscode-testing-iconPassed, #4ec9b0);">All resource types have required properties.</div>';
                }
                errorsList.innerHTML = errorsHtml;
            } else {
                errorsSection.classList.add('hidden');
            }

            if (maxSlots === 0) {
                container.innerHTML = '<div style="color: var(--vscode-descriptionForeground); padding: 12px;">No ingredient slots defined.</div>';
                return;
            }

            // Create array of indices to iterate through
            const slotIndices = Array.from({ length: maxSlots }, (_, i) => i);

            container.innerHTML = slotIndices.map((i) => {
                // Get slot from either source - prefer Lua, fall back to IFF
                const iffSlot = iffSlots[i];
                const luaSlot = luaSlots[i];
                const slot = luaSlot || iffSlot;
                // Determine slot status
                const diff = differences.find(d => d.index === i);
                let statusClass = 'match';
                if (diff) {
                    statusClass = diff.severity;
                }

                // Check for experimental property errors from backend validation
                const expError = experimentalErrors.find(e => e.slotIndex === i);
                const hasExpError = !!expError;

                // Build fix options HTML based on mismatch type
                let fixOptionsHtml = '';
                if (diff) {
                    if (diff.severity === 'mismatch') {
                        fixOptionsHtml = \`
                            <div class="fix-options" style="grid-column: 1 / -1;">
                                <span class="fix-label">Fix mismatch:</span>
                                <button class="fix-btn fix-use-iff" data-index="\${i}" title="Copy IFF values to Lua">Use IFF → Lua</button>
                                <button class="fix-btn fix-use-lua" data-index="\${i}" title="Copy Lua values to IFF">Use Lua → IFF</button>
                            </div>
                        \`;
                    } else if (diff.severity === 'missing_iff') {
                        fixOptionsHtml = \`
                            <div class="fix-options" style="grid-column: 1 / -1;">
                                <span class="fix-label">Slot only in Lua:</span>
                                <button class="fix-btn fix-add-to-iff" data-index="\${i}" title="Add this slot to IFF">Add to IFF</button>
                                <button class="fix-btn fix-remove-lua" data-index="\${i}" title="Remove from Lua">Remove</button>
                            </div>
                        \`;
                    } else if (diff.severity === 'missing_lua') {
                        fixOptionsHtml = \`
                            <div class="fix-options" style="grid-column: 1 / -1;">
                                <span class="fix-label">Slot only in IFF:</span>
                                <button class="fix-btn fix-add-to-lua" data-index="\${i}" title="Add this slot to Lua">Add to Lua</button>
                                <button class="fix-btn fix-remove-iff" data-index="\${i}" title="Remove from IFF">Remove</button>
                            </div>
                        \`;
                    }
                }

                return \`
                    <div class="slot-card \${statusClass} \${hasExpError ? 'experimental-error' : ''}" data-index="\${i}">
                        <span class="slot-index">\${i + 1}</span>

                        <div class="slot-field">
                            <label>Template</label>
                            <input type="text" class="slot-template" value="\${escapeHtml(slot.templateName)}" data-field="templateName">
                        </div>

                        <div class="slot-field">
                            <label>Title</label>
                            <input type="text" class="slot-title" value="\${escapeHtml(slot.titleName)}" data-field="titleName">
                        </div>

                        <div class="slot-field">
                            <label>Resource</label>
                            <input type="text" class="slot-resource" value="\${escapeHtml(slot.resourceType || '')}" data-field="resourceType" title="\${escapeHtml(slot.resourceType || '')}">
                        </div>

                        <div class="slot-field">
                            <label>Type</label>
                            <select class="slot-type" data-field="slotType">
                                \${Object.entries(SLOT_TYPES).map(([val, label]) =>
                                    \`<option value="\${val}" \${slot.slotType == val ? 'selected' : ''}>\${label}</option>\`
                                ).join('')}
                            </select>
                        </div>

                        <div class="slot-field">
                            <label>Qty</label>
                            <input type="number" class="slot-quantity" value="\${slot.quantity || 0}" data-field="quantity" min="0">
                        </div>

                        <div class="slot-field">
                            <label>%</label>
                            <input type="number" class="slot-contribution" value="\${slot.contribution || 100}" data-field="contribution" min="0" max="100">
                        </div>

                        <button class="slot-delete" data-index="\${i}" title="Delete slot">&times;</button>

                        \${fixOptionsHtml}
                        \${hasExpError ? \`
                            <div class="experimental-warning" style="grid-column: 1 / -1;">
                                \${escapeHtml(expError.errorMessage)}
                                \${expError.suggestedFixes && expError.suggestedFixes.length > 0 ? \`
                                    <div class="exp-fix-options">
                                        <span>Use instead:</span>
                                        \${expError.suggestedFixes.slice(0, 5).map(fix => \`
                                            <button class="exp-fix-btn" data-index="\${i}" data-property="\${escapeHtml(fix.propertyCode)}" title="\${escapeHtml(fix.propertyName)}">\${escapeHtml(fix.propertyCode)}</button>
                                        \`).join('')}
                                    </div>
                                \` : ''}
                            </div>
                        \` : ''}
                    </div>
                \`;
            }).join('');
        }

        // Placeholder function - validation is now done on backend
        function validateExperimentalProperties(slot) {
            return null;
        }

        function setupSchematicEventHandlers() {
            // Slot field changes
            document.querySelectorAll('.slot-card input, .slot-card select').forEach(input => {
                input.addEventListener('change', handleSlotFieldChange);
            });

            // Delete slot buttons
            document.querySelectorAll('.slot-delete').forEach(btn => {
                btn.addEventListener('click', handleDeleteSlot);
            });

            // Add slot button
            document.getElementById('add-slot-btn')?.addEventListener('click', handleAddSlot);

            // Sync buttons
            document.getElementById('sync-lua-to-iff')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'syncLuaToIff' });
            });

            document.getElementById('sync-iff-to-lua')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'syncIffToLua' });
            });

            // Save both button
            document.getElementById('save-both')?.addEventListener('click', () => {
                vscode.postMessage({ type: 'saveBoth' });
            });

            // Fix buttons
            document.querySelectorAll('.fix-use-iff').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    vscode.postMessage({ type: 'fixUseIff', slotIndex: index });
                });
            });

            document.querySelectorAll('.fix-use-lua').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    vscode.postMessage({ type: 'fixUseLua', slotIndex: index });
                });
            });

            document.querySelectorAll('.fix-add-to-iff').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    vscode.postMessage({ type: 'fixAddToIff', slotIndex: index });
                });
            });

            document.querySelectorAll('.fix-add-to-lua').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    vscode.postMessage({ type: 'fixAddToLua', slotIndex: index });
                });
            });

            document.querySelectorAll('.fix-remove-lua').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    vscode.postMessage({ type: 'fixRemoveLua', slotIndex: index });
                });
            });

            document.querySelectorAll('.fix-remove-iff').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    vscode.postMessage({ type: 'fixRemoveIff', slotIndex: index });
                });
            });

            // Experimental property fix buttons - suggest changing the required property
            document.querySelectorAll('.exp-fix-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const index = parseInt(e.target.dataset.index);
                    const propertyCode = e.target.dataset.property;
                    vscode.postMessage({ type: 'fixExperimentalProperty', slotIndex: index, propertyCode: propertyCode });
                });
            });
        }

        function handleSlotFieldChange(e) {
            const input = e.target;
            const card = input.closest('.slot-card');
            const slotIndex = parseInt(card.dataset.index);
            const field = input.dataset.field;

            // Collect all slot data from the input fields
            const slotData = {
                templateName: card.querySelector('[data-field="templateName"]').value,
                titleName: card.querySelector('[data-field="titleName"]').value,
                slotType: parseInt(card.querySelector('[data-field="slotType"]').value),
                resourceType: card.querySelector('[data-field="resourceType"]').value,
                quantity: parseInt(card.querySelector('[data-field="quantity"]').value) || 0,
                contribution: parseInt(card.querySelector('[data-field="contribution"]').value) || 100
            };

            // Send update to extension - this will update BOTH IFF and Lua
            vscode.postMessage({
                type: 'updateSchematicSlot',
                slotIndex: slotIndex,
                slotData: slotData
            });

            documentDirty = true;
            updateSaveBar();
        }

        function handleDeleteSlot(e) {
            const slotIndex = parseInt(e.target.dataset.index);

            if (confirm('Delete this ingredient slot from both IFF and Lua files?')) {
                vscode.postMessage({
                    type: 'deleteSchematicSlot',
                    slotIndex: slotIndex
                });
            }
        }

        function handleAddSlot() {
            const newSlot = {
                templateName: 'craft_weapon_ingredients_n',
                titleName: 'new_ingredient',
                slotType: 0,  // RESOURCESLOT
                resourceType: '',
                quantity: 1,
                contribution: 100
            };

            vscode.postMessage({
                type: 'addSchematicSlot',
                slotData: newSlot
            });
        }

        // ==================== End Schematic Tab Functions ====================

        function escapeHtml(str) {
            if (typeof str !== 'string') return '';
            return str
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        // Notify extension we're ready
        vscode.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }
}
