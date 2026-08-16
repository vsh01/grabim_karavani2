import * as THREE from 'three';
import { clamp } from '../core/math';
import type { Terrain } from '../world/terrain';
import type { Forest, TreeHit } from '../world/forest';

export const GRAVITY = 24;
/** Круче этого уклона в гору не подняться — только в обход. */
export const MAX_WALK_SLOPE = 0.62;
/** Высота, на которую персонаж заходит без прыжка: ступени, брёвна, пороги. */
export const STEP_HEIGHT = 0.55;

/** Прямоугольная преграда: стена дворца, дом, повозка. */
export interface BoxCollider {
  x: number;
  y: number;
  z: number;
  halfX: number;
  halfY: number;
  halfZ: number;
  rotationY: number;
  /** По верху можно ходить (пол, помост, крыша). */
  walkable: boolean;
}

const CELL = 32;

/**
 * Набор преград мира с разбиением по сетке.
 * Проверять тысячи стен на каждом шаге незачем — берём только соседние клетки.
 */
export class CollisionWorld {
  private readonly cells = new Map<number, BoxCollider[]>();
  private readonly all: BoxCollider[] = [];

  private static key(cx: number, cz: number): number {
    // Сдвиг на 512 клеток, чтобы отрицательные координаты не ломали ключ.
    return (cx + 512) * 4096 + (cz + 512);
  }

  add(box: BoxCollider): BoxCollider {
    this.all.push(box);

    // Радиус захвата с запасом на поворот.
    const reach = Math.hypot(box.halfX, box.halfZ);
    const minCx = Math.floor((box.x - reach) / CELL);
    const maxCx = Math.floor((box.x + reach) / CELL);
    const minCz = Math.floor((box.z - reach) / CELL);
    const maxCz = Math.floor((box.z + reach) / CELL);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const key = CollisionWorld.key(cx, cz);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = [];
          this.cells.set(key, bucket);
        }
        bucket.push(box);
      }
    }
    return box;
  }

  /** Преграды рядом с точкой. Результат складывается в переданный массив. */
  query(x: number, z: number, radius: number, out: BoxCollider[]): BoxCollider[] {
    out.length = 0;
    const minCx = Math.floor((x - radius) / CELL);
    const maxCx = Math.floor((x + radius) / CELL);
    const minCz = Math.floor((z - radius) / CELL);
    const maxCz = Math.floor((z + radius) / CELL);

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this.cells.get(CollisionWorld.key(cx, cz));
        if (!bucket) continue;
        for (const box of bucket) {
          if (out.indexOf(box) === -1) out.push(box);
        }
      }
    }
    return out;
  }

  get count(): number {
    return this.all.length;
  }

  clear(): void {
    this.cells.clear();
    this.all.length = 0;
  }
}

export interface CharacterBody {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  radius: number;
  height: number;
  grounded: boolean;
  /** Высота поверхности под ногами на прошлом шаге. */
  groundHeight: number;
}

export interface MoveContext {
  terrain: Terrain;
  forest?: Forest;
  colliders?: CollisionWorld;
  /** Персонаж не проваливается сквозь пол, но может летать (для отладки). */
  gravity?: boolean;
}

const boxScratch: BoxCollider[] = [];
const treeScratch: TreeHit[] = [];
const localPoint = new THREE.Vector2();
const closestPoint = new THREE.Vector2();

/** Оттолкнуть круг от повёрнутого прямоугольника в плоскости XZ. */
function resolveBox(body: CharacterBody, box: BoxCollider): void {
  const top = box.y + box.halfY;
  const bottom = box.y - box.halfY;
  const feet = body.position.y;
  const head = body.position.y + body.height;

  // Коробка целиком выше головы или ниже ног — не мешает.
  if (bottom > head || top < feet + 0.05) return;
  // По проходимому верху уже стоим — вертикальная часть разберётся отдельно.
  if (box.walkable && top <= feet + STEP_HEIGHT) return;

  const cos = Math.cos(-box.rotationY);
  const sin = Math.sin(-box.rotationY);
  const dx = body.position.x - box.x;
  const dz = body.position.z - box.z;

  localPoint.set(dx * cos - dz * sin, dx * sin + dz * cos);
  closestPoint.set(clamp(localPoint.x, -box.halfX, box.halfX), clamp(localPoint.y, -box.halfZ, box.halfZ));

  const offsetX = localPoint.x - closestPoint.x;
  const offsetZ = localPoint.y - closestPoint.y;
  const distance = Math.hypot(offsetX, offsetZ);

  if (distance >= body.radius) return;

  let pushX: number;
  let pushZ: number;
  if (distance > 1e-4) {
    pushX = (offsetX / distance) * body.radius;
    pushZ = (offsetZ / distance) * body.radius;
  } else {
    // Центр внутри коробки — выталкиваем по ближайшей грани.
    const toRight = box.halfX - localPoint.x;
    const toLeft = localPoint.x + box.halfX;
    const toFar = box.halfZ - localPoint.y;
    const toNear = localPoint.y + box.halfZ;
    const min = Math.min(toRight, toLeft, toFar, toNear);
    if (min === toRight) {
      pushX = box.halfX + body.radius;
      pushZ = localPoint.y;
    } else if (min === toLeft) {
      pushX = -box.halfX - body.radius;
      pushZ = localPoint.y;
    } else if (min === toFar) {
      pushX = localPoint.x;
      pushZ = box.halfZ + body.radius;
    } else {
      pushX = localPoint.x;
      pushZ = -box.halfZ - body.radius;
    }
    body.position.x = box.x + (pushX * Math.cos(box.rotationY) - pushZ * Math.sin(box.rotationY));
    body.position.z = box.z + (pushX * Math.sin(box.rotationY) + pushZ * Math.cos(box.rotationY));
    return;
  }

  const targetX = closestPoint.x + pushX;
  const targetZ = closestPoint.y + pushZ;
  body.position.x = box.x + (targetX * Math.cos(box.rotationY) - targetZ * Math.sin(box.rotationY));
  body.position.z = box.z + (targetX * Math.sin(box.rotationY) + targetZ * Math.cos(box.rotationY));
}

/**
 * Двигать персонажа с учётом рельефа, деревьев и построек.
 *
 * Контроллер кинематический: скорость задаёт управление, а не силы. Для экшена
 * это ощущается отзывчивее любой честной физики, и результат детерминирован —
 * значит, воспроизводится при загрузке сохранения.
 */
export function moveCharacter(body: CharacterBody, dt: number, context: MoveContext): void {
  const { terrain, forest, colliders } = context;

  const previousX = body.position.x;
  const previousZ = body.position.z;
  const previousHeight = terrain.heightAt(previousX, previousZ);

  body.position.x += body.velocity.x * dt;
  body.position.z += body.velocity.z * dt;

  // Не выпускаем за край карты.
  const limit = 1000;
  body.position.x = clamp(body.position.x, -limit, limit);
  body.position.z = clamp(body.position.z, -limit, limit);

  // Стволы деревьев.
  if (forest) {
    forest.queryTrees(body.position.x, body.position.z, body.radius + 2, treeScratch);
    for (const tree of treeScratch) {
      const dx = body.position.x - tree.x;
      const dz = body.position.z - tree.z;
      const minDistance = tree.radius + body.radius;
      const distance = Math.hypot(dx, dz);
      if (distance >= minDistance || distance < 1e-5) continue;
      const scale = minDistance / distance;
      body.position.x = tree.x + dx * scale;
      body.position.z = tree.z + dz * scale;
    }
  }

  // Постройки.
  if (colliders) {
    colliders.query(body.position.x, body.position.z, body.radius + 3, boxScratch);
    for (const box of boxScratch) resolveBox(body, box);
  }

  // Слишком крутой подъём — откатываем шаг. Вниз при этом идти можно.
  const newHeight = terrain.heightAt(body.position.x, body.position.z);
  if (newHeight > previousHeight + 0.02 && terrain.slopeAt(body.position.x, body.position.z) > MAX_WALK_SLOPE) {
    body.position.x = previousX;
    body.position.z = previousZ;
  }

  // Вертикаль.
  if (context.gravity !== false) {
    body.velocity.y -= GRAVITY * dt;
  }
  body.position.y += body.velocity.y * dt;

  let ground = terrain.heightAt(body.position.x, body.position.z);

  // Крыши и полы построек, на которые можно встать.
  if (colliders) {
    colliders.query(body.position.x, body.position.z, body.radius, boxScratch);
    for (const box of boxScratch) {
      if (!box.walkable) continue;
      const top = box.y + box.halfY;
      if (top <= ground) continue;
      if (top > body.position.y + STEP_HEIGHT) continue;

      const cos = Math.cos(-box.rotationY);
      const sin = Math.sin(-box.rotationY);
      const dx = body.position.x - box.x;
      const dz = body.position.z - box.z;
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      if (Math.abs(lx) > box.halfX + body.radius || Math.abs(lz) > box.halfZ + body.radius) continue;

      ground = top;
    }
  }

  body.groundHeight = ground;

  if (body.position.y <= ground) {
    body.position.y = ground;
    if (body.velocity.y < 0) body.velocity.y = 0;
    body.grounded = true;
  } else {
    body.grounded = false;
  }
}

/** Есть ли прямая видимость между точками — грубо, по рельефу. */
export function hasLineOfSight(
  terrain: Terrain,
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
  step = 4,
): boolean {
  const distance = Math.hypot(toX - fromX, toZ - fromZ);
  const steps = Math.max(1, Math.ceil(distance / step));

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = fromX + (toX - fromX) * t;
    const z = fromZ + (toZ - fromZ) * t;
    const y = fromY + (toY - fromY) * t;
    if (terrain.heightAt(x, z) > y + 0.4) return false;
  }
  return true;
}
