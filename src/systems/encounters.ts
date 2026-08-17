import { BodyPart } from '../entities/body';
import { Faction, FACTIONS } from '../data/factions';
import { Rng } from '../core/rng';
import { angleDelta, distance2D } from '../core/math';
import { item } from '../data/items';
import { getSite } from '../world/sites';
import type { CargoEntry } from '../entities/caravan';
import type { Actor } from '../entities/actor';
import type { RoadNetwork } from '../world/roads';
import type { Population } from './population';

/**
 * Дорожные встречи.
 *
 * Корованов в мире всего несколько, и между ними тракт пустой: идёшь и идёшь.
 * Эта система расставляет на дороге впереди небольшие сцены — конвой с
 * пленным, засаду, раненого, беглеца с краденым, — чтобы дорога перестала быть
 * перегоном между событиями и стала самим событием.
 *
 * Главное правило: никто не появляется на глазах. Место выбирается либо за
 * пределом видимости, либо за спиной, — иначе люди возникают из воздуха, и
 * вся правдоподобность мира рушится на ровном месте.
 */

export type EncounterKind = 'prisoner' | 'ambush' | 'wounded' | 'pedlar';

/** Насколько часто выпадает каждый вид. */
export const ENCOUNTER_WEIGHTS: readonly { kind: EncounterKind; weight: number }[] = [
  { kind: 'ambush', weight: 3 },
  { kind: 'prisoner', weight: 3 },
  { kind: 'wounded', weight: 2 },
  { kind: 'pedlar', weight: 2 },
];

/** Ближняя и дальняя граница, в которой ищется место для встречи. */
export const SPAWN_MIN_DISTANCE = 80;
export const SPAWN_MAX_DISTANCE = 200;
/** Дальше этого игрок всё равно ничего не разглядит: там можно ставить что угодно. */
export const OUT_OF_SIGHT_DISTANCE = 150;
/** Полуширина переднего сектора, в котором игрок заметил бы появление. */
export const FRONT_CONE = (75 * Math.PI) / 180;
/** Больше этого числа встреч одновременно не держим. */
export const MAX_ACTIVE_ENCOUNTERS = 2;
/** Разброс паузы между попытками, секунды. */
const ATTEMPT_INTERVAL: [number, number] = [35, 70];
/** Сколько живёт встреча, прежде чем её можно убрать. */
const ENCOUNTER_LIFETIME = 300;
/** Ближе этого расстояния встречу не убираем: игрок увидит исчезновение. */
const KEEP_DISTANCE = 250;

/**
 * Не увидит ли игрок само появление.
 *
 * Либо далеко (за пределом отрисовки), либо не в ту сторону смотрит.
 * Направление считается той же формулой, что и повороты персонажей.
 */
export function isSpotHidden(
  spotX: number,
  spotZ: number,
  playerX: number,
  playerZ: number,
  playerYaw: number,
): boolean {
  const distance = distance2D(spotX, spotZ, playerX, playerZ);
  if (distance > OUT_OF_SIGHT_DISTANCE) return true;

  const towards = Math.atan2(-(spotX - playerX), -(spotZ - playerZ));
  return Math.abs(angleDelta(playerYaw, towards)) > FRONT_CONE;
}

/**
 * Пора ли убирать встречу.
 * Оба условия обязательны: старая, но близкая сцена остаётся на месте, чтобы
 * люди не растворялись в двух шагах от игрока.
 */
export function encounterExpired(age: number, distanceToPlayer: number): boolean {
  return age > ENCOUNTER_LIFETIME && distanceToPlayer > KEEP_DISTANCE;
}

/** Выбрать вид встречи по доле от 0 до 1. Вынесено отдельно ради проверок. */
export function pickKind(
  roll: number,
  weights: readonly { kind: EncounterKind; weight: number }[] = ENCOUNTER_WEIGHTS,
): EncounterKind {
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
  let cursor = Math.max(0, Math.min(0.999999, roll)) * total;

  for (const entry of weights) {
    cursor -= entry.weight;
    if (cursor < 0) return entry.kind;
  }
  return weights[weights.length - 1].kind;
}

interface Encounter {
  kind: EncounterKind;
  actors: Actor[];
  x: number;
  z: number;
  age: number;
  /** Конвой: кого ведут. */
  prisoner?: Actor;
  guards?: Actor[];
  freed?: boolean;
  /** Раненый: кому нужна перевязка. */
  wounded?: Actor;
  helped?: boolean;
  reward?: number;
  /** Беглец: что и почём продаёт. */
  pedlar?: Actor;
  price?: number;
  goods?: CargoEntry[];
  traded?: boolean;
}

/** Что можно сделать с встреченным человеком по клавише E. */
export type EncounterInteraction =
  | { kind: 'wounded'; actor: Actor }
  | { kind: 'pedlar'; actor: Actor; price: number; goods: CargoEntry[] };

/** Где сейчас игрок и куда смотрит. */
export interface EncounterWorld {
  playerX: number;
  playerZ: number;
  playerYaw: number;
}

export class EncounterSystem {
  private readonly active: Encounter[] = [];
  private readonly rng: Rng;
  private timer: number;

  constructor(
    private readonly roads: RoadNetwork,
    private readonly population: Population,
    seed: number,
    private readonly onAnnounce: (message: string, tone: 'plain' | 'good' | 'bad' | 'alarm') => void,
  ) {
    this.rng = new Rng(seed ^ 0x5cea);
    this.timer = this.rng.range(20, 40);
  }

  get activeCount(): number {
    return this.active.length;
  }

  /**
   * Сводка для отладки и автотестов.
   *
   * Расстояние считается до живых людей, а не до точки, где сцена появилась:
   * засада на то и засада, что идёт к игроку, — по неподвижной точке этого было
   * бы не видно.
   */
  report(): { kind: EncounterKind; alive: number; distance: number; resolved: boolean }[] {
    return this.active.map((encounter) => {
      let nearest = Infinity;
      for (const actor of encounter.actors) {
        if (!actor.alive) continue;
        const distance = distance2D(actor.position.x, actor.position.z, this.playerX, this.playerZ);
        if (distance < nearest) nearest = distance;
      }

      return {
        kind: encounter.kind,
        alive: encounter.actors.filter((actor) => actor.alive).length,
        distance: Number.isFinite(nearest) ? Math.round(nearest) : -1,
        resolved: Boolean(encounter.freed || encounter.helped || encounter.traded),
      };
    });
  }

  /** Где игрок был на прошлом обновлении: нужно для сводки и для уборки сцен. */
  private playerX = 0;
  private playerZ = 0;

  update(dt: number, world: EncounterWorld): void {
    this.playerX = world.playerX;
    this.playerZ = world.playerZ;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.rng.range(ATTEMPT_INTERVAL[0], ATTEMPT_INTERVAL[1]);
      if (this.active.length < MAX_ACTIVE_ENCOUNTERS) this.spawn(undefined, world);
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const encounter = this.active[i];
      encounter.age += dt;

      // Уборку считаем по живым людям: сцена «далеко» — это когда далеко они,
      // а не место, где всё началось.
      let distance = distance2D(encounter.x, encounter.z, world.playerX, world.playerZ);
      for (const actor of encounter.actors) {
        if (!actor.alive) continue;
        distance = Math.min(distance, distance2D(actor.position.x, actor.position.z, world.playerX, world.playerZ));
      }

      this.checkPrisoner(encounter);

      if (encounterExpired(encounter.age, distance)) this.retire(i);
    }
  }

  /** Конвой перебит — пленный свободен. */
  private checkPrisoner(encounter: Encounter): void {
    if (encounter.kind !== 'prisoner' || encounter.freed) return;
    if (!encounter.prisoner?.alive) return;
    if (encounter.guards?.some((guard) => guard.alive && guard.wounds.canFight)) return;

    encounter.freed = true;
    const home = getSite('glade');
    encounter.prisoner.escortAnchor.set(home.x, 0, home.z);
    encounter.prisoner.hasEscortAnchor = true;
    this.onAnnounce('Пленный эльф свободен и уходит в лес', 'good');
    this.onFreed?.(encounter.prisoner);
  }

  /** Кому сообщить, что пленного освободили: репутацию считает игра, не мы. */
  onFreed: ((prisoner: Actor) => void) | null = null;

  /** Поставить встречу. Вид можно задать явно — этим пользуются автотесты. */
  spawn(kind: EncounterKind | undefined, world: EncounterWorld): EncounterKind | null {
    const chosen = kind ?? pickKind(this.rng.next());
    // Засада подбирается ближе: ей нужно успеть дойти, пока игрок на этом тракте.
    const spot = this.findSpot(world, chosen === 'ambush' ? 60 : SPAWN_MIN_DISTANCE);
    if (!spot) return null;

    const encounter: Encounter = { kind: chosen, actors: [], x: spot.x, z: spot.z, age: 0 };

    if (chosen === 'prisoner') this.buildPrisoner(encounter);
    else if (chosen === 'ambush') this.buildAmbush(encounter, world);
    else if (chosen === 'wounded') this.buildWounded(encounter);
    else this.buildPedlar(encounter);

    if (encounter.actors.length === 0) return null;
    this.active.push(encounter);
    return chosen;
  }

  /** Конвой дворца ведёт связанного эльфа в казармы. */
  private buildPrisoner(encounter: Encounter): void {
    const barracks = getSite('barracks');
    const guards: Actor[] = [];
    const count = this.rng.int(2, 3);

    for (let i = 0; i < count; i++) {
      const guard = this.population.spawn({
        faction: Faction.Palace,
        x: encounter.x + this.rng.range(-2.5, 2.5),
        z: encounter.z + this.rng.range(-2.5, 2.5),
        role: 'patrol',
        name: 'конвойный',
        weapon: this.rng.pick(['sword', 'mace', 'sword']),
        armor: 'mail',
        gold: this.rng.int(10, 45),
      });
      guard.escortAnchor.set(barracks.x + this.rng.range(-8, 8), 0, barracks.z + this.rng.range(-8, 8));
      guard.hasEscortAnchor = true;
      guards.push(guard);
      encounter.actors.push(guard);
    }

    // Пленный идёт безоружным и не отходит от конвоя.
    const prisoner = this.population.spawn({
      faction: Faction.Elves,
      x: encounter.x + this.rng.range(-1, 1),
      z: encounter.z + this.rng.range(-1, 1),
      role: 'civilian',
      name: 'пленный эльф',
      gold: 0,
      toughness: 0.85,
    });
    prisoner.escortAnchor.set(barracks.x, 0, barracks.z);
    prisoner.hasEscortAnchor = true;

    encounter.prisoner = prisoner;
    encounter.guards = guards;
    encounter.actors.push(prisoner);
  }

  /** Разбойники выходят из-за обочины именно на игрока. */
  private buildAmbush(encounter: Encounter, world: EncounterWorld): void {
    const count = this.rng.int(2, 3);

    for (let i = 0; i < count; i++) {
      const bandit = this.population.spawn({
        faction: Faction.Villain,
        x: encounter.x + this.rng.range(-4, 4),
        z: encounter.z + this.rng.range(-4, 4),
        role: 'bandit',
        name: 'дорожный разбойник',
        weapon: this.rng.pick(['axe', 'sword', 'mace', 'dagger']),
        armor: 'leather',
        gold: this.rng.int(8, 50),
        toughness: this.rng.range(0.95, 1.15),
      });
      // Нападают независимо от того, как к вам относится банда: это их промысел.
      bandit.huntsPlayer = true;
      bandit.escortAnchor.set(world.playerX, 0, world.playerZ);
      bandit.hasEscortAnchor = true;
      encounter.actors.push(bandit);
    }

    this.onAnnounce('На тракте неспокойно: впереди мелькнули люди', 'bad');
  }

  /** Раненый у обочины: истекает кровью и ждёт, что перевяжут. */
  private buildWounded(encounter: Encounter): void {
    const faction = this.rng.pick([Faction.Neutral, Faction.Neutral, Faction.Palace, Faction.Elves]);
    const wounded = this.population.spawn({
      faction,
      x: encounter.x + this.rng.range(-2, 2),
      z: encounter.z + this.rng.range(-2, 2),
      role: 'civilian',
      name: `раненый (${FACTIONS[faction].member})`,
      weapon: 'dagger',
      gold: this.rng.int(15, 40),
    });

    // Рана настоящая, той же системы, что и у игрока: если не помочь, умрёт.
    const part = this.rng.pick([BodyPart.LeftArm, BodyPart.RightLeg, BodyPart.Torso]);
    const status = wounded.wounds.get(part);
    status.hp = Math.max(1, status.maxHp * 0.25);
    status.bleeding = 0.4;
    wounded.wounds.blood = 60;

    encounter.wounded = wounded;
    encounter.reward = this.rng.int(15, 40);
    encounter.actors.push(wounded);
  }

  /** Беглец сбывает краденое дешевле, чем оно стоит. */
  private buildPedlar(encounter: Encounter): void {
    const pedlar = this.population.spawn({
      faction: Faction.Neutral,
      x: encounter.x + this.rng.range(-2, 2),
      z: encounter.z + this.rng.range(-2, 2),
      role: 'civilian',
      name: 'беглец с мешком',
      weapon: 'dagger',
      gold: this.rng.int(5, 30),
    });

    const goods: CargoEntry[] = [];
    const kinds = this.rng.int(1, 2);
    const pool = ['furs', 'silk', 'spices', 'wine', 'iron'];
    for (let i = 0; i < kinds; i++) {
      const id = pool.splice(this.rng.int(0, pool.length - 1), 1)[0];
      goods.push({ id, count: this.rng.int(2, 5) });
    }

    const value = goods.reduce((sum, entry) => sum + item(entry.id).price * entry.count, 0);
    encounter.pedlar = pedlar;
    encounter.goods = goods;
    // Ворованное отдают за полцены: в этом весь смысл сделки.
    encounter.price = Math.max(10, Math.round(value * 0.55));
    encounter.actors.push(pedlar);
  }

  /**
   * Найти место на тракте: близко к игроку, но вне его глаз.
   * Точки дорог стоят через каждые двенадцать метров, поэтому простого перебора
   * достаточно — их несколько сотен на всю карту.
   */
  private findSpot(world: EncounterWorld, minDistance: number): { x: number; z: number } | null {
    const candidates: { x: number; z: number }[] = [];

    for (const road of this.roads.roads) {
      for (const point of road.points) {
        const distance = distance2D(point.x, point.z, world.playerX, world.playerZ);
        if (distance < minDistance || distance > SPAWN_MAX_DISTANCE) continue;
        if (!isSpotHidden(point.x, point.z, world.playerX, world.playerZ, world.playerYaw)) continue;
        candidates.push({ x: point.x, z: point.z });
      }
    }

    if (candidates.length === 0) return null;
    const spot = this.rng.pick(candidates);
    // Чуть в сторону от колеи, чтобы сцена не стояла ровно посреди дороги.
    return { x: spot.x + this.rng.range(-2, 2), z: spot.z + this.rng.range(-2, 2) };
  }

  /** Главный человек встречи этого вида: к нему подходят и с ним говорят. */
  actorOf(kind: EncounterKind): Actor | null {
    for (const encounter of this.active) {
      if (encounter.kind !== kind) continue;
      const actor =
        encounter.wounded ?? encounter.pedlar ?? encounter.prisoner ?? encounter.actors.find((entry) => entry.alive);
      if (actor?.alive) return actor;
    }
    return null;
  }

  /** Что можно сделать с тем, кто стоит рядом. */
  interactionAt(x: number, z: number, radius: number): EncounterInteraction | null {
    for (const encounter of this.active) {
      if (encounter.kind === 'wounded' && !encounter.helped && encounter.wounded?.alive) {
        const actor = encounter.wounded;
        if (distance2D(x, z, actor.position.x, actor.position.z) < radius) {
          return { kind: 'wounded', actor };
        }
      }
      if (encounter.kind === 'pedlar' && !encounter.traded && encounter.pedlar?.alive) {
        const actor = encounter.pedlar;
        if (distance2D(x, z, actor.position.x, actor.position.z) < radius) {
          return { kind: 'pedlar', actor, price: encounter.price ?? 0, goods: encounter.goods ?? [] };
        }
      }
    }
    return null;
  }

  /**
   * Перевязать раненого. Возвращает благодарность в золоте.
   * Бинт списывает вызывающая сторона — мешок игрока не наше дело.
   */
  helpWounded(actor: Actor): number {
    const encounter = this.active.find((entry) => entry.wounded === actor);
    if (!encounter || encounter.helped) return 0;

    encounter.helped = true;
    actor.wounds.bandage();
    actor.wounds.heal(25);

    const reward = Math.min(encounter.reward ?? 0, actor.inventory.gold);
    actor.inventory.gold -= reward;
    return reward;
  }

  /** Купить у беглеца мешок. Золото списывает вызывающая сторона. */
  buyFromPedlar(actor: Actor): CargoEntry[] | null {
    const encounter = this.active.find((entry) => entry.pedlar === actor);
    if (!encounter || encounter.traded) return null;

    encounter.traded = true;
    actor.inventory.gold += encounter.price ?? 0;
    return (encounter.goods ?? []).map((entry) => ({ ...entry }));
  }

  private retire(index: number): void {
    const encounter = this.active[index];
    for (const actor of encounter.actors) {
      if (!actor.alive) continue;
      actor.huntsPlayer = false;
      actor.hasEscortAnchor = false;
      this.population.remove(actor);
    }
    this.active.splice(index, 1);
  }

  /** Убрать все встречи: используется при загрузке сохранения. */
  clear(): void {
    for (let i = this.active.length - 1; i >= 0; i--) this.retire(i);
  }
}
