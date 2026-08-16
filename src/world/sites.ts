import { Zone } from './zones';

export type SiteKind = 'town' | 'palace' | 'glade' | 'fort' | 'camp' | 'waypoint';

export interface Site {
  id: string;
  name: string;
  zone: Zone;
  kind: SiteKind;
  x: number;
  z: number;
  /** Радиус площадки в метрах — внутри него ландшафт выравнивается под застройку. */
  radius: number;
  /** Сила выравнивания: 1 — идеально ровная площадка, 0 — рельеф как есть. */
  flatten: number;
}

/**
 * Опорные точки мира. Один источник правды: по ним выравнивается ландшафт,
 * ставятся поселения и прокладываются дороги для корованов.
 */
export const SITES: readonly Site[] = [
  {
    id: 'village',
    name: 'Деревня Тихий Брод',
    zone: Zone.Human,
    kind: 'town',
    x: 40,
    z: 470,
    radius: 105,
    flatten: 0.92,
  },
  {
    id: 'palace',
    name: 'Дворец императора',
    zone: Zone.Imperial,
    kind: 'palace',
    x: 610,
    z: -230,
    radius: 145,
    flatten: 0.97,
  },
  {
    id: 'glade',
    name: 'Поляна Долгих Корней',
    zone: Zone.Elf,
    kind: 'glade',
    x: -580,
    z: -40,
    radius: 92,
    flatten: 0.8,
  },
  {
    id: 'fort',
    name: 'Старый форт',
    zone: Zone.Villain,
    kind: 'fort',
    x: 90,
    z: -760,
    radius: 100,
    flatten: 0.95,
  },
  {
    id: 'barracks',
    name: 'Казармы',
    zone: Zone.Imperial,
    kind: 'camp',
    x: 430,
    z: -60,
    radius: 52,
    flatten: 0.88,
  },
  {
    id: 'partisan-camp',
    name: 'Лагерь партизан',
    zone: Zone.Elf,
    kind: 'camp',
    x: -330,
    z: -290,
    radius: 44,
    flatten: 0.72,
  },
  // Развилки: через них идут дороги, поэтому их тоже слегка подравниваем.
  {
    id: 'crossroads-east',
    name: 'Восточная развилка',
    zone: Zone.Human,
    kind: 'waypoint',
    x: 400,
    z: 180,
    radius: 34,
    flatten: 0.7,
  },
  {
    id: 'crossroads-west',
    name: 'Западная развилка',
    zone: Zone.Human,
    kind: 'waypoint',
    x: -280,
    z: 250,
    radius: 34,
    flatten: 0.7,
  },
  {
    id: 'mountain-pass',
    name: 'Горный перевал',
    zone: Zone.Villain,
    kind: 'waypoint',
    x: 260,
    z: -520,
    radius: 46,
    flatten: 0.8,
  },
  {
    id: 'forest-gate',
    name: 'Лесные ворота',
    zone: Zone.Elf,
    kind: 'waypoint',
    x: -290,
    z: 60,
    radius: 34,
    flatten: 0.7,
  },
];

const SITE_BY_ID = new Map<string, Site>(SITES.map((site) => [site.id, site]));

export function getSite(id: string): Site {
  const site = SITE_BY_ID.get(id);
  if (!site) throw new Error(`Неизвестная точка мира: ${id}`);
  return site;
}

export function sitesOfKind(kind: SiteKind): Site[] {
  return SITES.filter((site) => site.kind === kind);
}
