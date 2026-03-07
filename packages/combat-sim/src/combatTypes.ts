/**
 * Combat Simulator Types
 *
 * All enums, interfaces, and constants for the SWGEmu combat system.
 * Values sourced from CombatManager.h, SharedWeaponObjectTemplate.h,
 * and CreatureState.h in the Infinity codebase.
 */

// ============================================================================
// ENUMS
// ============================================================================

export enum DamageType {
    KINETIC = 1,
    ENERGY = 2,
    HEAT = 4,
    COLD = 8,
    ACID = 16,
    ELECTRICITY = 32,
    STUN = 64,
    BLAST = 128,
    LIGHTSABER = 256
}

export enum WeaponType {
    UNARMED = 'unarmed',
    ONEHANDMELEE = 'onehandmelee',
    TWOHANDMELEE = 'twohandmelee',
    POLEARM = 'polearm',
    PISTOL = 'pistol',
    CARBINE = 'carbine',
    RIFLE = 'rifle',
    HEAVY = 'heavy',
    SPECIALHEAVY = 'specialheavy',
    ONEHANDJEDI = 'onehandjedi',
    TWOHANDJEDI = 'twohandjedi',
    POLEARMJEDI = 'polearmjedi'
}

export enum AttackType {
    MELEE = 'melee',
    RANGED = 'ranged',
    FORCE = 'force'
}

export enum ArmorRating {
    NONE = 0,
    LIGHT = 1,
    MEDIUM = 2,
    HEAVY = 3
}

export enum ArmorPiercingLevel {
    NONE = 0,
    LIGHT = 1,
    MEDIUM = 2,
    HEAVY = 3
}

// ============================================================================
// CONSTANTS (from CombatManager.h lines 77-82)
// ============================================================================

export const TO_HIT_SCALE = 50.0;
export const TO_HIT_BASE = 75.0;
export const TO_HIT_STEP = 25.0;
export const TO_HIT_STEP_MAX = TO_HIT_BASE / TO_HIT_STEP; // 3
export const TO_HIT_MAX = 100.0;
export const TO_HIT_MIN = 0.0;

export const PLAYER_DAMAGE_BONUS = 1.5;
export const MELEE_DAMAGE_BONUS = 1.25;
export const KNOCKDOWN_BONUS_PVP = 1.5;
export const KNOCKDOWN_BONUS_NPC_VS_PLAYER = 1.2;
export const INTIMIDATE_DEFENSE_MULT = 0.55;

export const ALL_DAMAGE_TYPES: DamageType[] = [
    DamageType.KINETIC, DamageType.ENERGY, DamageType.HEAT,
    DamageType.COLD, DamageType.ACID, DamageType.ELECTRICITY,
    DamageType.STUN, DamageType.BLAST, DamageType.LIGHTSABER
];

export const DAMAGE_TYPE_NAMES: Record<number, string> = {
    [DamageType.KINETIC]: 'Kinetic',
    [DamageType.ENERGY]: 'Energy',
    [DamageType.HEAT]: 'Heat',
    [DamageType.COLD]: 'Cold',
    [DamageType.ACID]: 'Acid',
    [DamageType.ELECTRICITY]: 'Electricity',
    [DamageType.STUN]: 'Stun',
    [DamageType.BLAST]: 'Blast',
    [DamageType.LIGHTSABER]: 'Lightsaber'
};

export const DAMAGE_TYPE_KEYS: Record<number, string> = {
    [DamageType.KINETIC]: 'kinetic',
    [DamageType.ENERGY]: 'energy',
    [DamageType.HEAT]: 'heat',
    [DamageType.COLD]: 'cold',
    [DamageType.ACID]: 'acid',
    [DamageType.ELECTRICITY]: 'electricity',
    [DamageType.STUN]: 'stun',
    [DamageType.BLAST]: 'blast',
    [DamageType.LIGHTSABER]: 'lightsaber'
};

export const WEAPON_TYPE_NAMES: Record<string, string> = {
    [WeaponType.UNARMED]: 'Unarmed',
    [WeaponType.ONEHANDMELEE]: '1H Melee',
    [WeaponType.TWOHANDMELEE]: '2H Melee',
    [WeaponType.POLEARM]: 'Polearm',
    [WeaponType.PISTOL]: 'Pistol',
    [WeaponType.CARBINE]: 'Carbine',
    [WeaponType.RIFLE]: 'Rifle',
    [WeaponType.HEAVY]: 'Heavy',
    [WeaponType.SPECIALHEAVY]: 'Special Heavy',
    [WeaponType.ONEHANDJEDI]: '1H Lightsaber',
    [WeaponType.TWOHANDJEDI]: '2H Lightsaber',
    [WeaponType.POLEARMJEDI]: 'Polearm Lightsaber'
};

export const ARMOR_RATING_NAMES: Record<number, string> = {
    [ArmorRating.NONE]: 'None',
    [ArmorRating.LIGHT]: 'Light',
    [ArmorRating.MEDIUM]: 'Medium',
    [ArmorRating.HEAVY]: 'Heavy'
};

export const AP_LEVEL_NAMES: Record<number, string> = {
    [ArmorPiercingLevel.NONE]: 'None',
    [ArmorPiercingLevel.LIGHT]: 'Light',
    [ArmorPiercingLevel.MEDIUM]: 'Medium',
    [ArmorPiercingLevel.HEAVY]: 'Heavy'
};

// ============================================================================
// INTERFACES
// ============================================================================

export interface ArmorResists {
    kinetic: number;
    energy: number;
    heat: number;
    cold: number;
    acid: number;
    electricity: number;
    stun: number;
    blast: number;
    lightsaber: number;
}

export interface CombatantConfig {
    name: string;
    isPlayer: boolean;

    // Weapon
    weaponType: WeaponType;
    attackType: AttackType;
    minDamage: number;
    maxDamage: number;
    attackSpeed: number;
    damageType: DamageType;
    armorPiercing: ArmorPiercingLevel;

    // Force attack override
    isForceAttack: boolean;
    forceMinDamage: number;
    forceMaxDamage: number;

    // Armor
    armorRating: ArmorRating;
    armorResists: ArmorResists;
    wearingArmor: boolean;

    // Pools
    health: number;
    action: number;
    mind: number;

    // Skill mods
    accuracy: number;
    defense: number;
    speedMod: number;
    combatHaste: number;
    damageBonus: number;

    // Jedi defenses
    saberBlock: number;
    forceArmor: number;
    forceShield: number;
    jediToughness: number;

    // States
    isIntimidated: boolean;
    intimidateDivisor: number;
    isKnockedDown: boolean;

    // Command modifiers
    damageMultiplier: number;
    speedMultiplier: number;

    // HAM costs (weapon base)
    healthAttackCost: number;
    actionAttackCost: number;
    mindAttackCost: number;
    healthCostMultiplier: number;
    actionCostMultiplier: number;
    mindCostMultiplier: number;

    // Secondary stats (for HAM cost reduction)
    strength: number;
    quickness: number;
    focus: number;

    // Force
    forcePool: number;
    weaponForceCost: number;
    forceCostMultiplier: number;
    isPvp: boolean;
    huntedLevel: number;

    // Force regen
    forceRegenBase: number;
    frsControlManipulation: number;
    forceRegenMultiplier: number;
    forceRegenDivisor: number;

    // Warcry
    warcryDelay: number;
}

// ============================================================================
// STEP RESULTS (for workflow display)
// ============================================================================

export interface Step1Result {
    avgWeaponDamage: number;
    afterMultiplier: number;
}

export interface Step2Result {
    playerBonus: number;
    meleeBonus: number;
    afterPlayerBonus: number;
    afterMeleeBonus: number;
    afterFlatBonus: number;
    knockdownMult: number;
    afterKnockdown: number;
    intimidateDivisor: number;
    afterIntimidate: number;
    finalDamage: number;
}

export interface Step3Result {
    apMultiplier: number;
    activeResist: number;
    damageAfterAP: number;
    damageAfterArmor: number;
}

export interface Step4Result {
    forceArmorApplies: boolean;
    forceShieldApplies: boolean;
    jediToughnessApplies: boolean;
    saberBlockApplies: boolean;
    forceArmorPct: number;
    forceShieldPct: number;
    jediToughnessPct: number;
    saberBlockPct: number;
    damageAfterForceArmor: number;
    damageAfterForceShield: number;
    damageAfterJediToughness: number;
    finalDamage: number;
}

export interface Step5Result {
    attackerAccuracy: number;
    defenderDefense: number;
    effectiveDefense: number;
    defenderIntimidated: boolean;
    hitChance: number;
}

export interface Step6Result {
    baseSpeed: number;
    afterSpeedMod: number;
    afterHaste: number;
    afterWarcry: number;
    finalSpeed: number;
}

export interface Step7Result {
    // HAM
    healthCostBase: number;
    actionCostBase: number;
    mindCostBase: number;
    healthCostAdjusted: number;
    actionCostAdjusted: number;
    mindCostAdjusted: number;
    hamDrainPerSec: [number, number, number];
    // Force cost
    weaponForceCost: number;
    effectiveForceCost: number;
    forceDrainPerSec: number;
    // Force regen
    effectiveForceRegen: number;
    forceTickAmount: number;
    forceTickInterval: number;
    forceRegenPerSec: number;
    netForcePerSec: number;
    sustainable: boolean;
}

export interface SummaryResult {
    avgDamagePerHit: number;
    hitChance: number;
    effectiveDmgPerHit: number;
    attackSpeed: number;
    rawDPS: number;
    effectiveDPS: number;
    hamCostPerSec: [number, number, number];
    forceCostPerSec: number;
    forceRegenPerSec: number;
    netForcePerSec: number;
    sustainable: boolean;
    defenderHealth: number;
    defenderAction: number;
    defenderMind: number;
    forcePool: number;
    ttkHealth: number;
    ttkAllHam: number;
    timeToOof: number;
}

export interface SimulationResult {
    step1: Step1Result;
    step2: Step2Result;
    step3: Step3Result;
    step4: Step4Result;
    step5: Step5Result;
    step6: Step6Result;
    step7: Step7Result;
    summary: SummaryResult;
}

export interface SimulationScenario {
    name: string;
    attacker: CombatantConfig;
    defender: CombatantConfig;
    savedAt?: string;
}

// ============================================================================
// DEFAULTS
// ============================================================================

export function createDefaultResists(): ArmorResists {
    return {
        kinetic: 0, energy: 0, heat: 0, cold: 0,
        acid: 0, electricity: 0, stun: 0, blast: 0, lightsaber: 0
    };
}

export function createDefaultConfig(name: string): CombatantConfig {
    return {
        name,
        isPlayer: true,
        weaponType: WeaponType.ONEHANDJEDI,
        attackType: AttackType.MELEE,
        minDamage: 200,
        maxDamage: 400,
        attackSpeed: 3.5,
        damageType: DamageType.ENERGY,
        armorPiercing: ArmorPiercingLevel.NONE,
        isForceAttack: false,
        forceMinDamage: 0,
        forceMaxDamage: 0,
        armorRating: ArmorRating.NONE,
        armorResists: createDefaultResists(),
        wearingArmor: false,
        health: 8000,
        action: 3000,
        mind: 3000,
        accuracy: 100,
        defense: 100,
        speedMod: 0,
        combatHaste: 0,
        damageBonus: 0,
        saberBlock: 0,
        forceArmor: 0,
        forceShield: 0,
        jediToughness: 0,
        isIntimidated: false,
        intimidateDivisor: 1.25,
        isKnockedDown: false,
        damageMultiplier: 1.0,
        speedMultiplier: 1.0,
        healthAttackCost: 12,
        actionAttackCost: 20,
        mindAttackCost: 8,
        healthCostMultiplier: 1.0,
        actionCostMultiplier: 1.0,
        mindCostMultiplier: 1.0,
        strength: 800,
        quickness: 800,
        focus: 800,
        forcePool: 2500,
        weaponForceCost: 5,
        forceCostMultiplier: 1.0,
        isPvp: false,
        huntedLevel: 0,
        forceRegenBase: 50,
        frsControlManipulation: 0,
        forceRegenMultiplier: 1,
        forceRegenDivisor: 1,
        warcryDelay: 0
    };
}

export function createDefaultScenario(): SimulationScenario {
    return {
        name: 'New Scenario',
        attacker: createDefaultConfig('Attacker'),
        defender: createDefaultConfig('Defender')
    };
}
