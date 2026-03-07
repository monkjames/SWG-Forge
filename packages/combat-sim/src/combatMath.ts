/**
 * Combat Math - Pure formula functions ported from SWGEmu C++
 *
 * References:
 * - CombatManager.cpp (damage, hit chance, armor, mitigation)
 * - CombatManager.h (constants)
 * - CreatureObjectImplementation.cpp (cost adjustment)
 * - PlayerObjectImplementation.cpp (force regen)
 *
 * All functions are pure — no side effects, no VSCode API.
 */

import {
    CombatantConfig, SimulationResult,
    Step1Result, Step2Result, Step3Result, Step4Result,
    Step5Result, Step6Result, Step7Result, SummaryResult,
    DamageType, AttackType, ArmorPiercingLevel, ArmorRating,
    TO_HIT_SCALE, TO_HIT_BASE, TO_HIT_STEP, TO_HIT_STEP_MAX,
    TO_HIT_MAX, TO_HIT_MIN,
    PLAYER_DAMAGE_BONUS, MELEE_DAMAGE_BONUS,
    KNOCKDOWN_BONUS_PVP, KNOCKDOWN_BONUS_NPC_VS_PLAYER,
    INTIMIDATE_DEFENSE_MULT,
    DAMAGE_TYPE_KEYS
} from './combatTypes';

// ============================================================================
// STEP 1: BASE DAMAGE
// CombatManager.cpp:1203-1315
// ============================================================================

export function calcBaseDamage(attacker: CombatantConfig): Step1Result {
    let minDmg: number, maxDmg: number;

    if (attacker.isForceAttack && attacker.forceMaxDamage > 0) {
        minDmg = attacker.forceMinDamage;
        maxDmg = attacker.forceMaxDamage;
    } else {
        minDmg = attacker.minDamage;
        maxDmg = attacker.maxDamage;
    }

    const avg = (minDmg + maxDmg) / 2;
    const afterMult = avg * attacker.damageMultiplier;

    return {
        avgWeaponDamage: avg,
        afterMultiplier: afterMult
    };
}

// ============================================================================
// STEP 2: DAMAGE MODIFIERS
// CombatManager.cpp:1289-1327, 1974-1976
// ============================================================================

export function calcDamageModifiers(
    baseDamage: number,
    attacker: CombatantConfig,
    defender: CombatantConfig
): Step2Result {
    let damage = baseDamage;

    // Player bonus (CombatManager.cpp:1289)
    const playerBonus = attacker.isPlayer ? PLAYER_DAMAGE_BONUS : 1.0;
    damage *= playerBonus;
    const afterPlayerBonus = damage;

    // Melee bonus (CombatManager.cpp:1310-1311)
    const isMelee = attacker.attackType === AttackType.MELEE && !attacker.isForceAttack;
    const meleeBonus = isMelee ? MELEE_DAMAGE_BONUS : 1.0;
    damage *= meleeBonus;
    const afterMeleeBonus = damage;

    // Flat damage bonus
    damage += attacker.damageBonus;
    const afterFlatBonus = damage;

    // Knockdown (CombatManager.cpp:1321-1327)
    let knockdownMult = 1.0;
    if (defender.isKnockedDown) {
        if (!attacker.isPlayer && defender.isPlayer) {
            knockdownMult = KNOCKDOWN_BONUS_NPC_VS_PLAYER;
        } else {
            knockdownMult = KNOCKDOWN_BONUS_PVP;
        }
    }
    damage *= knockdownMult;
    const afterKnockdown = damage;

    // Intimidate on attacker (CombatManager.cpp:1974-1976)
    const intDivisor = attacker.isIntimidated ? attacker.intimidateDivisor : 1.0;
    damage /= intDivisor;
    const afterIntimidate = damage;

    return {
        playerBonus,
        meleeBonus,
        afterPlayerBonus,
        afterMeleeBonus,
        afterFlatBonus,
        knockdownMult,
        afterKnockdown,
        intimidateDivisor: intDivisor,
        afterIntimidate,
        finalDamage: afterIntimidate
    };
}

// ============================================================================
// STEP 3: ARMOR MITIGATION
// CombatManager.cpp:3870-3903, 3541
// ============================================================================

/**
 * Armor piercing multiplier
 * CombatManager.cpp:3870-3903
 */
export function calcArmorPiercingMult(ap: ArmorPiercingLevel, ar: ArmorRating): number {
    if (ar === ArmorRating.NONE) return 1.0;
    if (ap > ar) return Math.pow(1.25, ap - ar);
    if (ar > ap) return Math.pow(0.50, ar - ap);
    return 1.0;
}

export function calcArmorMitigation(
    damage: number,
    attacker: CombatantConfig,
    defender: CombatantConfig
): Step3Result {
    const apMult = calcArmorPiercingMult(attacker.armorPiercing, defender.armorRating);

    // Get resist for weapon's damage type
    const dtKey = DAMAGE_TYPE_KEYS[attacker.damageType] as keyof typeof defender.armorResists;
    const resist = defender.armorResists[dtKey] || 0;

    const damageAfterAP = damage * apMult;
    const damageAfterArmor = damageAfterAP * (1 - resist / 100);

    return {
        apMultiplier: apMult,
        activeResist: resist,
        damageAfterAP,
        damageAfterArmor
    };
}

// ============================================================================
// STEP 4: FORCE DEFENSES
// CombatManager.cpp:3568-3590, 3342-3344
// ============================================================================

export function calcForceDefenses(
    damage: number,
    attacker: CombatantConfig,
    defender: CombatantConfig
): Step4Result {
    const noArmor = !defender.wearingArmor;
    const isForce = attacker.isForceAttack;
    const isLS = attacker.damageType === DamageType.LIGHTSABER;

    // Force Armor: no armor, non-force attacks (CombatManager.cpp:3568-3576)
    const forceArmorApplies = noArmor && !isForce && defender.forceArmor > 0;
    const forceArmorPct = forceArmorApplies ? defender.forceArmor : 0;
    const damageAfterForceArmor = damage * (1 - forceArmorPct / 100);

    // Force Shield: no armor, force attacks only (CombatManager.cpp:3582-3590)
    const forceShieldApplies = noArmor && isForce && defender.forceShield > 0;
    const forceShieldPct = forceShieldApplies ? defender.forceShield : 0;
    const damageAfterForceShield = damageAfterForceArmor * (1 - forceShieldPct / 100);

    // Jedi Toughness: no armor, not LS, not force (CombatManager.cpp:3342-3344)
    const jediToughnessApplies = noArmor && !isLS && !isForce && defender.jediToughness > 0;
    const jediToughnessPct = jediToughnessApplies ? defender.jediToughness : 0;
    const damageAfterJediToughness = damageAfterForceShield * (1 - jediToughnessPct / 100);

    // Saber Block: ranged attacks only (CombatManager.cpp:3132-3186)
    const saberBlockApplies = attacker.attackType === AttackType.RANGED && defender.saberBlock > 0;
    const saberBlockPct = saberBlockApplies ? Math.min(defender.saberBlock, 85) : 0;

    return {
        forceArmorApplies,
        forceShieldApplies,
        jediToughnessApplies,
        saberBlockApplies,
        forceArmorPct,
        forceShieldPct,
        jediToughnessPct,
        saberBlockPct,
        damageAfterForceArmor,
        damageAfterForceShield,
        damageAfterJediToughness,
        finalDamage: damageAfterJediToughness
    };
}

// ============================================================================
// STEP 5: HIT CHANCE
// CombatManager.cpp:3264-3287, CombatManager.h:77-82
// ============================================================================

export function calcHitChance(
    attacker: CombatantConfig,
    defender: CombatantConfig
): Step5Result {
    const attackerAccuracy = attacker.accuracy;
    let defenderDefense = defender.defense;

    // Intimidated defender gets defense reduction (CombatManager.cpp:2982-2983)
    const defenderIntimidated = defender.isIntimidated;
    const effectiveDefense = defenderIntimidated
        ? defenderDefense * INTIMIDATE_DEFENSE_MULT
        : defenderDefense;

    // Stepwise hit chance equation (CombatManager.cpp:3264-3287)
    let roll = (attackerAccuracy - effectiveDefense) / TO_HIT_SCALE;
    const sign = roll > 0 ? 1 : roll < 0 ? -1 : 0;
    let toHit = TO_HIT_BASE;

    for (let i = 1; i <= TO_HIT_STEP_MAX; i++) {
        if ((roll * sign) > i) {
            toHit += sign * TO_HIT_STEP;
            roll -= sign * i;
        } else {
            toHit += (roll / i) * TO_HIT_STEP;
            break;
        }
    }

    const hitChance = Math.max(TO_HIT_MIN, Math.min(TO_HIT_MAX, toHit));

    return {
        attackerAccuracy,
        defenderDefense,
        effectiveDefense,
        defenderIntimidated,
        hitChance
    };
}

// ============================================================================
// STEP 6: ATTACK SPEED
// CombatManager.cpp:4009-4023
// ============================================================================

export function calcAttackSpeed(attacker: CombatantConfig): Step6Result {
    const baseSpeed = attacker.attackSpeed;

    // Speed mod reduction
    const afterSpeedMod = (1 - attacker.speedMod / 100) * attacker.speedMultiplier * baseSpeed;

    // Jedi combat haste
    let afterHaste = afterSpeedMod;
    if (attacker.combatHaste > 0) {
        afterHaste -= afterSpeedMod * (attacker.combatHaste / 100);
    }

    // Warcry delay
    const afterWarcry = afterHaste + attacker.warcryDelay;

    // Floor at 1.0s
    const finalSpeed = Math.max(afterWarcry, 1.0);

    return {
        baseSpeed,
        afterSpeedMod,
        afterHaste,
        afterWarcry,
        finalSpeed
    };
}

// ============================================================================
// STEP 7: HAM & FORCE COSTS
// CombatManager.cpp:4106-4166, CreatureObjectImpl.cpp:3920-3927
// PlayerObjectImpl.cpp:2555-2597, 2855-2879
// ============================================================================

/**
 * HAM cost adjustment formula
 * CreatureObjectImplementation.cpp:3920-3927
 * cost = baseCost - ((stat - 300) / 1200) * baseCost
 */
function costAdjustment(baseCost: number, stat: number): number {
    const cost = baseCost - ((stat - 300) / 1200) * baseCost;
    return Math.max(0, cost);
}

export function calcCosts(
    attacker: CombatantConfig,
    attackSpeed: number
): Step7Result {
    // HAM costs (CombatManager.cpp:4139-4145)
    const healthBase = attacker.healthAttackCost * attacker.healthCostMultiplier;
    const actionBase = attacker.actionAttackCost * attacker.actionCostMultiplier;
    const mindBase = attacker.mindAttackCost * attacker.mindCostMultiplier;

    const healthAdj = costAdjustment(healthBase, attacker.strength);
    const actionAdj = costAdjustment(actionBase, attacker.quickness);
    const mindAdj = costAdjustment(mindBase, attacker.focus);

    const hamDrain: [number, number, number] = [
        healthAdj / attackSpeed,
        actionAdj / attackSpeed,
        mindAdj / attackSpeed
    ];

    // Force cost (CombatManager.cpp:4111-4136)
    let weaponFC = attacker.weaponForceCost;
    // PvP minimums (Infinity custom)
    if (attacker.isPvp && weaponFC < 5) {
        weaponFC = 5;
    } else if (weaponFC < 1) {
        weaponFC = 1;
    }
    // Bounty hunter hunted penalty
    if (attacker.huntedLevel > 0) {
        weaponFC += attacker.huntedLevel * 1.5;
    }

    const effectiveFC = weaponFC * attacker.forceCostMultiplier;
    const forceDrain = effectiveFC / attackSpeed;

    // Force regen (PlayerObjectImplementation.cpp:2555-2597)
    let regen = attacker.forceRegenBase;
    regen += attacker.frsControlManipulation / 10;
    if (attacker.forceRegenMultiplier !== 0) {
        regen *= attacker.forceRegenMultiplier;
    }
    if (attacker.forceRegenDivisor !== 0) {
        regen /= attacker.forceRegenDivisor;
    }

    // Tick rate (PlayerObjectImplementation.cpp:2591-2594)
    const tickAmount = 5;
    const timer = regen / 5;
    const tickInterval = timer > 0 ? 10 / timer : Infinity;
    const regenPerSec = tickInterval > 0 ? tickAmount / tickInterval : 0;

    const netForce = regenPerSec - forceDrain;

    return {
        healthCostBase: healthBase,
        actionCostBase: actionBase,
        mindCostBase: mindBase,
        healthCostAdjusted: healthAdj,
        actionCostAdjusted: actionAdj,
        mindCostAdjusted: mindAdj,
        hamDrainPerSec: hamDrain,
        weaponForceCost: weaponFC,
        effectiveForceCost: effectiveFC,
        forceDrainPerSec: forceDrain,
        effectiveForceRegen: regen,
        forceTickAmount: tickAmount,
        forceTickInterval: tickInterval,
        forceRegenPerSec: regenPerSec,
        netForcePerSec: netForce,
        sustainable: netForce >= 0
    };
}

// ============================================================================
// SUMMARY
// ============================================================================

function calcSummary(
    step1: Step1Result, step2: Step2Result, step3: Step3Result,
    step4: Step4Result, step5: Step5Result, step6: Step6Result,
    step7: Step7Result, defender: CombatantConfig
): SummaryResult {
    const avgDmg = step4.finalDamage;

    // Saber block reduces effective hit chance for ranged
    let effectiveHit = step5.hitChance / 100;
    if (step4.saberBlockApplies) {
        effectiveHit *= (1 - step4.saberBlockPct / 100);
    }

    const effectiveDmgPerHit = avgDmg * effectiveHit;
    const speed = step6.finalSpeed;
    const rawDPS = avgDmg / speed;
    const effectiveDPS = effectiveDmgPerHit / speed;

    const totalHam = defender.health + defender.action + defender.mind;
    const ttkHealth = effectiveDPS > 0 ? defender.health / effectiveDPS : Infinity;
    const ttkAll = effectiveDPS > 0 ? totalHam / effectiveDPS : Infinity;

    // Time to out of force
    let timeToOof = Infinity;
    if (step7.netForcePerSec < 0) {
        timeToOof = defender.forcePool / Math.abs(step7.netForcePerSec);
    }
    // If the attacker runs out of force
    const attackerOof = step7.netForcePerSec < 0
        ? (step7.effectiveForceCost > 0 ? step7.effectiveForceCost : Infinity)
        : Infinity;

    return {
        avgDamagePerHit: avgDmg,
        hitChance: step5.hitChance,
        effectiveDmgPerHit,
        attackSpeed: speed,
        rawDPS,
        effectiveDPS,
        hamCostPerSec: step7.hamDrainPerSec,
        forceCostPerSec: step7.forceDrainPerSec,
        forceRegenPerSec: step7.forceRegenPerSec,
        netForcePerSec: step7.netForcePerSec,
        sustainable: step7.sustainable,
        defenderHealth: defender.health,
        defenderAction: defender.action,
        defenderMind: defender.mind,
        forcePool: defender.forcePool,
        ttkHealth,
        ttkAllHam: ttkAll,
        timeToOof: step7.netForcePerSec < 0
            ? (step7.forceRegenPerSec > 0
                ? (step7.effectiveForceCost > 0 ? Infinity : Infinity) // attacker perspective
                : Infinity)
            : Infinity
    };
}

// ============================================================================
// FULL SIMULATION
// ============================================================================

export function runSimulation(
    attacker: CombatantConfig,
    defender: CombatantConfig
): SimulationResult {
    const step1 = calcBaseDamage(attacker);
    const step2 = calcDamageModifiers(step1.afterMultiplier, attacker, defender);
    const step3 = calcArmorMitigation(step2.finalDamage, attacker, defender);
    const step4 = calcForceDefenses(step3.damageAfterArmor, attacker, defender);
    const step5 = calcHitChance(attacker, defender);
    const step6 = calcAttackSpeed(attacker);
    const step7 = calcCosts(attacker, step6.finalSpeed);

    // Attacker time to OOF
    let timeToOof = Infinity;
    if (step7.netForcePerSec < 0 && attacker.forcePool > 0) {
        timeToOof = attacker.forcePool / Math.abs(step7.netForcePerSec);
    }

    const summary = calcSummary(step1, step2, step3, step4, step5, step6, step7, defender);
    summary.forcePool = attacker.forcePool;
    summary.timeToOof = timeToOof;

    return { step1, step2, step3, step4, step5, step6, step7, summary };
}
