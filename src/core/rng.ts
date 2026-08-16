/**
 * Детерминированный генератор случайных чисел.
 *
 * Весь мир строится из одного числа-сида: по одному и тому же сиду получается
 * ровно тот же ландшафт, тот же лес и та же расстановка построек. Поэтому в
 * сохранении достаточно хранить сид, а не гигабайты геометрии.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // Ноль — вырожденное состояние для mulberry32, сдвигаем.
    this.state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  }

  /** Следующее число в диапазоне [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Число с плавающей точкой в диапазоне [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Целое число в диапазоне [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** true с указанной вероятностью. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  /** Взвешенный выбор: веса не обязаны быть нормированы. */
  pickWeighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (let i = 0; i < items.length; i++) total += Math.max(0, weights[i] ?? 0);
    if (total <= 0) return items[0];
    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= Math.max(0, weights[i] ?? 0);
      if (roll <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Перемешивание на месте (Фишер–Йетс). */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  /** Приблизительно нормальное распределение (сумма двух равномерных). */
  gaussian(mean = 0, deviation = 1): number {
    return mean + (this.next() + this.next() - 1) * deviation;
  }
}

/** Детерминированный хеш целочисленной пары в [0, 1). Без состояния. */
export function hash2d(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Гладкий шум значений в диапазоне [0, 1). */
export function valueNoise2d(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = fade(x - xi);
  const yf = fade(y - yi);

  const v00 = hash2d(xi, yi, seed);
  const v10 = hash2d(xi + 1, yi, seed);
  const v01 = hash2d(xi, yi + 1, seed);
  const v11 = hash2d(xi + 1, yi + 1, seed);

  const top = v00 + (v10 - v00) * xf;
  const bottom = v01 + (v11 - v01) * xf;
  return top + (bottom - top) * yf;
}

export interface FbmOptions {
  octaves?: number;
  frequency?: number;
  amplitude?: number;
  lacunarity?: number;
  gain?: number;
  seed?: number;
}

/**
 * Фрактальный шум: несколько слоёв value-noise с растущей частотой.
 * Результат нормирован к [0, 1].
 */
export function fbm2d(x: number, y: number, options: FbmOptions = {}): number {
  const octaves = options.octaves ?? 4;
  const lacunarity = options.lacunarity ?? 2.0;
  const gain = options.gain ?? 0.5;
  const seed = options.seed ?? 0;

  let frequency = options.frequency ?? 1;
  let amplitude = options.amplitude ?? 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2d(x * frequency, y * frequency, seed + i * 1013) * amplitude;
    norm += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }

  return norm > 0 ? sum / norm : 0;
}

/**
 * «Хребтовый» шум — даёт острые гребни, из него получаются горы злодея.
 */
export function ridgedNoise2d(x: number, y: number, options: FbmOptions = {}): number {
  const octaves = options.octaves ?? 4;
  const lacunarity = options.lacunarity ?? 2.0;
  const gain = options.gain ?? 0.5;
  const seed = options.seed ?? 0;

  let frequency = options.frequency ?? 1;
  let amplitude = options.amplitude ?? 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2d(x * frequency, y * frequency, seed + i * 7919) * 2 - 1);
    sum += n * n * amplitude;
    norm += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }

  return norm > 0 ? sum / norm : 0;
}
