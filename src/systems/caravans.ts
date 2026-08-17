import * as THREE from 'three';
import { Caravan, type CargoEntry } from '../entities/caravan';
import { Faction } from '../data/factions';
import { Rng } from '../core/rng';
import { clamp, distance2D } from '../core/math';
import type { RoadNetwork } from '../world/roads';
import type { Terrain } from '../world/terrain';
import type { Population } from './population';

/** Постоянный маршрут, по которому ходят обозы. */
interface TradeRoute {
  id: string;
  from: string;
  to: string;
  /** Чей товар. */
  owner: Faction;
  /** Кто охраняет. */
  escort: Faction;
  /** Что обычно везут. */
  goods: string[];
  guards: [number, number];
  gold: [number, number];
}

const ROUTES: readonly TradeRoute[] = [
  {
    id: 'village-palace',
    from: 'village',
    to: 'palace',
    owner: Faction.Neutral,
    escort: Faction.Palace,
    goods: ['grain', 'salt', 'wine'],
    guards: [2, 3],
    gold: [40, 110],
  },
  {
    id: 'palace-village',
    from: 'palace',
    to: 'village',
    owner: Faction.Palace,
    escort: Faction.Palace,
    goods: ['silk', 'spices', 'wine'],
    guards: [3, 4],
    gold: [90, 220],
  },
  {
    id: 'glade-village',
    from: 'glade',
    to: 'village',
    owner: Faction.Elves,
    escort: Faction.Elves,
    goods: ['furs', 'furs', 'spices'],
    guards: [2, 3],
    gold: [35, 95],
  },
  {
    id: 'fort-village',
    from: 'fort',
    to: 'village',
    owner: Faction.Villain,
    escort: Faction.Villain,
    goods: ['iron', 'iron', 'salt'],
    guards: [2, 4],
    gold: [50, 140],
  },
  {
    id: 'village-glade',
    from: 'village',
    to: 'glade',
    owner: Faction.Neutral,
    escort: Faction.Neutral,
    goods: ['salt', 'grain'],
    guards: [1, 2],
    gold: [20, 60],
  },
];

/** Сколько обозов одновременно в пути. */
const MAX_ACTIVE = 3;
/** Разброс паузы между выходами корованов, секунды. */
const SPAWN_INTERVAL: [number, number] = [45, 95];
/** Через сколько секунд после разграбления телега убирается. */
const WRECK_LIFETIME = 200;

const ESCORT_WEAPONS: Record<Faction, string[]> = {
  [Faction.Palace]: ['sword', 'mace', 'sword', 'bow'],
  [Faction.Elves]: ['bow', 'bow', 'sword'],
  [Faction.Villain]: ['axe', 'sword', 'mace'],
  [Faction.Neutral]: ['dagger', 'sword'],
};

/**
 * Корованы: главный источник дохода и главная причина, по которой на дорогах
 * опасно.
 *
 * Обозы выходят по расписанию и идут по трактам между городами. Ограбленный
 * маршрут становится опаснее — на него ставят больше охраны, — а в городе
 * назначения дорожает то, что не доехало.
 */
export class CaravanSystem {
  readonly group = new THREE.Group();
  readonly caravans: Caravan[] = [];

  /** Насколько опасным считается каждый маршрут: растёт после каждого грабежа. */
  private readonly danger = new Map<string, number>();
  private readonly wreckAge = new Map<number, number>();
  private readonly routeOfCaravan = new Map<number, TradeRoute>();
  private timer = 12;
  private readonly rng: Rng;

  constructor(
    private readonly roads: RoadNetwork,
    private readonly terrain: Terrain,
    private readonly population: Population,
    seed: number,
  ) {
    this.group.name = 'caravans';
    this.rng = new Rng(seed ^ 0x0ca7a);
  }

  get activeCount(): number {
    return this.caravans.filter((caravan) => caravan.state !== 'plundered').length;
  }

  /** Насколько опасным считается маршрут: 0 — спокойно, 1 — возят с конвоем. */
  dangerOf(routeId: string): number {
    return this.danger.get(routeId) ?? 0;
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer <= 0 && this.activeCount < MAX_ACTIVE) {
      this.spawnCaravan();
      this.timer = this.rng.range(SPAWN_INTERVAL[0], SPAWN_INTERVAL[1]);
    }

    for (let i = this.caravans.length - 1; i >= 0; i--) {
      const caravan = this.caravans[i];
      caravan.update(dt, this.terrain);

      if (caravan.state === 'arrived') {
        this.retire(caravan, i);
        continue;
      }

      // Разграбленная или брошенная телега стоит на дороге, но не вечно.
      if (caravan.looted || !caravan.hasDefenders) {
        const age = (this.wreckAge.get(caravan.id) ?? 0) + dt;
        this.wreckAge.set(caravan.id, age);
        if (age > WRECK_LIFETIME) this.retire(caravan, i);
      }
    }

    // Опасность маршрутов постепенно забывается.
    for (const [routeId, value] of this.danger) {
      const next = value - dt / 600;
      if (next <= 0) this.danger.delete(routeId);
      else this.danger.set(routeId, next);
    }
  }

  private retire(caravan: Caravan, index: number): void {
    // Уцелевшее сопровождение уходит вместе с обозом.
    for (const member of caravan.members) {
      if (member.alive) this.population.remove(member);
      else member.hasEscortAnchor = false;
    }
    caravan.dispose();
    this.caravans.splice(index, 1);
    this.wreckAge.delete(caravan.id);
    this.routeOfCaravan.delete(caravan.id);
  }

  /** Выпустить обоз по случайному маршруту. */
  spawnCaravan(routeId?: string): Caravan | null {
    const route = routeId ? ROUTES.find((entry) => entry.id === routeId) : this.rng.pick(ROUTES);
    if (!route) return null;

    const path = this.roads.routeBetween(route.from, route.to);
    if (path.length < 2) return null;

    const caravan = new Caravan({
      owner: route.owner,
      fromSite: route.from,
      toSite: route.to,
      route: path,
      cargo: this.rollCargo(route),
      gold: this.rng.int(route.gold[0], route.gold[1]),
    });

    this.caravans.push(caravan);
    this.routeOfCaravan.set(caravan.id, route);
    this.group.add(caravan.group);

    // Возчик плюс охрана. На опасных маршрутах конвой больше.
    const extra = Math.round(this.dangerOf(route.id) * 2);
    const guards = this.rng.int(route.guards[0], route.guards[1]) + extra;
    const start = path[0];

    const driver = this.population.spawn({
      faction: route.owner,
      x: start.x + this.rng.range(-1, 1),
      z: start.z + this.rng.range(-1, 1),
      role: 'caravan-driver',
      name: 'погонщик',
      weapon: 'dagger',
      gold: this.rng.int(5, 25),
    });
    caravan.addMember(driver);

    const weapons = ESCORT_WEAPONS[route.escort];
    for (let i = 0; i < guards; i++) {
      const guard = this.population.spawn({
        faction: route.escort,
        x: start.x + this.rng.range(-3, 3),
        z: start.z + this.rng.range(-3, 3),
        role: 'caravan-guard',
        name: 'охранник корована',
        weapon: this.rng.pick(weapons),
        armor: route.escort === Faction.Palace ? 'mail' : 'leather',
        gold: this.rng.int(8, 45),
      });
      caravan.addMember(guard);
    }

    return caravan;
  }

  private rollCargo(route: TradeRoute): CargoEntry[] {
    const cargo: CargoEntry[] = [];
    const kinds = this.rng.int(2, 3);
    const pool = [...route.goods];

    for (let i = 0; i < kinds && pool.length > 0; i++) {
      const pick = pool.splice(this.rng.int(0, pool.length - 1), 1)[0];
      const existing = cargo.find((entry) => entry.id === pick);
      const count = this.rng.int(4, 14);
      if (existing) existing.count += count;
      else cargo.push({ id: pick, count });
    }

    return cargo;
  }

  /** Ближайшая телега, которую можно обыскать. */
  nearestPlunderable(x: number, z: number, radius: number): Caravan | null {
    let best: Caravan | null = null;
    let bestDistance = radius;

    for (const caravan of this.caravans) {
      if (!caravan.isPlunderable) continue;
      const distance = distance2D(x, z, caravan.position.x, caravan.position.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = caravan;
      }
    }
    return best;
  }

  /** Ближайший обоз любого состояния — для подсказок и отладки. */
  nearest(x: number, z: number, radius = Infinity): Caravan | null {
    let best: Caravan | null = null;
    let bestDistance = radius;

    for (const caravan of this.caravans) {
      const distance = distance2D(x, z, caravan.position.x, caravan.position.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = caravan;
      }
    }
    return best;
  }

  /** Куда шёл этот обоз — там и подскочат цены. */
  destinationOf(caravan: Caravan): string {
    return caravan.toSite;
  }

  /** Записать факт ограбления: маршрут становится опаснее. */
  registerRobbery(caravan: Caravan): void {
    const route = this.routeOfCaravan.get(caravan.id);
    if (!route) return;
    this.danger.set(route.id, clamp(this.dangerOf(route.id) + 0.5, 0, 3));
  }

  dispose(): void {
    for (const caravan of this.caravans) caravan.dispose();
    this.caravans.length = 0;
  }
}
