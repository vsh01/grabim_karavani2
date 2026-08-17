import * as THREE from 'three';
import { Rng } from '../core/rng';
import { distance2D } from '../core/math';
import { Terrain, WATER_LEVEL } from './terrain';
import { WORLD_HALF, WORLD_SIZE, forestDensityAt, zoneWeights } from './zones';
import { SITES } from './sites';
import { SPECIES_COUNT, TREE_SPECIES, buildSpeciesVariants } from './treeModels';
import { ImpostorField, bakeImpostorAtlas, type ImpostorAtlas } from './impostors';

/** Сторона чанка леса в метрах. */
export const FOREST_CHUNK = 64;
const CHUNKS_PER_SIDE = WORLD_SIZE / FOREST_CHUNK;
const CHUNK_DIAGONAL = Math.SQRT2 * FOREST_CHUNK * 0.5;

/** Шаг сетки, по которой рассеиваются деревья. */
const SCATTER_STEP = 4;
const CELLS_PER_CHUNK = FOREST_CHUNK / SCATTER_STEP;

/** Границы уровней детализации, метры. */
export const LOD0_END = 65;
export const LOD1_END = 165;
export const FAR_END = 820;
/** Ширина полосы, на которой два уровня видны одновременно и перетекают друг в друга. */
export const FADE_BAND = 10;

const VARIANTS = 3;
const LOD0_CAPACITY = 640;
const LOD1_CAPACITY = 1280;
const IMPOSTOR_CAPACITY = 45000;

/** Насколько далеко может уехать камера, прежде чем пересобрать буферы. */
const NEAR_REBUILD_DISTANCE = 6;
const FAR_REBUILD_DISTANCE = 40;

const MAX_SLOPE = 0.45;
const TREE_LINE = 118;
/** Насколько широко лес расступается вдоль дороги, метры. */
const ROAD_CLEARANCE = 8.5;

interface ForestChunk {
  cx: number;
  cz: number;
  centerX: number;
  centerZ: number;
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  scale: Float32Array;
  rotation: Float32Array;
  species: Uint8Array;
  variant: Uint8Array;
}

export interface TreeHit {
  x: number;
  z: number;
  radius: number;
}

/**
 * Материал трёхмерного дерева с растворением по расстоянию.
 *
 * Дизеринг вместо прозрачности: пиксели выбрасываются псевдослучайно, поэтому
 * дерево не мигает при смене уровня детализации и не требует сортировки.
 */
function createTreeMaterial(
  fadeIn: THREE.Vector2,
  fadeOut: THREE.Vector2,
  invert: boolean,
): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const uFadeIn = { value: fadeIn };
  const uFadeOut = { value: fadeOut };
  const uFadeInvert = { value: invert ? 1 : 0 };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFadeIn = uFadeIn;
    shader.uniforms.uFadeOut = uFadeOut;
    shader.uniforms.uFadeInvert = uFadeInvert;

    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying float vTreeDistance;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 treeWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          treeWorld = instanceMatrix * treeWorld;
        #endif
        treeWorld = modelMatrix * treeWorld;
        vTreeDistance = length(cameraPosition - treeWorld.xyz);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `varying float vTreeDistance;
        uniform vec2 uFadeIn;
        uniform vec2 uFadeOut;
        uniform float uFadeInvert;
        float treeDither(vec2 p) {
          return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
        }
        void main() {`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        float fadeIn = uFadeIn.y > uFadeIn.x
          ? clamp((vTreeDistance - uFadeIn.x) / (uFadeIn.y - uFadeIn.x), 0.0, 1.0)
          : 1.0;
        float fadeOut = uFadeOut.y > uFadeOut.x
          ? 1.0 - clamp((vTreeDistance - uFadeOut.x) / (uFadeOut.y - uFadeOut.x), 0.0, 1.0)
          : 1.0;
        float coverage = min(fadeIn, fadeOut);
        float noise = treeDither(gl_FragCoord.xy);
        // Соседние уровни детализации должны выбрасывать взаимно дополняющие
        // пиксели, иначе в полосе перехода дерево наполовину исчезает.
        bool keep = uFadeInvert > 0.5 ? (noise >= 1.0 - coverage) : (noise < coverage);
        if (!keep) discard;`,
      );
  };

  material.customProgramCacheKey = () => 'tree-lod-fade';
  return material;
}

/**
 * Лес: расстановка деревьев по всему миру и их отрисовка тремя уровнями
 * детализации — модель вблизи, упрощённая модель дальше, картинка на горизонте.
 */
export class Forest {
  readonly group = new THREE.Group();

  private readonly chunks: ForestChunk[] = [];
  private readonly lod0: THREE.InstancedMesh[][] = [];
  private readonly lod1: THREE.InstancedMesh[][] = [];
  private readonly lod0Counts: number[][] = [];
  private readonly lod1Counts: number[][] = [];
  private impostors!: ImpostorField;
  private atlas!: ImpostorAtlas;
  private materials: THREE.MeshLambertMaterial[] = [];
  private geometries: THREE.BufferGeometry[] = [];

  private readonly lastNear = new THREE.Vector3(Infinity, 0, Infinity);
  private readonly lastFar = new THREE.Vector3(Infinity, 0, Infinity);
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scaleVector = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3(0, 1, 0);

  private treeTotal = 0;

  /**
   * @param roads сеть дорог: вдоль тракта лес расступается. Может отсутствовать —
   *              тогда деревья растут везде, где позволяет рельеф.
   */
  constructor(
    private readonly terrain: Terrain,
    private readonly seed: number,
    private readonly roads?: { distanceTo(x: number, z: number, limit?: number): number },
  ) {
    this.group.name = 'forest';
    this.scatter();
  }

  get totalTrees(): number {
    return this.treeTotal;
  }

  /** Расставить деревья по всему миру. Один проход при загрузке. */
  private scatter(): void {
    for (let cz = 0; cz < CHUNKS_PER_SIDE; cz++) {
      for (let cx = 0; cx < CHUNKS_PER_SIDE; cx++) {
        const chunk = this.scatterChunk(cx, cz);
        this.chunks.push(chunk);
        this.treeTotal += chunk.count;
      }
    }
  }

  private scatterChunk(cx: number, cz: number): ForestChunk {
    const originX = cx * FOREST_CHUNK - WORLD_HALF;
    const originZ = cz * FOREST_CHUNK - WORLD_HALF;
    const rng = new Rng(this.seed + cx * 73856093 + cz * 19349663);

    const maxTrees = CELLS_PER_CHUNK * CELLS_PER_CHUNK;
    const x = new Float32Array(maxTrees);
    const y = new Float32Array(maxTrees);
    const z = new Float32Array(maxTrees);
    const scale = new Float32Array(maxTrees);
    const rotation = new Float32Array(maxTrees);
    const species = new Uint8Array(maxTrees);
    const variant = new Uint8Array(maxTrees);

    const speciesWeights = new Array<number>(SPECIES_COUNT).fill(0);
    let count = 0;

    for (let j = 0; j < CELLS_PER_CHUNK; j++) {
      for (let i = 0; i < CELLS_PER_CHUNK; i++) {
        const px = originX + (i + rng.next()) * SCATTER_STEP;
        const pz = originZ + (j + rng.next()) * SCATTER_STEP;

        const density = forestDensityAt(px, pz);
        // Вероятность занять клетку: плотность (деревьев на гектар) на площадь клетки.
        if (!rng.chance((density * SCATTER_STEP * SCATTER_STEP) / 10000)) continue;

        const height = this.terrain.heightAt(px, pz);
        if (height < WATER_LEVEL + 0.6) continue;
        if (height > TREE_LINE) continue;
        if (this.terrain.slopeAt(px, pz) > MAX_SLOPE) continue;
        if (this.insideClearing(px, pz)) continue;
        // Обочина тракта: дорогу не должно затягивать подлеском.
        if (this.roads && this.roads.distanceTo(px, pz, ROAD_CLEARANCE) < ROAD_CLEARANCE) continue;

        const weights = zoneWeights(px, pz);
        for (let s = 0; s < SPECIES_COUNT; s++) {
          const speciesWeightsByZone = TREE_SPECIES[s].weights;
          speciesWeights[s] =
            weights[0] * speciesWeightsByZone[0] +
            weights[1] * speciesWeightsByZone[1] +
            weights[2] * speciesWeightsByZone[2] +
            weights[3] * speciesWeightsByZone[3];
        }

        const chosen = rng.pickWeighted(TREE_SPECIES, speciesWeights);
        const [minScale, maxScale] = chosen.scaleRange;

        x[count] = px;
        y[count] = height - 0.2;
        z[count] = pz;
        scale[count] = rng.range(minScale, maxScale);
        rotation[count] = rng.range(0, Math.PI * 2);
        species[count] = chosen.id;
        variant[count] = rng.int(0, VARIANTS - 1);
        count++;
      }
    }

    return {
      cx,
      cz,
      centerX: originX + FOREST_CHUNK / 2,
      centerZ: originZ + FOREST_CHUNK / 2,
      count,
      x: x.subarray(0, count),
      y: y.subarray(0, count),
      z: z.subarray(0, count),
      scale: scale.subarray(0, count),
      rotation: rotation.subarray(0, count),
      species: species.subarray(0, count),
      variant: variant.subarray(0, count),
    };
  }

  /** Поляны поселений: там деревьев нет, там будут дома. */
  private insideClearing(x: number, z: number): boolean {
    for (const site of SITES) {
      if (distance2D(x, z, site.x, site.z) < site.radius * 0.9) return true;
    }
    return false;
  }

  /**
   * Построить меши. Требует готовый рендерер: атлас импосторов запекается на
   * видеокарте.
   */
  build(renderer: THREE.WebGLRenderer): void {
    const lod0Variants = buildSpeciesVariants(this.seed ^ 0x5eed, 0, VARIANTS);
    const lod1Variants = buildSpeciesVariants(this.seed ^ 0x5eed, 1, VARIANTS);

    // Импосторы печатаем с первого варианта каждой породы: на 165 метрах разницу
    // между вариантами уже не различить.
    this.atlas = bakeImpostorAtlas(
      renderer,
      lod0Variants.map((variants) => variants[0]),
      { tile: 192, angles: 8 },
    );

    // Ближний уровень гаснет обычной выборкой, средний — обратной, дальние
    // картинки снова обычной: соседи всегда дополняют друг друга до целого.
    const lod0Material = createTreeMaterial(
      new THREE.Vector2(0, 0),
      new THREE.Vector2(LOD0_END - FADE_BAND, LOD0_END),
      false,
    );
    const lod1Material = createTreeMaterial(
      new THREE.Vector2(LOD0_END - FADE_BAND, LOD0_END),
      new THREE.Vector2(LOD1_END - FADE_BAND, LOD1_END),
      true,
    );
    this.materials.push(lod0Material, lod1Material);

    for (let s = 0; s < SPECIES_COUNT; s++) {
      this.lod0.push([]);
      this.lod1.push([]);
      this.lod0Counts.push(new Array<number>(VARIANTS).fill(0));
      this.lod1Counts.push(new Array<number>(VARIANTS).fill(0));

      for (let v = 0; v < VARIANTS; v++) {
        const near = new THREE.InstancedMesh(lod0Variants[s][v], lod0Material, LOD0_CAPACITY);
        near.name = `tree-lod0-${s}-${v}`;
        near.frustumCulled = false;
        near.count = 0;
        near.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.lod0[s].push(near);
        this.group.add(near);
        this.geometries.push(lod0Variants[s][v]);

        const mid = new THREE.InstancedMesh(lod1Variants[s][v], lod1Material, LOD1_CAPACITY);
        mid.name = `tree-lod1-${s}-${v}`;
        mid.frustumCulled = false;
        mid.count = 0;
        mid.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.lod1[s].push(mid);
        this.group.add(mid);
        this.geometries.push(lod1Variants[s][v]);
      }
    }

    this.impostors = new ImpostorField(this.atlas, IMPOSTOR_CAPACITY);
    this.impostors.setFade(LOD1_END - FADE_BAND, LOD1_END);
    this.impostors.setFadeOut(FAR_END - 90, FAR_END);
    this.group.add(this.impostors.mesh);
  }

  /** Пересобрать буферы, если камера уехала достаточно далеко. */
  update(cameraPosition: THREE.Vector3, force = false): void {
    if (force || this.lastNear.distanceTo(cameraPosition) > NEAR_REBUILD_DISTANCE) {
      this.rebuildNear(cameraPosition);
      this.lastNear.copy(cameraPosition);
    }
    if (force || this.lastFar.distanceTo(cameraPosition) > FAR_REBUILD_DISTANCE) {
      this.rebuildFar(cameraPosition);
      this.lastFar.copy(cameraPosition);
    }
  }

  private rebuildNear(camera: THREE.Vector3): void {
    for (let s = 0; s < SPECIES_COUNT; s++) {
      this.lod0Counts[s].fill(0);
      this.lod1Counts[s].fill(0);
    }

    const collectRadius = LOD1_END + NEAR_REBUILD_DISTANCE + 6;
    const lod0Limit = LOD0_END + NEAR_REBUILD_DISTANCE;
    const lod1Start = LOD0_END - FADE_BAND - NEAR_REBUILD_DISTANCE;

    for (const chunk of this.chunks) {
      if (chunk.count === 0) continue;
      const chunkDistance = distance2D(camera.x, camera.z, chunk.centerX, chunk.centerZ) - CHUNK_DIAGONAL;
      if (chunkDistance > collectRadius) continue;

      for (let i = 0; i < chunk.count; i++) {
        const d = distance2D(camera.x, camera.z, chunk.x[i], chunk.z[i]);
        if (d > collectRadius) continue;

        const species = chunk.species[i];
        const variant = chunk.variant[i];

        if (d <= lod0Limit) {
          const count = this.lod0Counts[species][variant];
          if (count < LOD0_CAPACITY) {
            this.writeMatrix(chunk, i);
            this.lod0[species][variant].setMatrixAt(count, this.matrix);
            this.lod0Counts[species][variant] = count + 1;
          }
        }

        if (d >= lod1Start) {
          const count = this.lod1Counts[species][variant];
          if (count < LOD1_CAPACITY) {
            this.writeMatrix(chunk, i);
            this.lod1[species][variant].setMatrixAt(count, this.matrix);
            this.lod1Counts[species][variant] = count + 1;
          }
        }
      }
    }

    for (let s = 0; s < SPECIES_COUNT; s++) {
      for (let v = 0; v < VARIANTS; v++) {
        const near = this.lod0[s][v];
        near.count = this.lod0Counts[s][v];
        near.instanceMatrix.needsUpdate = true;

        const mid = this.lod1[s][v];
        mid.count = this.lod1Counts[s][v];
        mid.instanceMatrix.needsUpdate = true;
      }
    }
  }

  private rebuildFar(camera: THREE.Vector3): void {
    this.impostors.begin();

    const collectRadius = FAR_END + FAR_REBUILD_DISTANCE + 10;
    const start = LOD1_END - FADE_BAND - FAR_REBUILD_DISTANCE - 10;

    for (const chunk of this.chunks) {
      if (chunk.count === 0) continue;
      const chunkDistance = distance2D(camera.x, camera.z, chunk.centerX, chunk.centerZ);
      if (chunkDistance - CHUNK_DIAGONAL > collectRadius) continue;
      if (chunkDistance + CHUNK_DIAGONAL < start) continue;

      for (let i = 0; i < chunk.count; i++) {
        const d = distance2D(camera.x, camera.z, chunk.x[i], chunk.z[i]);
        if (d < start || d > collectRadius) continue;
        this.impostors.push(chunk.x[i], chunk.y[i], chunk.z[i], chunk.scale[i], chunk.rotation[i], chunk.species[i]);
      }
    }

    this.impostors.end();
  }

  private writeMatrix(chunk: ForestChunk, index: number): void {
    this.position.set(chunk.x[index], chunk.y[index], chunk.z[index]);
    this.quaternion.setFromAxisAngle(this.axisY, chunk.rotation[index]);
    this.scaleVector.setScalar(chunk.scale[index]);
    this.matrix.compose(this.position, this.quaternion, this.scaleVector);
  }

  /** Стволы рядом с точкой — для столкновений и для проверки укрытия. */
  queryTrees(x: number, z: number, radius: number, out: TreeHit[]): TreeHit[] {
    out.length = 0;
    const minCx = Math.max(0, Math.floor((x - radius + WORLD_HALF) / FOREST_CHUNK));
    const maxCx = Math.min(CHUNKS_PER_SIDE - 1, Math.floor((x + radius + WORLD_HALF) / FOREST_CHUNK));
    const minCz = Math.max(0, Math.floor((z - radius + WORLD_HALF) / FOREST_CHUNK));
    const maxCz = Math.min(CHUNKS_PER_SIDE - 1, Math.floor((z + radius + WORLD_HALF) / FOREST_CHUNK));

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const chunk = this.chunks[cz * CHUNKS_PER_SIDE + cx];
        if (!chunk || chunk.count === 0) continue;

        for (let i = 0; i < chunk.count; i++) {
          const trunkRadius = TREE_SPECIES[chunk.species[i]].collisionRadius * chunk.scale[i];
          if (trunkRadius <= 0) continue;
          if (distance2D(x, z, chunk.x[i], chunk.z[i]) > radius + trunkRadius) continue;
          out.push({ x: chunk.x[i], z: chunk.z[i], radius: trunkRadius });
        }
      }
    }
    return out;
  }

  /** Насколько густо вокруг точки — эльфу это даёт укрытие. */
  coverAt(x: number, z: number, radius = 12): number {
    let count = 0;
    const minCx = Math.max(0, Math.floor((x - radius + WORLD_HALF) / FOREST_CHUNK));
    const maxCx = Math.min(CHUNKS_PER_SIDE - 1, Math.floor((x + radius + WORLD_HALF) / FOREST_CHUNK));
    const minCz = Math.max(0, Math.floor((z - radius + WORLD_HALF) / FOREST_CHUNK));
    const maxCz = Math.min(CHUNKS_PER_SIDE - 1, Math.floor((z + radius + WORLD_HALF) / FOREST_CHUNK));

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const chunk = this.chunks[cz * CHUNKS_PER_SIDE + cx];
        if (!chunk) continue;
        for (let i = 0; i < chunk.count; i++) {
          if (distance2D(x, z, chunk.x[i], chunk.z[i]) <= radius) count++;
        }
      }
    }

    // Полтора десятка стволов в радиусе 12 метров — это уже стена зелени.
    return Math.min(1, count / 15);
  }

  /** Синхронизировать туман и общий тон дальнего леса с небом. */
  syncAtmosphere(fogColor: THREE.Color, fogNear: number, fogFar: number, tint: THREE.Color): void {
    this.impostors.setFog(fogColor, fogNear, fogFar);
    this.impostors.setTint(tint);
  }

  /** Счётчики для отладочной панели. */
  stats(): { lod0: number; lod1: number; impostors: number; total: number } {
    let lod0 = 0;
    let lod1 = 0;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      for (let v = 0; v < VARIANTS; v++) {
        lod0 += this.lod0Counts[s][v];
        lod1 += this.lod1Counts[s][v];
      }
    }
    return { lod0, lod1, impostors: this.impostors?.count ?? 0, total: this.treeTotal };
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.impostors?.dispose();
    this.atlas?.dispose();
  }
}
