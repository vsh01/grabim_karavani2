import * as THREE from 'three';
import { Actor, type ActorOptions } from '../entities/actor';
import { createSeveredLimb } from '../entities/humanoid';
import type { BodyPart } from '../entities/body';
import { Faction } from '../data/factions';
import { Rng } from '../core/rng';
import { distance2D } from '../core/math';
import type { Terrain } from '../world/terrain';
import type { Forest } from '../world/forest';
import { SITES } from '../world/sites';
import { WATER_LEVEL } from '../world/terrain';
import type { AiWorld } from './ai';
import { updateActorAi } from './ai';

/** Дальше этого расстояния модель не рисуется. */
const RENDER_DISTANCE = 175;
/** Дальше этого расстояния разум обновляется реже — раз в несколько кадров. */
const FULL_AI_DISTANCE = 90;
/** Сколько трупов одновременно лежит в мире. */
const MAX_CORPSES = 26;
/** Через сколько секунд труп убирается, если их накопилось слишком много. */
const CORPSE_LIFETIME = 300;

interface SeveredLimb {
  mesh: THREE.Mesh;
  age: number;
}

/**
 * Население мира: живые персонажи, трупы и отрубленные конечности.
 *
 * Здесь же живёт вся экономия: далёкие персонажи не рисуются, а их разум
 * обновляется реже. Без этого сорок стражников в кадре съедают всё время.
 */
export class Population {
  readonly group = new THREE.Group();
  readonly actors: Actor[] = [];

  private readonly limbs: SeveredLimb[] = [];
  private frame = 0;

  constructor(private readonly terrain: Terrain) {
    this.group.name = 'population';
  }

  spawn(options: ActorOptions): Actor {
    const actor = new Actor(options, this.terrain);
    this.actors.push(actor);
    this.group.add(actor.model.root);
    return actor;
  }

  /** Живые персонажи указанной стороны. */
  membersOf(faction: Faction): Actor[] {
    return this.actors.filter((actor) => actor.alive && actor.faction === faction);
  }

  get aliveCount(): number {
    let count = 0;
    for (const actor of this.actors) if (actor.alive) count++;
    return count;
  }

  get corpseCount(): number {
    let count = 0;
    for (const actor of this.actors) if (!actor.alive) count++;
    return count;
  }

  /** Ближайший персонаж в радиусе — для обыска трупов и разговоров. */
  nearest(x: number, z: number, radius: number, filter?: (actor: Actor) => boolean): Actor | null {
    let best: Actor | null = null;
    let bestDistance = radius;

    for (const actor of this.actors) {
      if (filter && !filter(actor)) continue;
      const distance = distance2D(x, z, actor.position.x, actor.position.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = actor;
      }
    }
    return best;
  }

  /** Бросить отрубленную конечность на землю рядом с местом удара. */
  dropLimb(actor: Actor, part: BodyPart, x: number, y: number, z: number): void {
    const source = actor.model.severPart(part);
    if (!source) return;

    const limb = createSeveredLimb(source.mesh);
    limb.position.set(x, Math.max(y, this.terrain.heightAt(x, z) + 0.12), z);
    limb.rotation.set(Math.random() * 0.6 - 0.3, Math.random() * Math.PI * 2, Math.PI / 2 + Math.random() * 0.4);
    this.group.add(limb);
    this.limbs.push({ mesh: limb, age: 0 });

    // Конечностей на земле тоже не должно накапливаться бесконечно.
    while (this.limbs.length > 40) {
      const oldest = this.limbs.shift();
      oldest?.mesh.removeFromParent();
    }
  }

  update(dt: number, world: AiWorld, cameraPosition: THREE.Vector3): void {
    this.frame++;

    for (const actor of this.actors) {
      const distance = distance2D(cameraPosition.x, cameraPosition.z, actor.position.x, actor.position.z);

      // Далёкие персонажи не нужны в кадре и не нужны каждый кадр.
      actor.model.root.visible = distance < RENDER_DISTANCE;

      if (actor.alive) {
        if (distance < FULL_AI_DISTANCE || this.frame % 4 === 0) {
          const step = distance < FULL_AI_DISTANCE ? dt : dt * 4;
          updateActorAi(actor, step, world);
        }
      }

      actor.update(dt, { terrain: world.terrain, forest: world.forest, colliders: world.colliders });
    }

    this.updateLimbs(dt);
    this.cullCorpses();
  }

  private updateLimbs(dt: number): void {
    for (const limb of this.limbs) limb.age += dt;
  }

  /** Убрать старые трупы, если их стало слишком много. */
  private cullCorpses(): void {
    if (this.corpseCount <= MAX_CORPSES) return;

    let oldest: Actor | null = null;
    for (const actor of this.actors) {
      if (actor.alive) continue;
      if (actor.corpseAge < CORPSE_LIFETIME * 0.1) continue;
      if (!oldest || actor.corpseAge > oldest.corpseAge) oldest = actor;
    }

    if (oldest) this.remove(oldest);
  }

  remove(actor: Actor): void {
    const index = this.actors.indexOf(actor);
    if (index >= 0) this.actors.splice(index, 1);
    actor.dispose();
  }

  dispose(): void {
    for (const actor of this.actors) actor.dispose();
    this.actors.length = 0;
    for (const limb of this.limbs) limb.mesh.removeFromParent();
    this.limbs.length = 0;
  }
}

interface SquadTemplate {
  siteId: string;
  faction: Faction;
  count: number;
  role: ActorOptions['role'];
  /** Из чего выбирается оружие для бойца. */
  weapons: string[];
  armor?: string;
  /** Радиус, по которому разбросан отряд. */
  radius: number;
  /** Разброс золота в кармане: это же и добыча с трупа. */
  gold: [number, number];
}

const SQUADS: readonly SquadTemplate[] = [
  {
    siteId: 'palace',
    faction: Faction.Palace,
    count: 8,
    role: 'guard',
    weapons: ['sword', 'sword', 'mace'],
    armor: 'mail',
    radius: 62,
    gold: [15, 60],
  },
  {
    siteId: 'barracks',
    faction: Faction.Palace,
    count: 6,
    role: 'patrol',
    weapons: ['sword', 'mace', 'bow'],
    armor: 'leather',
    radius: 40,
    gold: [8, 35],
  },
  {
    siteId: 'glade',
    faction: Faction.Elves,
    count: 7,
    role: 'patrol',
    weapons: ['bow', 'bow', 'dagger', 'sword'],
    armor: 'leather',
    radius: 55,
    gold: [5, 30],
  },
  {
    siteId: 'partisan-camp',
    faction: Faction.Elves,
    count: 6,
    role: 'partisan',
    weapons: ['bow', 'dagger', 'sword'],
    armor: 'leather',
    radius: 38,
    gold: [4, 26],
  },
  {
    siteId: 'fort',
    faction: Faction.Villain,
    count: 9,
    role: 'bandit',
    weapons: ['axe', 'sword', 'mace', 'bow'],
    armor: 'leather',
    radius: 58,
    gold: [12, 70],
  },
  {
    siteId: 'village',
    faction: Faction.Neutral,
    count: 7,
    role: 'civilian',
    weapons: ['fists', 'dagger'],
    radius: 60,
    gold: [3, 22],
  },
];

/**
 * Расселить мир: патрули дворца, эльфы в лесу, банда в форте, мирные в деревне.
 * Расстановка детерминирована — тот же сид даёт тех же людей на тех же местах.
 */
export function populateWorld(population: Population, terrain: Terrain, forest: Forest | undefined, seed: number): void {
  const rng = new Rng(seed ^ 0x1d0c);

  for (const squad of SQUADS) {
    const site = SITES.find((candidate) => candidate.id === squad.siteId);
    if (!site) continue;

    for (let i = 0; i < squad.count; i++) {
      const point = findStandingSpot(terrain, rng, site.x, site.z, squad.radius);
      const actor = population.spawn({
        faction: squad.faction,
        x: point.x,
        z: point.z,
        role: squad.role,
        weapon: rng.pick(squad.weapons),
        armor: squad.armor,
        gold: rng.int(squad.gold[0], squad.gold[1]),
        toughness: rng.range(0.9, 1.15),
      });
      actor.homeRadius = squad.radius * 0.7;
      actor.yaw = rng.range(0, Math.PI * 2);
    }
  }

  void forest;
}

/** Найти место, где можно стоять: не в воде и не на отвесном склоне. */
function findStandingSpot(
  terrain: Terrain,
  rng: Rng,
  centerX: number,
  centerZ: number,
  radius: number,
): { x: number; z: number } {
  for (let attempt = 0; attempt < 24; attempt++) {
    const angle = rng.range(0, Math.PI * 2);
    const distance = radius * Math.sqrt(rng.next());
    const x = centerX + Math.cos(angle) * distance;
    const z = centerZ + Math.sin(angle) * distance;
    if (terrain.heightAt(x, z) < WATER_LEVEL + 0.5) continue;
    if (terrain.slopeAt(x, z) > 0.4) continue;
    return { x, z };
  }
  return { x: centerX, z: centerZ };
}
