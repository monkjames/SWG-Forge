import { spawn } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import { parseRecordSummary } from './fieldParser';

export interface CacheInfo {
    exists: boolean;
    buildTime?: string;
    totalRecords?: number;
}

export interface CachedRecordSummary {
    oid: string;
    className: string;
    fieldCount: number;
    compressedSize: number;
    decompressedSize: number;
}

export interface CachedClassEntry {
    className: string;
    count: number;
    avgSize: number;
}

export function getCachePath(dbPath: string): string {
    return dbPath + '.cache';
}

export async function getCacheInfo(dbPath: string): Promise<CacheInfo> {
    const cachePath = getCachePath(dbPath);
    if (!fs.existsSync(cachePath)) {
        return { exists: false };
    }
    try {
        const lines = await querySqlite(cachePath,
            "SELECT key, value FROM cache_meta WHERE key IN ('build_time','total_records') ORDER BY key");
        let buildTime: string | undefined;
        let totalRecords: number | undefined;
        for (const line of lines) {
            const sep = line.indexOf('|');
            if (sep < 0) { continue; }
            const key = line.substring(0, sep);
            const val = line.substring(sep + 1);
            if (key === 'build_time') { buildTime = val; }
            if (key === 'total_records') { totalRecords = parseInt(val, 10) || 0; }
        }
        return { exists: true, buildTime, totalRecords };
    } catch {
        return { exists: false };
    }
}

export function deleteCache(dbPath: string): void {
    const cachePath = getCachePath(dbPath);
    try { fs.unlinkSync(cachePath); } catch {}
    try { fs.unlinkSync(cachePath + '-wal'); } catch {}
    try { fs.unlinkSync(cachePath + '-shm'); } catch {}
}

/**
 * Build the SQLite metadata cache by streaming db5.3_dump.
 * Stores OID, className, fieldCount, sizes — no value_hex.
 * Returns a cancel function.
 */
export function buildCache(
    dbPath: string,
    totalRecordEstimate: number,
    onProgress: (scanned: number) => void,
    onDone: (totalRecords: number) => void,
    onError: (err: Error) => void
): () => void {
    const cachePath = getCachePath(dbPath);
    let cancelled = false;
    let finalized = false;

    // Delete existing cache
    deleteCache(dbPath);

    // Start sqlite3 process
    const sqlite = spawn('sqlite3', [cachePath]);
    let sqliteError = '';
    sqlite.stderr.on('data', (d: Buffer) => { sqliteError += d.toString(); });

    // Send schema with performance pragmas
    sqlite.stdin.write('PRAGMA journal_mode = WAL;\n');
    sqlite.stdin.write('PRAGMA synchronous = OFF;\n');
    sqlite.stdin.write('CREATE TABLE cache_meta (key TEXT PRIMARY KEY, value TEXT);\n');
    sqlite.stdin.write('CREATE TABLE records (\n');
    sqlite.stdin.write('  rownum INTEGER PRIMARY KEY,\n');
    sqlite.stdin.write('  oid TEXT NOT NULL,\n');
    sqlite.stdin.write('  class_name TEXT NOT NULL,\n');
    sqlite.stdin.write('  field_count INTEGER NOT NULL,\n');
    sqlite.stdin.write('  compressed_size INTEGER NOT NULL,\n');
    sqlite.stdin.write('  decompressed_size INTEGER NOT NULL\n');
    sqlite.stdin.write(');\n');

    // Start streaming from BDB
    const dump = spawn('/usr/bin/db5.3_dump', [dbPath]);
    const rl = readline.createInterface({ input: dump.stdout });

    let inData = false;
    let pendingKey: string | null = null;
    let rownum = 0;
    let batchLines: string[] = [];
    const BATCH_SIZE = 5000;

    dump.stderr.on('data', () => {});

    function sqlEsc(s: string): string {
        return s.replace(/'/g, "''");
    }

    function flushBatch(): void {
        if (batchLines.length === 0) { return; }
        sqlite.stdin.write('BEGIN;\n');
        for (const line of batchLines) {
            sqlite.stdin.write(line);
        }
        sqlite.stdin.write('COMMIT;\n');
        batchLines = [];
    }

    function finalize(): void {
        if (finalized) { return; }
        finalized = true;
        cancelled = true;

        flushBatch();

        // Create index after all inserts (much faster)
        sqlite.stdin.write('CREATE INDEX idx_class ON records(class_name);\n');
        sqlite.stdin.write(`INSERT INTO cache_meta VALUES('build_time', '${new Date().toISOString()}');\n`);
        sqlite.stdin.write(`INSERT INTO cache_meta VALUES('total_records', '${rownum}');\n`);
        sqlite.stdin.write(`INSERT INTO cache_meta VALUES('version', '1');\n`);
        sqlite.stdin.write('PRAGMA journal_mode = DELETE;\n');
        sqlite.stdin.end();

        sqlite.on('close', (code) => {
            dump.kill();
            rl.close();
            clearTimeout(timer);
            if (code !== 0) {
                deleteCache(dbPath);
                onError(new Error('sqlite3 failed (code ' + code + '): ' + sqliteError));
            } else {
                onDone(rownum);
            }
        });
    }

    rl.on('line', (line: string) => {
        if (cancelled) { return; }

        if (!inData) {
            if (line === 'HEADER=END') { inData = true; }
            return;
        }

        if (line === 'DATA=END') {
            finalize();
            return;
        }

        const hex = line.startsWith(' ') ? line.substring(1) : line;

        if (pendingKey === null) {
            pendingKey = hex;
        } else {
            let oidStr = '0x0000000000000000';
            try {
                const keyBuf = Buffer.from(pendingKey, 'hex');
                const oid = keyBuf.length >= 8 ? keyBuf.readBigUInt64LE(0) : 0n;
                oidStr = '0x' + oid.toString(16).toUpperCase().padStart(16, '0');
            } catch {}

            try {
                const summary = parseRecordSummary(hex);
                batchLines.push(
                    `INSERT INTO records VALUES(${rownum},'${oidStr}','${sqlEsc(summary.className)}',${summary.fieldCount},${summary.compressedSize},${summary.decompressedSize});\n`
                );
            } catch {
                batchLines.push(
                    `INSERT INTO records VALUES(${rownum},'${oidStr}','[error]',0,${Math.floor(hex.length / 2)},0);\n`
                );
            }

            rownum++;
            pendingKey = null;

            if (batchLines.length >= BATCH_SIZE) {
                flushBatch();
                onProgress(rownum);
            }
        }
    });

    rl.on('close', () => {
        if (!finalized) {
            finalize();
        }
    });

    dump.on('error', (err) => {
        if (!cancelled) {
            cancelled = true;
            finalized = true;
            sqlite.kill();
            clearTimeout(timer);
            onError(new Error('db5.3_dump failed: ' + err.message));
        }
    });

    sqlite.on('error', (err) => {
        if (!cancelled) {
            cancelled = true;
            finalized = true;
            dump.kill();
            rl.close();
            clearTimeout(timer);
            onError(new Error('sqlite3 not found. Install with: sudo apt install sqlite3\n' + err.message));
        }
    });

    // 30 minute timeout
    const timer = setTimeout(() => {
        if (!finalized) {
            finalize();
        }
    }, 1800000);

    return () => {
        if (!cancelled) {
            cancelled = true;
            finalized = true;
            clearTimeout(timer);
            dump.kill();
            sqlite.kill();
            rl.close();
            deleteCache(dbPath);
        }
    };
}

/**
 * Run a sqlite3 query and return output lines.
 * Uses -list mode (pipe-separated).
 */
function querySqlite(cachePath: string, sql: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const proc = spawn('sqlite3', ['-list', cachePath, sql]);
        let output = '';
        let stderr = '';

        proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
        proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

        proc.on('close', (code) => {
            if (settled) { return; }
            settled = true;
            if (code !== 0) {
                reject(new Error('sqlite3 query failed: ' + stderr));
                return;
            }
            const lines = output.trim().split('\n').filter(l => l.length > 0);
            resolve(lines);
        });

        proc.on('error', (err) => {
            if (!settled) {
                settled = true;
                reject(new Error('sqlite3 not found: ' + err.message));
            }
        });

        setTimeout(() => {
            if (!settled) {
                settled = true;
                proc.kill();
                reject(new Error('sqlite3 query timed out'));
            }
        }, 30000);
    });
}

export async function queryRecordPage(
    cachePath: string,
    page: number,
    pageSize: number
): Promise<CachedRecordSummary[]> {
    const offset = page * pageSize;
    const lines = await querySqlite(cachePath,
        `SELECT oid, class_name, field_count, compressed_size, decompressed_size FROM records ORDER BY rownum LIMIT ${pageSize} OFFSET ${offset}`);

    return lines.map(line => {
        const parts = line.split('|');
        return {
            oid: parts[0],
            className: parts[1],
            fieldCount: parseInt(parts[2], 10) || 0,
            compressedSize: parseInt(parts[3], 10) || 0,
            decompressedSize: parseInt(parts[4], 10) || 0
        };
    });
}

export async function queryClassIndex(cachePath: string): Promise<CachedClassEntry[]> {
    const lines = await querySqlite(cachePath,
        'SELECT class_name, COUNT(*), CAST(AVG(decompressed_size) AS INTEGER) FROM records GROUP BY class_name ORDER BY COUNT(*) DESC');

    return lines.map(line => {
        const parts = line.split('|');
        return {
            className: parts[0],
            count: parseInt(parts[1], 10) || 0,
            avgSize: parseInt(parts[2], 10) || 0
        };
    });
}

/**
 * Get OID strings for a specific class and page from cache.
 * Returns OIDs in dump key hex format (8-byte LE) for fast key matching.
 */
export async function queryClassOidKeys(
    cachePath: string,
    className: string,
    page: number,
    pageSize: number
): Promise<{ dumpKeys: string[]; total: number }> {
    const escaped = className.replace(/'/g, "''");

    const countLines = await querySqlite(cachePath,
        `SELECT COUNT(*) FROM records WHERE class_name = '${escaped}'`);
    const total = parseInt(countLines[0], 10) || 0;

    const offset = page * pageSize;
    const lines = await querySqlite(cachePath,
        `SELECT oid FROM records WHERE class_name = '${escaped}' ORDER BY rownum LIMIT ${pageSize} OFFSET ${offset}`);

    // Convert OID strings (0x...) to dump key hex format (8-byte LE)
    const dumpKeys: string[] = [];
    for (const oidStr of lines) {
        try {
            const bi = BigInt(oidStr);
            const buf = Buffer.alloc(8);
            buf.writeBigUInt64LE(bi);
            dumpKeys.push(buf.toString('hex'));
        } catch {}
    }

    return { dumpKeys, total };
}

export async function queryClassRecordPage(
    cachePath: string,
    className: string,
    page: number,
    pageSize: number
): Promise<{ records: CachedRecordSummary[]; total: number }> {
    const escaped = className.replace(/'/g, "''");

    // Run count and page query in one call (two statements)
    const countLines = await querySqlite(cachePath,
        `SELECT COUNT(*) FROM records WHERE class_name = '${escaped}'`);
    const total = parseInt(countLines[0], 10) || 0;

    const offset = page * pageSize;
    const lines = await querySqlite(cachePath,
        `SELECT oid, class_name, field_count, compressed_size, decompressed_size FROM records WHERE class_name = '${escaped}' ORDER BY rownum LIMIT ${pageSize} OFFSET ${offset}`);

    const records = lines.map(line => {
        const parts = line.split('|');
        return {
            oid: parts[0],
            className: parts[1],
            fieldCount: parseInt(parts[2], 10) || 0,
            compressedSize: parseInt(parts[3], 10) || 0,
            decompressedSize: parseInt(parts[4], 10) || 0
        };
    });

    return { records, total };
}
