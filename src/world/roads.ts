import { valueNoise2d } from '../core/rng';
import { distance2D, smoothstep } from '../core/math';
import { Terrain, WATER_LEVEL } from './terrain';
import { WORLD_HALF } from './zones';
import { SITES, getSite, type Site } from './sites';

/** Половина ширины накатанной части тракта, метры. */
const ROAD_HALF_WIDTH = 3.4;
/** Обочина, на которой рельеф возвращается к своему. */
const ROAD_SHOULDER = 5.5;
/** Через сколько метров ставится очередная точка ломаной. */
const ROAD_STEP = 12;
/** Клетка индекса для быстрых запросов расстояния до дороги. */
const GRID_CELL = 32;

export interface RoadPoint {
  x: number;
  z: number;
  y: number;
}

export interface Road {
  id: string;
  from: string;
  to: string;
  points: RoadPoint[];
  length: number;
}

interface RoadLink {
  to: string;
  road: Road;
  reversed: boolean;
}

/** Какие узлы соединены дорогами. */
const ROAD_EDGES: readonly [string, string][] = [
  ['village', 'crossroads-east'],
  ['crossroads-east', 'barracks'],
  ['barracks', 'palace'],
  ['village', 'crossroads-west'],
  ['crossroads-west', 'forest-gate'],
  ['forest-gate', 'glade'],
  ['crossroads-east', 'mountain-pass'],
  ['mountain-pass', 'fort'],
  ['forest-gate', 'partisan-camp'],
];

/**
 * Сеть дорог: по ним ходят корованы, по ним же удобнее всего ездить в коляске.
 *
 * Дорога не просто рисуется поверх холмов — она срезает рельеф под себя,
 * поэтому нигде не превращается в отвесный подъём. Заодно вдоль полотна не
 * растут деревья: лес расступается перед трактом.
 */
export class RoadNetwork {
  readonly roads: Road[] = [];

  private readonly links = new Map<string, RoadLink[]>();
  private readonly grid = new Map<number, number[]>();
  private readonly segments: { ax: number; az: number; bx: number; bz: number }[] = [];

  constructor(terrain: Terrain) {
    for (const [fromId, toId] of ROAD_EDGES) {
      const from = getSite(fromId);
      const to = getSite(toId);
      const road: Road = {
        id: `${fromId}→${toId}`,
        from: fromId,
        to: toId,
        points: buildRoadPoints(terrain, from, to),
        length: 0,
      };
      road.length = pathLength(road.points);
      this.roads.push(road);

      this.link(fromId, { to: toId, road, reversed: false });
      this.link(toId, { to: fromId, road, reversed: true });
    }

    this.buildIndex();
  }

  private link(siteId: string, entry: RoadLink): void {
    const list = this.links.get(siteId);
    if (list) list.push(entry);
    else this.links.set(siteId, [entry]);
  }

  private buildIndex(): void {
    for (const road of this.roads) {
      for (let i = 0; i < road.points.length - 1; i++) {
        const a = road.points[i];
        const b = road.points[i + 1];
        const index = this.segments.length;
        this.segments.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z });

        // Отрезок попадает во все клетки, которые задевает его габаритный
        // прямоугольник, расширенный на ширину полотна.
        const reach = ROAD_HALF_WIDTH + ROAD_SHOULDER;
        const minCx = Math.floor((Math.min(a.x, b.x) - reach + WORLD_HALF) / GRID_CELL);
        const maxCx = Math.floor((Math.max(a.x, b.x) + reach + WORLD_HALF) / GRID_CELL);
        const minCz = Math.floor((Math.min(a.z, b.z) - reach + WORLD_HALF) / GRID_CELL);
        const maxCz = Math.floor((Math.max(a.z, b.z) + reach + WORLD_HALF) / GRID_CELL);

        for (let cx = minCx; cx <= maxCx; cx++) {
          for (let cz = minCz; cz <= maxCz; cz++) {
            const key = cx * 4096 + cz;
            const bucket = this.grid.get(key);
            if (bucket) bucket.push(index);
            else this.grid.set(key, [index]);
          }
        }
      }
    }
  }

  /** Прорезать все дороги в рельефе. Вызывать до terrain.build(). */
  carveInto(terrain: Terrain): void {
    for (const road of this.roads) {
      terrain.carvePath(road.points, ROAD_HALF_WIDTH, ROAD_SHOULDER);
    }
  }

  /**
   * Расстояние до ближайшей дороги. Возвращает `limit`, если дорог рядом нет, —
   * так вызывающему не нужно отдельно проверять «не найдено».
   */
  distanceTo(x: number, z: number, limit = 60): number {
    const cx = Math.floor((x + WORLD_HALF) / GRID_CELL);
    const cz = Math.floor((z + WORLD_HALF) / GRID_CELL);
    let best = limit;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = this.grid.get((cx + dx) * 4096 + (cz + dz));
        if (!bucket) continue;

        for (const index of bucket) {
          const segment = this.segments[index];
          const distance = distanceToSegment(x, z, segment.ax, segment.az, segment.bx, segment.bz);
          if (distance < best) best = distance;
        }
      }
    }

    return best;
  }

  /** Насколько точка «на дороге»: 1 — по колее, 0 — целина. */
  maskAt(x: number, z: number): number {
    const distance = this.distanceTo(x, z, ROAD_HALF_WIDTH + ROAD_SHOULDER + 1);
    return 1 - smoothstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + ROAD_SHOULDER, distance);
  }

  /** Идёт ли игрок по дороге — от этого зависит скорость коляски. */
  isOnRoad(x: number, z: number): boolean {
    return this.distanceTo(x, z, ROAD_HALF_WIDTH + 2) <= ROAD_HALF_WIDTH + 1;
  }

  /**
   * Маршрут между узлами: последовательность точек, по которым поедет корован.
   * Обычный поиск в ширину по графу — узлов меньше десятка, ничего умнее не нужно.
   */
  routeBetween(fromSiteId: string, toSiteId: string): RoadPoint[] {
    const hops = this.findHops(fromSiteId, toSiteId);
    if (!hops) return [];

    const points: RoadPoint[] = [];
    for (const hop of hops) {
      const segment = hop.reversed ? [...hop.road.points].reverse() : hop.road.points;
      // Стык двух рёбер — одна и та же точка, второй раз её не добавляем.
      const start = points.length > 0 ? 1 : 0;
      for (let i = start; i < segment.length; i++) points.push(segment[i]);
    }
    return points;
  }

  /** Список рёбер кратчайшего пути или null, если узлы не связаны. */
  private findHops(fromSiteId: string, toSiteId: string): RoadLink[] | null {
    if (fromSiteId === toSiteId) return [];

    const queue: string[] = [fromSiteId];
    const cameFrom = new Map<string, RoadLink>();
    const visited = new Set<string>([fromSiteId]);

    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current === toSiteId) break;

      for (const link of this.links.get(current) ?? []) {
        if (visited.has(link.to)) continue;
        visited.add(link.to);
        cameFrom.set(link.to, link);
        queue.push(link.to);
      }
    }

    if (!visited.has(toSiteId)) return null;

    const hops: RoadLink[] = [];
    let node = toSiteId;
    while (node !== fromSiteId) {
      const link = cameFrom.get(node);
      if (!link) return null;
      hops.unshift(link);
      // Ребро вело сюда, значит пришли из его другого конца.
      node = link.reversed ? link.road.to : link.road.from;
    }
    return hops;
  }

  /** Все узлы, до которых есть дорога. */
  get connectedSites(): string[] {
    return [...this.links.keys()];
  }
}

/**
 * Построить ломаную между двумя точками мира.
 * Дорога слегка изгибается: идеально прямой тракт через лес выглядит чертежом,
 * а не дорогой.
 */
function buildRoadPoints(terrain: Terrain, from: Site, to: Site): RoadPoint[] {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  const steps = Math.max(4, Math.round(length / ROAD_STEP));

  const normalX = -dz / length;
  const normalZ = dx / length;
  const points: RoadPoint[] = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Изгиб гасится к концам, чтобы дорога точно приходила в поселение.
    const wobble = (valueNoise2d(t * 3.1, from.x * 0.01 + to.z * 0.01, 8123) - 0.5) * 2;
    const bend = Math.sin(t * Math.PI) * wobble * Math.min(70, length * 0.12);

    const x = from.x + dx * t + normalX * bend;
    const z = from.z + dz * t + normalZ * bend;
    points.push({ x, z, y: terrain.heightAt(x, z) });
  }

  smoothProfile(points);
  return points;
}

/**
 * Сгладить продольный профиль дороги и поднять её над водой.
 * Без сглаживания тракт повторяет каждую кочку и получается пилой.
 */
function smoothProfile(points: RoadPoint[]): void {
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 1; i < points.length - 1; i++) {
      points[i].y = (points[i - 1].y + points[i].y * 2 + points[i + 1].y) / 4;
    }
  }
  for (const point of points) {
    if (point.y < WATER_LEVEL + 0.7) point.y = WATER_LEVEL + 0.7;
  }
}

function pathLength(points: readonly RoadPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += distance2D(points[i].x, points[i].z, points[i + 1].x, points[i + 1].z);
  }
  return total;
}

function distanceToSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lengthSq = abx * abx + abz * abz;
  if (lengthSq < 1e-9) return Math.hypot(x - ax, z - az);

  let t = ((x - ax) * abx + (z - az) * abz) / lengthSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + abx * t), z - (az + abz * t));
}

/** Узлы, между которыми вообще имеет смысл гонять корованы. */
export const TRADE_HUBS: readonly string[] = SITES.filter((site) =>
  ['village', 'palace', 'glade', 'fort'].includes(site.id),
).map((site) => site.id);
