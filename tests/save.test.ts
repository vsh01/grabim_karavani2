import { describe, expect, it } from 'vitest';
import { SAVE_VERSION, describeSave, migrate, type SaveGame } from '../src/systems/save';
import { Body, BodyPart } from '../src/entities/body';
import { Inventory } from '../src/data/items';
import { Reputation } from '../src/systems/reputation';
import { Economy } from '../src/systems/economy';
import { QuestLog } from '../src/systems/quests';
import { Faction } from '../src/data/factions';
import { Rng } from '../src/core/rng';

/** Собрать снимок так же, как это делает игра, но без графики. */
function buildSave(): SaveGame {
  const wounds = new Body();
  wounds.damage(BodyPart.LeftLeg, 400, { type: 'cut' });
  wounds.attachProsthetic(BodyPart.LeftLeg);

  const inventory = new Inventory();
  inventory.add('sword');
  inventory.add('bandage', 3);
  inventory.add('furs', 12);
  inventory.gold = 317;
  inventory.equippedWeapon = 'sword';

  const reputation = new Reputation(Faction.Villain);
  reputation.change(Faction.Palace, -44);

  const economy = new Economy();
  economy.registerLostCargo('village', [{ id: 'silk', count: 9 }]);

  const quests = new QuestLog();
  quests.offer(Faction.Villain, new Rng(3));
  quests.onRecruit();

  return {
    version: SAVE_VERSION,
    seed: 20260816,
    savedAt: new Date('2026-08-17T00:30:00Z').toISOString(),
    label: describeSave('Злодей и его люди', 'Горы злодея', inventory.gold),
    timeOfDay: 0.61,
    player: {
      faction: Faction.Villain,
      name: 'Кирилл Грозный',
      x: 90,
      y: 42.5,
      z: -700,
      yaw: 1.2,
      pitch: -0.1,
      wounds: wounds.serialize(),
      inventory: inventory.serialize(),
    },
    reputation: reputation.serialize(),
    quests: quests.serialize(),
    economy: economy.serialize(),
    actors: [],
    caravans: [
      {
        owner: Faction.Palace,
        fromSite: 'palace',
        toSite: 'village',
        cargo: [{ id: 'silk', count: 7 }],
        gold: 140,
        distanceAlong: 213.5,
        looted: false,
        members: [],
      },
    ],
  };
}

describe('снимок сохранения', () => {
  it('переживает запись в строку и чтение обратно', () => {
    const save = buildSave();
    const restored = JSON.parse(JSON.stringify(save)) as SaveGame;

    expect(restored).toEqual(save);
    expect(restored.player.name).toBe('Кирилл Грозный');
    expect(restored.caravans[0].distanceAlong).toBeCloseTo(213.5, 5);
  });

  it('состояние игрока восстанавливается вплоть до протеза', () => {
    const save = buildSave();
    const raw = JSON.parse(JSON.stringify(save)) as SaveGame;

    const wounds = new Body();
    wounds.restore(raw.player.wounds);
    expect(wounds.get(BodyPart.LeftLeg).prosthetic).toBe(true);
    expect(wounds.movementMode).toBe('prosthetic');

    const inventory = new Inventory();
    inventory.restore(raw.player.inventory);
    expect(inventory.gold).toBe(317);
    expect(inventory.count('furs')).toBe(12);
    expect(inventory.weapon.id).toBe('sword');
  });

  it('репутация, цены и приказы возвращаются как были', () => {
    const raw = JSON.parse(JSON.stringify(buildSave())) as SaveGame;

    const reputation = new Reputation(Faction.Elves);
    reputation.restore(raw.reputation);
    expect(reputation.get(Faction.Palace)).toBe(-44);
    expect(reputation.get(Faction.Villain)).toBeGreaterThan(0);

    const economy = new Economy();
    economy.restore(raw.economy);
    expect(economy.shortageOf('village', 'silk')).toBeGreaterThan(0);

    const quests = new QuestLog();
    quests.restore(raw.quests);
    expect(quests.active?.progress).toBe(1);
  });

  it('снимок из будущей версии не принимается', () => {
    const save = buildSave();
    save.version = SAVE_VERSION + 5;
    expect(migrate(save)).toBeNull();
  });

  it('снимок текущей версии проходит проверку', () => {
    expect(migrate(buildSave())).not.toBeNull();
  });

  it('подпись слота читаема', () => {
    expect(describeSave('Лесные эльфы', 'Лес эльфов', 240)).toBe('Лесные эльфы · Лес эльфов · 240 зол.');
  });
});
