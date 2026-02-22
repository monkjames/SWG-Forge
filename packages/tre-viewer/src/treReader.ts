import * as fs from 'fs';
import * as zlib from 'zlib';

export interface TREHeader {
    magic: string;
    version: string;
    recordCount: number;
    dataOffset: number;
    fileBlockCompressionType: number;
    fileBlockCompressedSize: number;
    nameBlockCompressionType: number;
    nameBlockCompressedSize: number;
    nameBlockUncompressedSize: number;
}

export interface TREFileEntry {
    path: string;
    crc: number;
    uncompressedSize: number;
    fileOffset: number;
    compressionType: number;
    compressedSize: number;
}

export interface TREContents {
    header: TREHeader;
    files: TREFileEntry[];
    totalCompressedSize: number;
    totalUncompressedSize: number;
    archiveSize: number;
}

const MAGIC_TREE = 0x54524545; // 'TREE'

/**
 * Parse a TRE archive and return its file listing.
 * Only reads the header + metadata + name blocks (not file data).
 */
export function parseTRE(filePath: string): TREContents {
    const fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);

    try {
        // Read 36-byte header
        const headerBuf = Buffer.alloc(36);
        fs.readSync(fd, headerBuf, 0, 36, 0);

        const magic = headerBuf.readUInt32LE(0);
        if (magic !== MAGIC_TREE) {
            throw new Error('Not a TRE file (invalid magic: 0x' + magic.toString(16) + ')');
        }

        const header: TREHeader = {
            magic: 'TREE',
            version: headerBuf.toString('ascii', 4, 8).split('').reverse().join(''),
            recordCount: headerBuf.readUInt32LE(8),
            dataOffset: headerBuf.readUInt32LE(12),
            fileBlockCompressionType: headerBuf.readUInt32LE(16),
            fileBlockCompressedSize: headerBuf.readUInt32LE(20),
            nameBlockCompressionType: headerBuf.readUInt32LE(24),
            nameBlockCompressedSize: headerBuf.readUInt32LE(28),
            nameBlockUncompressedSize: headerBuf.readUInt32LE(32),
        };

        // Read compressed file metadata block (starts at dataOffset)
        const fileBlockBuf = Buffer.alloc(header.fileBlockCompressedSize);
        fs.readSync(fd, fileBlockBuf, 0, header.fileBlockCompressedSize, header.dataOffset);

        let fileBlock: Buffer;
        if (header.fileBlockCompressionType === 2) {
            fileBlock = zlib.inflateSync(fileBlockBuf);
        } else {
            fileBlock = fileBlockBuf;
        }

        // Read compressed name block (follows file metadata block)
        const nameBlockOffset = header.dataOffset + header.fileBlockCompressedSize;
        const nameBlockBuf = Buffer.alloc(header.nameBlockCompressedSize);
        fs.readSync(fd, nameBlockBuf, 0, header.nameBlockCompressedSize, nameBlockOffset);

        let nameBlock: Buffer;
        if (header.nameBlockCompressionType === 2) {
            nameBlock = zlib.inflateSync(nameBlockBuf);
        } else {
            nameBlock = nameBlockBuf;
        }

        // Parse file entries (24 bytes each)
        const files: TREFileEntry[] = [];
        let totalCompressed = 0;
        let totalUncompressed = 0;

        for (let i = 0; i < header.recordCount; i++) {
            const offset = i * 24;
            const crc = fileBlock.readUInt32LE(offset);
            const uncompressedSize = fileBlock.readUInt32LE(offset + 4);
            const fileOffset = fileBlock.readUInt32LE(offset + 8);
            const compressionType = fileBlock.readUInt32LE(offset + 12);
            const compressedSize = fileBlock.readUInt32LE(offset + 16);
            const nameOffset = fileBlock.readUInt32LE(offset + 20);

            // Read null-terminated path from name block
            let nameEnd = nameOffset;
            while (nameEnd < nameBlock.length && nameBlock[nameEnd] !== 0) {
                nameEnd++;
            }
            const filePath = nameBlock.toString('utf8', nameOffset, nameEnd);

            files.push({
                path: filePath,
                crc,
                uncompressedSize,
                fileOffset,
                compressionType,
                compressedSize,
            });

            totalCompressed += compressedSize;
            totalUncompressed += uncompressedSize;
        }

        // Sort by path for display
        files.sort((a, b) => a.path.localeCompare(b.path));

        return {
            header,
            files,
            totalCompressedSize: totalCompressed,
            totalUncompressedSize: totalUncompressed,
            archiveSize: stat.size,
        };
    } finally {
        fs.closeSync(fd);
    }
}
