import { describe, expect, it } from 'vitest';
import {
  ENCOUNTER_WEIGHTS,
  FRONT_CONE,
  OUT_OF_SIGHT_DISTANCE,
  encounterExpired,
  isSpotHidden,
  pickKind,
  type EncounterKind,
} from '../src/systems/encounters';

/**
 * Направление считается так же, как повороты персонажей: рыскание 0 смотрит в
 * сторону уменьшения Z. Поэтому «прямо перед игроком» — это точка с меньшим Z.
 */
describe('место встречи выбирается вне глаз игрока', () => {
  it('прямо перед носом ставить нельзя', () => {
    expect(isSpotHidden(0, -90, 0, 0, 0)).toBe(false);
  });

  it('за спиной — можно', () => {
    expect(isSpotHidden(0, 90, 0, 0, 0)).toBe(true);
  });

  it('далеко — можно даже прямо по курсу', () => {
    expect(isSpotHidden(0, -(OUT_OF_SIGHT_DISTANCE + 20), 0, 0, 0)).toBe(true);
  });

  it('сбоку, но в пределах переднего сектора — нельзя', () => {
    // Чуть внутрь границы сектора.
    const angle = FRONT_CONE * 0.8;
    const x = Math.sin(angle) * -90;
    const z = Math.cos(angle) * -90;
    expect(isSpotHidden(x, z, 0, 0, 0)).toBe(false);
  });

  it('сразу за краем переднего сектора — уже можно', () => {
    const angle = FRONT_CONE * 1.2;
    const x = Math.sin(angle) * -90;
    const z = Math.cos(angle) * -90;
    expect(isSpotHidden(x, z, 0, 0, 0)).toBe(true);
  });

  it('поворот головы меняет ответ', () => {
    // Та же точка: пока игрок смотрит на неё — нельзя, отвернулся — можно.
    expect(isSpotHidden(0, -90, 0, 0, 0)).toBe(false);
    expect(isSpotHidden(0, -90, 0, 0, Math.PI)).toBe(true);
  });
});

describe('когда встречу можно убрать', () => {
  it('свежую не убирают', () => {
    expect(encounterExpired(10, 900)).toBe(false);
  });

  it('старую, но близкую — тоже не убирают', () => {
    // Иначе люди растворятся на глазах у игрока.
    expect(encounterExpired(9000, 30)).toBe(false);
  });

  it('старую и далёкую — убирают', () => {
    expect(encounterExpired(9000, 900)).toBe(true);
  });
});

describe('выбор вида встречи', () => {
  it('нулевая доля даёт первый вид, предельная — последний', () => {
    expect(pickKind(0)).toBe(ENCOUNTER_WEIGHTS[0].kind);
    expect(pickKind(1)).toBe(ENCOUNTER_WEIGHTS[ENCOUNTER_WEIGHTS.length - 1].kind);
  });

  it('за пределами отрезка не ломается', () => {
    expect(pickKind(-5)).toBe(ENCOUNTER_WEIGHTS[0].kind);
    expect(pickKind(17)).toBe(ENCOUNTER_WEIGHTS[ENCOUNTER_WEIGHTS.length - 1].kind);
  });

  it('выпадают все четыре вида', () => {
    const seen = new Set<EncounterKind>();
    for (let i = 0; i < 1000; i++) seen.add(pickKind(i / 1000));
    expect(seen.size).toBe(ENCOUNTER_WEIGHTS.length);
  });

  it('более весомый вид выпадает чаще', () => {
    const weights = [
      { kind: 'ambush' as const, weight: 9 },
      { kind: 'wounded' as const, weight: 1 },
    ];
    let ambush = 0;
    for (let i = 0; i < 1000; i++) if (pickKind(i / 1000, weights) === 'ambush') ambush++;
    expect(ambush).toBeGreaterThan(850);
  });
});
