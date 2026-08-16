import * as THREE from 'three';
import { Rng } from '../core/rng';
import { merge, paint, place } from '../core/geometry';
import { TAU } from '../core/math';
import { Zone } from './zones';

/** Уровень детализации трёхмерной модели дерева. */
export type TreeLod = 0 | 1;

export interface TreeSpecies {
  id: number;
  name: string;
  /** Базовая высота в метрах. */
  height: number;
  /** Разброс размера у отдельных деревьев. */
  scaleRange: [number, number];
  /** Радиус ствола у земли — по нему строится столкновение. */
  collisionRadius: number;
  /** Вес при выборе породы в каждой зоне. */
  weights: Record<Zone, number>;
  build(lod: TreeLod, rng: Rng): THREE.BufferGeometry;
}

const BARK_DARK = 0x4a3a2a;
const BARK_LIGHT = 0x6b5540;
const BARK_BIRCH = 0xd8d3c4;
const BARK_DEAD = 0x6a6055;

function trunk(height: number, baseRadius: number, topRadius: number, segments: number, color: number): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(topRadius, baseRadius, height, segments, 1, false);
  geometry.translate(0, height / 2, 0);
  return paint(geometry, color, 0.07);
}

function cone(radius: number, height: number, segments: number, color: number): THREE.BufferGeometry {
  const geometry = new THREE.ConeGeometry(radius, height, segments, 1);
  geometry.translate(0, height / 2, 0);
  return paint(geometry, color, 0.1);
}

function blob(radius: number, detail: number, color: number): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, detail);
  return paint(geometry, color, 0.12);
}

/** Ветка: тонкий цилиндр, наклонённый и отведённый в сторону. */
function branch(
  rng: Rng,
  length: number,
  radius: number,
  yaw: number,
  pitch: number,
  attachHeight: number,
  color: number,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radius * 0.4, radius, length, 4, 1, false);
  geometry.translate(0, length / 2, 0);
  geometry.rotateZ(pitch);
  geometry.rotateY(yaw);
  const reach = Math.sin(pitch) * length * 0.5;
  geometry.translate(Math.cos(yaw) * reach * 0.4, attachHeight, -Math.sin(yaw) * reach * 0.4);
  return paint(geometry, color, 0.05 + rng.next() * 0.02);
}

/** Ель: ярусы конусов на голом стволе. Основная порода леса эльфов и гор. */
function buildPine(lod: TreeLod, rng: Rng): THREE.BufferGeometry {
  const height = rng.range(13, 19);
  const segments = lod === 0 ? 7 : 5;
  const parts: THREE.BufferGeometry[] = [];
  const foliageColor = 0x2c4a26;

  parts.push(trunk(height, rng.range(0.32, 0.46), 0.1, segments, BARK_DARK));

  const tiers = lod === 0 ? 4 : 3;
  const bottom = height * 0.24;
  for (let i = 0; i < tiers; i++) {
    const t = i / tiers;
    const radius = rng.range(2.1, 2.9) * (1 - t * 0.62);
    const tierHeight = height * rng.range(0.3, 0.38) * (1 - t * 0.28);
    const y = bottom + (height - bottom) * t * 0.78;
    parts.push(place(cone(radius, tierHeight, segments, foliageColor), 0, y, 0));
  }

  return merge(parts);
}

/** Дуб: толстый ствол, разлапистые ветви, круглая крона. */
function buildOak(lod: TreeLod, rng: Rng): THREE.BufferGeometry {
  const height = rng.range(9, 14);
  const segments = lod === 0 ? 7 : 5;
  const detail = lod === 0 ? 1 : 0;
  const parts: THREE.BufferGeometry[] = [];
  const foliage = 0x496b2f;

  const trunkHeight = height * 0.55;
  parts.push(trunk(trunkHeight, rng.range(0.5, 0.72), 0.28, segments, BARK_LIGHT));

  if (lod === 0) {
    const branchCount = 4;
    for (let i = 0; i < branchCount; i++) {
      const yaw = (i / branchCount) * TAU + rng.range(-0.4, 0.4);
      parts.push(branch(rng, height * 0.4, 0.16, yaw, rng.range(0.5, 0.9), trunkHeight * 0.75, BARK_LIGHT));
    }
  }

  const blobs = lod === 0 ? 4 : 2;
  for (let i = 0; i < blobs; i++) {
    const radius = rng.range(2.0, 3.1) * (i === 0 ? 1.15 : 0.86);
    const angle = (i / blobs) * TAU + rng.range(-0.5, 0.5);
    const spread = i === 0 ? 0 : rng.range(1.1, 2.2);
    const geometry = blob(radius, detail, foliage);
    geometry.scale(1, 0.82, 1);
    parts.push(
      place(
        geometry,
        Math.cos(angle) * spread,
        trunkHeight + height * rng.range(0.16, 0.32),
        Math.sin(angle) * spread,
      ),
    );
  }

  return merge(parts);
}

/** Берёза: светлый тонкий ствол, редкая листва. */
function buildBirch(lod: TreeLod, rng: Rng): THREE.BufferGeometry {
  const height = rng.range(11, 16);
  const segments = lod === 0 ? 6 : 4;
  const detail = lod === 0 ? 1 : 0;
  const parts: THREE.BufferGeometry[] = [];
  const foliage = 0x7a9c46;

  const trunkHeight = height * 0.72;
  parts.push(trunk(trunkHeight, rng.range(0.22, 0.32), 0.13, segments, BARK_BIRCH));

  const blobs = lod === 0 ? 3 : 2;
  for (let i = 0; i < blobs; i++) {
    const radius = rng.range(1.5, 2.3);
    const angle = (i / blobs) * TAU + rng.range(-0.6, 0.6);
    const spread = i === 0 ? 0 : rng.range(0.8, 1.5);
    const geometry = blob(radius, detail, foliage);
    geometry.scale(1, 1.15, 1);
    parts.push(
      place(geometry, Math.cos(angle) * spread, trunkHeight + height * rng.range(0.05, 0.2), Math.sin(angle) * spread),
    );
  }

  return merge(parts);
}

/** Древо эльфов: огромное, с широкой кроной. На таких стоят их домики. */
function buildElfTree(lod: TreeLod, rng: Rng): THREE.BufferGeometry {
  const height = rng.range(24, 32);
  const segments = lod === 0 ? 8 : 5;
  const detail = lod === 0 ? 1 : 0;
  const parts: THREE.BufferGeometry[] = [];
  const foliage = 0x38602c;

  const trunkHeight = height * 0.62;
  parts.push(trunk(trunkHeight, rng.range(1.1, 1.5), 0.5, segments, 0x5a4632));

  if (lod === 0) {
    for (let i = 0; i < 5; i++) {
      const yaw = (i / 5) * TAU + rng.range(-0.3, 0.3);
      parts.push(branch(rng, height * 0.36, 0.3, yaw, rng.range(0.55, 0.95), trunkHeight * 0.72, 0x5a4632));
    }
  }

  const blobs = lod === 0 ? 5 : 3;
  for (let i = 0; i < blobs; i++) {
    const radius = rng.range(4.2, 6.0) * (i === 0 ? 1.1 : 0.85);
    const angle = (i / blobs) * TAU + rng.range(-0.4, 0.4);
    const spread = i === 0 ? 0 : rng.range(2.4, 4.4);
    const geometry = blob(radius, detail, foliage);
    geometry.scale(1.1, 0.75, 1.1);
    parts.push(
      place(geometry, Math.cos(angle) * spread, trunkHeight + height * rng.range(0.1, 0.26), Math.sin(angle) * spread),
    );
  }

  return merge(parts);
}

/** Сухостой: голый ствол и обломанные ветви. Горы злодея заросли ими. */
function buildDeadTree(lod: TreeLod, rng: Rng): THREE.BufferGeometry {
  const height = rng.range(6, 10);
  const segments = lod === 0 ? 6 : 4;
  const parts: THREE.BufferGeometry[] = [];

  parts.push(trunk(height, rng.range(0.3, 0.45), 0.08, segments, BARK_DEAD));

  const branchCount = lod === 0 ? 5 : 2;
  for (let i = 0; i < branchCount; i++) {
    const yaw = (i / branchCount) * TAU + rng.range(-0.5, 0.5);
    parts.push(
      branch(rng, height * rng.range(0.28, 0.44), 0.1, yaw, rng.range(0.7, 1.15), height * rng.range(0.4, 0.85), BARK_DEAD),
    );
  }

  return merge(parts);
}

/** Куст: подлесок, в котором эльфу удобно прятаться. */
function buildBush(lod: TreeLod, rng: Rng): THREE.BufferGeometry {
  const detail = lod === 0 ? 1 : 0;
  const parts: THREE.BufferGeometry[] = [];
  const foliage = 0x3f5a2b;
  const blobs = lod === 0 ? 3 : 2;

  for (let i = 0; i < blobs; i++) {
    const radius = rng.range(0.7, 1.25);
    const angle = (i / blobs) * TAU + rng.range(-0.7, 0.7);
    const spread = i === 0 ? 0 : rng.range(0.4, 0.9);
    const geometry = blob(radius, detail, foliage);
    geometry.scale(1.2, 0.8, 1.2);
    parts.push(place(geometry, Math.cos(angle) * spread, radius * 0.7, Math.sin(angle) * spread));
  }

  return merge(parts);
}

export const TREE_SPECIES: readonly TreeSpecies[] = [
  {
    id: 0,
    name: 'ель',
    height: 16,
    scaleRange: [0.78, 1.3],
    collisionRadius: 0.45,
    weights: { [Zone.Human]: 1.0, [Zone.Imperial]: 0.9, [Zone.Elf]: 3.2, [Zone.Villain]: 2.2 },
    build: buildPine,
  },
  {
    id: 1,
    name: 'дуб',
    height: 12,
    scaleRange: [0.82, 1.35],
    collisionRadius: 0.7,
    weights: { [Zone.Human]: 3.0, [Zone.Imperial]: 2.4, [Zone.Elf]: 2.4, [Zone.Villain]: 0.3 },
    build: buildOak,
  },
  {
    id: 2,
    name: 'берёза',
    height: 14,
    scaleRange: [0.8, 1.25],
    collisionRadius: 0.32,
    weights: { [Zone.Human]: 2.6, [Zone.Imperial]: 2.0, [Zone.Elf]: 2.0, [Zone.Villain]: 0.4 },
    build: buildBirch,
  },
  {
    id: 3,
    name: 'древо эльфов',
    height: 28,
    scaleRange: [0.85, 1.25],
    collisionRadius: 1.5,
    weights: { [Zone.Human]: 0.05, [Zone.Imperial]: 0.02, [Zone.Elf]: 1.5, [Zone.Villain]: 0 },
    build: buildElfTree,
  },
  {
    id: 4,
    name: 'сухостой',
    height: 8,
    scaleRange: [0.8, 1.2],
    collisionRadius: 0.35,
    weights: { [Zone.Human]: 0.4, [Zone.Imperial]: 0.3, [Zone.Elf]: 0.5, [Zone.Villain]: 2.6 },
    build: buildDeadTree,
  },
  {
    id: 5,
    name: 'куст',
    height: 2,
    scaleRange: [0.7, 1.4],
    collisionRadius: 0,
    weights: { [Zone.Human]: 2.2, [Zone.Imperial]: 2.0, [Zone.Elf]: 3.0, [Zone.Villain]: 1.4 },
    build: buildBush,
  },
];

export const SPECIES_COUNT = TREE_SPECIES.length;

/**
 * Построить набор вариантов для каждой породы.
 * Несколько вариантов на породу нужны, чтобы лес не выглядел как ряды клонов,
 * но при этом всё оставалось инстансингом — вариантов немного, и каждый рисуется
 * одним вызовом.
 */
export function buildSpeciesVariants(seed: number, lod: TreeLod, variants: number): THREE.BufferGeometry[][] {
  const result: THREE.BufferGeometry[][] = [];
  for (const species of TREE_SPECIES) {
    const perSpecies: THREE.BufferGeometry[] = [];
    for (let v = 0; v < variants; v++) {
      // Один и тот же сид на вариант для всех уровней детализации — LOD0 и LOD1
      // получаются похожими, поэтому подмена при подходе незаметна.
      const rng = new Rng(seed + species.id * 977 + v * 31);
      perSpecies.push(species.build(lod, rng));
    }
    result.push(perSpecies);
  }
  return result;
}
