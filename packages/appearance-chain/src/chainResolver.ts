/**
 * Chain Resolver - Recursively resolve the full appearance chain from a starting file.
 * Returns ChainNodeWithIFF nodes that include per-file IFF trees for inline editing.
 */

import * as fs from 'fs';
import { parseIFF, IFFNode, nodeToJson } from './iffParser';
import { parseAppearanceReferences } from './appearanceParser';
import { resolveFile, toTREPath, getFileType, normalizeReferencePath, isInWorkingFolder } from './fileResolver';
import { ChainNode, ChainAnalysis, ChainSummary, ChainNodeWithIFF, FileType } from './types';

export class ChainResolver {
    private workspaceRoot: string;
    private visitedPaths: Set<string>;
    private nodeCounter: number;
    /** Map of absolute path -> parsed IFF root for mutation/serialization */
    private _iffRoots: Map<string, IFFNode> = new Map();

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.visitedPaths = new Set();
        this.nodeCounter = 0;
    }

    /** Get the cached IFF roots (for chainPanel to cache for editing) */
    public get iffRoots(): Map<string, IFFNode> {
        return this._iffRoots;
    }

    /**
     * Analyze the full appearance chain starting from a given file.
     */
    public analyze(startPath: string): ChainAnalysis {
        const startTime = Date.now();
        this.visitedPaths.clear();
        this.nodeCounter = 0;
        this._iffRoots.clear();

        const rootNode = this.resolveFromAbsolutePath(startPath);
        const summary = this.computeSummary(rootNode);

        return {
            rootNode,
            summary,
            startFile: startPath,
            analysisTime: Date.now() - startTime
        };
    }

    /**
     * Build a chain node from an absolute file path (the starting point).
     */
    private resolveFromAbsolutePath(absolutePath: string): ChainNodeWithIFF {
        const fileType = this.detectFileType(absolutePath);
        const trePath = toTREPath(absolutePath, this.workspaceRoot);
        const referencePath = trePath || absolutePath;

        // Determine source
        let source: 'working' | 'vanilla' | 'infinity' | null = null;
        if (absolutePath.includes('/tre/working/')) source = 'working';
        else if (absolutePath.includes('/tre/vanilla/')) source = 'vanilla';
        else if (absolutePath.includes('/tre/infinity/')) source = 'infinity';

        const exists = fs.existsSync(absolutePath);
        let fileSize = 0;
        if (exists) {
            fileSize = fs.statSync(absolutePath).size;
        }

        const node: ChainNodeWithIFF = {
            id: `node_${this.nodeCounter++}`,
            fileType,
            referencePath,
            resolvedPath: exists ? absolutePath : null,
            source,
            fileSize,
            exists,
            editable: exists && isInWorkingFolder(absolutePath),
            children: []
        };

        if (exists) {
            this.visitedPaths.add(absolutePath);
            node.children = this.resolveChildren(absolutePath, fileType, node);
        }

        return node;
    }

    /**
     * Build a chain node from a TRE-relative reference path.
     */
    private resolveFromReference(
        refPath: string,
        parentFileType: FileType,
        label?: string
    ): ChainNodeWithIFF {
        const normalizedPath = normalizeReferencePath(refPath, parentFileType);
        const resolved = resolveFile(normalizedPath, this.workspaceRoot);

        const node: ChainNodeWithIFF = {
            id: `node_${this.nodeCounter++}`,
            fileType: getFileType(normalizedPath),
            referencePath: normalizedPath,
            resolvedPath: resolved?.absolutePath || null,
            source: resolved?.source || null,
            fileSize: resolved?.fileSize || 0,
            exists: resolved !== null,
            editable: resolved !== null && isInWorkingFolder(resolved.absolutePath),
            label,
            children: []
        };

        // Only recurse if file exists and not already visited
        if (resolved && !this.visitedPaths.has(resolved.absolutePath)) {
            this.visitedPaths.add(resolved.absolutePath);
            node.children = this.resolveChildren(resolved.absolutePath, node.fileType, node);
        }

        return node;
    }

    /**
     * Parse a file and resolve all its child references.
     * Also attaches the IFF tree to the node for inline display.
     */
    private resolveChildren(absolutePath: string, fileType: FileType, node: ChainNodeWithIFF): ChainNode[] {
        // Terminal file types have no children
        if (['dds', 'eft', 'skt', 'lat', 'unknown'].includes(fileType)) {
            return [];
        }

        try {
            const rawData = new Uint8Array(fs.readFileSync(absolutePath));

            let root: IFFNode | null = null;
            try {
                root = parseIFF(rawData);
            } catch {
                // IFF parsing failed
            }

            if (!root) {
                return [];
            }

            // Cache the IFF root for editing and attach JSON-safe tree to node
            this._iffRoots.set(absolutePath, root);
            node.iffTree = nodeToJson(root);

            const refs = parseAppearanceReferences(fileType, root, rawData);
            return refs.map(ref => this.resolveFromReference(ref.path, fileType, ref.label));
        } catch {
            return [];
        }
    }

    /**
     * Detect the file type, using extension first, then IFF form name for .iff files.
     */
    private detectFileType(absolutePath: string): FileType {
        const extType = getFileType(absolutePath);

        if (extType === 'object') {
            try {
                const rawData = new Uint8Array(fs.readFileSync(absolutePath));
                const root = parseIFF(rawData);

                if (root.formName) {
                    switch (root.formName) {
                        case 'APT ':
                        case 'IAPT':
                            return 'apt';
                        case 'SMAT':
                            return 'sat';
                        case 'DTLA':
                            return 'lod';
                        case 'MLOD':
                            return 'lmg';
                        case 'MESH':
                            return 'msh';
                        case 'SKMG':
                            return 'mgn';
                        case 'SSHT':
                            return 'sht';
                    }
                }
            } catch {
                // Parse failed
            }
        }

        return extType;
    }

    /**
     * Compute summary statistics from the chain tree.
     */
    private computeSummary(node: ChainNode): ChainSummary {
        const summary: ChainSummary = {
            totalFiles: 0,
            existingFiles: 0,
            missingFiles: 0,
            filesByType: {}
        };
        this.walkTree(node, summary);
        return summary;
    }

    private walkTree(node: ChainNode, summary: ChainSummary): void {
        summary.totalFiles++;
        if (node.exists) {
            summary.existingFiles++;
        } else {
            summary.missingFiles++;
        }
        const typeKey = node.fileType;
        summary.filesByType[typeKey] = (summary.filesByType[typeKey] || 0) + 1;
        for (const child of node.children) {
            this.walkTree(child, summary);
        }
    }
}
