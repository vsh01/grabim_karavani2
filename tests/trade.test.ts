import { describe, expect, it } from 'vitest';
import { Economy, MARKETS, marketAt, stackValue, validateMarkets } from '../src/systems/economy';
import { Reputation } from '../src/systems/reputation';
import { Faction } from '../src/data/factions';
import { Inventory, item } from '../src/data/items';
import { RoadNetwork, TRADE_HUBS } from '../src/world/roads';
import { Terrain } from '../src/world/terrain';
import { getSite } from '../src/world/sites';
import { distance2D } from '../src/core/math';
import { DEFENDER_RANGE, countsAsDefender } from '../src/entities/caravan';
import { AiState } from '../src/entities/actor';

describe('прилавки', () => {
  it('все товары на прилавках существуют', () => {
    expect(validateMarkets()).toEqual([]);
  });

  it('где производят — дешевле, где ждут — дороже', () => {
    const economy = new Economy();
    // Зерно растят в деревне людей, а во дворце его ждут.
    expect(economy.basePrice('grain', 'village')).toBeLessThan(economy.basePrice('grain', 'palace'));
    // Меха добывают эльфы, а нужны они людям.
    expect(economy.basePrice('furs', 'glade')).toBeLessThan(economy.basePrice('furs', 'village'));
  });

  it('торговец покупает дешевле, чем продаёт', () => {
    const economy = new Economy();
    for (const market of MARKETS) {
      for (const id of ['bandage', 'sword', 'grain']) {
        expect(economy.sellPrice(id, market.siteId)).toBeLessThan(economy.buyPrice(id, market.siteId));
      }
    }
  });
});

describe('последствия ограбления корована', () => {
  it('недоехавший груз поднимает цену в городе назначения', () => {
    const economy = new Economy();
    const before = economy.basePrice('silk', 'village');

    economy.registerLostCargo('village', [{ id: 'silk', count: 12 }]);
    const after = economy.basePrice('silk', 'village');

    expect(after).toBeGreaterThan(before);
    expect(economy.shortageOf('village', 'silk')).toBeGreaterThan(0);
    // На соседний город это не влияет.
    expect(economy.shortageOf('palace', 'silk')).toBe(0);
  });

  it('дефицит со временем рассасывается', () => {
    const economy = new Economy();
    economy.registerLostCargo('palace', [{ id: 'wine', count: 10 }]);
    const spike = economy.shortageOf('palace', 'wine');

    for (let i = 0; i < 100; i++) economy.update(1);
    expect(economy.shortageOf('palace', 'wine')).toBeLessThan(spike);

    for (let i = 0; i < 600; i++) economy.update(1);
    expect(economy.shortageOf('palace', 'wine')).toBe(0);
  });

  it('дефицит не растёт бесконечно, сколько корованов ни грабь', () => {
    const economy = new Economy();
    for (let i = 0; i < 40; i++) {
      economy.registerLostCargo('village', [{ id: 'iron', count: 20 }]);
    }
    expect(economy.shortageOf('village', 'iron')).toBeLessThanOrEqual(1.8);
  });

  it('добычу выгоднее всего сбывать там, где её ждали', () => {
    const economy = new Economy();
    economy.registerLostCargo('palace', [{ id: 'wine', count: 14 }]);

    const best = economy.bestMarketFor('wine');
    expect(best?.market.siteId).toBe('palace');
  });

  it('оценка добычи считается по базовым ценам', () => {
    const expected = item('furs').price * 3 + item('silk').price * 2;
    expect(
      stackValue([
        { id: 'furs', count: 3 },
        { id: 'silk', count: 2 },
      ]),
    ).toBe(expected);
  });
});

describe('репутация', () => {
  it('за своих начинают со знаком плюс', () => {
    const reputation = new Reputation(Faction.Elves);
    expect(reputation.get(Faction.Elves)).toBeGreaterThan(0);
    expect(reputation.get(Faction.Neutral)).toBe(0);
  });

  it('испорченные отношения делают своих же врагами', () => {
    const reputation = new Reputation(Faction.Palace);
    expect(reputation.hostilityTowardsPlayer(Faction.Palace, Faction.Palace)).toBe(0);

    reputation.set(Faction.Palace, -80);
    expect(reputation.hostilityTowardsPlayer(Faction.Palace, Faction.Palace)).toBeGreaterThan(0.5);
    expect(reputation.willTrade(Faction.Palace)).toBe(false);
  });

  it('заслуги успокаивают даже исконных врагов', () => {
    const reputation = new Reputation(Faction.Elves);
    const before = reputation.hostilityTowardsPlayer(Faction.Palace, Faction.Elves);
    expect(before).toBeGreaterThan(0.5);

    reputation.set(Faction.Palace, 100);
    expect(reputation.hostilityTowardsPlayer(Faction.Palace, Faction.Elves)).toBe(0);
  });

  it('своим продают дешевле, а покупают у них охотнее', () => {
    const economy = new Economy();
    const friendly = new Reputation(Faction.Neutral);
    const stranger = new Reputation(Faction.Elves);
    friendly.set(Faction.Neutral, 90);
    stranger.set(Faction.Neutral, -40);

    expect(economy.buyPrice('sword', 'village', friendly)).toBeLessThan(
      economy.buyPrice('sword', 'village', stranger),
    );
    expect(economy.sellPrice('furs', 'village', friendly)).toBeGreaterThan(
      economy.sellPrice('furs', 'village', stranger),
    );
  });

  it('репутация переживает сохранение', () => {
    const reputation = new Reputation(Faction.Villain);
    reputation.change(Faction.Palace, -63);
    const snapshot = JSON.parse(JSON.stringify(reputation.serialize()));

    const restored = new Reputation(Faction.Elves);
    restored.restore(snapshot);
    expect(restored.get(Faction.Palace)).toBe(reputation.get(Faction.Palace));
    expect(restored.get(Faction.Villain)).toBe(reputation.get(Faction.Villain));
  });
});

describe('мешок', () => {
  it('одинаковые товары складываются в стопку', () => {
    const inventory = new Inventory();
    inventory.add('bandage', 3);
    inventory.add('bandage', 2);
    expect(inventory.count('bandage')).toBe(5);
    expect(inventory.stacks.length).toBe(1);
  });

  it('нельзя достать больше, чем есть', () => {
    const inventory = new Inventory();
    inventory.add('arrow', 5);
    expect(inventory.remove('arrow', 9)).toBe(false);
    expect(inventory.count('arrow')).toBe(5);
    expect(inventory.remove('arrow', 5)).toBe(true);
    expect(inventory.has('arrow')).toBe(false);
  });

  it('вес и броня считаются по надетому', () => {
    const inventory = new Inventory();
    inventory.add('mail');
    inventory.equippedArmor = 'mail';
    expect(inventory.armorValue).toBe(item('mail').armor);
    expect(inventory.totalWeight).toBeCloseTo(item('mail').weight, 5);
  });
});

describe('дороги', () => {
  const terrain = new Terrain();
  const roads = new RoadNetwork(terrain);

  it('между всеми торговыми узлами есть маршрут', () => {
    for (const from of TRADE_HUBS) {
      for (const to of TRADE_HUBS) {
        if (from === to) continue;
        const route = roads.routeBetween(from, to);
        expect(route.length, `${from} → ${to}`).toBeGreaterThan(1);
      }
    }
  });

  it('маршрут начинается и заканчивается у нужных поселений', () => {
    const route = roads.routeBetween('glade', 'village');
    const start = route[0];
    const end = route[route.length - 1];
    const glade = getSite('glade');
    const village = getSite('village');

    expect(distance2D(start.x, start.z, glade.x, glade.z)).toBeLessThan(5);
    expect(distance2D(end.x, end.z, village.x, village.z)).toBeLessThan(5);
  });

  it('маршрут непрерывен: между соседними точками нет разрывов', () => {
    const route = roads.routeBetween('fort', 'glade');
    for (let i = 0; i < route.length - 1; i++) {
      const step = distance2D(route[i].x, route[i].z, route[i + 1].x, route[i + 1].z);
      expect(step).toBeLessThan(40);
    }
  });

  it('на полотне дороги расстояние до неё нулевое, а в стороне — нет', () => {
    const route = roads.routeBetween('village', 'palace');
    const middle = route[Math.floor(route.length / 2)];

    expect(roads.distanceTo(middle.x, middle.z)).toBeLessThan(1);
    expect(roads.isOnRoad(middle.x, middle.z)).toBe(true);
    expect(roads.isOnRoad(middle.x + 40, middle.z + 40)).toBe(false);
  });

  it('дорога срезает рельеф: по тракту нет обрывов', () => {
    const route = roads.routeBetween('village', 'palace');
    roads.carveInto(terrain);

    for (let i = 0; i < route.length - 1; i++) {
      const a = terrain.heightAt(route[i].x, route[i].z);
      const b = terrain.heightAt(route[i + 1].x, route[i + 1].z);
      const run = distance2D(route[i].x, route[i].z, route[i + 1].x, route[i + 1].z);
      // Уклон полотна не должен превышать примерно 25 градусов.
      expect(Math.abs(b - a) / Math.max(1, run)).toBeLessThan(0.47);
    }
  });

  it('каждый узел с прилавком стоит на дороге', () => {
    for (const market of MARKETS) {
      expect(marketAt(market.siteId)).toBeDefined();
      expect(roads.connectedSites).toContain(market.siteId);
    }
  });
});

describe('кто стережёт корован', () => {
  /** Здоровый боец, стоящий вплотную к телеге. */
  function guard(overrides: Partial<Parameters<typeof countsAsDefender>[0]> = {}) {
    return { alive: true, canFight: true, state: AiState.Attack, x: 2, z: 0, ...overrides };
  }

  it('живой боец рядом с телегой её стережёт', () => {
    expect(countsAsDefender(guard(), 0, 0)).toBe(true);
  });

  it('убитый уже никого не стережёт', () => {
    expect(countsAsDefender(guard({ alive: false }), 0, 0)).toBe(false);
  });

  it('удирающий охраной не считается', () => {
    // Иначе один стражник, сбежавший от боли за дерево, навсегда запирал бы обоз.
    expect(countsAsDefender(guard({ state: AiState.Flee }), 0, 0)).toBe(false);
  });

  it('безрукий телегу не удержит', () => {
    expect(countsAsDefender(guard({ canFight: false }), 0, 0)).toBe(false);
  });

  it('ушедший далеко перестаёт быть охраной', () => {
    expect(countsAsDefender(guard({ x: DEFENDER_RANGE - 1 }), 0, 0)).toBe(true);
    expect(countsAsDefender(guard({ x: DEFENDER_RANGE + 1 }), 0, 0)).toBe(false);
  });

  it('разбежавшееся сопровождение открывает телегу целиком', () => {
    const escort = [
      guard({ alive: false }),
      guard({ state: AiState.Flee, x: 6 }),
      guard({ canFight: false, x: 3 }),
      guard({ x: DEFENDER_RANGE + 12 }),
    ];
    expect(escort.some((member) => countsAsDefender(member, 0, 0))).toBe(false);
  });
});
