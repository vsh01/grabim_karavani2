import * as THREE from 'three';
import { merge, paint, place } from '../core/geometry';
import { distance2D } from '../core/math';
import { Faction } from '../data/factions';
import { tryItem } from '../data/items';
import type { RoadPoint } from '../world/roads';
import type { Terrain } from '../world/terrain';
import type { Actor } from './actor';

/** Одна позиция в накладной корована. */
export interface CargoEntry {
  id: string;
  count: number;
}

export type CaravanState = 'travelling' | 'halted' | 'plundered' | 'arrived';

export interface CaravanOptions {
  /** Чей товар — с ним и портятся отношения при грабеже. */
  owner: Faction;
  fromSite: string;
  toSite: string;
  route: RoadPoint[];
  cargo: CargoEntry[];
  gold: number;
}

let nextCaravanId = 1;

/** Скорость гружёной повозки, м/с. */
const CARAVAN_SPEED = 2.1;
/**
 * На каком расстоянии охранник ещё считается охраной.
 * Тот, кто удрал в лес, телегу уже не защищает: иначе один сбежавший погонщик
 * навсегда делал бы обоз неприкосновенным.
 */
const DEFENDER_RANGE = 25;

/**
 * Корован: повозка с грузом, погонщик и охрана, идущие по тракту из одного
 * города в другой.
 *
 * Грабят его все одинаково: перебить сопровождение и обыскать телегу. Разница
 * только в последствиях — чей корован тронули, тот и обидится.
 */
export class Caravan {
  readonly id = nextCaravanId++;
  readonly group = new THREE.Group();
  readonly owner: Faction;
  readonly fromSite: string;
  readonly toSite: string;
  readonly route: RoadPoint[];
  readonly cargo: CargoEntry[];

  gold: number;
  state: CaravanState = 'travelling';
  /** Груз уже забрали. */
  looted = false;
  /** Сколько метров пройдено по маршруту. */
  distanceAlong = 0;

  readonly members: Actor[] = [];

  private readonly cumulative: number[] = [];
  private readonly heading = new THREE.Vector3(0, 0, -1);
  private totalLength = 0;
  private haltTimer = 0;

  constructor(options: CaravanOptions) {
    this.owner = options.owner;
    this.fromSite = options.fromSite;
    this.toSite = options.toSite;
    this.route = options.route;
    this.cargo = options.cargo;
    this.gold = options.gold;

    this.group.name = `caravan-${this.id}`;
    this.group.add(buildWagon(options.owner));

    // Заранее считаем длину до каждой точки: по ней ищем положение на маршруте.
    this.cumulative.push(0);
    for (let i = 0; i < this.route.length - 1; i++) {
      this.totalLength += distance2D(
        this.route[i].x,
        this.route[i].z,
        this.route[i + 1].x,
        this.route[i + 1].z,
      );
      this.cumulative.push(this.totalLength);
    }
  }

  get position(): THREE.Vector3 {
    return this.group.position;
  }

  /** Осталось ли кому защищать телегу: живые и не разбежавшиеся. */
  get hasDefenders(): boolean {
    return this.members.some(
      (member) =>
        member.alive &&
        distance2D(member.position.x, member.position.z, this.position.x, this.position.z) < DEFENDER_RANGE,
    );
  }

  /** Сколько сопровождающих ещё живы, где бы они ни были. */
  get survivors(): number {
    return this.members.filter((member) => member.alive).length;
  }

  /** Можно ли обыскать: охрана перебита, а груз ещё на месте. */
  get isPlunderable(): boolean {
    return !this.looted && !this.hasDefenders && this.cargo.length + this.gold > 0;
  }

  /** Сколько ещё идти до места назначения, метры. */
  get remaining(): number {
    return Math.max(0, this.totalLength - this.distanceAlong);
  }

  addMember(actor: Actor): void {
    this.members.push(actor);
  }

  update(dt: number, terrain: Terrain): void {
    if (this.state === 'arrived') return;

    // Пока охрана дерётся, телега стоит. Возчик не поедет под стрелами.
    const fighting = this.members.some((member) => member.alive && member.target !== null);
    if (fighting) {
      this.state = 'halted';
      this.haltTimer = 4;
    } else if (this.haltTimer > 0) {
      this.haltTimer -= dt;
    }

    const abandoned = !this.hasDefenders;
    if (abandoned) {
      this.state = this.looted ? 'plundered' : 'halted';
    } else if (this.haltTimer <= 0) {
      this.state = 'travelling';
      this.distanceAlong = Math.min(this.totalLength, this.distanceAlong + CARAVAN_SPEED * dt);
      if (this.distanceAlong >= this.totalLength) this.state = 'arrived';
    }

    this.placeOnRoute(terrain);
    this.escortMembers();
  }

  /** Поставить повозку в точку маршрута и развернуть по ходу движения. */
  private placeOnRoute(terrain: Terrain): void {
    const point = this.sampleRoute(this.distanceAlong);
    const ahead = this.sampleRoute(Math.min(this.totalLength, this.distanceAlong + 2));

    this.group.position.set(point.x, terrain.heightAt(point.x, point.z), point.z);

    this.heading.set(ahead.x - point.x, 0, ahead.z - point.z);
    if (this.heading.lengthSq() > 1e-6) {
      this.heading.normalize();
      this.group.rotation.y = Math.atan2(-this.heading.x, -this.heading.z);
    }
  }

  /** Точка маршрута на заданном расстоянии от начала. */
  private sampleRoute(distance: number): RoadPoint {
    if (this.route.length === 1) return this.route[0];

    // Линейный поиск по накопленным длинам: точек десятки, бинарный не нужен.
    let index = 0;
    while (index < this.cumulative.length - 2 && this.cumulative[index + 1] < distance) index++;

    const a = this.route[index];
    const b = this.route[index + 1] ?? a;
    const segmentLength = this.cumulative[index + 1] - this.cumulative[index];
    const t = segmentLength > 1e-6 ? (distance - this.cumulative[index]) / segmentLength : 0;

    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  }

  /**
   * Расставить сопровождение вокруг телеги.
   * Собственно ходьбой занимается общий разум персонажа — здесь только якорь,
   * к которому он возвращается, когда драться не с кем.
   */
  private escortMembers(): void {
    const right = { x: -this.heading.z, z: this.heading.x };

    for (let i = 0; i < this.members.length; i++) {
      const member = this.members[i];
      if (!member.alive) continue;

      // Первый идёт впереди как возчик, остальные — по бокам в шахматном порядке.
      const side = i % 2 === 0 ? 1 : -1;
      const rank = Math.floor(i / 2);
      const forwardOffset = i === 0 ? 3.2 : -1.2 - rank * 2.2;
      const sideOffset = i === 0 ? 0 : side * 2.4;

      member.escortAnchor.set(
        this.group.position.x + this.heading.x * forwardOffset + right.x * sideOffset,
        0,
        this.group.position.z + this.heading.z * forwardOffset + right.z * sideOffset,
      );
      member.hasEscortAnchor = true;
    }
  }

  /** Поставить обоз в нужную точку маршрута — при загрузке сохранения. */
  setProgress(distance: number, terrain: Terrain): void {
    this.distanceAlong = Math.max(0, Math.min(this.totalLength, distance));
    this.placeOnRoute(terrain);
  }

  /** Забрать груз. Возвращает то, что досталось. */
  plunder(): { cargo: CargoEntry[]; gold: number } {
    const loot = { cargo: this.cargo.map((entry) => ({ ...entry })), gold: this.gold };
    this.cargo.length = 0;
    this.gold = 0;
    this.looted = true;
    this.state = 'plundered';
    return loot;
  }

  /** Человеческое описание груза для журнала и подсказки. */
  describeCargo(): string {
    if (this.cargo.length === 0) return 'телега пуста';
    return this.cargo
      .map((entry) => `${tryItem(entry.id)?.name ?? entry.id} ×${entry.count}`)
      .join(', ');
  }

  dispose(): void {
    this.group.removeFromParent();
  }
}

/** Цвет тента по хозяину корована — видно издалека, чей это обоз. */
const CANOPY_COLORS: Record<Faction, number> = {
  [Faction.Neutral]: 0xd8cba6,
  [Faction.Palace]: 0x53619c,
  [Faction.Elves]: 0x6f9160,
  [Faction.Villain]: 0x6d4550,
};

/**
 * Повозка с лошадью, собранная из коробок и цилиндров.
 * Всё в одной геометрии — на весь корован уходит один вызов отрисовки.
 */
function buildWagon(owner: Faction): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const wood = 0x6b5133;
  const darkWood = 0x4a3722;

  // Кузов.
  parts.push(place(paint(new THREE.BoxGeometry(2.9, 0.55, 1.5), wood, 0.06), 0, 0.85, 0));
  // Борта.
  parts.push(place(paint(new THREE.BoxGeometry(2.9, 0.4, 0.1), darkWood, 0.04), 0, 1.25, 0.7));
  parts.push(place(paint(new THREE.BoxGeometry(2.9, 0.4, 0.1), darkWood, 0.04), 0, 1.25, -0.7));

  // Тент: цилиндр, положенный набок вдоль повозки.
  const canopy = new THREE.CylinderGeometry(0.78, 0.78, 2.5, 9, 1, true);
  canopy.rotateZ(Math.PI / 2);
  parts.push(place(paint(canopy, CANOPY_COLORS[owner], 0.08), -0.1, 1.6, 0));

  // Колёса: ось вдоль повозки поперёк хода.
  for (const [x, z] of [
    [-1.0, 0.82],
    [-1.0, -0.82],
    [1.0, 0.82],
    [1.0, -0.82],
  ] as const) {
    const wheel = new THREE.CylinderGeometry(0.46, 0.46, 0.13, 9);
    wheel.rotateX(Math.PI / 2);
    parts.push(place(paint(wheel, darkWood, 0.05), x, 0.46, z));
  }

  // Оглобли и лошадь.
  parts.push(place(paint(new THREE.BoxGeometry(1.7, 0.09, 0.09), darkWood), 2.2, 0.9, 0.35));
  parts.push(place(paint(new THREE.BoxGeometry(1.7, 0.09, 0.09), darkWood), 2.2, 0.9, -0.35));
  parts.push(...buildHorse(3.6));

  const geometry = merge(parts);
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'wagon';
  return mesh;
}

/** Лошадь из семи коробок. Издалека — вылитая лошадь. */
function buildHorse(offsetX: number): THREE.BufferGeometry[] {
  const hide = 0x5a4632;
  const mane = 0x33261a;
  const parts: THREE.BufferGeometry[] = [];

  parts.push(place(paint(new THREE.BoxGeometry(1.6, 0.72, 0.62), hide, 0.05), offsetX, 1.15, 0));
  parts.push(place(paint(new THREE.BoxGeometry(0.4, 0.62, 0.36), hide, 0.05), offsetX + 0.85, 1.45, 0, 0, 0, -0.35));
  parts.push(place(paint(new THREE.BoxGeometry(0.62, 0.3, 0.3), hide, 0.05), offsetX + 1.2, 1.68, 0));
  parts.push(place(paint(new THREE.BoxGeometry(0.16, 0.5, 0.24), mane), offsetX - 0.82, 1.28, 0, 0, 0, 0.5));

  for (const [dx, dz] of [
    [-0.55, 0.24],
    [-0.55, -0.24],
    [0.55, 0.24],
    [0.55, -0.24],
  ] as const) {
    parts.push(place(paint(new THREE.BoxGeometry(0.17, 0.86, 0.17), mane, 0.03), offsetX + dx, 0.43, dz));
  }

  return parts;
}
