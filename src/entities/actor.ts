import * as THREE from 'three';
import { Body, BodyPart, LEGS } from './body';
import { Humanoid } from './humanoid';
import { MovementMode } from './movement';
import { Inventory, item, type ItemDef, type WeaponStats } from '../data/items';
import {
  PART_COLLIDERS,
  createColliderBuffer,
  raycastColliders,
  roughlyIntersects,
  updateColliderPositions,
} from './hitbox';
import { Faction, FACTIONS } from '../data/factions';
import { type CharacterBody, type CollisionWorld, moveCharacter } from '../systems/physics';
import type { Terrain } from '../world/terrain';
import type { Forest } from '../world/forest';
import { clamp01, damp, angleDelta } from '../core/math';

/** Чем этот персонаж занят в мире. */
export type ActorRole =
  | 'patrol'
  | 'guard'
  | 'partisan'
  | 'bandit'
  | 'civilian'
  | 'merchant'
  | 'caravan-driver'
  | 'caravan-guard'
  | 'commander';

/** Что делает искусственный разум прямо сейчас. */
export enum AiState {
  Idle = 'idle',
  Patrol = 'patrol',
  Chase = 'chase',
  Attack = 'attack',
  Flee = 'flee',
  Follow = 'follow',
  Hold = 'hold',
  Dead = 'dead',
}

export interface ActorOptions {
  faction: Faction;
  x: number;
  z: number;
  role?: ActorRole;
  name?: string;
  weapon?: string;
  armor?: string;
  toughness?: number;
  gold?: number;
  scale?: number;
  /** Для торговца: какой прилавок он держит. */
  shopSiteId?: string;
}

export interface HitResult {
  actor: Actor;
  part: BodyPart;
  distance: number;
  point: THREE.Vector3;
}

export interface ActorWorld {
  terrain: Terrain;
  forest?: Forest;
  colliders?: CollisionWorld;
}

let nextActorId = 1;

/**
 * Живой персонаж мира: и патрульный стражник, и эльф-партизан, и погонщик
 * корована. У всех одинаковое тело — значит, любому можно отрубить руку, и
 * любой может истечь кровью.
 */
export class Actor {
  readonly id = nextActorId++;
  readonly faction: Faction;
  readonly role: ActorRole;
  readonly name: string;
  readonly wounds: Body;
  readonly inventory = new Inventory();
  readonly model: Humanoid;
  readonly physics: CharacterBody;

  /** Куда смотрит, радианы. */
  yaw = 0;
  /** Куда хочет идти, м/с. Задаётся искусственным разумом. */
  readonly desiredVelocity = new THREE.Vector3();

  state: AiState = AiState.Idle;
  target: Actor | null = null;
  /** Прогресс замаха: 0 — не бьёт, 1 — удар завершён. */
  attackProgress = 0;
  attackCooldown = 0;
  /** Кому нанесён удар в этом замахе — чтобы не бить дважды. */
  attackResolved = true;
  /** Сколько секунд стоит на месте: для патрулей и раздумий. */
  stateTimer = 0;
  /** Точка, к которой идёт. */
  readonly waypoint = new THREE.Vector3();
  /** Место службы: патруль возвращается сюда, потеряв противника. */
  readonly home = new THREE.Vector3();
  /** Радиус, в котором персонаж считает себя «у себя». */
  homeRadius = 26;

  /**
   * Точка, около которой надо держаться: сопровождение корована идёт за
   * телегой, а не бродит по своему участку. Обновляется владельцем каждый кадр.
   */
  readonly escortAnchor = new THREE.Vector3();
  hasEscortAnchor = false;

  /** Торговец обслуживает этот узел — по нему берутся прилавок и цены. */
  shopSiteId: string | null = null;
  /** Труп исчезает не сразу — сколько он уже лежит. */
  corpseAge = 0;

  private readonly colliderWorld = createColliderBuffer();
  private colliderFrame = -1;
  private lastSeveredSync = 0;

  constructor(options: ActorOptions, terrain: Terrain) {
    this.faction = options.faction;
    this.role = options.role ?? 'patrol';
    this.name = options.name ?? FACTIONS[options.faction].member;
    this.wounds = new Body(options.toughness ?? 1);
    this.model = new Humanoid(options.faction, options.scale ?? 1);

    if (options.weapon) this.inventory.add(options.weapon);
    this.inventory.equippedWeapon = options.weapon ?? 'fists';
    if (options.armor) {
      this.inventory.add(options.armor);
      this.inventory.equippedArmor = options.armor;
    }
    this.inventory.gold = options.gold ?? 0;
    this.shopSiteId = options.shopSiteId ?? null;

    const y = terrain.heightAt(options.x, options.z);
    this.physics = {
      position: new THREE.Vector3(options.x, y, options.z),
      velocity: new THREE.Vector3(),
      radius: 0.34,
      height: 1.8,
      grounded: true,
      groundHeight: y,
    };

    this.model.setWeaponVisible(this.weapon.id !== 'fists');
    this.waypoint.copy(this.physics.position);
    this.home.copy(this.physics.position);
    this.syncModel();
  }

  get position(): THREE.Vector3 {
    return this.physics.position;
  }

  get alive(): boolean {
    return this.wounds.alive;
  }

  get weapon(): ItemDef {
    return this.inventory.weapon;
  }

  get movementMode(): MovementMode {
    return this.wounds.movementMode;
  }

  /** Скорость ходьбы с учётом ран и способа передвижения. */
  get maxSpeed(): number {
    const mode = this.movementMode;
    const base = mode === MovementMode.Crawl ? 0.8 : mode === MovementMode.Prosthetic ? 2.6 : 3.4;
    return base * this.wounds.speedMultiplier;
  }

  /** Скорость бега — например, при погоне. */
  get chaseSpeed(): number {
    const mode = this.movementMode;
    if (mode === MovementMode.Crawl) return 0.8;
    if (mode === MovementMode.Prosthetic) return 2.9;
    return 5.1 * this.wounds.speedMultiplier;
  }

  /** Насколько далеко замечает противника. Раненому не до наблюдения. */
  get sightRange(): number {
    return 52 * (0.55 + 0.45 * this.wounds.bloodFraction);
  }

  /** Начать замах. Возвращает false, если бить нечем или рано. */
  startAttack(): boolean {
    if (!this.alive || this.attackCooldown > 0 || this.attackProgress > 0) return false;
    if (!this.wounds.canFight) return false;
    this.attackProgress = 0.001;
    this.attackResolved = false;
    return true;
  }

  /** Характеристики оружия в руках; кулаки, если оружия нет. */
  get weaponStats(): WeaponStats {
    return this.weapon.weapon ?? (item('fists').weapon as WeaponStats);
  }

  /** Урон этого персонажа с учётом оружия и состояния рук. */
  get damageMultiplier(): number {
    return this.wounds.meleeDamageMultiplier;
  }

  update(dt: number, world: ActorWorld): void {
    this.wounds.tick(dt);

    if (!this.alive) {
      this.corpseAge += dt;
      this.physics.velocity.x = 0;
      this.physics.velocity.z = 0;
      moveCharacter(this.physics, dt, world);
      this.model.update(dt, { speed: 0, attack: 0, crawling: false, dead: true });
      this.syncModel();
      return;
    }

    if (this.attackCooldown > 0) this.attackCooldown -= dt;

    if (this.attackProgress > 0) {
      const stats = this.weaponStats;
      this.attackProgress += dt * stats.speed * 2.2;
      if (this.attackProgress >= 1) {
        this.attackProgress = 0;
        this.attackCooldown = 1 / stats.speed;
      }
    }

    // Управление задаёт желаемую скорость, физика решает, куда получится.
    this.physics.velocity.x = damp(this.physics.velocity.x, this.desiredVelocity.x, 0.0006, dt);
    this.physics.velocity.z = damp(this.physics.velocity.z, this.desiredVelocity.z, 0.0006, dt);
    moveCharacter(this.physics, dt, world);

    const speed = Math.hypot(this.physics.velocity.x, this.physics.velocity.z);
    this.model.update(dt, {
      speed,
      attack: this.attackProgress,
      crawling: this.movementMode === MovementMode.Crawl,
      dead: false,
    });

    this.syncSeveredParts();
    this.syncModel();
  }

  /** Повернуться к точке — плавно, а не рывком. */
  faceTowards(x: number, z: number, dt: number, rate = 7): void {
    const desired = Math.atan2(-(x - this.position.x), -(z - this.position.z));
    this.yaw += angleDelta(this.yaw, desired) * clamp01(dt * rate);
  }

  private syncModel(): void {
    this.model.root.position.copy(this.physics.position);
    this.model.root.rotation.y = this.yaw;
  }

  /** Убрать с модели то, что отрубили, и вернуть то, что заменили протезом. */
  private syncSeveredParts(): void {
    // Проверяем не каждый кадр: состояние меняется редко.
    this.lastSeveredSync -= 1;
    if (this.lastSeveredSync > 0) return;
    this.lastSeveredSync = 12;

    for (const part of [BodyPart.LeftArm, BodyPart.RightArm, ...LEGS]) {
      const status = this.wounds.get(part);
      if (status.severed && !status.prosthetic) {
        this.model.severPart(part);
      } else if (status.prosthetic) {
        this.model.restorePart(part, true);
      }
    }
  }

  /**
   * Пересчитать мировые положения точек попадания.
   * Кэшируется по номеру кадра: за один кадр по персонажу может прилететь
   * несколько лучей.
   */
  private updateColliders(frame: number): void {
    if (this.colliderFrame === frame) return;
    this.colliderFrame = frame;
    // Ползущий персонаж прижат к земле — точки попадания опускаются вместе с ним.
    const crouch = this.movementMode === MovementMode.Crawl ? 0.32 : 1;
    updateColliderPositions(this.position, this.yaw, crouch, this.colliderWorld);
  }

  /**
   * Мировое положение конкретной части тела.
   * Нужно, чтобы прицелиться именно в руку или в глаз — и людям, и автотестам.
   */
  getPartPosition(part: BodyPart, out: THREE.Vector3): boolean {
    const local = PART_COLLIDERS.find((collider) => collider.part === part);
    if (!local) return false;

    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    const crouch = this.movementMode === MovementMode.Crawl ? 0.32 : 1;

    out.set(
      this.position.x + local.x * cos + local.z * sin,
      this.position.y + local.y * crouch,
      this.position.z - local.x * sin + local.z * cos,
    );
    return true;
  }

  /** Проверить попадание луча. Возвращает ближайшую задетую часть тела. */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, frame: number): HitResult | null {
    if (!roughlyIntersects(this.position, origin, direction, maxDistance)) return null;
    this.updateColliders(frame);

    const hit = raycastColliders(this.colliderWorld, this.wounds, origin, direction, maxDistance);
    return hit ? { actor: this, part: hit.part, distance: hit.distance, point: hit.point } : null;
  }

  /** Что осталось при трупе — это и будет добычей. */
  lootTable(): { gold: number; items: string[] } {
    const items: string[] = [];
    for (const stack of this.inventory.stacks) {
      for (let i = 0; i < Math.min(stack.count, 4); i++) items.push(stack.id);
    }
    return { gold: this.inventory.gold, items };
  }

  dispose(): void {
    this.model.dispose();
  }
}
