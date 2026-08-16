import { valueNoise2d } from '../core/rng';
import { clamp01, distance2D, smoothstep } from '../core/math';

/** Размер карты в метрах: мир занимает квадрат от -1024 до +1024 по X и Z. */
export const WORLD_SIZE = 2048;
export const WORLD_HALF = WORLD_SIZE / 2;

/** Четыре зоны из техзадания. */
export enum Zone {
  /** 1 — земли людей, нейтралы, главный рынок и корованы. */
  Human = 0,
  /** 2 — земли императора, дворец и охрана. */
  Imperial = 1,
  /** 3 — лес эльфов, густой и тёмный. */
  Elf = 2,
  /** 4 — горы злодея, старый форт. */
  Villain = 3,
}

export const ALL_ZONES: readonly Zone[] = [Zone.Human, Zone.Imperial, Zone.Elf, Zone.Villain];

export interface ZoneInfo {
  zone: Zone;
  /** Название для интерфейса и карты. */
  name: string;
  shortName: string;
  /** Центр зоны — вокруг него стоит главное поселение. */
  center: { x: number; z: number };
  /** Радиус влияния, в метрах: чем больше, тем дальше «дотягивается» зона. */
  influence: number;
  /** Плотность леса, деревьев на гектар. */
  forestDensity: number;
  /** Цвет на карте и в подсказках. */
  color: number;
}

export const ZONES: Record<Zone, ZoneInfo> = {
  [Zone.Human]: {
    zone: Zone.Human,
    name: 'Земли людей',
    shortName: 'Люди',
    center: { x: 40, z: 470 },
    influence: 620,
    forestDensity: 22,
    color: 0xd9c07a,
  },
  [Zone.Imperial]: {
    zone: Zone.Imperial,
    name: 'Земли императора',
    shortName: 'Дворец',
    center: { x: 610, z: -230 },
    influence: 560,
    forestDensity: 14,
    color: 0xc8b5e6,
  },
  [Zone.Elf]: {
    zone: Zone.Elf,
    name: 'Лес эльфов',
    shortName: 'Эльфы',
    center: { x: -580, z: -40 },
    influence: 660,
    forestDensity: 165,
    color: 0x74c47a,
  },
  [Zone.Villain]: {
    zone: Zone.Villain,
    name: 'Горы злодея',
    shortName: 'Горы',
    center: { x: 90, z: -760 },
    influence: 560,
    forestDensity: 8,
    color: 0xc76a5a,
  },
};

const ZONE_ORDER = ALL_ZONES;

/** Шум, который делает границы зон извилистыми, а не окружностями. */
function borderWobble(x: number, z: number): number {
  return (valueNoise2d(x * 0.0016, z * 0.0016, 4711) - 0.5) * 240;
}

const weightScratch = [0, 0, 0, 0];

/**
 * Доля влияния каждой зоны в точке. Сумма всегда равна 1.
 * Используется и для смешивания высот ландшафта, и для плотности леса,
 * чтобы переходы между зонами были плавными, а не по линейке.
 */
export function zoneWeights(x: number, z: number, out: number[] = weightScratch): number[] {
  const wobble = borderWobble(x, z);
  let total = 0;

  for (let i = 0; i < ZONE_ORDER.length; i++) {
    const info = ZONES[ZONE_ORDER[i]];
    const d = Math.max(1, distance2D(x, z, info.center.x, info.center.z) + wobble);
    // Степень 3.5 даёт заметные ядра зон и не слишком широкие размытые границы.
    const w = Math.pow(info.influence / d, 3.5);
    out[i] = w;
    total += w;
  }

  const inv = total > 0 ? 1 / total : 0;
  for (let i = 0; i < ZONE_ORDER.length; i++) out[i] *= inv;
  return out;
}

/** Какая зона в этой точке — та, чьё влияние больше всех. */
export function zoneAt(x: number, z: number): Zone {
  const w = zoneWeights(x, z);
  let best = 0;
  for (let i = 1; i < w.length; i++) if (w[i] > w[best]) best = i;
  return ZONE_ORDER[best];
}

/**
 * Насколько уверенно точка принадлежит своей зоне: 0 — ровно на границе,
 * 1 — в самом сердце зоны. Пригодится, чтобы приграничные патрули вели себя мягче.
 */
export function zoneDominance(x: number, z: number): number {
  const w = zoneWeights(x, z);
  let first = 0;
  let second = 0;
  for (const value of w) {
    if (value > first) {
      second = first;
      first = value;
    } else if (value > second) {
      second = value;
    }
  }
  return clamp01(first - second);
}

/** Плотность леса в точке (деревьев на гектар) — смесь плотностей соседних зон. */
export function forestDensityAt(x: number, z: number): number {
  const w = zoneWeights(x, z);
  let density = 0;
  for (let i = 0; i < ZONE_ORDER.length; i++) density += w[i] * ZONES[ZONE_ORDER[i]].forestDensity;

  // К краю карты лес редеет — там начинается «ничья земля».
  const edge = Math.max(Math.abs(x), Math.abs(z));
  return density * (1 - smoothstep(WORLD_HALF - 220, WORLD_HALF - 20, edge));
}

/** Точка внутри карты? */
export function isInsideWorld(x: number, z: number, margin = 0): boolean {
  return Math.abs(x) < WORLD_HALF - margin && Math.abs(z) < WORLD_HALF - margin;
}
