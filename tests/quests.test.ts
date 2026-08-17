import { describe, expect, it } from 'vitest';
import { QuestLog, orderCount } from '../src/systems/quests';
import { Faction, PLAYABLE_FACTIONS } from '../src/data/factions';
import { Rng } from '../src/core/rng';

function log(): { quests: QuestLog; rng: Rng } {
  return { quests: new QuestLog(), rng: new Rng(7) };
}

describe('приказы', () => {
  it('у каждой играбельной стороны есть свои приказы', () => {
    for (const faction of PLAYABLE_FACTIONS) {
      expect(orderCount(faction), faction).toBeGreaterThan(0);
    }
    // Мирным людям приказывать некому.
    expect(orderCount(Faction.Neutral)).toBe(0);
  });

  it('приказ выдаётся и сразу становится активным', () => {
    const { quests, rng } = log();
    expect(quests.hasActive).toBe(false);

    const order = quests.offer(Faction.Palace, rng);
    expect(order).not.toBeNull();
    expect(quests.hasActive).toBe(true);
    expect(quests.describe()).toContain('0 из');
  });

  it('засчитываются только убитые из нужной стороны', () => {
    const { quests, rng } = log();
    quests.offer(Faction.Palace, rng); // «Разогнать партизан»: четверо эльфов

    quests.onKill(Faction.Villain);
    expect(quests.active?.progress).toBe(0);

    quests.onKill(Faction.Elves);
    expect(quests.active?.progress).toBe(1);
  });

  it('приказ закрывается на последнем засчитанном действии', () => {
    const { quests, rng } = log();
    const order = quests.offer(Faction.Palace, rng);
    const need = order?.objective.count ?? 0;

    for (let i = 0; i < need - 1; i++) {
      expect(quests.onKill(Faction.Elves)).toBe(false);
    }
    expect(quests.onKill(Faction.Elves)).toBe(true);
    expect(quests.active?.done).toBe(true);
    expect(quests.describe()).toContain('выполнено');
  });

  it('награда выдаётся один раз, и приказ уходит в выполненные', () => {
    const { quests, rng } = log();
    quests.offer(Faction.Elves, rng); // «Пощипать обоз императора»
    quests.onRobbery(Faction.Palace);

    const claimed = quests.claim();
    expect(claimed?.gold).toBeGreaterThan(0);
    expect(quests.completed.has(claimed!.id)).toBe(true);
    expect(quests.active).toBeNull();
    expect(quests.claim()).toBeNull();
  });

  it('следующий приказ отличается от уже выполненного', () => {
    const { quests, rng } = log();
    const first = quests.offer(Faction.Villain, rng);
    // Проходим его целиком.
    for (let i = 0; i < (first?.objective.count ?? 0); i++) quests.onRecruit();
    quests.claim();

    const second = quests.offer(Faction.Villain, rng);
    expect(second?.id).not.toBe(first?.id);
  });

  it('обоз любого хозяина годится, если в приказе хозяин не указан', () => {
    const { quests, rng } = log();
    quests.offer(Faction.Villain, rng);
    for (let i = 0; i < 3; i++) quests.onRecruit();
    quests.claim();

    // Следующий приказ злодея — обчистить тракт, без указания хозяина обозов.
    const order = quests.offer(Faction.Villain, rng);
    expect(order?.objective.kind).toBe('rob');
    expect(order?.objective.faction).toBeUndefined();

    quests.onRobbery(Faction.Neutral);
    expect(quests.active?.progress).toBe(1);
  });

  it('дозорный приказ закрывается приходом в нужную точку', () => {
    const { quests, rng } = log();
    // Пропускаем первые два приказа стражи, чтобы добраться до дозора.
    for (let i = 0; i < 2; i++) {
      const order = quests.offer(Faction.Palace, rng);
      for (let k = 0; k < (order?.objective.count ?? 0); k++) {
        quests.onKill(order!.objective.faction!);
      }
      quests.claim();
    }

    const patrolOrder = quests.offer(Faction.Palace, rng);
    expect(patrolOrder?.objective.kind).toBe('reach');

    expect(quests.onReach('village')).toBe(false);
    expect(quests.onReach(patrolOrder!.objective.siteId!)).toBe(true);
  });

  it('приказы переживают сохранение', () => {
    const { quests, rng } = log();
    quests.offer(Faction.Elves, rng);
    quests.onRobbery(Faction.Palace);
    quests.claim();
    quests.offer(Faction.Elves, rng);
    quests.onKill(Faction.Palace);

    const snapshot = JSON.parse(JSON.stringify(quests.serialize()));
    const restored = new QuestLog();
    restored.restore(snapshot);

    expect(restored.active?.id).toBe(quests.active?.id);
    expect(restored.active?.progress).toBe(quests.active?.progress);
    expect([...restored.completed]).toEqual([...quests.completed]);
  });
});
