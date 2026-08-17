import { ALL_FACTIONS, Faction, FACTIONS } from '../data/factions';
import { Rng } from '../core/rng';
import { clamp, distance2D } from '../core/math';
import { getSite } from '../world/sites';
import type { Actor } from '../entities/actor';
import type { Population } from './population';

/**
 * Награда за голову и охотники по следу.
 *
 * Репутация уже делает стороны враждебными: ограбьте дворец достаточно раз, и
 * стража начнёт бить при встрече. Но это пассивно — мир ждёт, пока вы сами к
 * нему придёте. Награда за голову работает наоборот: она посылает людей за вами.
 * Именно это превращает грабёж из безнаказанного занятия в ремесло с риском.
 *
 * Уйти можно. Отряд идёт к последнему месту, где вас видели, и бросает след,
 * если долго не находит, — поэтому лес, ночь и просто расстояние работают как
 * укрытие. Второй выход — заплатить виру, вдвое больше назначенного.
 */

/** Ниже этого награда не назначается: за мелочь никто не поедет. */
export const BOUNTY_MIN = 25;
/** Потолок за одно ограбление, чтобы один жирный обоз не давал сразу облаву. */
export const BOUNTY_MAX_PER_ROBBERY = 250;
/** Прибавка за каждого убитого. */
export const BOUNTY_PER_KILL = 15;
/** За сколько секунд забывается одна золотая монета награды. */
export const BOUNTY_FORGET_SECONDS = 8;
/** Во сколько раз вира дороже самой награды. */
export const BLOOD_MONEY_RATE = 2;

/** Сколько назначат за голову после ограбления обоза. */
export function bountyForRobbery(cargoValue: number, gold: number): number {
  const raw = (cargoValue + gold) / 2;
  if (raw <= 0) return 0;
  return Math.round(clamp(raw, BOUNTY_MIN, BOUNTY_MAX_PER_ROBBERY));
}

/**
 * Сколько человек пошлют за такой наградой.
 * 0 — никого: пока не набежало, вас просто не считают стоящим погони.
 */
export function hunterTier(bounty: number): number {
  if (bounty < 60) return 0;
  if (bounty < 150) return 1;
  if (bounty < 300) return 2;
  return 3;
}

/** Размер отряда по ступени. */
export function hunterPartySize(tier: number): number {
  if (tier <= 0) return 0;
  if (tier === 1) return 2;
  if (tier === 2) return 3;
  return 5;
}

/**
 * Пора ли бросить след.
 *
 * Это и есть выбранная жёсткость: охота ощутимая, но пережить её можно. Кто
 * оторвался и отсиделся — тот ушёл.
 */
export function shouldGiveUp(secondsSinceSeen: number, secondsFarAway: number): boolean {
  return secondsSinceSeen > 90 || secondsFarAway > 30;
}

/** Дальше этого расстояния игрок считается оторвавшимся. */
export const LOST_DISTANCE = 400;
/** Ближе этого охотники знают, где вы, без всякого следа. */
export const TRACK_DISTANCE = 220;
/**
 * Насколько близко к последнему известному месту надо подойти, чтобы считать,
 * что отряд дошёл и никого там не застал.
 */
export const ARRIVED_AT_TRAIL = 30;

/** Откуда выходит охота каждой стороны. */
const HUNTER_HOME: Record<Faction, string> = {
  [Faction.Palace]: 'barracks',
  [Faction.Elves]: 'partisan-camp',
  [Faction.Villain]: 'fort',
  [Faction.Neutral]: 'village',
};

const HUNTER_WEAPONS: Record<Faction, string[]> = {
  [Faction.Palace]: ['sword', 'mace', 'sword', 'bow'],
  [Faction.Elves]: ['bow', 'bow', 'sword'],
  [Faction.Villain]: ['axe', 'sword', 'mace'],
  [Faction.Neutral]: ['sword', 'dagger'],
};

export interface BountySnapshot {
  values: Record<string, number>;
}

interface Hunt {
  faction: Faction;
  actors: Actor[];
  /** Куда идти: последнее место, где игрока видели. */
  lastKnownX: number;
  lastKnownZ: number;
  secondsSinceSeen: number;
  secondsFarAway: number;
  givingUp: boolean;
  age: number;
}

/** Куда смотреть системе, чтобы понять, где игрок и кому он насолил. */
export interface BountyWorld {
  playerX: number;
  playerZ: number;
  playerAlive: boolean;
}

export class BountySystem {
  private readonly values = new Map<Faction, number>();
  private readonly hunts: Hunt[] = [];
  private readonly announced = new Map<Faction, number>();
  private readonly rng: Rng;
  /** Пауза до следующей возможной охоты, по каждой стороне. */
  private readonly cooldown = new Map<Faction, number>();

  constructor(
    private readonly population: Population,
    seed: number,
    private readonly onAnnounce: (message: string, tone: 'plain' | 'bad' | 'alarm') => void,
  ) {
    this.rng = new Rng(seed ^ 0xb0117);
    for (const faction of ALL_FACTIONS) this.values.set(faction, 0);
  }

  get(faction: Faction): number {
    return Math.round(this.values.get(faction) ?? 0);
  }

  /** Самая большая награда — её и показываем в углу экрана. */
  get worst(): { faction: Faction; amount: number } | null {
    let best: { faction: Faction; amount: number } | null = null;
    for (const faction of ALL_FACTIONS) {
      const amount = this.get(faction);
      if (amount > 0 && (!best || amount > best.amount)) best = { faction, amount };
    }
    return best;
  }

  get activeHunts(): number {
    return this.hunts.length;
  }

  /** Живые охотники — их показывает карта, чтобы было понятно, от кого бежать. */
  hunterActors(): Actor[] {
    const actors: Actor[] = [];
    for (const hunt of this.hunts) {
      for (const actor of hunt.actors) if (actor.alive) actors.push(actor);
    }
    return actors;
  }

  /** Сколько стоит откупиться от этой стороны. */
  bloodMoney(faction: Faction): number {
    return this.get(faction) * BLOOD_MONEY_RATE;
  }

  add(faction: Faction, amount: number): void {
    if (amount <= 0) return;
    // Мирные люди награду не назначают: у них нет ни казны, ни охотников.
    if (faction === Faction.Neutral) return;

    const before = this.get(faction);
    this.values.set(faction, (this.values.get(faction) ?? 0) + amount);
    const after = this.get(faction);

    // Про новую ступень сообщаем один раз, а не каждый раз при росте награды.
    const tier = hunterTier(after);
    if (tier > (this.announced.get(faction) ?? 0)) {
      this.announced.set(faction, tier);
      this.onAnnounce(`${FACTIONS[faction].name}: за вашу голову объявлено ${after} золота`, 'alarm');
    } else if (before === 0 && after > 0) {
      this.onAnnounce(`${FACTIONS[faction].name} запомнили вас: ${after} золота за голову`, 'bad');
    }
  }

  registerRobbery(faction: Faction, cargoValue: number, gold: number): number {
    const amount = bountyForRobbery(cargoValue, gold);
    this.add(faction, amount);
    return amount;
  }

  registerKill(faction: Faction): void {
    this.add(faction, BOUNTY_PER_KILL);
  }

  /** Заплатить виру: награда этой стороны снимается, её охота прекращается. */
  payOff(faction: Faction): number {
    const price = this.bloodMoney(faction);
    if (price <= 0) return 0;

    this.values.set(faction, 0);
    this.announced.set(faction, 0);
    for (const hunt of this.hunts) {
      if (hunt.faction === faction) this.callOff(hunt);
    }
    return price;
  }

  update(dt: number, world: BountyWorld): void {
    this.forget(dt);

    for (const faction of ALL_FACTIONS) {
      const left = (this.cooldown.get(faction) ?? 0) - dt;
      this.cooldown.set(faction, Math.max(0, left));
    }

    if (world.playerAlive) this.maybeLaunch(world);
    this.updateHunts(dt, world);
  }

  /** Награда медленно забывается: сидя тихо, можно переждать. */
  private forget(dt: number): void {
    for (const faction of ALL_FACTIONS) {
      const value = this.values.get(faction) ?? 0;
      if (value <= 0) continue;
      const next = Math.max(0, value - dt / BOUNTY_FORGET_SECONDS);
      this.values.set(faction, next);
      if (hunterTier(next) < (this.announced.get(faction) ?? 0)) {
        this.announced.set(faction, hunterTier(next));
      }
    }
  }

  private maybeLaunch(world: BountyWorld): void {
    for (const faction of ALL_FACTIONS) {
      if (hunterTier(this.get(faction)) <= 0) continue;
      if ((this.cooldown.get(faction) ?? 0) > 0) continue;
      if (this.hunts.some((hunt) => hunt.faction === faction)) continue;

      this.launch(faction, world);
      this.cooldown.set(faction, this.rng.range(120, 240));
    }
  }

  /** Послать охоту немедленно. Возвращает число вышедших. */
  launch(faction: Faction, world: BountyWorld): number {
    const tier = Math.max(1, hunterTier(this.get(faction)));
    const count = hunterPartySize(tier);
    if (count <= 0) return 0;

    const home = getSite(HUNTER_HOME[faction]);
    const weapons = HUNTER_WEAPONS[faction];
    const actors: Actor[] = [];

    for (let i = 0; i < count; i++) {
      // Во главе большого отряда идёт кто-то покрепче: он и заметнее в бою.
      const leader = tier >= 3 && i === 0;
      const actor = this.population.spawn({
        faction,
        x: home.x + this.rng.range(-10, 10),
        z: home.z + this.rng.range(-10, 10),
        role: 'patrol',
        name: leader ? 'старший охотник' : 'охотник за головой',
        weapon: leader ? 'sword' : this.rng.pick(weapons),
        armor: faction === Faction.Palace ? 'mail' : 'leather',
        gold: this.rng.int(20, 80),
        toughness: leader ? 1.3 : this.rng.range(1, 1.2),
      });

      // Охотник бьёт игрока независимо от репутации: за это ему и платят.
      actor.huntsPlayer = true;
      actor.escortAnchor.set(world.playerX, 0, world.playerZ);
      actor.hasEscortAnchor = true;
      actors.push(actor);
    }

    this.hunts.push({
      faction,
      actors,
      lastKnownX: world.playerX,
      lastKnownZ: world.playerZ,
      secondsSinceSeen: 0,
      secondsFarAway: 0,
      givingUp: false,
      age: 0,
    });

    this.onAnnounce(`${FACTIONS[faction].name}: по вашему следу вышли охотники (${count})`, 'alarm');
    return count;
  }

  private updateHunts(dt: number, world: BountyWorld): void {
    for (let i = this.hunts.length - 1; i >= 0; i--) {
      const hunt = this.hunts[i];
      hunt.age += dt;

      const survivors = hunt.actors.filter((actor) => actor.alive);
      if (survivors.length === 0) {
        this.hunts.splice(i, 1);
        continue;
      }

      if (hunt.givingUp) {
        // Разошлись по домам — убираем, но только вдали от глаз игрока.
        const home = getSite(HUNTER_HOME[hunt.faction]);
        for (const actor of survivors) {
          const far = distance2D(actor.position.x, actor.position.z, world.playerX, world.playerZ) > 200;
          const arrived = distance2D(actor.position.x, actor.position.z, home.x, home.z) < 30;
          if (arrived || (far && hunt.age > 420)) {
            actor.huntsPlayer = false;
            actor.hasEscortAnchor = false;
            this.population.remove(actor);
          }
        }
        if (hunt.actors.every((actor) => !actor.alive || !actor.huntsPlayer)) this.hunts.splice(i, 1);
        continue;
      }

      // Ближайший охотник решает за весь отряд, потеряли они игрока или нет.
      let nearest = Infinity;
      let atTrail = false;
      for (const actor of survivors) {
        const distance = distance2D(actor.position.x, actor.position.z, world.playerX, world.playerZ);
        if (distance < nearest) nearest = distance;
        if (distance2D(actor.position.x, actor.position.z, hunt.lastKnownX, hunt.lastKnownZ) < ARRIVED_AT_TRAIL) {
          atTrail = true;
        }
      }

      if (world.playerAlive && nearest < TRACK_DISTANCE) {
        hunt.lastKnownX = world.playerX;
        hunt.lastKnownZ = world.playerZ;
        hunt.secondsSinceSeen = 0;
        hunt.secondsFarAway = 0;
      } else if (atTrail) {
        // Дошли до места, где игрока видели, и никого не нашли — вот теперь
        // след остывает. Пока отряд ещё в пути, сдаваться не с чего: иначе
        // охота из дальнего гарнизона выдыхалась бы, не дойдя до цели.
        hunt.secondsSinceSeen += dt;
        if (nearest > LOST_DISTANCE || !world.playerAlive) hunt.secondsFarAway += dt;
        else hunt.secondsFarAway = 0;
      }

      if (shouldGiveUp(hunt.secondsSinceSeen, hunt.secondsFarAway)) {
        this.callOff(hunt);
        continue;
      }

      for (const actor of survivors) {
        actor.escortAnchor.set(hunt.lastKnownX, 0, hunt.lastKnownZ);
        actor.hasEscortAnchor = true;
      }
    }
  }

  /** Отряд бросает след и уходит домой. */
  private callOff(hunt: Hunt): void {
    if (hunt.givingUp) return;
    hunt.givingUp = true;
    hunt.age = 0;

    const home = getSite(HUNTER_HOME[hunt.faction]);
    for (const actor of hunt.actors) {
      if (!actor.alive) continue;
      actor.huntsPlayer = false;
      actor.escortAnchor.set(home.x, 0, home.z);
      actor.hasEscortAnchor = true;
    }
    this.onAnnounce(`${FACTIONS[hunt.faction].name}: охотники потеряли ваш след`, 'plain');
  }

  /** Сводка для карты, отладки и автотестов. */
  report(): { faction: Faction; bounty: number; hunters: number; givingUp: boolean }[] {
    return ALL_FACTIONS.filter((faction) => this.get(faction) > 0 || this.hunts.some((h) => h.faction === faction)).map(
      (faction) => ({
        faction,
        bounty: this.get(faction),
        hunters: this.hunts
          .filter((hunt) => hunt.faction === faction)
          .reduce((sum, hunt) => sum + hunt.actors.filter((actor) => actor.alive).length, 0),
        givingUp: this.hunts.filter((hunt) => hunt.faction === faction).every((hunt) => hunt.givingUp),
      }),
    );
  }

  serialize(): BountySnapshot {
    const values: Record<string, number> = {};
    for (const faction of ALL_FACTIONS) values[faction] = this.get(faction);
    return { values };
  }

  /**
   * Восстановить награду из снимка.
   * Сами охоты не сохраняются: отряд в пути — состояние сиюминутное, и проще
   * послать новый, чем чинить полдороги. Награда при этом на месте, поэтому
   * охота возобновится сама.
   */
  restore(snapshot: BountySnapshot | undefined): void {
    for (const hunt of this.hunts) {
      for (const actor of hunt.actors) actor.huntsPlayer = false;
    }
    this.hunts.length = 0;
    this.cooldown.clear();

    for (const faction of ALL_FACTIONS) {
      const value = snapshot?.values?.[faction];
      this.values.set(faction, typeof value === 'number' ? value : 0);
      this.announced.set(faction, hunterTier(typeof value === 'number' ? value : 0));
    }
  }
}
