import { spawn } from 'child_process';
import * as readline from 'readline';

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
