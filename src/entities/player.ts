import * as THREE from 'three';
import { clamp, damp, TAU } from '../core/math';
import type { Input } from '../core/input';
import type { Terrain } from '../world/terrain';
import { WATER_LEVEL } from '../world/terrain';
import type { Forest } from '../world/forest';
import { type CharacterBody, type CollisionWorld, moveCharacter } from '../systems/physics';

/**
 * Способ передвижения. Меняется не по желанию игрока, а по состоянию ног:
 * потерял ногу — ползёшь, купил коляску — катишься, поставил протез — ходишь.
 */
export enum MovementMode {
  /** Обе ноги на месте. */
  Normal = 'normal',
  /** Протез вместо ноги: ходить можно, бегать нет. */
  Prosthetic = 'prosthetic',
  /** Ноги нет и протеза нет — только ползком. */
  Crawl = 'crawl',
  /** Коляска: по ровному быстро, по склонам и лесу почти никак. */
  Wheelchair = 'wheelchair',
}

interface ModeParams {
  walk: number;
  sprint: number;
  eyeHeight: number;
  jump: number;
  canJump: boolean;
  /** Насколько сильно уклон режет скорость. */
  slopePenalty: number;
}

const MODE_PARAMS: Record<MovementMode, ModeParams> = {
  [MovementMode.Normal]: { walk: 4.7, sprint: 7.8, eyeHeight: 1.68, jump: 7.2, canJump: true, slopePenalty: 0.9 },
  [MovementMode.Prosthetic]: { walk: 3.8, sprint: 3.8, eyeHeight: 1.64, jump: 4.4, canJump: true, slopePenalty: 1.3 },
  [MovementMode.Crawl]: { walk: 0.85, sprint: 0.85, eyeHeight: 0.5, jump: 0, canJump: false, slopePenalty: 1.6 },
  [MovementMode.Wheelchair]: { walk: 3.4, sprint: 4.6, eyeHeight: 1.15, jump: 0, canJump: false, slopePenalty: 3.4 },
};

export interface PlayerWorld {
  terrain: Terrain;
  forest?: Forest;
  colliders?: CollisionWorld;
}

/** Игрок: тело, камера от первого лица и управление. */
export class Player {
  readonly camera: THREE.PerspectiveCamera;
  readonly body: CharacterBody;

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
  private eyeOffset = MODE_PARAMS[MovementMode.Normal].eyeHeight;

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

  get params(): ModeParams {
    return MODE_PARAMS[this.mode];
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

  update(dt: number, input: Input, world: PlayerWorld): void {
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

    // Склон режет скорость: круче — медленнее. Для коляски это почти приговор.
    const slope = world.terrain.slopeAt(this.body.position.x, this.body.position.z);
    speed *= Math.max(0.12, 1 - slope * params.slopePenalty);

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
