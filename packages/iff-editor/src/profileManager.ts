/**
 * Profile Manager - handles loading and matching profiles for IFF files
 *
 * Profiles act as FILTERS - they determine which properties to show/highlight
 * rather than defining what properties exist. All properties are always available.
 */

import * as vscode from 'vscode';
import { minimatch } from 'minimatch';

export interface ProfileField {
    id: string;           // Property name to match
    label?: string;       // Display label (if different from id)
    description?: string; // Help text
    highlight?: boolean;  // Whether to highlight this field
}

export interface Profile {
    name: string;
    pathPatterns: string[];
    priority: number;
    fields?: ProfileField[];  // Fields to highlight/show first
    hideFields?: string[];    // Fields to hide
}

const DEFAULT_PROFILE: Profile = {
    name: 'Default',
    pathPatterns: ['**/*.iff'],
    priority: 0
};

// Built-in profiles
const BUILTIN_PROFILES: Profile[] = [
    {
        name: 'Tangible/Static Object',
        pathPatterns: [
            '**/object/tangible/**/*.iff',
            '**/object/static/**/*.iff'
        ],
        priority: 10,
        fields: [
            { id: 'objectName', label: 'Object Name', highlight: true },
            { id: 'detailedDescription', label: 'Description', highlight: true },
            { id: 'appearanceFilename', label: 'Appearance', highlight: true }
        ]
    },
    {
        name: 'Draft Schematic',
        pathPatterns: ['**/object/draft_schematic/**/*.iff'],
        priority: 10,
        fields: [
            { id: 'objectName', label: 'Object Name', highlight: true },
            { id: 'detailedDescription', label: 'Description', highlight: true },
            { id: 'craftedSharedTemplate', label: 'Crafted Template', highlight: true },
            { id: 'itemsPerContainer', label: 'Items Per Container' },
            { id: 'complexity', label: 'Complexity' },
            { id: 'xpType', label: 'XP Type' },
            { id: 'xp', label: 'XP Amount' }
        ]
    },
    {
        name: 'Intangible Object',
        pathPatterns: ['**/object/intangible/**/*.iff'],
        priority: 10,
        fields: [
            { id: 'objectName', label: 'Object Name', highlight: true },
            { id: 'detailedDescription', label: 'Description', highlight: true }
        ]
    }
];

export class ProfileManager {
    private profiles: Profile[] = [];
    private customProfilesPath: string | undefined;

    constructor(extensionContext: vscode.ExtensionContext) {
        this.profiles = [...BUILTIN_PROFILES, DEFAULT_PROFILE];
        // Could load custom profiles from workspace settings or files here
    }

    /**
     * Find the best matching profile for a file path
     */
    public selectProfile(filePath: string): Profile {
        // Normalize path separators
        const normalizedPath = filePath.replace(/\\/g, '/');

        // Sort by priority (highest first)
        const sorted = [...this.profiles].sort((a, b) => b.priority - a.priority);

        for (const profile of sorted) {
            for (const pattern of profile.pathPatterns) {
                if (minimatch(normalizedPath, pattern, { matchBase: true })) {
                    return profile;
                }
            }
        }

        return DEFAULT_PROFILE;
    }

    /**
     * Get all available profiles
     */
    public getAllProfiles(): Profile[] {
        return [...this.profiles];
    }

    /**
     * Get a profile by name
     */
    public getProfile(name: string): Profile | undefined {
        return this.profiles.find(p => p.name === name);
    }

    /**
     * Add or update a custom profile
     */
    public addProfile(profile: Profile): void {
        const existing = this.profiles.findIndex(p => p.name === profile.name);
        if (existing >= 0) {
            this.profiles[existing] = profile;
        } else {
            this.profiles.push(profile);
        }
    }

    /**
     * Sort properties based on profile - highlighted first, then alphabetical
     */
    public sortProperties(propertyNames: string[], profile: Profile): string[] {
        if (!profile.fields || profile.fields.length === 0) {
            return [...propertyNames].sort();
        }

        const fieldOrder = new Map<string, number>();
        profile.fields.forEach((f, i) => fieldOrder.set(f.id, i));

        const hidden = new Set(profile.hideFields || []);

        return [...propertyNames]
            .filter(name => !hidden.has(name))
            .sort((a, b) => {
                const orderA = fieldOrder.has(a) ? fieldOrder.get(a)! : 1000;
                const orderB = fieldOrder.has(b) ? fieldOrder.get(b)! : 1000;
                if (orderA !== orderB) return orderA - orderB;
                return a.localeCompare(b);
            });
    }

    /**
     * Get field configuration for a property
     */
    public getFieldConfig(propertyName: string, profile: Profile): ProfileField | undefined {
        return profile.fields?.find(f => f.id === propertyName);
    }

    /**
     * Check if a field should be highlighted
     */
    public isHighlighted(propertyName: string, profile: Profile): boolean {
        const field = this.getFieldConfig(propertyName, profile);
        return field?.highlight ?? false;
    }
}
