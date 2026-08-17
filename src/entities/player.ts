import * as THREE from 'three';
import { clamp, damp, TAU } from '../core/math';
import type { Input } from '../core/input';
import type { Terrain } from '../world/terrain';
import { WATER_LEVEL } from '../world/terrain';
import type { Forest } from '../world/forest';
import { type CharacterBody, type CollisionWorld, moveCharacter } from '../systems/physics';
import { MOVEMENT_PARAMS, MovementMode, type MovementParams } from './movement';
import { Body, type BodyPart } from './body';
import { createColliderBuffer, raycastColliders, roughlyIntersects, updateColliderPositions } from './hitbox';
import { Inventory } from '../data/items';
import { Faction } from '../data/factions';

export { MovementMode } from './movement';

export interface PlayerWorld {
  terrain: Terrain;
  forest?: Forest;
  colliders?: CollisionWorld;
  /** Дороги: по накатанному коляска едет заметно бодрее. */
  roads?: { isOnRoad(x: number, z: number): boolean };
}

export interface PlayerHit {
  part: BodyPart;
  distance: number;
  point: THREE.Vector3;
}

/** Игрок: тело, раны, мешок, камера от первого лица и управление. */
export class Player {
  readonly camera: THREE.PerspectiveCamera;
  readonly body: CharacterBody;
  /** Раны игрока: те же правила, что и у врагов. */
  readonly wounds = new Body(1.15);
  readonly inventory = new Inventory();
  /** За кого играем. Задаётся при создании персонажа. */
  faction: Faction = Faction.Elves;
  /** Имя злодея игрок придумывает сам — по умолчанию Безымянный. */
  characterName = 'Безымянный';

  private readonly colliderWorld = createColliderBuffer();
  private colliderFrame = -1;

  /** Поворот вокруг вертикали, радианы. */
  yaw = 0;
  /** Наклон вверх-вниз, радианы. */
  pitch = 0;

  mode: MovementMode = MovementMode.Normal;
  /** Множитель скорости от ран, усталости и груза. */
  speedMultiplier = 1;
  /** Управление отключается, когда игрок мёртв или открыто меню. */
  controlEnabled = true;

  sensitivity = 0.0022;
  sprinting = false;

  private bobPhase = 0;
  private bobAmount = 0;
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly axis = { x: 0, z: 0 };
  private eyeOffset = MOVEMENT_PARAMS[MovementMode.Normal].eyeHeight;

  constructor(x = 0, z = 0, terrain?: Terrain) {
    this.camera = new THREE.PerspectiveCamera(78, 1, 0.1, 2200);
    this.camera.name = 'player-camera';

    const y = terrain ? terrain.heightAt(x, z) : 0;
    this.body = {
      position: new THREE.Vector3(x, y + 1, z),
      velocity: new THREE.Vector3(),
      radius: 0.36,
      height: 1.8,
      grounded: false,
      groundHeight: y,
    };
  }

  get position(): THREE.Vector3 {
    return this.body.position;
  }

  get params(): MovementParams {
    return MOVEMENT_PARAMS[this.mode];
  }

  /** Направление взгляда в горизонтальной плоскости. */
  getForward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Полное направление взгляда, с учётом наклона. */
  getLookDirection(out = new THREE.Vector3()): THREE.Vector3 {
    const cosPitch = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cosPitch, Math.sin(this.pitch), -Math.cos(this.yaw) * cosPitch);
  }

  /** Точка, из которой смотрят глаза и откуда летят стрелы. */
  getEyePosition(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.body.position.x, this.body.position.y + this.eyeOffset, this.body.position.z);
  }

  teleport(x: number, z: number, terrain: Terrain): void {
    this.body.position.set(x, terrain.heightAt(x, z) + 1.2, z);
    this.body.velocity.set(0, 0, 0);
  }

  /**
   * Проверить, попал ли луч по игроку, и в какую часть тела.
   * Ползущий игрок ниже — попасть по нему из лука труднее.
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, frame: number): PlayerHit | null {
    if (!roughlyIntersects(this.body.position, origin, direction, maxDistance)) return null;

    if (this.colliderFrame !== frame) {
      this.colliderFrame = frame;
      const crouch = this.mode === MovementMode.Crawl ? 0.32 : 1;
      updateColliderPositions(this.body.position, this.yaw, crouch, this.colliderWorld);
    }

    return raycastColliders(this.colliderWorld, this.wounds, origin, direction, maxDistance);
  }

  /**
   * Привести способ передвижения и скорость в соответствие с ранами.
   * Отсюда и берётся «либо умрёшь, либо будешь ползать, либо коляска, либо
   * протез»: игрок ничего не переключает — это делает состояние ног.
   */
  syncWithWounds(): void {
    this.mode = this.wounds.movementMode;
    this.speedMultiplier = this.wounds.speedMultiplier;
    this.controlEnabled = this.wounds.alive;
  }

  update(dt: number, input: Input, world: PlayerWorld): void {
    this.wounds.tick(dt);
    this.syncWithWounds();

    if (this.controlEnabled) {
      this.applyLook(input);
      this.applyMovement(dt, input, world);
    } else {
      this.body.velocity.x = 0;
      this.body.velocity.z = 0;
    }

    moveCharacter(this.body, dt, { terrain: world.terrain, forest: world.forest, colliders: world.colliders });
    this.updateCamera(dt);
  }

  private applyLook(input: Input): void {
    if (!input.pointerLocked) return;
    this.yaw -= input.mouseDeltaX * this.sensitivity;
    this.pitch -= input.mouseDeltaY * this.sensitivity;
    this.pitch = clamp(this.pitch, -1.5, 1.5);
    this.yaw = ((this.yaw + Math.PI) % TAU + TAU) % TAU - Math.PI;
  }

  private applyMovement(dt: number, input: Input, world: PlayerWorld): void {
    const params = this.params;
    input.moveAxis(this.axis);

    const length = Math.hypot(this.axis.x, this.axis.z);
    if (length > 0) {
      this.axis.x /= length;
      this.axis.z /= length;
    }

    this.sprinting = params.walk !== params.sprint && input.isDown('ShiftLeft') && this.axis.z < 0;
    let speed = (this.sprinting ? params.sprint : params.walk) * this.speedMultiplier;

    // Склон режет скорость: круче — медленнее. Для коляски это почти приговор,
    // но ровный тракт её спасает — именно на дорогах она и имеет смысл.
    const slope = world.terrain.slopeAt(this.body.position.x, this.body.position.z);
    const onRoad = world.roads?.isOnRoad(this.body.position.x, this.body.position.z) ?? false;
    const penalty = onRoad ? params.slopePenalty * 0.3 : params.slopePenalty;
    speed *= Math.max(0.12, 1 - slope * penalty);
    if (onRoad && this.mode === MovementMode.Wheelchair) speed *= 1.25;

    // По воде не побегаешь.
    if (this.body.position.y < WATER_LEVEL + 0.3) speed *= 0.55;

    this.getForward(this.forward);
    this.right.set(-this.forward.z, 0, this.forward.x);

    const targetX = (this.forward.x * -this.axis.z + this.right.x * this.axis.x) * speed;
    const targetZ = (this.forward.z * -this.axis.z + this.right.z * this.axis.x) * speed;

    // В воздухе управление вялое — прыжок нельзя переиграть на лету.
    const control = this.body.grounded ? 0.0005 : 0.28;
    this.body.velocity.x = damp(this.body.velocity.x, targetX, control, dt);
    this.body.velocity.z = damp(this.body.velocity.z, targetZ, control, dt);

    if (params.canJump && this.body.grounded && input.justPressed('Space')) {
      this.body.velocity.y = params.jump;
      this.body.grounded = false;
    }

    this.bobAmount = damp(this.bobAmount, this.body.grounded ? Math.hypot(targetX, targetZ) / params.sprint : 0, 0.02, dt);
    this.bobPhase += dt * (this.sprinting ? 11 : 7.5) * this.bobAmount;
  }

  private updateCamera(dt: number): void {
    const targetEye = this.params.eyeHeight;
    this.eyeOffset = damp(this.eyeOffset, targetEye, 0.0008, dt);

    const bob = Math.sin(this.bobPhase) * 0.055 * this.bobAmount;
    const sway = Math.cos(this.bobPhase * 0.5) * 0.03 * this.bobAmount;

    // Боковое покачивание идёт вдоль правого плеча, поэтому вектор считаем здесь,
    // а не в управлении: камера обновляется и когда игрок не может двигаться.
    this.getForward(this.forward);
    this.right.set(-this.forward.z, 0, this.forward.x);

    this.camera.position.set(
      this.body.position.x + this.right.x * sway,
      this.body.position.y + this.eyeOffset + bob,
      this.body.position.z + this.right.z * sway,
    );
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  /** Сменить способ передвижения — вызывается системой увечий. */
  setMovementMode(mode: MovementMode): void {
    this.mode = mode;
  }
}
