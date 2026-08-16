import { describe, expect, it } from 'vitest';
import { Rng, fbm2d } from '../src/core/rng';
import { CELL_SIZE, Terrain, VERTS } from '../src/world/terrain';
import { WORLD_HALF, Zone, ZONES, forestDensityAt, zoneAt } from '../src/world/zones';
import { SITES } from '../src/world/sites';

describe('генератор случайных чисел', () => {
  it('по одному сиду выдаёт одну и ту же последовательность', () => {
    const first = Array.from({ length: 8 }, () => new Rng(12345).next());
    const second = new Rng(12345);
    const sequence = Array.from({ length: 8 }, () => second.next());
    // Первый массив — восемь раз «первое число» одного и того же сида.
    expect(new Set(first).size).toBe(1);
    expect(sequence[0]).toBe(first[0]);

    const repeat = new Rng(12345);
    expect(Array.from({ length: 8 }, () => repeat.next())).toEqual(sequence);
  });

  it('разные сиды дают разные миры', () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it('фрактальный шум лежит в диапазоне от нуля до единицы', () => {
    for (let i = 0; i < 200; i++) {
      const value = fbm2d(i * 3.7, i * -1.9, { octaves: 5 });
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('зоны мира', () => {
  it('в центре каждой зоны действительно эта зона', () => {
    for (const zone of [Zone.Human, Zone.Imperial, Zone.Elf, Zone.Villain]) {
      const info = ZONES[zone];
      expect(zoneAt(info.center.x, info.center.z)).toBe(zone);
    }
  });

  it('каждая опорная точка лежит в своей зоне', () => {
    for (const site of SITES) {
      expect(zoneAt(site.x, site.z), `точка ${site.id}`).toBe(site.zone);
    }
  });

  it('лес эльфов гуще всех остальных зон', () => {
    const elf = forestDensityAt(ZONES[Zone.Elf].center.x, ZONES[Zone.Elf].center.z);
    for (const zone of [Zone.Human, Zone.Imperial, Zone.Villain]) {
      const info = ZONES[zone];
      expect(elf).toBeGreaterThan(forestDensityAt(info.center.x, info.center.z));
    }
  });
});

describe('ландшафт', () => {
  const terrain = new Terrain();

  it('в узлах сетки высота совпадает с высотной картой', () => {
    for (const [i, j] of [
      [0, 0],
      [40, 90],
      [128, 128],
      [VERTS - 1, VERTS - 1],
    ] as const) {
      const x = i * CELL_SIZE - WORLD_HALF;
      const z = j * CELL_SIZE - WORLD_HALF;
      expect(terrain.heightAt(x, z)).toBeCloseTo(terrain.heights[j * VERTS + i], 4);
    }
  });

  it('высота непрерывна: соседние точки не отличаются на обрыв', () => {
    for (let x = -900; x <= 900; x += 37) {
      const a = terrain.heightAt(x, 120);
      const b = terrain.heightAt(x + 0.5, 120);
      expect(Math.abs(a - b)).toBeLessThan(3);
    }
  });

  it('площадки поселений выровнены', () => {
    for (const site of SITES) {
      const center = terrain.heightAt(site.x, site.z);
      let maxDeviation = 0;
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 6) {
        const x = site.x + Math.cos(angle) * site.radius * 0.5;
        const z = site.z + Math.sin(angle) * site.radius * 0.5;
        maxDeviation = Math.max(maxDeviation, Math.abs(terrain.heightAt(x, z) - center));
      }
      // Полностью ровной площадку не делаем, но дворец не должен стоять на склоне.
      expect(maxDeviation, `площадка ${site.id}`).toBeLessThan(6);
    }
  });

  it('уклон нормирован', () => {
    for (let i = 0; i < 60; i++) {
      const x = -900 + i * 30;
      const slope = terrain.slopeAt(x, x * 0.5);
      expect(slope).toBeGreaterThanOrEqual(0);
      expect(slope).toBeLessThanOrEqual(1);
    }
  });
});
