import { describe, expect, it, vi } from 'vitest';
import {
  BLOOD_MONEY_RATE,
  BOUNTY_MAX_PER_ROBBERY,
  BOUNTY_MIN,
  BOUNTY_PER_KILL,
  BountySystem,
  bountyForRobbery,
  hunterPartySize,
  hunterTier,
  shouldGiveUp,
} from '../src/systems/bounty';
import { Faction } from '../src/data/factions';
import { fakePopulation, type FakeActor } from './fakes';

function system(onAnnounce: (message: string, tone: string) => void = () => {}): {
  bounty: BountySystem;
  spawned: FakeActor[];
} {
  const world = fakePopulation();
  return { bounty: new BountySystem(world.population, 7, onAnnounce as never), spawned: world.spawned };
}

describe('сколько назначат за голову', () => {
  it('за пустой обоз не назначают ничего', () => {
    expect(bountyForRobbery(0, 0)).toBe(0);
  });

  it('за мелочь всё равно назначают не меньше порога', () => {
    // Иначе за грабёж в три монеты выходила бы награда, которую не заметят.
    expect(bountyForRobbery(4, 2)).toBe(BOUNTY_MIN);
  });

  it('чем богаче обоз, тем больше награда', () => {
    expect(bountyForRobbery(400, 100)).toBeGreaterThan(bountyForRobbery(200, 50));
  });

  it('один жирный обоз не поднимает награду до небес', () => {
    expect(bountyForRobbery(100000, 100000)).toBe(BOUNTY_MAX_PER_ROBBERY);
  });
});

describe('сколько человек пошлют', () => {
  it('за мелкую награду не идут вовсе', () => {
    expect(hunterTier(0)).toBe(0);
    expect(hunterTier(59)).toBe(0);
    expect(hunterPartySize(0)).toBe(0);
  });

  it('отряд растёт ступенями', () => {
    expect(hunterTier(60)).toBe(1);
    expect(hunterTier(149)).toBe(1);
    expect(hunterTier(150)).toBe(2);
    expect(hunterTier(299)).toBe(2);
    expect(hunterTier(300)).toBe(3);
    expect(hunterTier(5000)).toBe(3);
  });

  it('каждая следующая ступень многочисленнее', () => {
    expect(hunterPartySize(1)).toBeLessThan(hunterPartySize(2));
    expect(hunterPartySize(2)).toBeLessThan(hunterPartySize(3));
  });
});

describe('когда охотники бросают след', () => {
  it('пока игрок на виду, погоня продолжается', () => {
    expect(shouldGiveUp(0, 0)).toBe(false);
    expect(shouldGiveUp(60, 10)).toBe(false);
  });

  it('долго не находят — уходят', () => {
    expect(shouldGiveUp(91, 0)).toBe(true);
  });

  it('оторвался далеко и держится — тоже уходят', () => {
    expect(shouldGiveUp(0, 31)).toBe(true);
  });
});

describe('счёт награды', () => {
  it('ограбление и убийства складываются', () => {
    const { bounty } = system();
    bounty.registerRobbery(Faction.Palace, 200, 60);
    const afterRobbery = bounty.get(Faction.Palace);

    bounty.registerKill(Faction.Palace);
    expect(bounty.get(Faction.Palace)).toBe(afterRobbery + BOUNTY_PER_KILL);
  });

  it('награда назначается только той стороне, которую ограбили', () => {
    const { bounty } = system();
    bounty.registerRobbery(Faction.Palace, 300, 80);
    expect(bounty.get(Faction.Elves)).toBe(0);
    expect(bounty.worst?.faction).toBe(Faction.Palace);
  });

  it('мирные люди награду не назначают: у них нет ни казны, ни охотников', () => {
    const { bounty } = system();
    bounty.registerRobbery(Faction.Neutral, 500, 200);
    expect(bounty.get(Faction.Neutral)).toBe(0);
  });

  it('со временем награда забывается', () => {
    const { bounty } = system();
    bounty.registerRobbery(Faction.Palace, 200, 40);
    const start = bounty.get(Faction.Palace);

    const world = { playerX: 0, playerZ: 0, playerAlive: true };
    for (let i = 0; i < 300; i++) bounty.update(1, world);

    const after = bounty.get(Faction.Palace);
    expect(after).toBeLessThan(start);
    expect(after).toBeGreaterThanOrEqual(0);
  });

  it('отсидевшись достаточно долго, можно перестать быть в розыске', () => {
    const { bounty } = system();
    bounty.add(Faction.Elves, 40);

    const world = { playerX: 0, playerZ: 0, playerAlive: true };
    for (let i = 0; i < 400; i++) bounty.update(1, world);

    expect(bounty.get(Faction.Elves)).toBe(0);
    expect(bounty.worst).toBeNull();
  });

  it('про новую ступень сообщают, но не тараторят на каждую монету', () => {
    const announce = vi.fn();
    const { bounty } = system(announce);

    bounty.add(Faction.Palace, 70);
    bounty.add(Faction.Palace, 5);
    bounty.add(Faction.Palace, 5);
    const afterSmallChange = announce.mock.calls.length;

    bounty.add(Faction.Palace, 100);
    expect(announce.mock.calls.length).toBeGreaterThan(afterSmallChange);
  });
});

describe('погоня', () => {
  const near = { playerX: 0, playerZ: 0, playerAlive: true };

  it('за мелкую награду никто не выходит', () => {
    const { bounty, spawned } = system();
    bounty.add(Faction.Palace, 30);
    for (let i = 0; i < 10; i++) bounty.update(1, near);
    expect(spawned.length).toBe(0);
  });

  it('когда награда доросла, отряд выходит сам', () => {
    const { bounty, spawned } = system();
    bounty.add(Faction.Palace, 200);
    bounty.update(1, near);

    expect(spawned.length).toBeGreaterThan(0);
    // Охотник бьёт лично игрока, а не воюет за свою сторону вообще.
    expect(spawned.every((actor) => actor.huntsPlayer)).toBe(true);
  });

  it('отряд идёт туда, где игрока видели в последний раз', () => {
    const { bounty, spawned } = system();
    bounty.launch(Faction.Palace, { playerX: 100, playerZ: 50, playerAlive: true });

    // Игрок сместился, но остался в пределах видимости следа.
    spawned.forEach((actor) => {
      actor.position.x = 90;
      actor.position.z = 45;
    });
    bounty.update(1, { playerX: 140, playerZ: 60, playerAlive: true });

    expect(spawned[0].escortAnchor.x).toBeCloseTo(140, 5);
    expect(spawned[0].escortAnchor.z).toBeCloseTo(60, 5);
  });

  it('кто оторвался и отсиделся — того теряют', () => {
    const { bounty, spawned } = system();
    bounty.launch(Faction.Palace, near);
    expect(spawned.every((actor) => actor.huntsPlayer)).toBe(true);

    // Отряд дошёл до места, где игрока видели, а игрок давно ушёл.
    spawned.forEach((actor) => {
      actor.position.x = 0;
      actor.position.z = 0;
    });
    const far = { playerX: 5000, playerZ: 5000, playerAlive: true };
    for (let i = 0; i < 120; i++) bounty.update(1, far);

    expect(spawned.some((actor) => actor.huntsPlayer)).toBe(false);
    expect(bounty.report().every((entry) => entry.hunters === 0 || entry.givingUp)).toBe(true);
  });

  it('отряд из дальнего гарнизона не выдыхается по дороге', () => {
    // Раньше след остывал прямо в пути: пока охотники шли через полкарты,
    // счётчик «давно не видели» успевал добежать до предела, и отряд
    // разворачивался, ни разу не дойдя. Такая охота бессмысленна.
    const { bounty, spawned } = system();
    bounty.launch(Faction.Palace, { playerX: 800, playerZ: 800, playerAlive: true });

    // Идут издалека и ещё не дошли до места, где игрока видели.
    spawned.forEach((actor) => {
      actor.position.x = 0;
      actor.position.z = 0;
    });
    for (let i = 0; i < 200; i++) {
      bounty.update(1, { playerX: 800, playerZ: 800, playerAlive: true });
    }

    expect(spawned.every((actor) => actor.huntsPlayer)).toBe(true);
  });

  it('вира отзывает уже вышедший отряд', () => {
    const { bounty, spawned } = system();
    bounty.add(Faction.Palace, 200);
    bounty.update(1, near);
    expect(spawned.some((actor) => actor.huntsPlayer)).toBe(true);

    bounty.payOff(Faction.Palace);
    expect(spawned.some((actor) => actor.huntsPlayer)).toBe(false);
  });

  it('двух отрядов от одной стороны разом не бывает', () => {
    const { bounty, spawned } = system();
    bounty.add(Faction.Palace, 400);
    for (let i = 0; i < 60; i++) bounty.update(1, near);

    // Пятеро — это один отряд высшей ступени, а не два подряд.
    expect(spawned.length).toBe(hunterPartySize(3));
  });
});

describe('вира', () => {
  it('стоит вдвое против назначенного', () => {
    const { bounty } = system();
    bounty.add(Faction.Palace, 120);
    expect(bounty.bloodMoney(Faction.Palace)).toBe(120 * BLOOD_MONEY_RATE);
  });

  it('уплаченная вира снимает награду', () => {
    const { bounty } = system();
    bounty.add(Faction.Palace, 120);

    const paid = bounty.payOff(Faction.Palace);
    expect(paid).toBe(240);
    expect(bounty.get(Faction.Palace)).toBe(0);
  });

  it('платить не за что, когда за вами ничего не числится', () => {
    const { bounty } = system();
    expect(bounty.payOff(Faction.Elves)).toBe(0);
  });

  it('вира одной стороне не отменяет розыск у другой', () => {
    const { bounty } = system();
    bounty.add(Faction.Palace, 100);
    bounty.add(Faction.Elves, 100);

    bounty.payOff(Faction.Palace);
    expect(bounty.get(Faction.Elves)).toBe(100);
  });
});
