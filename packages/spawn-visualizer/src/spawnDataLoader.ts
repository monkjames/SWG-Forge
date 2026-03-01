import * as vscode from 'vscode';
import * as path from 'path';
import { parseRegions, parseSpawnGroups, parseLairTemplates, parseCreatureDefinitions } from './luaParser';
import { PlanetData, SpawnRegion, SpawnGroup, LairTemplate, CreatureDefinition, SpawnWarning } from './types';

export async function discoverPlanets(sp: string): Promise<string[]> {
    try {
        const e = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(sp, 'managers', 'planet')));
        return e.map(([n]) => n.match(/^(.+)_regions\.lua$/)).filter(Boolean).map(m => m![1]).sort();
    } catch { return []; }
}

export type ProgressCallback = (msg: { type: string; [key: string]: any }) => void;

/**
 * Load planet data in progressive phases, calling `progress` after each phase
 * so the webview can render incrementally.
 */
export async function loadPlanetData(sp: string, planet: string, progress?: ProgressCallback): Promise<PlanetData> {
    // ── Phase 1: Regions (instant) ──────────────────────────────────
    progress?.({ type: 'status', text: 'Parsing regions...' });
    const rf = path.join(sp, 'managers', 'planet', planet + '_regions.lua');
    const regions = parseRegions(await rd(rf), rf);
    const ng = new Set<string>();
    for (const r of regions) for (const g of r.spawnGroups) ng.add(g);

    // Send regions immediately so the map draws
    progress?.({ type: 'regions', regions, planetName: planet });
    progress?.({ type: 'status', text: 'Loading spawn groups (' + ng.size + ' referenced)...' });

    // ── Phase 2: Spawn Groups ───────────────────────────────────────
    const sg = new Map<string, SpawnGroup>();
    for (const f of await ls(path.join(sp, 'mobile', 'spawn', planet)))
        for (const g of parseSpawnGroups(await rd(f), f, false)) sg.set(g.name, g);
    for (const f of await ls(path.join(sp, 'mobile', 'custom_content', 'spawn'))) {
        const b = path.basename(f, '.lua');
        if (b.startsWith(planet + '_') || b === planet)
            for (const g of parseSpawnGroups(await rd(f), f, true)) sg.set(g.name, g);
    }

    const nl = new Set<string>();
    for (const [, g] of sg) for (const e of g.lairSpawns) nl.add(e.lairTemplateName);
    progress?.({ type: 'status', text: 'Loading lair templates (' + nl.size + ')...' });

    // ── Phase 3: Lair Templates ─────────────────────────────────────
    const lt = new Map<string, LairTemplate>();
    const ld = [
        path.join(sp, 'mobile', 'lair', 'creature_lair', planet),
        path.join(sp, 'mobile', 'lair', 'creature_dynamic', planet),
        path.join(sp, 'mobile', 'lair', 'npc_theater', planet),
        path.join(sp, 'mobile', 'lair', 'npc_dynamic', planet),
        path.join(sp, 'mobile', 'lair', 'creature_lair', 'global'),
        path.join(sp, 'mobile', 'lair', 'creature_dynamic', 'global'),
        path.join(sp, 'mobile', 'lair', 'npc_theater', 'global'),
        path.join(sp, 'mobile', 'lair', 'npc_dynamic', 'global'),
    ];
    let lairMissing = 0;
    for (const n of nl) {
        if (lt.has(n)) continue;
        let found = false;
        for (const d of ld) {
            const fp = path.join(d, n + '.lua');
            const c = await rd(fp);
            if (c) { for (const t of parseLairTemplates(c, fp)) lt.set(t.name, t); found = true; break; }
        }
        if (!found) lairMissing++;
    }
    progress?.({ type: 'status', text: 'Lairs: ' + lt.size + ' found, ' + lairMissing + ' missing of ' + nl.size + ' referenced' });

    const nc = new Set<string>();
    for (const [, l] of lt) {
        for (const m of l.mobiles) nc.add(m.name);
        for (const b of l.bossMobiles) nc.add(b.name);
    }
    progress?.({ type: 'status', text: 'Loading creature definitions (' + nc.size + ')...' });

    // ── Phase 4: Creature Definitions ───────────────────────────────
    const cr = new Map<string, CreatureDefinition>();
    const localDirs = [
        { dir: path.join(sp, 'mobile', planet), p: planet },
        { dir: path.join(sp, 'mobile', 'custom_content', 'mobile', planet), p: planet },
    ];
    let od: { dir: string; p: string }[] | null = null;

    for (const n of nc) {
        if (cr.has(n)) continue;
        let found = false;
        for (const { dir, p } of localDirs) {
            const fp = path.join(dir, n + '.lua');
            const c = await rd(fp);
            if (c) {
                for (const d of parseCreatureDefinitions(c, fp, p)) cr.set(d.name, d);
                found = true; break;
            }
        }
        if (!found) {
            if (!od) od = await otherDirs(sp, planet);
            for (const { dir, p } of od) {
                const fp = path.join(dir, n + '.lua');
                const c = await rd(fp);
                if (c) { for (const d of parseCreatureDefinitions(c, fp, p)) cr.set(d.name, d); break; }
            }
        }
    }

    progress?.({ type: 'status', text: 'Scanning for missing creatures...' });

    // ── Phase 5: Missing creatures scan ─────────────────────────────
    const inSpawns = new Set<string>(nc);
    const missing: CreatureDefinition[] = [];
    for (const { dir, p } of localDirs) {
        for (const f of await ls(dir)) {
            const bn = path.basename(f, '.lua');
            if (inSpawns.has(bn)) continue;
            if (!cr.has(bn)) {
                const c = await rd(f);
                if (c) for (const d of parseCreatureDefinitions(c, f, p)) cr.set(d.name, d);
            }
            const x = cr.get(bn);
            if (x) missing.push(x);
        }
    }
    missing.sort((a, b) => a.level - b.level);

    progress?.({ type: 'status', text: 'Building warnings...' });

    const warnings = buildW(regions, sg, lt, cr, planet, ng);
    return { planetName: planet, regions, spawnGroups: sg, lairTemplates: lt, creatures: cr, missingCreatures: missing, warnings, staticSpawns: [] };
}

async function otherDirs(sp: string, cur: string): Promise<{ dir: string; p: string }[]> {
    const r: { dir: string; p: string }[] = [];
    try {
        for (const [n, t] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(sp, 'mobile'))))
            if (t === vscode.FileType.Directory && n !== cur && n !== 'spawn' && n !== 'lair' && n !== 'custom_content')
                r.push({ dir: path.join(sp, 'mobile', n), p: n });
    } catch {}
    try {
        for (const [n, t] of await vscode.workspace.fs.readDirectory(vscode.Uri.file(path.join(sp, 'mobile', 'custom_content', 'mobile'))))
            if (t === vscode.FileType.Directory && n !== cur)
                r.push({ dir: path.join(sp, 'mobile', 'custom_content', 'mobile', n), p: n });
    } catch {}
    return r;
}

function buildW(regions: SpawnRegion[], sg: Map<string, SpawnGroup>, lt: Map<string, LairTemplate>, cr: Map<string, CreatureDefinition>, planet: string, ng: Set<string>): SpawnWarning[] {
    const w: SpawnWarning[] = [];
    for (const gn of ng) {
        if (!sg.has(gn)) {
            const r = regions.find(r => r.spawnGroups.includes(gn));
            w.push({ type: 'empty-group', message: 'Group "' + gn + '" not found', regionName: r?.name, sourceFile: r?.sourceFile });
        }
    }
    for (const [name, group] of sg) {
        if (group.lairSpawns.length === 0)
            w.push({ type: 'empty-group', message: 'Group "' + name + '" empty', sourceFile: group.sourceFile });
    }
    for (const [, group] of sg) {
        for (const e of group.lairSpawns) {
            if (!lt.has(e.lairTemplateName))
                w.push({ type: 'missing-lair', message: 'Lair "' + e.lairTemplateName + '" not found', sourceFile: group.sourceFile, details: 'In "' + group.name + '"' });
            if (e.weighting <= 0)
                w.push({ type: 'zero-weight', message: 'Lair "' + e.lairTemplateName + '" wt=' + e.weighting, sourceFile: group.sourceFile, details: 'In "' + group.name + '"' });
        }
    }
    for (const [, lair] of lt) {
        for (const mob of [...lair.mobiles, ...lair.bossMobiles]) {
            if (!cr.has(mob.name))
                w.push({ type: 'missing-creature', message: '"' + mob.name + '" not found', sourceFile: lair.sourceFile, details: 'In lair "' + lair.name + '"' });
            const c = cr.get(mob.name);
            if (c && c.sourcePlanet !== planet && c.sourcePlanet !== 'global')
                w.push({ type: 'cross-planet', message: '"' + mob.name + '" from ' + c.sourcePlanet + '/', sourceFile: c.sourceFile, details: 'In lair "' + lair.name + '"' });
        }
    }
    return w;
}

async function rd(fp: string): Promise<string> {
    try { return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fp))).toString('utf-8'); }
    catch { return ''; }
}

async function ls(dir: string): Promise<string[]> {
    try {
        return (await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir)))
            .filter(([n, t]) => n.endsWith('.lua') && t === vscode.FileType.File)
            .map(([n]) => path.join(dir, n));
    } catch { return []; }
}
