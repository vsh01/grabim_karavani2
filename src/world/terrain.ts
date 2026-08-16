import * as THREE from 'three';
import { fbm2d, ridgedNoise2d, valueNoise2d } from '../core/rng';
import { clamp, clamp01, smoothstep } from '../core/math';
import { WORLD_HALF, WORLD_SIZE, Zone, zoneWeights } from './zones';
import { SITES } from './sites';

/** Сторона одной клетки высотной карты, метры. */
export const CELL_SIZE = 8;
/** Клеток по стороне мира. */
export const GRID = WORLD_SIZE / CELL_SIZE;
/** Узлов высотной карты по стороне. */
export const VERTS = GRID + 1;
/** Клеток в одном чанке ландшафта (чанк = 128 м). */
export const CHUNK_CELLS = 16;
export const CHUNKS = GRID / CHUNK_CELLS;
/** Уровень воды: всё ниже — река, озеро или болото. */
export const WATER_LEVEL = 2.4;

const COLOR_SAND = new THREE.Color(0x9c8b5e);
const COLOR_GRASS_HUMAN = new THREE.Color(0x6f7f3c);
const COLOR_GRASS_ELF = new THREE.Color(0x35562c);
const COLOR_GRASS_IMPERIAL = new THREE.Color(0x6b7a44);
const COLOR_GRASS_VILLAIN = new THREE.Color(0x5a5240);
const COLOR_ROCK = new THREE.Color(0x5d5952);
const COLOR_SNOW = new THREE.Color(0xd7dde2);
const COLOR_DIRT = new THREE.Color(0x6b5638);

/**
 * Мелкий рельеф, общий для всей карты: бугры, промоины, складки.
 * Без него склоны выглядят надутыми и пластиковыми.
 */
function surfaceDetail(x: number, z: number): number {
  const medium = fbm2d(x * 0.0135, z * 0.0135, { octaves: 3, seed: 99 }) - 0.5;
  const fine = fbm2d(x * 0.045, z * 0.045, { octaves: 2, seed: 98 }) - 0.5;
  return medium * 4.4 + fine * 1.1;
}

function humanHeight(x: number, z: number): number {
  const base = fbm2d(x * 0.0012, z * 0.0012, { octaves: 4, seed: 11 });
  const detail = fbm2d(x * 0.0062, z * 0.0062, { octaves: 3, seed: 12 });
  return 3 + base * 15 + detail * 3;
}

function imperialHeight(x: number, z: number): number {
  const base = fbm2d(x * 0.0014, z * 0.0014, { octaves: 4, seed: 21 });
  const detail = fbm2d(x * 0.0058, z * 0.0058, { octaves: 3, seed: 22 });
  return 20 + base * 20 + detail * 4;
}

function elfHeight(x: number, z: number): number {
  const base = fbm2d(x * 0.0011, z * 0.0011, { octaves: 5, seed: 31 });
  const detail = fbm2d(x * 0.0054, z * 0.0054, { octaves: 3, seed: 32 });
  return 5 + base * 32 + detail * 6;
}

function villainHeight(x: number, z: number): number {
  const ridge = ridgedNoise2d(x * 0.0016, z * 0.0016, { octaves: 6, seed: 41 });
  const base = fbm2d(x * 0.0009, z * 0.0009, { octaves: 3, seed: 42 });
  const mountain = Math.pow(ridge, 1.4) * 128;

  // Гладкий хребет читается как песчаная дюна. Ломаем его двумя сетками скал
  // разного размера — и только на высоте, иначе у подножия идёт мелкая сыпь.
  const highlands = smoothstep(12, 55, mountain);
  const crags = ridgedNoise2d(x * 0.0062, z * 0.0062, { octaves: 3, seed: 43 });
  const shards = ridgedNoise2d(x * 0.0175, z * 0.0175, { octaves: 2, seed: 44 });

  return 14 + base * 28 + mountain + highlands * (crags * crags * 34 + shards * shards * 11);
}

/** Высота до выравнивания площадок — чистый рельеф. */
function baseHeight(x: number, z: number): number {
  const w = zoneWeights(x, z);
  let h =
    w[Zone.Human] * humanHeight(x, z) +
    w[Zone.Imperial] * imperialHeight(x, z) +
    w[Zone.Elf] * elfHeight(x, z) +
    w[Zone.Villain] * villainHeight(x, z);

  h += surfaceDetail(x, z);

  // Границы карты поднимаются горной грядой — мир замкнут без невидимых стен.
  // Гряда начинается далеко от поселений, чтобы не нависать над головой.
  const edge = Math.max(Math.abs(x), Math.abs(z));
  const wall = smoothstep(WORLD_HALF - 190, WORLD_HALF - 10, edge);
  const wallRidge = ridgedNoise2d(x * 0.004, z * 0.004, { octaves: 3, seed: 55 });
  h += wall * wall * (105 + wallRidge * 45);

  return h;
}

export interface TerrainSample {
  height: number;
  /** Наклон: 0 — ровно, 1 — отвесно. */
  slope: number;
}

/**
 * Ландшафт мира: высотная карта, её геометрия и запросы высоты.
 *
 * Высота считается ровно по той же триангуляции, что и у видимого меша, поэтому
 * персонаж стоит точно на поверхности, а не проваливается и не парит.
 */
export class Terrain {
  readonly heights: Float32Array;
  readonly group = new THREE.Group();
  private readonly chunkMeshes: THREE.Mesh[] = [];
  private material!: THREE.MeshLambertMaterial;
  private groundTexture?: THREE.Texture;
  private waterMesh?: THREE.Mesh;

  constructor() {
    this.heights = new Float32Array(VERTS * VERTS);
    this.group.name = 'terrain';
    this.generate();
  }

  private generate(): void {
    const { heights } = this;

    for (let j = 0; j < VERTS; j++) {
      const z = j * CELL_SIZE - WORLD_HALF;
      for (let i = 0; i < VERTS; i++) {
        const x = i * CELL_SIZE - WORLD_HALF;
        heights[j * VERTS + i] = baseHeight(x, z);
      }
    }

    this.flattenSites();
  }

  /**
   * Выравнивание площадок под поселения: сначала считаем среднюю высоту пятна,
   * потом плавно притягиваем к ней рельеф. Дворец не должен стоять на склоне.
   */
  private flattenSites(): void {
    const { heights } = this;

    for (const site of SITES) {
      const target = this.averageHeightIn(site.x, site.z, site.radius * 0.55);
      const outer = site.radius * 1.9;

      const minI = Math.max(0, Math.floor((site.x - outer + WORLD_HALF) / CELL_SIZE));
      const maxI = Math.min(VERTS - 1, Math.ceil((site.x + outer + WORLD_HALF) / CELL_SIZE));
      const minJ = Math.max(0, Math.floor((site.z - outer + WORLD_HALF) / CELL_SIZE));
      const maxJ = Math.min(VERTS - 1, Math.ceil((site.z + outer + WORLD_HALF) / CELL_SIZE));

      for (let j = minJ; j <= maxJ; j++) {
        const z = j * CELL_SIZE - WORLD_HALF;
        for (let i = minI; i <= maxI; i++) {
          const x = i * CELL_SIZE - WORLD_HALF;
          const d = Math.hypot(x - site.x, z - site.z);
          if (d > outer) continue;

          // Внутри radius — полная сила, дальше плавно сходит на нет.
          const strength = site.flatten * (1 - smoothstep(site.radius, outer, d));
          if (strength <= 0) continue;

          const index = j * VERTS + i;
          heights[index] += (target - heights[index]) * strength;
        }
      }
    }
  }

  private averageHeightIn(cx: number, cz: number, radius: number): number {
    let sum = 0;
    let count = 0;
    const step = CELL_SIZE;
    for (let z = cz - radius; z <= cz + radius; z += step) {
      for (let x = cx - radius; x <= cx + radius; x += step) {
        if (Math.hypot(x - cx, z - cz) > radius) continue;
        sum += this.rawHeightAt(x, z);
        count++;
      }
    }
    return count > 0 ? sum / count : this.rawHeightAt(cx, cz);
  }

  /** Высота по сырой формуле, без учёта уже применённого выравнивания. */
  private rawHeightAt(x: number, z: number): number {
    return baseHeight(x, z);
  }

  /** Значение из высотной карты по индексам узла. */
  private node(i: number, j: number): number {
    const ci = clamp(i, 0, VERTS - 1) | 0;
    const cj = clamp(j, 0, VERTS - 1) | 0;
    return this.heights[cj * VERTS + ci];
  }

  /**
   * Высота поверхности в мировой точке.
   * Интерполяция идёт по треугольнику, а не по квадрату, — ровно так же, как
   * разбит видимый меш, поэтому расхождения с картинкой нет вообще.
   */
  heightAt(x: number, z: number): number {
    const gx = clamp((x + WORLD_HALF) / CELL_SIZE, 0, GRID);
    const gz = clamp((z + WORLD_HALF) / CELL_SIZE, 0, GRID);

    const i = Math.min(GRID - 1, Math.floor(gx));
    const j = Math.min(GRID - 1, Math.floor(gz));
    const fx = gx - i;
    const fz = gz - j;

    const h00 = this.node(i, j);
    const h10 = this.node(i + 1, j);
    const h01 = this.node(i, j + 1);
    const h11 = this.node(i + 1, j + 1);

    if (fx + fz < 1) {
      return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    }
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** Нормаль поверхности — нужна для уклонов, скольжения и расстановки объектов. */
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const d = CELL_SIZE * 0.5;
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    return out.set(-hx, 2 * d, -hz).normalize();
  }

  /** Уклон в точке: 0 — горизонталь, 1 — отвесная стена. */
  slopeAt(x: number, z: number): number {
    const n = this.normalAt(x, z, _slopeVec);
    return clamp01(1 - n.y);
  }

  sample(x: number, z: number): TerrainSample {
    return { height: this.heightAt(x, z), slope: this.slopeAt(x, z) };
  }

  /** Цвет поверхности в узле — по высоте, уклону и зоне. */
  private vertexColor(x: number, z: number, height: number, slope: number, out: THREE.Color): THREE.Color {
    const w = zoneWeights(x, z);
    const wh = w[Zone.Human];
    const wi = w[Zone.Imperial];
    const we = w[Zone.Elf];
    const wv = w[Zone.Villain];

    // Смешиваем травы соседних зон — на границе леса эльфов и полей людей
    // получается плавный переход, а не шов.
    out.setRGB(
      COLOR_GRASS_HUMAN.r * wh + COLOR_GRASS_IMPERIAL.r * wi + COLOR_GRASS_ELF.r * we + COLOR_GRASS_VILLAIN.r * wv,
      COLOR_GRASS_HUMAN.g * wh + COLOR_GRASS_IMPERIAL.g * wi + COLOR_GRASS_ELF.g * we + COLOR_GRASS_VILLAIN.g * wv,
      COLOR_GRASS_HUMAN.b * wh + COLOR_GRASS_IMPERIAL.b * wi + COLOR_GRASS_ELF.b * we + COLOR_GRASS_VILLAIN.b * wv,
    );

    // Пятна земли, чтобы трава не была однотонной простынёй.
    const patch = fbm2d(x * 0.02, z * 0.02, { octaves: 2, seed: 77 });
    out.lerp(COLOR_DIRT, smoothstep(0.55, 0.85, patch) * 0.35);

    // Камень на крутых склонах и в высокогорье.
    const rocky = Math.max(smoothstep(0.2, 0.5, slope), smoothstep(70, 118, height) * 0.85);
    out.lerp(COLOR_ROCK, rocky);

    // Песок у воды.
    out.lerp(COLOR_SAND, 1 - smoothstep(WATER_LEVEL - 0.5, WATER_LEVEL + 3.5, height));

    // Снег только на вершинах и только там, где он удержится: на отвесных
    // скалах его сдувает. Линию снега слегка колышем шумом, иначе она читается
    // как ровная горизонталь на всех горах разом.
    const snowLine = 138 + (fbm2d(x * 0.004, z * 0.004, { octaves: 2, seed: 66 }) - 0.5) * 26;
    const snow = smoothstep(snowLine, snowLine + 34, height) * (1 - smoothstep(0.42, 0.68, slope));
    out.lerp(COLOR_SNOW, snow);

    return out;
  }

  /** Построить видимую геометрию: чанки 128×128 м, каждый — отдельный меш. */
  build(): THREE.Group {
    this.groundTexture = createGroundTexture();
    this.material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      map: this.groundTexture,
    });

    const color = new THREE.Color();

    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const geometry = this.buildChunkGeometry(cx, cz, color);
        const mesh = new THREE.Mesh(geometry, this.material);
        mesh.name = `terrain-chunk-${cx}-${cz}`;
        mesh.receiveShadow = false;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        this.chunkMeshes.push(mesh);
        this.group.add(mesh);
      }
    }

    this.group.add(this.buildWater());
    return this.group;
  }

  private buildChunkGeometry(cx: number, cz: number, color: THREE.Color): THREE.BufferGeometry {
    const side = CHUNK_CELLS + 1;
    const count = side * side;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const indices = new Uint16Array(CHUNK_CELLS * CHUNK_CELLS * 6);

    const baseI = cx * CHUNK_CELLS;
    const baseJ = cz * CHUNK_CELLS;

    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const gi = baseI + i;
        const gj = baseJ + j;
        const x = gi * CELL_SIZE - WORLD_HALF;
        const z = gj * CELL_SIZE - WORLD_HALF;
        const h = this.node(gi, gj);

        const v = (j * side + i) * 3;
        positions[v] = x;
        positions[v + 1] = h;
        positions[v + 2] = z;

        this.vertexColor(x, z, h, this.slopeAt(x, z), color);
        colors[v] = color.r;
        colors[v + 1] = color.g;
        colors[v + 2] = color.b;

        // Крапчатая текстура земли повторяется каждые 12 метров.
        const t = (j * side + i) * 2;
        uvs[t] = x / 12;
        uvs[t + 1] = z / 12;
      }
    }

    // Диагональ квадрата идёт из (i, j+1) в (i+1, j) — то же разбиение,
    // по которому считает heightAt().
    let t = 0;
    for (let j = 0; j < CHUNK_CELLS; j++) {
      for (let i = 0; i < CHUNK_CELLS; i++) {
        const a = j * side + i;
        const b = a + 1;
        const c = a + side;
        const d = c + 1;

        indices[t++] = a;
        indices[t++] = c;
        indices[t++] = b;

        indices[t++] = d;
        indices[t++] = b;
        indices[t++] = c;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private buildWater(): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshLambertMaterial({
      color: 0x2c4a55,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = WATER_LEVEL;
    mesh.name = 'water';
    mesh.renderOrder = 1;
    this.waterMesh = mesh;
    return mesh;
  }

  get water(): THREE.Mesh | undefined {
    return this.waterMesh;
  }

  dispose(): void {
    for (const mesh of this.chunkMeshes) mesh.geometry.dispose();
    this.material?.dispose();
    this.groundTexture?.dispose();
    this.waterMesh?.geometry.dispose();
    (this.waterMesh?.material as THREE.Material | undefined)?.dispose();
  }
}

const _slopeVec = new THREE.Vector3();

/**
 * Крапчатая текстура земли: мелкий шум, который умножается на цвет вершин.
 * Без неё трава вблизи выглядит залитой одной краской. Рисуем прямо в холсте —
 * никаких файлов картинок в проекте нет.
 */
function createGroundTexture(size = 256): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return new THREE.Texture();

  const image = context.createImageData(size, size);
  const data = image.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Два слоя шума: крупная рябь и мелкое зерно.
      const coarse = valueNoise2d(x * 0.06, y * 0.06, 321);
      const fine = valueNoise2d(x * 0.28, y * 0.28, 654);
      const value = clamp(240 + (coarse - 0.5) * 34 + (fine - 0.5) * 16, 0, 255);
      const index = (y * size + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.name = 'ground-detail';
  return texture;
}
