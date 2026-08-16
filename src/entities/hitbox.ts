import * as THREE from 'three';
import { Body, BodyPart } from './body';

/** Сфера, по которой определяется попадание в конкретную часть тела. */
export interface PartCollider {
  part: BodyPart;
  x: number;
  y: number;
  z: number;
  radius: number;
}

/**
 * Точки попаданий в локальных координатах: +X — правое плечо персонажа,
 * −Z — направление взгляда, Y отсчитывается от подошв.
 *
 * Крупные части набраны из нескольких сфер, чтобы удар в плечо не считался
 * ударом в живот, а стрела в лицо могла выбить именно глаз. Один и тот же набор
 * используется и для врагов, и для игрока — правила одинаковы для всех.
 */
export const PART_COLLIDERS: readonly PartCollider[] = [
  { part: BodyPart.Head, x: 0, y: 1.62, z: 0, radius: 0.17 },
  { part: BodyPart.LeftEye, x: -0.06, y: 1.66, z: -0.11, radius: 0.05 },
  { part: BodyPart.RightEye, x: 0.06, y: 1.66, z: -0.11, radius: 0.05 },
  { part: BodyPart.Torso, x: 0, y: 1.36, z: 0, radius: 0.24 },
  { part: BodyPart.Torso, x: 0, y: 1.02, z: 0, radius: 0.24 },
  { part: BodyPart.LeftArm, x: -0.3, y: 1.33, z: 0, radius: 0.13 },
  { part: BodyPart.LeftArm, x: -0.3, y: 1.04, z: 0, radius: 0.12 },
  { part: BodyPart.RightArm, x: 0.3, y: 1.33, z: 0, radius: 0.13 },
  { part: BodyPart.RightArm, x: 0.3, y: 1.04, z: 0, radius: 0.12 },
  { part: BodyPart.LeftLeg, x: -0.13, y: 0.62, z: 0, radius: 0.15 },
  { part: BodyPart.LeftLeg, x: -0.13, y: 0.22, z: 0, radius: 0.14 },
  { part: BodyPart.RightLeg, x: 0.13, y: 0.62, z: 0, radius: 0.15 },
  { part: BodyPart.RightLeg, x: 0.13, y: 0.22, z: 0, radius: 0.14 },
];

/** Радиус грубой сферы вокруг персонажа для быстрой отбраковки. */
export const ROUGH_RADIUS = 1.45;

export interface PartHit {
  part: BodyPart;
  distance: number;
  point: THREE.Vector3;
}

/**
 * Пересчитать точки попадания в мировые координаты.
 * @param crouch множитель высоты: ползущий персонаж прижат к земле
 */
export function updateColliderPositions(
  position: THREE.Vector3,
  yaw: number,
  crouch: number,
  out: THREE.Vector3[],
): void {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);

  for (let i = 0; i < PART_COLLIDERS.length; i++) {
    const local = PART_COLLIDERS[i];
    out[i].set(
      position.x + local.x * cos + local.z * sin,
      position.y + local.y * crouch,
      position.z - local.x * sin + local.z * cos,
    );
  }
}

/**
 * Найти ближайшую часть тела, которую задел луч.
 * Отрубленные части пропускаются — по ним уже не попасть.
 */
export function raycastColliders(
  colliderWorld: readonly THREE.Vector3[],
  wounds: Body,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
): PartHit | null {
  let best: PartHit | null = null;

  for (let i = 0; i < PART_COLLIDERS.length; i++) {
    const collider = PART_COLLIDERS[i];
    if (wounds.isLost(collider.part)) continue;

    const center = colliderWorld[i];
    const ox = center.x - origin.x;
    const oy = center.y - origin.y;
    const oz = center.z - origin.z;

    const along = ox * direction.x + oy * direction.y + oz * direction.z;
    if (along < 0 || along > maxDistance + collider.radius) continue;

    const perpSq = ox * ox + oy * oy + oz * oz - along * along;
    const radiusSq = collider.radius * collider.radius;
    if (perpSq > radiusSq) continue;

    const distance = Math.max(0, along - Math.sqrt(radiusSq - perpSq));
    if (distance > maxDistance) continue;
    if (best && distance >= best.distance) continue;

    best = {
      part: collider.part,
      distance,
      point: new THREE.Vector3(
        origin.x + direction.x * distance,
        origin.y + direction.y * distance,
        origin.z + direction.z * distance,
      ),
    };
  }

  return best;
}

/** Быстрая проверка: может ли луч вообще задеть персонажа. */
export function roughlyIntersects(
  position: THREE.Vector3,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
): boolean {
  const ox = position.x - origin.x;
  const oy = position.y + 0.9 - origin.y;
  const oz = position.z - origin.z;
  const along = ox * direction.x + oy * direction.y + oz * direction.z;
  if (along < -ROUGH_RADIUS || along > maxDistance + ROUGH_RADIUS) return false;
  const perpSq = ox * ox + oy * oy + oz * oz - along * along;
  return perpSq < ROUGH_RADIUS * ROUGH_RADIUS;
}

/** Готовый буфер под мировые координаты точек попадания. */
export function createColliderBuffer(): THREE.Vector3[] {
  return PART_COLLIDERS.map(() => new THREE.Vector3());
}
