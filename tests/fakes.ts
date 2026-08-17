import type { Actor } from '../src/entities/actor';
import type { Population } from '../src/systems/population';

/**
 * Заглушки для проверок чистой логики.
 *
 * Награда за голову умеет выпускать охотников, а значит, ей нужно население.
 * Настоящее тянет за собой графику и ландшафт, поэтому здесь живут самые
 * простые подделки: у них есть ровно то, чего касается проверяемый код.
 */

export interface FakeActor {
  alive: boolean;
  position: { x: number; y: number; z: number };
  escortAnchor: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => void };
  hasEscortAnchor: boolean;
  huntsPlayer: boolean;
  name: string;
}

export function fakeActor(x = 0, z = 0): FakeActor {
  const anchor = {
    x: 0,
    y: 0,
    z: 0,
    set(nx: number, ny: number, nz: number): void {
      anchor.x = nx;
      anchor.y = ny;
      anchor.z = nz;
    },
  };

  return {
    alive: true,
    position: { x, y: 0, z },
    escortAnchor: anchor,
    hasEscortAnchor: false,
    huntsPlayer: false,
    name: 'подделка',
  };
}

export interface FakePopulation {
  population: Population;
  /** Все, кого успели выпустить: по ним и проверяем, что охота вышла. */
  spawned: FakeActor[];
  removed: FakeActor[];
}

export function fakePopulation(): FakePopulation {
  const spawned: FakeActor[] = [];
  const removed: FakeActor[] = [];

  const population = {
    spawn: (options: { x: number; z: number }): Actor => {
      const actor = fakeActor(options.x, options.z);
      spawned.push(actor);
      return actor as unknown as Actor;
    },
    remove: (actor: Actor): void => {
      removed.push(actor as unknown as FakeActor);
    },
  } as unknown as Population;

  return { population, spawned, removed };
}
