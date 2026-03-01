import { spawn } from 'child_process';
import * as readline from 'readline';
import { parseRecordSummary } from './fieldParser';

export interface DbStats {
    recordCount: number;
    dbType: string;
    pageSize: number;
    byteOrder: string;
}

export interface RawRecord {
    oid: bigint;
    valueHex: string;
}

export interface ClassIndexEntry {
    count: number;
    totalSize: number;
}

export interface ClassRecordField {
    name: string;
    type: string;
    decoded: string;
    size: number;
    hash: string;
    annotation?: string;
}

export interface ClassRecord {
    oid: string;
    fields: ClassRecordField[];
}

export interface ClassPageResult {
    records: ClassRecord[];
    totalMatching: number;
    columns: string[];
    timedOut?: boolean;
}

/**
 * Get database statistics using db5.3_stat -d.
 * Fast — reads metadata pages only, not records.
 */
export async function getDbStats(filePath: string): Promise<DbStats> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const proc = spawn('/usr/bin/db5.3_stat', ['-d', filePath]);
        let output = '';
        let stderr = '';

        proc.stdout.on('data', (data: Buffer) => { output += data.toString(); });
        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            if (settled) { return; }
            settled = true;
            if (code !== 0) {
                reject(new Error(`db5.3_stat failed (code ${code}): ${stderr}`));
                return;
            }

            const lines = output.split('\n');
            let recordCount = 0;
            let dbType = 'hash';
            let pageSize = 16384;
            let byteOrder = 'Little-endian';

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.endsWith('Number of keys in the database')) {
                    recordCount = parseInt(trimmed, 10) || 0;
                } else if (trimmed.endsWith('Underlying database page size')) {
                    pageSize = parseInt(trimmed, 10) || 16384;
                } else if (trimmed.endsWith('Byte order')) {
                    byteOrder = trimmed.replace('Byte order', '').trim();
                } else if (trimmed.endsWith('Hash magic number')) {
                    dbType = 'hash';
                } else if (trimmed.endsWith('Btree magic number')) {
                    dbType = 'btree';
                }
            }

            resolve({ recordCount, dbType, pageSize, byteOrder });
        });

        proc.on('error', (err) => {
            if (settled) { return; }
            settled = true;
            reject(new Error(`Failed to run db5.3_stat: ${err.message}. Is Berkeley DB 5.3 installed?`));
        });

        setTimeout(() => {
            if (!settled) {
                settled = true;
                proc.kill();
                reject(new Error('db5.3_stat timed out after 10s'));
            }
        }, 10000);
    });
}

/**
 * Read a page of records from BDB using db5.3_dump.
 * Spawns the process, skips to the requested page, collects records, then kills it.
 */
export async function getRecordPage(
    filePath: string,
    page: number,
    pageSize: number
): Promise<RawRecord[]> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const proc = spawn('/usr/bin/db5.3_dump', [filePath]);
        const rl = readline.createInterface({ input: proc.stdout });

        let inData = false;
        let pendingKey: string | null = null;
        const skipRecords = page * pageSize;
        let recordIndex = 0;
        const records: RawRecord[] = [];
        let stderr = '';

        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        rl.on('line', (line: string) => {
            if (settled) { return; }

            if (!inData) {
                if (line === 'HEADER=END') {
                    inData = true;
                }
                return;
            }

            if (line === 'DATA=END') {
                settled = true;
                proc.kill();
                rl.close();
                resolve(records);
                return;
            }

            // Each data line starts with a single space
            const hex = line.startsWith(' ') ? line.substring(1) : line;

            if (pendingKey === null) {
                // This is a key line
                pendingKey = hex;
            } else {
                // This is a value line — we have a complete record
                if (recordIndex >= skipRecords) {
                    const keyBuf = Buffer.from(pendingKey, 'hex');
                    const oid = keyBuf.length >= 8 ? keyBuf.readBigUInt64LE(0) : 0n;
                    records.push({ oid, valueHex: hex });
                }

                recordIndex++;
                pendingKey = null;

                if (records.length >= pageSize) {
                    settled = true;
                    proc.kill();
                    rl.close();
                    resolve(records);
                    return;
                }
            }
        });

        rl.on('close', () => {
            if (!settled) {
                settled = true;
                resolve(records);
            }
        });

        proc.on('error', (err) => {
            if (!settled) {
                settled = true;
                reject(new Error(`Failed to run db5.3_dump: ${err.message}`));
            }
        });

        // Timeout: 60s for large databases with deep pagination
        setTimeout(() => {
            if (!settled) {
                settled = true;
                proc.kill();
                resolve(records);
            }
        }, 60000);
    });
}

/**
 * Format an OID for display.
 * Upper 16 bits = database table ID, lower 48 bits = object counter.
 */
export function formatOID(oid: bigint): string {
    return '0x' + oid.toString(16).toUpperCase().padStart(16, '0');
}

export function oidTableId(oid: bigint): number {
    return Number((oid >> 48n) & 0xFFFFn);
}

export function oidCounter(oid: bigint): bigint {
    return oid & 0x0000FFFFFFFFFFFFn;
}

/**
 * Scan all records to build a class name index.
 * Streams db5.3_dump, decompresses each record, extracts className.
 * Calls onProgress periodically with the current class map and scanned count.
 * Returns a cancel function that kills the underlying process.
 */
export function scanClassIndex(
    filePath: string,
    onProgress: (classMap: Map<string, ClassIndexEntry>, scanned: number) => void,
    onDone: (classMap: Map<string, ClassIndexEntry>, total: number) => void,
    onError: (err: Error) => void
): () => void {
    const classMap = new Map<string, ClassIndexEntry>();
    let scanned = 0;
    let cancelled = false;

    const proc = spawn('/usr/bin/db5.3_dump', [filePath]);
    const rl = readline.createInterface({ input: proc.stdout });

    let inData = false;
    let pendingKey: string | null = null;

    proc.stderr.on('data', () => {});

    rl.on('line', (line: string) => {
        if (cancelled) { return; }

        if (!inData) {
            if (line === 'HEADER=END') { inData = true; }
            return;
        }

        if (line === 'DATA=END') {
            cancelled = true;
            rl.close();
            onDone(classMap, scanned);
            return;
        }

        const hex = line.startsWith(' ') ? line.substring(1) : line;

        if (pendingKey === null) {
            pendingKey = hex;
        } else {
            try {
                const summary = parseRecordSummary(hex);
                const entry = classMap.get(summary.className);
                if (entry) {
                    entry.count++;
                    entry.totalSize += summary.decompressedSize;
                } else {
                    classMap.set(summary.className, {
                        count: 1,
                        totalSize: summary.decompressedSize
                    });
                }
            } catch {
                const entry = classMap.get('[error]');
                if (entry) { entry.count++; }
                else { classMap.set('[error]', { count: 1, totalSize: 0 }); }
            }

            scanned++;
            pendingKey = null;

            if (scanned % 1000 === 0) {
                onProgress(classMap, scanned);
            }
        }
    });

    rl.on('close', () => {
        if (!cancelled) {
            cancelled = true;
            onDone(classMap, scanned);
        }
    });

    proc.on('error', (err) => {
        if (!cancelled) {
            cancelled = true;
            onError(new Error(`Failed to run db5.3_dump: ${err.message}`));
        }
    });

    // 10 minute timeout for very large databases
    const timer = setTimeout(() => {
        if (!cancelled) {
            cancelled = true;
            proc.kill();
            rl.close();
            onDone(classMap, scanned);
        }
    }, 600000);

    return () => {
        if (!cancelled) {
            cancelled = true;
            clearTimeout(timer);
            proc.kill();
            rl.close();
        }
    };
}

/**
 * Fetch a page of records filtered by class name.
 * Streams db5.3_dump, decompresses each to check className, collects matching page.
 * Returns fully parsed records with all decoded fields.
 *
 * If knownTotal is provided (from cache), stops early once the page is collected
 * instead of scanning the entire DB for an accurate count.
 */
export async function getRecordPageByClass(
    filePath: string,
    className: string,
    page: number,
    pageSize: number,
    knownTotal?: number
): Promise<ClassPageResult> {
    const { parseRecordDetail } = await import('./fieldParser');

    return new Promise((resolve, reject) => {
        let settled = false;
        const proc = spawn('/usr/bin/db5.3_dump', [filePath]);
        const rl = readline.createInterface({ input: proc.stdout });

        let inData = false;
        let pendingKey: string | null = null;
        const skipMatching = page * pageSize;
        let matchCount = 0;
        const records: ClassRecord[] = [];
        const columnSet = new Set<string>();

        proc.stderr.on('data', () => {});

        function finish(): void {
            if (settled) { return; }
            settled = true;
            proc.kill();
            rl.close();
            const total = knownTotal !== undefined ? knownTotal : matchCount;
            resolve({ records, totalMatching: total, columns: Array.from(columnSet) });
        }

        rl.on('line', (line: string) => {
            if (settled) { return; }

            if (!inData) {
                if (line === 'HEADER=END') { inData = true; }
                return;
            }

            if (line === 'DATA=END') {
                finish();
                return;
            }

            const hex = line.startsWith(' ') ? line.substring(1) : line;

            if (pendingKey === null) {
                pendingKey = hex;
            } else {
                try {
                    const summary = parseRecordSummary(hex);
                    if (summary.className === className) {
                        matchCount++;
                        if (matchCount > skipMatching && records.length < pageSize) {
                            // In the target page range — fully parse
                            const keyBuf = Buffer.from(pendingKey, 'hex');
                            const oid = keyBuf.length >= 8 ? keyBuf.readBigUInt64LE(0) : 0n;
                            const detail = parseRecordDetail(hex);
                            const fields: ClassRecordField[] = [];
                            for (const f of detail.fields) {
                                const hashStr = '0x' + f.hash.toString(16).toUpperCase().padStart(8, '0');
                                fields.push({ name: f.name, type: f.type, decoded: f.decoded, size: f.size, hash: hashStr });
                                if (f.hash !== 0x76457CCA) { // _className excluded from columns
                                    columnSet.add(f.name);
                                }
                            }
                            records.push({ oid: formatOID(oid), fields });
                        }

                        // Early stop: stop when page is full OR all matching records found
                        if (knownTotal !== undefined && (records.length >= pageSize || matchCount >= knownTotal)) {
                            finish();
                            return;
                        }
                    }
                } catch {
                    // skip unparseable records
                }

                pendingKey = null;
            }
        });

        rl.on('close', () => {
            if (!settled) {
                settled = true;
                resolve({ records, totalMatching: matchCount, columns: Array.from(columnSet) });
            }
        });

        proc.on('error', (err) => {
            if (!settled) {
                settled = true;
                reject(new Error(`Failed to run db5.3_dump: ${err.message}`));
            }
        });

        // 60 second timeout for filtered scans
        setTimeout(() => {
            if (!settled) {
                settled = true;
                proc.kill();
                rl.close();
                resolve({ records, totalMatching: matchCount, columns: Array.from(columnSet), timedOut: true });
            }
        }, 60000);
    });
}

/**
 * Fetch records by exact dump key hex strings (from cache OIDs).
 * Only decompresses/parses records whose key matches — skips all others.
 * Much faster than getRecordPageByClass for large databases.
 */
export async function getRecordsByKeys(
    filePath: string,
    targetKeyHexes: Set<string>,
    onProgress?: (scanned: number, found: number) => void
): Promise<ClassPageResult> {
    const { parseRecordDetail } = await import('./fieldParser');

    return new Promise((resolve, reject) => {
        let settled = false;
        const proc = spawn('/usr/bin/db5.3_dump', [filePath]);
        const rl = readline.createInterface({ input: proc.stdout });

        let inData = false;
        let pendingKey: string | null = null;
        let scanned = 0;
        let found = 0;
        const records: ClassRecord[] = [];
        const columnSet = new Set<string>();

        proc.stderr.on('data', () => {});

        function finish(): void {
            if (settled) { return; }
            settled = true;
            proc.kill();
            rl.close();
            resolve({ records, totalMatching: targetKeyHexes.size, columns: Array.from(columnSet) });
        }

        rl.on('line', (line: string) => {
            if (settled) { return; }

            if (!inData) {
                if (line === 'HEADER=END') { inData = true; }
                return;
            }

            if (line === 'DATA=END') {
                finish();
                return;
            }

            const hex = line.startsWith(' ') ? line.substring(1) : line;

            if (pendingKey === null) {
                pendingKey = hex;
            } else {
                scanned++;

                // Key match only — no decompression for non-matching records
                if (targetKeyHexes.has(pendingKey)) {
                    try {
                        const keyBuf = Buffer.from(pendingKey, 'hex');
                        const oid = keyBuf.length >= 8 ? keyBuf.readBigUInt64LE(0) : 0n;
                        const detail = parseRecordDetail(hex);
                        const fields: ClassRecordField[] = [];
                        for (const f of detail.fields) {
                            const hashStr = '0x' + f.hash.toString(16).toUpperCase().padStart(8, '0');
                            fields.push({ name: f.name, type: f.type, decoded: f.decoded, size: f.size, hash: hashStr });
                            if (f.hash !== 0x76457CCA) {
                                columnSet.add(f.name);
                            }
                        }
                        records.push({ oid: formatOID(oid), fields });
                        found++;

                        // All target records found — stop immediately
                        if (found >= targetKeyHexes.size) {
                            finish();
                            return;
                        }
                    } catch {
                        // skip unparseable
                    }
                }

                pendingKey = null;

                if (onProgress && scanned % 100000 === 0) {
                    onProgress(scanned, found);
                }
            }
        });

        rl.on('close', () => {
            if (!settled) {
                settled = true;
                resolve({ records, totalMatching: found, columns: Array.from(columnSet) });
            }
        });

        proc.on('error', (err) => {
            if (!settled) {
                settled = true;
                reject(new Error(`Failed to run db5.3_dump: ${err.message}`));
            }
        });

        // 5 minute timeout for key-matching scans
        setTimeout(() => {
            if (!settled) {
                settled = true;
                proc.kill();
                rl.close();
                resolve({ records, totalMatching: found, columns: Array.from(columnSet), timedOut: true });
            }
        }, 300000);
    });
}
