/**
 * Datatable IFF Parser
 *
 * Format:
 * - FORM DTII
 *   - FORM 0001 (version)
 *     - COLS chunk: null-terminated column names
 *     - TYPE chunk: null-terminated type definitions
 *     - ROWS chunk: row count (4 bytes) + row data
 *
 * Type codes (from SWGEmu DataTableCell.h):
 * - s = string (null-terminated)
 * - i or i[default] = int32 (signed)
 * - h = hex/uint32 (unsigned 32-bit, NOT short!)
 * - f or f[default] = float32
 * - b or b[default] = bool (stored as 4-byte int)
 * - e(name=val,...)[default] = enum (stored as int32)
 * - c, p, z, I = treated as int32
 */

export interface ColumnDef {
    name: string;
    type: ColumnType;
    typeStr: string;  // Original type string for serialization
}

export type ColumnType =
    | { kind: 'string' }
    | { kind: 'int'; defaultValue: number }
    | { kind: 'uint'; defaultValue: number }  // 'h' = hex/unsigned 32-bit
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

    // Read FORM DTII
    const formTag = readTag(data, pos);
    pos += 4;
    if (formTag !== 'FORM') {
        throw new Error(`Expected FORM tag, got ${formTag}`);
    }
    const formSize = view.getUint32(pos, false); // big-endian
    pos += 4;
    const dtiiTag = readTag(data, pos);
    pos += 4;
    if (dtiiTag !== 'DTII') {
        throw new Error(`Expected DTII tag, got ${dtiiTag}`);
    }

    // Read FORM 0001
    const form2Tag = readTag(data, pos);
    pos += 4;
    if (form2Tag !== 'FORM') {
        throw new Error(`Expected inner FORM tag, got ${form2Tag}`);
    }
    const form2Size = view.getUint32(pos, false);
    pos += 4;
    const versionTag = readTag(data, pos);
    pos += 4;
    // Version tag is typically "0001"

    // Read COLS chunk
    const colsTag = readTag(data, pos);
    pos += 4;
    if (colsTag !== 'COLS') {
        throw new Error(`Expected COLS tag, got ${colsTag}`);
    }
    const colsSize = view.getUint32(pos, false);
    pos += 4;

    // Parse column count and names
    const colsEnd = pos + colsSize;
    const columnCount = view.getUint32(pos, true); // little-endian
    pos += 4;

    const columnNames: string[] = [];
    while (pos < colsEnd) {
        const str = readNullString(data, pos);
        if (str.length > 0 || pos < colsEnd - 1) {
            columnNames.push(str);
        }
        pos += str.length + 1;
    }
    pos = colsEnd;

    // Read TYPE chunk
    const typeTag = readTag(data, pos);
    pos += 4;
    if (typeTag !== 'TYPE') {
        throw new Error(`Expected TYPE tag, got ${typeTag}`);
    }
    const typeSize = view.getUint32(pos, false);
    pos += 4;

    const typeEnd = pos + typeSize;
    const typeStrings: string[] = [];
    while (pos < typeEnd) {
        const str = readNullString(data, pos);
        if (str.length > 0 || pos < typeEnd - 1) {
            typeStrings.push(str);
        }
        pos += str.length + 1;
    }
    pos = typeEnd;

    // Build column definitions
    const columns: ColumnDef[] = [];
    for (let i = 0; i < columnNames.length; i++) {
        const typeStr = typeStrings[i] || 's';
        columns.push({
            name: columnNames[i],
            type: parseTypeString(typeStr),
            typeStr
        });
    }

    // Read ROWS chunk
    const rowsTag = readTag(data, pos);
    pos += 4;
    if (rowsTag !== 'ROWS') {
        throw new Error(`Expected ROWS tag, got ${rowsTag}`);
    }
    const rowsSize = view.getUint32(pos, false);
    pos += 4;

    const rowsEnd = pos + rowsSize;
    const rowCount = view.getUint32(pos, true);
    pos += 4;

    // Parse rows
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
    // Calculate sizes
    let colsDataSize = 4; // column count
    for (const col of dt.columns) {
        colsDataSize += col.name.length + 1;
    }

    let typeDataSize = 0;
    for (const col of dt.columns) {
        typeDataSize += col.typeStr.length + 1;
    }

    // Calculate rows size
    let rowsDataSize = 4; // row count
    for (const row of dt.rows) {
        for (let c = 0; c < dt.columns.length; c++) {
            rowsDataSize += getCellSize(row[c], dt.columns[c].type);
        }
    }

    // Total size calculation
    // FORM DTII header: 4 + 4 + 4 = 12
    // FORM 0001 header: 4 + 4 + 4 = 12
    // COLS chunk: 4 + 4 + colsDataSize
    // TYPE chunk: 4 + 4 + typeDataSize
    // ROWS chunk: 4 + 4 + rowsDataSize
    const innerFormSize = 4 + (8 + colsDataSize) + (8 + typeDataSize) + (8 + rowsDataSize);
    const outerFormSize = 4 + (8 + innerFormSize);
    const totalSize = 8 + outerFormSize;

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const arr = new Uint8Array(buffer);
    let pos = 0;

    // Write FORM DTII
    writeTag(arr, pos, 'FORM');
    pos += 4;
    view.setUint32(pos, outerFormSize, false);
    pos += 4;
    writeTag(arr, pos, 'DTII');
    pos += 4;

    // Write FORM 0001
    writeTag(arr, pos, 'FORM');
    pos += 4;
    view.setUint32(pos, innerFormSize, false);
    pos += 4;
    writeTag(arr, pos, '0001');
    pos += 4;

    // Write COLS chunk
    writeTag(arr, pos, 'COLS');
    pos += 4;
    view.setUint32(pos, colsDataSize, false);
    pos += 4;
    view.setUint32(pos, dt.columns.length, true);
    pos += 4;
    for (const col of dt.columns) {
        pos = writeNullString(arr, pos, col.name);
    }

    // Write TYPE chunk
    writeTag(arr, pos, 'TYPE');
    pos += 4;
    view.setUint32(pos, typeDataSize, false);
    pos += 4;
    for (const col of dt.columns) {
        pos = writeNullString(arr, pos, col.typeStr);
    }

    // Write ROWS chunk
    writeTag(arr, pos, 'ROWS');
    pos += 4;
    view.setUint32(pos, rowsDataSize, false);
    pos += 4;
    view.setUint32(pos, dt.rows.length, true);
    pos += 4;

    for (const row of dt.rows) {
        for (let c = 0; c < dt.columns.length; c++) {
            pos = writeCellValue(arr, view, pos, row[c], dt.columns[c].type);
        }
    }

    return arr;
}

function parseTypeString(typeStr: string): ColumnType {
    if (typeStr === 's') {
        return { kind: 'string' };
    }
    if (typeStr === 'h') {
        // 'h' = hex = unsigned 32-bit integer (NOT short!)
        return { kind: 'uint', defaultValue: 0 };
    }
    if (typeStr.startsWith('i') || typeStr === 'I' || typeStr === 'c' || typeStr === 'p' || typeStr === 'z') {
        const match = typeStr.match(/^[iIcpz](?:\[(-?\d+)\])?$/);
        const defaultValue = match && match[1] ? parseInt(match[1], 10) : 0;
        return { kind: 'int', defaultValue };
    }
    if (typeStr.startsWith('f')) {
        const match = typeStr.match(/^f(?:\[(-?[\d.]+)\])?$/);
        const defaultValue = match && match[1] ? parseFloat(match[1]) : 0;
        return { kind: 'float', defaultValue };
    }
    if (typeStr.startsWith('b')) {
        const match = typeStr.match(/^b(?:\[([01])\])?$/);
        const defaultValue = match && match[1] ? match[1] === '1' : false;
        return { kind: 'bool', defaultValue };
    }
    if (typeStr.startsWith('e(')) {
        // e(name=val,name=val,...)[default]
        const match = typeStr.match(/^e\(([^)]+)\)(?:\[([^\]]+)\])?$/);
        if (match) {
            const values = new Map<string, number>();
            const pairs = match[1].split(',');
            let firstKey = '';
            for (const pair of pairs) {
                const [name, valStr] = pair.split('=');
                const val = parseInt(valStr, 10);
                values.set(name.trim(), val);
                if (!firstKey) firstKey = name.trim();
            }
            const defaultValue = match[2] || firstKey;
            return { kind: 'enum', values, defaultValue };
        }
    }
    // Unknown type, treat as string
    return { kind: 'string' };
}

function readTag(data: Uint8Array, pos: number): string {
    return String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
}

function writeTag(arr: Uint8Array, pos: number, tag: string): void {
    for (let i = 0; i < 4; i++) {
        arr[pos + i] = tag.charCodeAt(i);
    }
}

function readNullString(data: Uint8Array, pos: number): string {
    let end = pos;
    while (end < data.length && data[end] !== 0) {
        end++;
    }
    const bytes = data.slice(pos, end);
    return String.fromCharCode(...bytes);
}

function writeNullString(arr: Uint8Array, pos: number, str: string): number {
    for (let i = 0; i < str.length; i++) {
        arr[pos++] = str.charCodeAt(i);
    }
    arr[pos++] = 0;
    return pos;
}

function readCellValue(data: Uint8Array, pos: number, view: DataView, type: ColumnType): { value: CellValue; bytesRead: number } {
    switch (type.kind) {
        case 'string': {
            const str = readNullString(data, pos);
            return { value: str, bytesRead: str.length + 1 };
        }
        case 'int': {
            const value = view.getInt32(pos, true);
            return { value, bytesRead: 4 };
        }
        case 'uint': {
            // 'h' = hex = unsigned 32-bit
            const value = view.getUint32(pos, true);
            return { value, bytesRead: 4 };
        }
        case 'float': {
            const value = view.getFloat32(pos, true);
            return { value, bytesRead: 4 };
        }
        case 'bool': {
            // Bools are stored as 4-byte integers in datatable format
            const value = view.getInt32(pos, true) !== 0;
            return { value, bytesRead: 4 };
        }
        case 'enum': {
            const numValue = view.getInt32(pos, true);
            // Find the name for this value
            let name = type.defaultValue;
            for (const [k, v] of type.values.entries()) {
                if (v === numValue) {
                    name = k;
                    break;
                }
            }
            return { value: name, bytesRead: 4 };
        }
    }
}

function getCellSize(value: CellValue, type: ColumnType): number {
    switch (type.kind) {
        case 'string':
            return (value as string).length + 1;
        case 'int':
        case 'uint':
        case 'float':
        case 'enum':
        case 'bool':  // All non-string types are 4 bytes
            return 4;
    }
}

function writeCellValue(arr: Uint8Array, view: DataView, pos: number, value: CellValue, type: ColumnType): number {
    switch (type.kind) {
        case 'string':
            return writeNullString(arr, pos, value as string);
        case 'int':
            view.setInt32(pos, value as number, true);
            return pos + 4;
        case 'uint':
            view.setUint32(pos, value as number, true);
            return pos + 4;
        case 'float':
            view.setFloat32(pos, value as number, true);
            return pos + 4;
        case 'bool':
            // Bools are stored as 4-byte integers
            view.setInt32(pos, (value as boolean) ? 1 : 0, true);
            return pos + 4;
        case 'enum': {
            const numValue = type.values.get(value as string) ?? 0;
            view.setInt32(pos, numValue, true);
            return pos + 4;
        }
    }
}

// Export type info for the webview
export interface ColumnInfo {
    name: string;
    kind: string;
    typeStr: string;
    enumValues?: string[];
    defaultValue?: CellValue;
}

export function getColumnInfo(col: ColumnDef): ColumnInfo {
    const info: ColumnInfo = {
        name: col.name,
        kind: col.type.kind,
        typeStr: col.typeStr
    };

    switch (col.type.kind) {
        case 'int':
        case 'uint':
            info.defaultValue = col.type.defaultValue;
            break;
        case 'float':
            info.defaultValue = col.type.defaultValue;
            break;
        case 'bool':
            info.defaultValue = col.type.defaultValue;
            break;
        case 'enum':
            info.enumValues = Array.from(col.type.values.keys());
            info.defaultValue = col.type.defaultValue;
            break;
    }

    return info;
}
