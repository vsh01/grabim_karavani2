import * as THREE from 'three';
import { merge, paint, place } from '../core/geometry';
import { Rng } from '../core/rng';
import { TAU } from '../core/math';
import type { Terrain } from '../world/terrain';
import { SITES, type Site } from './sites';
import type { BoxCollider, CollisionWorld } from '../systems/physics';

/**
 * Постройки мира: дворец императора, старый форт злодея, деревянные домики
 * эльфов и деревня людей.
 *
 * Всё собрано из коробок и склеено в один меш на здание — сотня домов стоит
 * дешевле десятка живых персонажей. Стены сразу регистрируются как преграды,
 * причём с проёмом: в дом можно зайти, а не только обойти его снаружи.
 */

const COLOR_WOOD = 0x6b5133;
const COLOR_DARK_WOOD = 0x46331f;
const COLOR_THATCH = 0x9a7f45;
const COLOR_STONE = 0x8a8577;
const COLOR_DARK_STONE = 0x5f5b50;
const COLOR_RUIN = 0x6a6357;
const COLOR_TILE = 0x6a4238;
const COLOR_CANVAS = 0xcfc3a0;
const COLOR_BANNER = 0x8d2323;

interface Building {
  parts: THREE.BufferGeometry[];
  colliders: Omit<BoxCollider, 'walkable'>[];
  walkable?: Omit<BoxCollider, 'walkable'>[];
}

/** Стена как преграда: коробка в мировых координатах. */
function wall(
  building: Building,
  color: number,
  x: number,
  y: number,
  z: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  rotationY = 0,
): void {
  const geometry = paint(new THREE.BoxGeometry(sizeX, sizeY, sizeZ), color, 0.05);
  if (rotationY) geometry.rotateY(rotationY);
  geometry.translate(x, y, z);
  building.parts.push(geometry);
  building.colliders.push({
    x,
    y,
    z,
    halfX: sizeX / 2,
    halfY: sizeY / 2,
    halfZ: sizeZ / 2,
    rotationY,
  });
}

/** Украшение без столкновений: крыша, флаг, бочка. */
function decor(building: Building, geometry: THREE.BufferGeometry): void {
  building.parts.push(geometry);
}

/**
 * Домик: четыре стены с проёмом в одной из них и двускатная крыша.
 * Проём обязателен — иначе получается не дом, а декорация.
 */
function makeHouse(
  building: Building,
  cx: number,
  cz: number,
  ground: number,
  width: number,
  depth: number,
  height: number,
  rotation: number,
  wallColor: number,
  roofColor: number,
): void {
  const thickness = 0.22;
  const halfW = width / 2;
  const halfD = depth / 2;
  const doorWidth = 1.1;
  const sin = Math.sin(rotation);
  const cos = Math.cos(rotation);

  /** Перевести местные координаты дома в мировые. */
  const toWorld = (lx: number, lz: number): [number, number] => [
    cx + lx * cos + lz * sin,
    cz - lx * sin + lz * cos,
  ];

  const midY = ground + height / 2;

  // Задняя и боковые стены целиком.
  {
    const [x, z] = toWorld(0, -halfD);
    wall(building, wallColor, x, midY, z, width, height, thickness, rotation);
  }
  {
    const [x, z] = toWorld(-halfW, 0);
    wall(building, wallColor, x, midY, z, thickness, height, depth, rotation);
  }
  {
    const [x, z] = toWorld(halfW, 0);
    wall(building, wallColor, x, midY, z, thickness, height, depth, rotation);
  }

  // Передняя стена с дверным проёмом посередине.
  const sideWidth = (width - doorWidth) / 2;
  for (const sign of [-1, 1] as const) {
    const offset = sign * (doorWidth / 2 + sideWidth / 2);
    const [x, z] = toWorld(offset, halfD);
    wall(building, wallColor, x, midY, z, sideWidth, height, thickness, rotation);
  }
  // Перемычка над дверью.
  {
    const [x, z] = toWorld(0, halfD);
    const lintelHeight = height - 2.1;
    if (lintelHeight > 0.2) {
      wall(building, wallColor, x, ground + height - lintelHeight / 2, z, doorWidth, lintelHeight, thickness, rotation);
    }
  }

  // Двускатная крыша: две наклонённые плиты.
  const slope = 0.62;
  for (const sign of [-1, 1] as const) {
    const roof = paint(new THREE.BoxGeometry(width + 0.7, 0.16, depth * 0.62), roofColor, 0.06);
    roof.rotateX(sign * slope);
    roof.rotateY(rotation);
    const [x, z] = toWorld(0, sign * depth * 0.24);
    roof.translate(x, ground + height + 0.42, z);
    decor(building, roof);
  }
}

/** Дом эльфов: сруб на сваях, лестница и навес. */
function makeElfHouse(building: Building, cx: number, cz: number, ground: number, rng: Rng): void {
  const platformHeight = rng.range(2.2, 3.4);
  const width = rng.range(3.4, 4.6);
  const depth = rng.range(3.2, 4.2);
  const rotation = rng.range(0, TAU);

  // Сваи.
  for (const [dx, dz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    const post = paint(new THREE.CylinderGeometry(0.16, 0.2, platformHeight, 6), COLOR_DARK_WOOD, 0.05);
    decor(building, place(post, cx + dx * width * 0.38, ground + platformHeight / 2, cz + dz * depth * 0.38));
  }

  // Помост, по которому можно ходить.
  const deck = paint(new THREE.BoxGeometry(width + 1.2, 0.26, depth + 1.2), COLOR_WOOD, 0.05);
  deck.rotateY(rotation);
  decor(building, place(deck, cx, ground + platformHeight, cz));
  building.walkable = building.walkable ?? [];
  building.walkable.push({
    x: cx,
    y: ground + platformHeight,
    z: cz,
    halfX: (width + 1.2) / 2,
    halfY: 0.13,
    halfZ: (depth + 1.2) / 2,
    rotationY: rotation,
  });

  makeHouse(building, cx, cz, ground + platformHeight + 0.13, width, depth, 2.5, rotation, COLOR_WOOD, 0x4d6b3a);

  // Лестница-сходни: наклонная доска до земли.
  const stairs = paint(new THREE.BoxGeometry(1.1, 0.14, platformHeight * 1.5), COLOR_DARK_WOOD, 0.04);
  stairs.rotateX(-Math.atan2(platformHeight, platformHeight * 1.3));
  stairs.rotateY(rotation);
  decor(
    building,
    place(
      stairs,
      cx + Math.sin(rotation) * (depth * 0.5 + 1.4),
      ground + platformHeight * 0.5,
      cz + Math.cos(rotation) * (depth * 0.5 + 1.4),
    ),
  );
}

/** Палатка: два ската и вход. */
function makeTent(building: Building, cx: number, cz: number, ground: number, rng: Rng, color: number): void {
  const length = rng.range(2.6, 3.6);
  const rotation = rng.range(0, TAU);

  for (const sign of [-1, 1] as const) {
    const side = paint(new THREE.BoxGeometry(0.12, 2.1, length), color, 0.06);
    side.rotateZ(sign * 0.52);
    side.rotateY(rotation);
    decor(building, place(side, cx + sign * 0.78, ground + 0.95, cz));
  }

  building.colliders.push({
    x: cx,
    y: ground + 0.8,
    z: cz,
    halfX: 1.0,
    halfY: 0.8,
    halfZ: length / 2,
    rotationY: rotation,
  });
}

/** Костёр с брёвнами вокруг. */
function makeCampfire(building: Building, cx: number, cz: number, ground: number): void {
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * TAU;
    const log = paint(new THREE.CylinderGeometry(0.09, 0.09, 1.1, 5), COLOR_DARK_WOOD, 0.05);
    log.rotateZ(1.15);
    log.rotateY(angle);
    decor(building, place(log, cx + Math.cos(angle) * 0.28, ground + 0.28, cz + Math.sin(angle) * 0.28));
  }
  decor(building, place(paint(new THREE.ConeGeometry(0.34, 0.5, 6), 0xd06a2a, 0.2), cx, ground + 0.5, cz));
}

/** Башня: круглая, с зубцами. */
function makeTower(building: Building, cx: number, cz: number, ground: number, height: number, radius: number): void {
  const body = paint(new THREE.CylinderGeometry(radius, radius * 1.08, height, 9), COLOR_STONE, 0.05);
  decor(building, place(body, cx, ground + height / 2, cz));
  building.colliders.push({
    x: cx,
    y: ground + height / 2,
    z: cz,
    halfX: radius,
    halfY: height / 2,
    halfZ: radius,
    rotationY: 0,
  });

  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * TAU;
    const merlon = paint(new THREE.BoxGeometry(0.42, 0.6, 0.42), COLOR_DARK_STONE, 0.05);
    decor(
      building,
      place(merlon, cx + Math.cos(angle) * radius * 0.86, ground + height + 0.3, cz + Math.sin(angle) * radius * 0.86),
    );
  }
}

/**
 * Зубцы по верху стены.
 * Без них стена — просто длинная плита; с ними это сразу читается как крепость.
 */
function addMerlons(
  building: Building,
  cx: number,
  cz: number,
  length: number,
  top: number,
  rotationY: number,
): void {
  const step = 2.2;
  const count = Math.max(2, Math.floor(length / step));
  const sin = Math.sin(rotationY);
  const cos = Math.cos(rotationY);

  for (let i = 0; i < count; i++) {
    const offset = (i - (count - 1) / 2) * step;
    const merlon = paint(new THREE.BoxGeometry(1.1, 0.85, 1.9), COLOR_DARK_STONE, 0.06);
    merlon.rotateY(rotationY);
    decor(building, place(merlon, cx + offset * cos, top + 0.42, cz - offset * sin));
  }
}

/** Флаг на шесте — по нему видно, чья это крепость. */
function makeBanner(building: Building, cx: number, cz: number, ground: number, height: number, color: number): void {
  decor(
    building,
    place(paint(new THREE.CylinderGeometry(0.07, 0.07, height, 5), COLOR_DARK_WOOD), cx, ground + height / 2, cz),
  );
  decor(
    building,
    place(paint(new THREE.BoxGeometry(1.2, 0.75, 0.06), color, 0.08), cx + 0.6, ground + height - 0.55, cz),
  );
}

/** Собрать здание в один меш и зарегистрировать преграды. */
function finish(building: Building, colliders: CollisionWorld, name: string): THREE.Mesh {
  for (const box of building.colliders) colliders.add({ ...box, walkable: false });
  for (const box of building.walkable ?? []) colliders.add({ ...box, walkable: true });

  const geometry = merge(building.parts);
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

function emptyBuilding(): Building {
  return { parts: [], colliders: [] };
}

// ── Поселения ───────────────────────────────────────────────────────────────

/** Деревня людей: избы вокруг площади и торговые навесы. */
function buildVillage(site: Site, terrain: Terrain, rng: Rng): Building {
  const building = emptyBuilding();
  const houses = 9;

  for (let i = 0; i < houses; i++) {
    const angle = (i / houses) * TAU + rng.range(-0.16, 0.16);
    const radius = rng.range(26, 48);
    const x = site.x + Math.cos(angle) * radius;
    const z = site.z + Math.sin(angle) * radius;
    makeHouse(
      building,
      x,
      z,
      terrain.heightAt(x, z),
      rng.range(4.2, 5.8),
      rng.range(3.8, 5.2),
      2.7,
      // Дома смотрят дверью на площадь.
      Math.atan2(site.x - x, site.z - z),
      COLOR_WOOD,
      COLOR_THATCH,
    );
  }

  // Навесы на площади.
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * TAU + 0.4;
    const x = site.x + Math.cos(angle) * 9;
    const z = site.z + Math.sin(angle) * 9;
    const ground = terrain.heightAt(x, z);

    for (const [dx, dz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      decor(
        building,
        place(
          paint(new THREE.CylinderGeometry(0.08, 0.08, 2.2, 5), COLOR_DARK_WOOD),
          x + dx * 1.2,
          ground + 1.1,
          z + dz * 1.0,
        ),
      );
    }
    decor(building, place(paint(new THREE.BoxGeometry(3.0, 0.12, 2.6), COLOR_CANVAS, 0.07), x, ground + 2.25, z));
    decor(building, place(paint(new THREE.BoxGeometry(2.4, 0.7, 1.0), COLOR_WOOD, 0.05), x, ground + 0.55, z));
  }

  return building;
}

/** Дворец: стена с башнями, ворота и донжон. */
function buildPalace(site: Site, terrain: Terrain): Building {
  const building = emptyBuilding();
  const ground = terrain.heightAt(site.x, site.z);
  const half = 40;
  const wallHeight = 6.5;
  const gateWidth = 6;

  // Четыре стороны стены; в южной — проём ворот.
  for (const side of ['north', 'south', 'east', 'west'] as const) {
    if (side === 'south') {
      const segment = (half * 2 - gateWidth) / 2;
      for (const sign of [-1, 1] as const) {
        const centerX = site.x + sign * (gateWidth / 2 + segment / 2);
        wall(building, COLOR_STONE, centerX, ground + wallHeight / 2, site.z + half, segment, wallHeight, 1.6);
        addMerlons(building, centerX, site.z + half, segment, ground + wallHeight, 0);
      }
      // Арка над воротами.
      wall(building, COLOR_DARK_STONE, site.x, ground + wallHeight - 0.9, site.z + half, gateWidth, 1.8, 1.8);
      continue;
    }

    const isNorth = side === 'north';
    const isEast = side === 'east';
    const wallX = site.x + (isEast ? half : side === 'west' ? -half : 0);
    const wallZ = site.z + (isNorth ? -half : 0);
    wall(
      building,
      COLOR_STONE,
      wallX,
      ground + wallHeight / 2,
      wallZ,
      isNorth ? half * 2 : 1.6,
      wallHeight,
      isNorth ? 1.6 : half * 2,
    );
    addMerlons(building, wallX, wallZ, half * 2, ground + wallHeight, isNorth ? 0 : Math.PI / 2);

    // Контрфорсы: длинная стена перестаёт выглядеть плоской плитой.
    for (let i = -3; i <= 3; i++) {
      const offset = i * 11;
      const bx = isNorth ? wallX + offset : wallX;
      const bz = isNorth ? wallZ : wallZ + offset;
      decor(
        building,
        place(
          paint(new THREE.BoxGeometry(isNorth ? 1.5 : 2.4, wallHeight * 0.92, isNorth ? 2.4 : 1.5), COLOR_DARK_STONE, 0.05),
          bx,
          ground + wallHeight * 0.46,
          bz,
        ),
      );
    }
  }

  for (const [dx, dz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    makeTower(building, site.x + dx * half, site.z + dz * half, ground, wallHeight + 3.5, 2.8);
  }

  // Донжон в центре: два яруса и черепичная крыша.
  makeHouse(building, site.x, site.z, ground, 18, 14, 7.5, 0, COLOR_STONE, COLOR_TILE);
  makeHouse(building, site.x, site.z - 1, ground + 7.9, 11, 8, 4.5, 0, COLOR_DARK_STONE, COLOR_TILE);
  makeBanner(building, site.x - 7, site.z + 8, ground, 9, 0x3a4c9c);
  makeBanner(building, site.x + 7, site.z + 8, ground, 9, 0x3a4c9c);

  return building;
}

/** Старый форт: обвалившаяся стена и приземистая башня. */
function buildFort(site: Site, terrain: Terrain, rng: Rng): Building {
  const building = emptyBuilding();
  const ground = terrain.heightAt(site.x, site.z);
  const radius = 27;
  const segments = 14;

  for (let i = 0; i < segments; i++) {
    // Две бреши в кольце: форт старый и держится на честном слове.
    if (i === 3 || i === 9) continue;

    const angle = (i / segments) * TAU;
    const x = site.x + Math.cos(angle) * radius;
    const z = site.z + Math.sin(angle) * radius;
    const height = rng.range(2.4, 5.2);
    wall(
      building,
      COLOR_RUIN,
      x,
      terrain.heightAt(x, z) + height / 2,
      z,
      (TAU * radius) / segments,
      height,
      1.4,
      -angle,
    );
  }

  makeTower(building, site.x - 9, site.z - 9, ground, 11, 3.4);
  makeHouse(building, site.x + 4, site.z + 2, ground, 12, 9, 5.2, 0.3, COLOR_RUIN, COLOR_DARK_STONE);
  makeBanner(building, site.x + 12, site.z - 8, ground, 7.5, COLOR_BANNER);

  for (let i = 0; i < 3; i++) {
    makeCampfire(building, site.x + rng.range(-14, 14), site.z + rng.range(-14, 14), ground);
  }

  return building;
}

/** Поляна эльфов: домики на сваях среди леса. */
function buildGlade(site: Site, terrain: Terrain, rng: Rng): Building {
  const building = emptyBuilding();

  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * TAU + rng.range(-0.2, 0.2);
    const radius = rng.range(20, 46);
    const x = site.x + Math.cos(angle) * radius;
    const z = site.z + Math.sin(angle) * radius;
    makeElfHouse(building, x, z, terrain.heightAt(x, z), rng);
  }

  makeCampfire(building, site.x, site.z, terrain.heightAt(site.x, site.z));
  return building;
}

/** Лагерь: палатки и костёр. */
function buildCamp(site: Site, terrain: Terrain, rng: Rng, tents: number, color: number): Building {
  const building = emptyBuilding();

  for (let i = 0; i < tents; i++) {
    const angle = (i / tents) * TAU + rng.range(-0.3, 0.3);
    const radius = rng.range(7, 16);
    const x = site.x + Math.cos(angle) * radius;
    const z = site.z + Math.sin(angle) * radius;
    makeTent(building, x, z, terrain.heightAt(x, z), rng, color);
  }

  makeCampfire(building, site.x, site.z, terrain.heightAt(site.x, site.z));
  return building;
}

/**
 * Построить все поселения мира и зарегистрировать их стены как преграды.
 * Возвращает группу, готовую к добавлению в сцену.
 */
export function buildSettlements(terrain: Terrain, colliders: CollisionWorld, seed: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'settlements';
  const rng = new Rng(seed ^ 0x5e77);

  for (const site of SITES) {
    let building: Building | null = null;

    switch (site.kind) {
      case 'town':
        building = buildVillage(site, terrain, rng);
        break;
      case 'palace':
        building = buildPalace(site, terrain);
        break;
      case 'fort':
        building = buildFort(site, terrain, rng);
        break;
      case 'glade':
        building = buildGlade(site, terrain, rng);
        break;
      case 'camp':
        building = buildCamp(
          site,
          terrain,
          rng,
          site.id === 'barracks' ? 5 : 4,
          site.id === 'barracks' ? 0x8d9bc4 : 0x7f9160,
        );
        break;
      default:
        building = null;
    }

    if (building) group.add(finish(building, colliders, `settlement-${site.id}`));
  }

  return group;
}
