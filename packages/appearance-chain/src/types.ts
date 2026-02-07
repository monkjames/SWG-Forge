/**
 * Represents one node in the appearance chain tree
 */
export interface ChainNode {
    /** Unique ID for tree node identification */
    id: string;
    /** File type for icon and display */
    fileType: FileType;
    /** The reference path as stored in the parent file */
    referencePath: string;
    /** Resolved absolute path on disk (null if not found) */
    resolvedPath: string | null;
    /** Which TRE directory the file was found in */
    source: 'working' | 'vanilla' | 'infinity' | null;
    /** File size in bytes (0 if missing) */
    fileSize: number;
    /** Whether the file exists on disk */
    exists: boolean;
    /** Display label (e.g., "LOD Level 0 (highest detail)") */
    label?: string;
    /** Child nodes */
    children: ChainNode[];
}

export type FileType =
    | 'apt' | 'sat' | 'lod' | 'lmg'
    | 'msh' | 'mgn' | 'sht' | 'dds'
    | 'eft' | 'skt' | 'lat' | 'object'
    | 'unknown';

/**
 * Summary statistics for the analyzed chain
 */
export interface ChainSummary {
    totalFiles: number;
    existingFiles: number;
    missingFiles: number;
    filesByType: Record<string, number>;
}

/**
 * Full result of a chain analysis
 */
export interface ChainAnalysis {
    rootNode: ChainNode;
    summary: ChainSummary;
    startFile: string;
    analysisTime: number;
}

/**
 * IFF tree node serialized for webview transport (JSON-safe).
 */
export interface IFFNodeJson {
    type: 'form' | 'chunk';
    tag: string;
    formName?: string;
    offset: number;
    size: number;
    /** Full bytes as number array (only for chunks <= 256 bytes) */
    dataArray?: number[];
    /** ASCII preview of first ~80 bytes */
    preview?: string;
    /** Hex dump of first ~64 bytes (only for chunks > 256 bytes) */
    hex?: string;
    /** Actual data length (always present for chunks) */
    fullSize?: number;
    /** First null-terminated string extracted from chunk data (property name) */
    propertyName?: string;
    /** Child nodes (for forms) */
    children?: IFFNodeJson[];
}

/**
 * Extended ChainNode that includes per-file IFF tree
 */
export interface ChainNodeWithIFF extends ChainNode {
    /** Full IFF tree for this file, serialized for the webview */
    iffTree?: IFFNodeJson;
    /** Whether the file is editable (in tre/working/) */
    editable: boolean;
}
