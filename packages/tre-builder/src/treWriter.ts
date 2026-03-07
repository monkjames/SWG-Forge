import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';

/**
 * TRE File Format (Version 5):
 *
 * Structure (in order):
 *   1. Header (36 bytes)
 *   2. File Data (individual files, starting at offset 36)
 *   3. File Metadata Block (zlib compressed) - at dataOffset
 *   4. Name Block (zlib compressed)
 *   5. MD5 Block (16 bytes per file)
 *
 * Header (36 bytes):
 *   - 4 bytes: "TREE" magic (as uint32 LE = 0x54524545)
 *   - 4 bytes: "0005" version (as uint32 LE = 0x30303035)
 *   - 4 bytes: record count
 *   - 4 bytes: data offset (where metadata starts, after file data)
 *   - 4 bytes: file block compression type (2 = zlib)
 *   - 4 bytes: file block compressed size
 *   - 4 bytes: name block compression type (2 = zlib)
 *   - 4 bytes: name block compressed size
 *   - 4 bytes: name block uncompressed size
 *
 * File Metadata Block (24 bytes per file, then zlib compressed):
 *   - 4 bytes: CRC32 checksum
 *   - 4 bytes: uncompressed size
 *   - 4 bytes: file offset in TRE (from start of file)
 *   - 4 bytes: compression type (0=none, 2=zlib)
 *   - 4 bytes: compressed size
 *   - 4 bytes: name offset in name block
 */

interface FileRecord {
    relativePath: string;
    absolutePath: string;
    crc32: number;
    uncompressedSize: number;
    compressedData: Buffer;
    compressionType: number;
    md5: Buffer;
    fileOffset: number;
    nameOffset: number;
}

export class TREWriter {

    async build(sourceDir: string, outputPath: string, onStatus?: (status: string) => void): Promise<void> {
        const status = onStatus || (() => {});

        // Step 1: Collect all files
        status('Scanning files...');
        const files = this.collectFiles(sourceDir);

        if (files.length === 0) {
            throw new Error('No files found in source directory');
        }

        status(`Found ${files.length} files, processing...`);

        // Step 2: Read and compress each file, calculate offsets
        const records: FileRecord[] = [];
        let currentFileOffset = 36; // File data starts right after header

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const relativePath = path.relative(sourceDir, file).replace(/\\/g, '/');

            if (i % 50 === 0) {
                status(`Processing ${i + 1}/${files.length}...`);
            }

            const data = fs.readFileSync(file);
            const compressed = zlib.deflateSync(data);  // Default level 6

            // Use compressed if smaller, otherwise store uncompressed
            const useCompression = compressed.length < data.length;
            const finalData = useCompression ? compressed : data;

            records.push({
                relativePath,
                absolutePath: file,
                crc32: this.crc32(Buffer.from(relativePath.toLowerCase())),  // CRC of path (for sorting)
                uncompressedSize: data.length,
                compressedData: finalData,
                compressionType: useCompression ? 2 : 0,
                md5: crypto.createHash('md5').update(data).digest(),
                fileOffset: currentFileOffset,
                nameOffset: 0 // Will be set when building name block
            });

            currentFileOffset += finalData.length;
        }

        status('Building metadata...');

        // Step 3: Build name block and set name offsets
        let nameOffset = 0;
        for (const record of records) {
            record.nameOffset = nameOffset;
            nameOffset += record.relativePath.length + 1; // +1 for null terminator
        }

        const nameBlock = Buffer.alloc(nameOffset);
        let namePos = 0;
        for (const record of records) {
            nameBlock.write(record.relativePath, namePos, 'utf8');
            namePos += record.relativePath.length;
            nameBlock.writeUInt8(0, namePos); // Null terminator
            namePos++;
        }
        const compressedNameBlock = zlib.deflateSync(nameBlock);  // Default compression

        // Step 4: Build file metadata block
        const fileBlock = Buffer.alloc(records.length * 24);
        for (let i = 0; i < records.length; i++) {
            const record = records[i];
            const offset = i * 24;

            fileBlock.writeUInt32LE(record.crc32, offset);
            fileBlock.writeUInt32LE(record.uncompressedSize, offset + 4);
            fileBlock.writeUInt32LE(record.fileOffset, offset + 8);
            fileBlock.writeUInt32LE(record.compressionType, offset + 12);
            fileBlock.writeUInt32LE(record.compressedData.length, offset + 16);
            fileBlock.writeUInt32LE(record.nameOffset, offset + 20);
        }
        const compressedFileBlock = zlib.deflateSync(fileBlock);  // Default compression

        // Step 5: Calculate dataOffset (where metadata starts, after all file data)
        const dataOffset = currentFileOffset; // This is where file data ends

        status('Writing TRE file...');

        // Step 6: Write the TRE file
        const fd = fs.openSync(outputPath, 'w');

        try {
            // Write header
            const header = Buffer.alloc(36);
            header.writeUInt32LE(0x54524545, 0);  // 'TREE' magic
            header.writeUInt32LE(0x30303035, 4);  // '0005' version
            header.writeUInt32LE(records.length, 8);
            header.writeUInt32LE(dataOffset, 12);
            header.writeUInt32LE(2, 16); // File block compression type (zlib)
            header.writeUInt32LE(compressedFileBlock.length, 20);
            header.writeUInt32LE(2, 24); // Name block compression type (zlib)
            header.writeUInt32LE(compressedNameBlock.length, 28);
            header.writeUInt32LE(nameBlock.length, 32);

            fs.writeSync(fd, header);

            // Write file data (in order, starting at offset 36)
            for (const record of records) {
                fs.writeSync(fd, record.compressedData);
            }

            // Write compressed file metadata block (at dataOffset)
            fs.writeSync(fd, compressedFileBlock);

            // Write compressed name block
            fs.writeSync(fd, compressedNameBlock);

            // Write MD5 sums
            for (const record of records) {
                fs.writeSync(fd, record.md5);
            }

        } finally {
            fs.closeSync(fd);
        }

        status(`Done! Built ${outputPath}`);
    }

    private collectFiles(dir: string): string[] {
        const files: string[] = [];

        const scan = (currentDir: string) => {
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);

                if (entry.isDirectory()) {
                    scan(fullPath);
                } else if (entry.isFile()) {
                    files.push(fullPath);
                }
            }
        };

        scan(dir);

        // Sort by SWG CRC of relative path (to match SIE behavior)
        files.sort((a, b) => {
            const relA = path.relative(dir, a).replace(/\\/g, '/').toLowerCase();
            const relB = path.relative(dir, b).replace(/\\/g, '/').toLowerCase();
            const crcA = this.crc32(Buffer.from(relA));
            const crcB = this.crc32(Buffer.from(relB));
            return crcA - crcB;  // Ascending CRC order
        });

        return files;
    }

    /**
     * SWG MPEG-2 CRC32 implementation (polynomial 0x04C11DB7)
     * Used by TRE files for path-based sorting
     */
    private crc32(data: Buffer): number {
        let crc = 0xFFFFFFFF;

        for (let i = 0; i < data.length; i++) {
            crc ^= (data[i] << 24);
            for (let j = 0; j < 8; j++) {
                if (crc & 0x80000000) {
                    crc = ((crc << 1) ^ 0x04C11DB7) >>> 0;
                } else {
                    crc = (crc << 1) >>> 0;
                }
            }
        }

        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
}
