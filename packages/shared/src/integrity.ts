import {
  BASE_DOT_RATE,
  TILE_LAYER_ARMOR_MAX,
  WEIGHT_THRESHOLD,
} from './constants.js';

// Damage per second to a tile's topmost layer for a given total accumulated
// bug-weight + that layer's armor. Two regimes:
//
//   w ≤ THRESHOLD  →  linear:    BASE × w × (1 - armor/ARMOR_MAX)
//   w >  THRESHOLD  →  quadratic: BASE × (w + (w - THRESHOLD)²) × armorMul
//
// Armor is flat per damage event (the "event" here is one second of DPS).
// A value of 0 = no protection; a value of TILE_LAYER_ARMOR_MAX = invincible.
export function damagePerSecond(totalWeight: number, armor: number): number {
  if (totalWeight <= 0) return 0;
  const armorMul = Math.max(0, 1 - armor / TILE_LAYER_ARMOR_MAX);
  if (armorMul === 0) return 0;
  if (totalWeight <= WEIGHT_THRESHOLD) {
    return BASE_DOT_RATE * totalWeight * armorMul;
  }
  const over = totalWeight - WEIGHT_THRESHOLD;
  return BASE_DOT_RATE * (totalWeight + over * over) * armorMul;
}
