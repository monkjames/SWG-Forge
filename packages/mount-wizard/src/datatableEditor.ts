/**
 * Datatable IFF Editor - wraps the DTII parser for mount datatable operations
 * Parser adapted from vscode-datatable-editor/src/datatableParser.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── DTII Parser (from vscode-datatable-editor) ────────────────────────────

export interface ColumnDef {
    name: string;
    type: ColumnType;
    typeStr: string;
}

export type ColumnType =
    | { kind: 'string' }
    | { kind: 'int'; defaultValue: number }
    | { kind: 'uint'; defaultValue: number }
    | { kind: 'float'; defaultValue: number }
    | { kind: 'bool'; defaultValue: boolean }
    | { kind: 'enum'; values: Map<string, number>; defaultValue: string };

export type CellValue = string | number | boolean;

export interface DatatableData {
    columns: ColumnDef[];
    rows: CellValue[][];
}

export function parseDatatable(data: Uint8Array): DatatableData {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;

    const formTag = readTag(data, pos); pos += 4;
    if (formTag !== 'FORM') throw new Error(`Expected FORM tag, got ${formTag}`);
    pos += 4; // skip size
    const dtiiTag = readTag(data, pos); pos += 4;
    if (dtiiTag !== 'DTII') throw new Error(`Expected DTII tag, got ${dtiiTag}`);

    const form2Tag = readTag(data, pos); pos += 4;
    if (form2Tag !== 'FORM') throw new Error(`Expected inner FORM tag, got ${form2Tag}`);
    pos += 4; // skip size
    pos += 4; // skip version tag

    // COLS
    const colsTag = readTag(data, pos); pos += 4;
    if (colsTag !== 'COLS') throw new Error(`Expected COLS tag, got ${colsTag}`);
    const colsSize = view.getUint32(pos, false); pos += 4;
    const colsEnd = pos + colsSize;
    pos += 4; // skip column count (LE)
    const columnNames: string[] = [];
    while (pos < colsEnd) {
        const str = readNullString(data, pos);
        if (str.length > 0 || pos < colsEnd - 1) columnNames.push(str);
        pos += str.length + 1;
    }
    pos = colsEnd;

    // TYPE
    const typeTag = readTag(data, pos); pos += 4;
    if (typeTag !== 'TYPE') throw new Error(`Expected TYPE tag, got ${typeTag}`);
    const typeSize = view.getUint32(pos, false); pos += 4;
    const typeEnd = pos + typeSize;
    const typeStrings: string[] = [];
    while (pos < typeEnd) {
        const str = readNullString(data, pos);
        if (str.length > 0 || pos < typeEnd - 1) typeStrings.push(str);
        pos += str.length + 1;
    }
    pos = typeEnd;

    const columns: ColumnDef[] = [];
    for (let i = 0; i < columnNames.length; i++) {
        const typeStr = typeStrings[i] || 's';
        columns.push({ name: columnNames[i], type: parseTypeString(typeStr), typeStr });
    }

    // ROWS
    const rowsTag = readTag(data, pos); pos += 4;
    if (rowsTag !== 'ROWS') throw new Error(`Expected ROWS tag, got ${rowsTag}`);
    pos += 4; // skip size
    const rowCount = view.getUint32(pos, true); pos += 4;

    const rows: CellValue[][] = [];
    for (let r = 0; r < rowCount; r++) {
        const row: CellValue[] = [];
        for (const col of columns) {
            const { value, bytesRead } = readCellValue(data, pos, view, col.type);
            row.push(value);
            pos += bytesRead;
        }
        rows.push(row);
    }

    return { columns, rows };
}

export function serializeDatatable(dt: DatatableData): Uint8Array {
    let colsDataSize = 4;
    for (const col of dt.columns) colsDataSize += col.name.length + 1;

    let typeDataSize = 0;
    for (const col of dt.columns) typeDataSize += col.typeStr.length + 1;

    let rowsDataSize = 4;
    for (const row of dt.rows) {
        for (let c = 0; c < dt.columns.length; c++) {
            rowsDataSize += getCellSize(row[c], dt.columns[c].type);
        }
    }

    const innerFormSize = 4 + (8 + colsDataSize) + (8 + typeDataSize) + (8 + rowsDataSize);
    const outerFormSize = 4 + (8 + innerFormSize);
    const totalSize = 8 + outerFormSize;

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const arr = new Uint8Array(buffer);
    let pos = 0;

    writeTag(arr, pos, 'FORM'); pos += 4;
    view.setUint32(pos, outerFormSize, false); pos += 4;
    writeTag(arr, pos, 'DTII'); pos += 4;

    writeTag(arr, pos, 'FORM'); pos += 4;
    view.setUint32(pos, innerFormSize, false); pos += 4;
    writeTag(arr, pos, '0001'); pos += 4;

    writeTag(arr, pos, 'COLS'); pos += 4;
    view.setUint32(pos, colsDataSize, false); pos += 4;
    view.setUint32(pos, dt.columns.length, true); pos += 4;
    for (const col of dt.columns) pos = writeNullString(arr, pos, col.name);

    writeTag(arr, pos, 'TYPE'); pos += 4;
    view.setUint32(pos, typeDataSize, false); pos += 4;
    for (const col of dt.columns) pos = writeNullString(arr, pos, col.typeStr);

    writeTag(arr, pos, 'ROWS'); pos += 4;
    view.setUint32(pos, rowsDataSize, false); pos += 4;
    view.setUint32(pos, dt.rows.length, true); pos += 4;
    for (const row of dt.rows) {
        for (let c = 0; c < dt.columns.length; c++) {
            pos = writeCellValue(arr, view, pos, row[c], dt.columns[c].type);
        }
    }

    return arr;
}

// ─── Helper functions ───────────────────────────────────────────────────────

function parseTypeString(typeStr: string): ColumnType {
    if (typeStr === 's') return { kind: 'string' };
    if (typeStr === 'h') return { kind: 'uint', defaultValue: 0 };
    if (typeStr.startsWith('i') || typeStr === 'I' || typeStr === 'c' || typeStr === 'p' || typeStr === 'z') {
        const match = typeStr.match(/^[iIcpz](?:\[(-?\d+)\])?$/);
        return { kind: 'int', defaultValue: match?.[1] ? parseInt(match[1], 10) : 0 };
    }
    if (typeStr.startsWith('f')) {
        const match = typeStr.match(/^f(?:\[(-?[\d.]+)\])?$/);
        return { kind: 'float', defaultValue: match?.[1] ? parseFloat(match[1]) : 0 };
    }
    if (typeStr.startsWith('b')) {
        const match = typeStr.match(/^b(?:\[([01])\])?$/);
        return { kind: 'bool', defaultValue: match?.[1] === '1' };
    }
    if (typeStr.startsWith('e(')) {
        const match = typeStr.match(/^e\(([^)]+)\)(?:\[([^\]]+)\])?$/);
        if (match) {
            const values = new Map<string, number>();
            let firstKey = '';
            for (const pair of match[1].split(',')) {
                const [name, valStr] = pair.split('=');
                values.set(name.trim(), parseInt(valStr, 10));
                if (!firstKey) firstKey = name.trim();
            }
            return { kind: 'enum', values, defaultValue: match[2] || firstKey };
        }
    }
    return { kind: 'string' };
}

function readTag(data: Uint8Array, pos: number): string {
    return String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
}

function writeTag(arr: Uint8Array, pos: number, tag: string): void {
    for (let i = 0; i < 4; i++) arr[pos + i] = tag.charCodeAt(i);
}

function readNullString(data: Uint8Array, pos: number): string {
    let end = pos;
    while (end < data.length && data[end] !== 0) end++;
    let result = '';
    for (let i = pos; i < end; i++) result += String.fromCharCode(data[i]);
    return result;
}

function writeNullString(arr: Uint8Array, pos: number, str: string): number {
    for (let i = 0; i < str.length; i++) arr[pos++] = str.charCodeAt(i);
    arr[pos++] = 0;
    return pos;
}

function readCellValue(data: Uint8Array, pos: number, view: DataView, type: ColumnType): { value: CellValue; bytesRead: number } {
    switch (type.kind) {
        case 'string': {
            const str = readNullString(data, pos);
            return { value: str, bytesRead: str.length + 1 };
        }
        case 'int': return { value: view.getInt32(pos, true), bytesRead: 4 };
        case 'uint': return { value: view.getUint32(pos, true), bytesRead: 4 };
        case 'float': return { value: view.getFloat32(pos, true), bytesRead: 4 };
        case 'bool': return { value: view.getInt32(pos, true) !== 0, bytesRead: 4 };
        case 'enum': {
            const numValue = view.getInt32(pos, true);
            let name = type.defaultValue;
            for (const [k, v] of type.values.entries()) {
                if (v === numValue) { name = k; break; }
            }
            return { value: name, bytesRead: 4 };
        }
    }
}

function getCellSize(value: CellValue, type: ColumnType): number {
    if (type.kind === 'string') return (value as string).length + 1;
    return 4;
}

function writeCellValue(arr: Uint8Array, view: DataView, pos: number, value: CellValue, type: ColumnType): number {
    switch (type.kind) {
        case 'string': return writeNullString(arr, pos, value as string);
        case 'int': view.setInt32(pos, value as number, true); return pos + 4;
        case 'uint': view.setUint32(pos, value as number, true); return pos + 4;
        case 'float': view.setFloat32(pos, value as number, true); return pos + 4;
        case 'bool': view.setInt32(pos, (value as boolean) ? 1 : 0, true); return pos + 4;
        case 'enum': {
            const numValue = type.values.get(value as string) ?? 0;
            view.setInt32(pos, numValue, true); return pos + 4;
        }
    }
}

// ─── Mount Datatable Operations ─────────────────────────────────────────────

/**
 * Resolve a datatable file, copying from vanilla to working if needed.
 * Returns the working path.
 */
export function ensureWorkingCopy(workspaceRoot: string, relativePath: string): string {
    const workingPath = path.join(workspaceRoot, 'tre/working', relativePath);
    if (fs.existsSync(workingPath)) return workingPath;

    const vanillaPath = path.join(workspaceRoot, 'tre/vanilla', relativePath);
    if (fs.existsSync(vanillaPath)) {
        const dir = path.dirname(workingPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(vanillaPath, workingPath);
        return workingPath;
    }

    const infinityPath = path.join(workspaceRoot, 'tre/infinity', relativePath);
    if (fs.existsSync(infinityPath)) {
        const dir = path.dirname(workingPath);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(infinityPath, workingPath);
        return workingPath;
    }

    throw new Error(`Datatable not found: ${relativePath}`);
}

/** Add a row to valid_scale_range.iff */
export function addValidScaleRange(workspaceRoot: string, appearanceName: string, saddleCapacity: number, scaleMin: number, scaleMax: number): void {
    const filePath = ensureWorkingCopy(workspaceRoot, 'datatables/mount/valid_scale_range.iff');
    const data = new Uint8Array(fs.readFileSync(filePath));
    const dt = parseDatatable(data);

    // Check if already exists
    if (dt.rows.some(r => r[0] === appearanceName)) return;

    dt.rows.push([appearanceName, saddleCapacity, scaleMin, scaleMax]);
    fs.writeFileSync(filePath, serializeDatatable(dt));
}

/** Add a row to logical_saddle_name_map.iff */
export function addLogicalSaddleNameMap(workspaceRoot: string, satName: string, logicalSaddleName: string): void {
    const filePath = ensureWorkingCopy(workspaceRoot, 'datatables/mount/logical_saddle_name_map.iff');
    const data = new Uint8Array(fs.readFileSync(filePath));
    const dt = parseDatatable(data);

    if (dt.rows.some(r => r[0] === satName)) return;

    dt.rows.push([satName, logicalSaddleName]);
    fs.writeFileSync(filePath, serializeDatatable(dt));
}

/** Add a row to rider_pose_map.iff (only for new saddle types) */
export function addRiderPoseMap(workspaceRoot: string, saddleAppearance: string, seatIndex: number, riderPose: string): void {
    const filePath = ensureWorkingCopy(workspaceRoot, 'datatables/mount/rider_pose_map.iff');
    const data = new Uint8Array(fs.readFileSync(filePath));
    const dt = parseDatatable(data);

    if (dt.rows.some(r => r[0] === saddleAppearance)) return;

    dt.rows.push([saddleAppearance, seatIndex, riderPose]);
    fs.writeFileSync(filePath, serializeDatatable(dt));
}

/** Add a row to saddle_appearance_map.iff (only for new saddle types) */
export function addSaddleAppearanceMap(workspaceRoot: string, logicalName: string, capacity: number, saddleAppearance: string): void {
    const filePath = ensureWorkingCopy(workspaceRoot, 'datatables/mount/saddle_appearance_map.iff');
    const data = new Uint8Array(fs.readFileSync(filePath));
    const dt = parseDatatable(data);

    if (dt.rows.some(r => r[0] === logicalName)) return;

    dt.rows.push([logicalName, capacity, saddleAppearance]);
    fs.writeFileSync(filePath, serializeDatatable(dt));
}

/** Get all existing logical saddle names for the dropdown */
export function getExistingSaddleNames(workspaceRoot: string): string[] {
    try {
        const filePath = ensureWorkingCopy(workspaceRoot, 'datatables/mount/logical_saddle_name_map.iff');
        const data = new Uint8Array(fs.readFileSync(filePath));
        const dt = parseDatatable(data);
        const names = new Set<string>();
        for (const row of dt.rows) {
            names.add(row[1] as string);
        }
        return Array.from(names).sort();
    } catch {
        return [];
    }
}

/** Look up existing scale range for an appearance */
export function getScaleRange(workspaceRoot: string, appearanceName: string): { min: number; max: number } | null {
    try {
        const filePath = ensureWorkingCopy(workspaceRoot, 'datatables/mount/valid_scale_range.iff');
        const data = new Uint8Array(fs.readFileSync(filePath));
        const dt = parseDatatable(data);
        const row = dt.rows.find(r => r[0] === appearanceName);
        if (row) return { min: row[2] as number, max: row[3] as number };
    } catch { /* ignore */ }
    return null;
}

/** Look up existing logical saddle name for an appearance */
export function getSaddleNameForAppearance(workspaceRoot: string, appearanceName: string): string | null {
    try {
        const filePath = ensureWorkingCopy(workspaceRoot, 'datatables/mount/logical_saddle_name_map.iff');
        const data = new Uint8Array(fs.readFileSync(filePath));
        const dt = parseDatatable(data);
        const row = dt.rows.find(r => r[0] === appearanceName);
        if (row) return row[1] as string;
    } catch { /* ignore */ }
    return null;
}

/** Look up existing mount speed data from pet_manager.lua */
export function getMountSpeedData(workspaceRoot: string, appearanceName: string): {
    runSpeed: number; gallopMultiplier: number; gallopDuration: number; gallopCooldown: number;
} | null {
    try {
        const filePath = path.join(workspaceRoot, 'infinity4.0.0/MMOCoreORB/bin/scripts/managers/pet_manager.lua');
        const content = fs.readFileSync(filePath, 'utf-8');
        // Match: {"appearance/foo.sat", 17, 1.33, 300, 600}
        const escaped = appearanceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\{"${escaped}"\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*\\}`);
        const match = content.match(regex);
        if (match) {
            return {
                runSpeed: parseFloat(match[1]),
                gallopMultiplier: parseFloat(match[2]),
                gallopDuration: parseFloat(match[3]),
                gallopCooldown: parseFloat(match[4]),
            };
        }
    } catch { /* ignore */ }
    return null;
}
