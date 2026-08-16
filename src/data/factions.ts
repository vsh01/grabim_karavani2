/** Стороны конфликта. За три из них можно играть, четвёртая — мирные люди. */
export enum Faction {
  /** Лесные эльфы: партизаны, засады, густой лес. */
  Elves = 'elves',
  /** Охрана дворца: приказы командира, патрули, сопровождение корованов. */
  Palace = 'palace',
  /** Злодей и его банда: сам себе командир. */
  Villain = 'villain',
  /** Люди: торговцы, крестьяне, погонщики корованов. Ни с кем не воюют. */
  Neutral = 'neutral',
}

export const PLAYABLE_FACTIONS: readonly Faction[] = [Faction.Elves, Faction.Palace, Faction.Villain];
export const ALL_FACTIONS: readonly Faction[] = [Faction.Elves, Faction.Palace, Faction.Villain, Faction.Neutral];

export interface FactionInfo {
  id: Faction;
  name: string;
  /** Как называют одного её представителя. */
  member: string;
  description: string;
  /** Основной цвет одежды и знамён. */
  color: number;
  accent: number;
  /** Цвет кожи по умолчанию. */
  skin: number;
}

export const FACTIONS: Record<Faction, FactionInfo> = {
  [Faction.Elves]: {
    id: Faction.Elves,
    name: 'Лесные эльфы',
    member: 'эльф',
    description: 'Живут в деревянных домиках среди густого леса. Бьют из засад и уходят в чащу.',
    color: 0x35603a,
    accent: 0xa8c66c,
    skin: 0xe4c9a8,
  },
  [Faction.Palace]: {
    id: Faction.Palace,
    name: 'Охрана дворца',
    member: 'стражник',
    description: 'Служат императору. Держат патрули, водят корованы и ходят в набеги по приказу.',
    color: 0x2f3f7a,
    accent: 0xd9b45a,
    skin: 0xd9b48c,
  },
  [Faction.Villain]: {
    id: Faction.Villain,
    name: 'Злодей и его люди',
    member: 'разбойник',
    description: 'Засели в старом форте в горах. Никому не подчиняются и берут что хотят.',
    color: 0x4a2330,
    accent: 0x8d2323,
    skin: 0xc9a884,
  },
  [Faction.Neutral]: {
    id: Faction.Neutral,
    name: 'Люди',
    member: 'человек',
    description: 'Крестьяне, торговцы и погонщики. Воевать не хотят, но корованы водят исправно.',
    color: 0x7a6242,
    accent: 0xc4a86a,
    skin: 0xe0bd95,
  },
};

/**
 * Базовая вражда между сторонами: 1 — воюют, 0 — не трогают друг друга.
 * Поверх этого лежит репутация игрока, которая может всё перевернуть.
 */
const BASE_HOSTILITY: Record<Faction, Record<Faction, number>> = {
  [Faction.Elves]: {
    [Faction.Elves]: 0,
    [Faction.Palace]: 1,
    [Faction.Villain]: 1,
    [Faction.Neutral]: 0.15,
  },
  [Faction.Palace]: {
    [Faction.Elves]: 1,
    [Faction.Palace]: 0,
    [Faction.Villain]: 1,
    [Faction.Neutral]: 0,
  },
  [Faction.Villain]: {
    [Faction.Elves]: 0.8,
    [Faction.Palace]: 1,
    [Faction.Villain]: 0,
    [Faction.Neutral]: 0.9,
  },
  [Faction.Neutral]: {
    [Faction.Elves]: 0.15,
    [Faction.Palace]: 0,
    [Faction.Villain]: 0.9,
    [Faction.Neutral]: 0,
  },
};

/** Насколько сторона `a` враждебна стороне `b`: от 0 до 1. */
export function baseHostility(a: Faction, b: Faction): number {
  return BASE_HOSTILITY[a][b];
}

export function factionInfo(faction: Faction): FactionInfo {
  return FACTIONS[faction];
}
