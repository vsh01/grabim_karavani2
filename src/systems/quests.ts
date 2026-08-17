import { Faction } from '../data/factions';
import type { Rng } from '../core/rng';

/** Что именно надо сделать. */
export type ObjectiveKind = 'kill' | 'rob' | 'reach' | 'recruit';

export interface Objective {
  kind: ObjectiveKind;
  /** Кого бить или чей обоз грабить. */
  faction?: Faction;
  /** Куда дойти. */
  siteId?: string;
  count: number;
}

export interface OrderTemplate {
  id: string;
  title: string;
  /** Что говорит командир, выдавая приказ. */
  brief: string;
  objective: Objective;
  gold: number;
  /** Как меняются отношения по выполнении. */
  reputation: [Faction, number][];
}

export interface Order extends OrderTemplate {
  progress: number;
  done: boolean;
}

/**
 * Приказы.
 *
 * За стражу дворца их выдаёт командир, и не выполнять их накладно. За эльфов —
 * старший партизан. А злодей сам себе командир: он берёт приказ у самого себя,
 * где угодно и когда захочет.
 */
const TEMPLATES: Record<Faction, readonly OrderTemplate[]> = {
  [Faction.Palace]: [
    {
      id: 'palace-partisans',
      title: 'Разогнать партизан',
      brief: 'Эльфы обнаглели в лесу. Возьми четверых — и чтобы больше не высовывались.',
      objective: { kind: 'kill', faction: Faction.Elves, count: 4 },
      gold: 130,
      reputation: [
        [Faction.Palace, 12],
        [Faction.Elves, -16],
      ],
    },
    {
      id: 'palace-bandits',
      title: 'Указать разбойникам место',
      brief: 'С гор снова лезут. Трое — и обратно в свой форт, ползком.',
      objective: { kind: 'kill', faction: Faction.Villain, count: 3 },
      gold: 150,
      reputation: [
        [Faction.Palace, 13],
        [Faction.Villain, -18],
      ],
    },
    {
      id: 'palace-patrol',
      title: 'Обойти дозором тракт',
      brief: 'Дойди до восточной развилки и посмотри, спокойно ли на дороге.',
      objective: { kind: 'reach', siteId: 'crossroads-east', count: 1 },
      gold: 65,
      reputation: [[Faction.Palace, 8]],
    },
  ],
  [Faction.Elves]: [
    {
      id: 'elves-caravan',
      title: 'Пощипать обоз императора',
      brief: 'Дворцовый обоз идёт по тракту. Пусть не доедет.',
      objective: { kind: 'rob', faction: Faction.Palace, count: 1 },
      gold: 160,
      reputation: [
        [Faction.Elves, 15],
        [Faction.Palace, -14],
      ],
    },
    {
      id: 'elves-patrol',
      title: 'Проредить патруль',
      brief: 'Стража ходит слишком близко к поляне. Четверо не дойдут обратно.',
      objective: { kind: 'kill', faction: Faction.Palace, count: 4 },
      gold: 140,
      reputation: [
        [Faction.Elves, 14],
        [Faction.Palace, -18],
      ],
    },
    {
      id: 'elves-pass',
      title: 'Проверить горную тропу',
      brief: 'Из гор тянет бедой. Дойди до перевала и посмотри своими глазами.',
      objective: { kind: 'reach', siteId: 'mountain-pass', count: 1 },
      gold: 80,
      reputation: [[Faction.Elves, 9]],
    },
  ],
  [Faction.Villain]: [
    {
      id: 'villain-recruit',
      title: 'Собрать людей',
      brief: 'В одиночку дворец не берут. Найми троих в форте.',
      objective: { kind: 'recruit', count: 3 },
      gold: 0,
      reputation: [[Faction.Villain, 10]],
    },
    {
      id: 'villain-roads',
      title: 'Обчистить тракт',
      brief: 'Пусть дороги станут нашими. Два обоза — и купцы задумаются.',
      objective: { kind: 'rob', count: 2 },
      gold: 220,
      reputation: [
        [Faction.Villain, 15],
        [Faction.Neutral, -14],
      ],
    },
    {
      id: 'villain-palace',
      title: 'Взять дворец',
      brief: 'Хватит прятаться в горах. Шестеро дворцовых — и трон недалеко.',
      objective: { kind: 'kill', faction: Faction.Palace, count: 6 },
      gold: 420,
      reputation: [
        [Faction.Villain, 25],
        [Faction.Palace, -32],
      ],
    },
  ],
  [Faction.Neutral]: [],
};

export interface QuestSnapshot {
  active: Order | null;
  completed: string[];
}

export class QuestLog {
  active: Order | null = null;
  /** Идентификаторы уже выполненных приказов. */
  readonly completed = new Set<string>();

  /**
   * Выдать следующий приказ.
   * Сначала идут ещё не выполненные; когда кончились — по кругу, чтобы работа
   * не заканчивалась никогда.
   */
  offer(faction: Faction, rng: Rng): Order | null {
    const templates = TEMPLATES[faction];
    if (templates.length === 0) return null;

    const fresh = templates.filter((template) => !this.completed.has(template.id));
    const template = fresh.length > 0 ? fresh[0] : rng.pick(templates);

    this.active = { ...template, progress: 0, done: false };
    return this.active;
  }

  get hasActive(): boolean {
    return this.active !== null && !this.active.done;
  }

  /** Убит противник указанной стороны. */
  onKill(faction: Faction): boolean {
    return this.advance('kill', (objective) => objective.faction === faction);
  }

  /** Ограблен обоз указанного хозяина. */
  onRobbery(owner: Faction): boolean {
    return this.advance('rob', (objective) => objective.faction === undefined || objective.faction === owner);
  }

  /** Игрок дошёл до опорной точки. */
  onReach(siteId: string): boolean {
    return this.advance('reach', (objective) => objective.siteId === siteId);
  }

  /** Нанят ещё один боец. */
  onRecruit(): boolean {
    return this.advance('recruit', () => true);
  }

  private advance(kind: ObjectiveKind, matches: (objective: Objective) => boolean): boolean {
    const order = this.active;
    if (!order || order.done || order.objective.kind !== kind) return false;
    if (!matches(order.objective)) return false;

    order.progress++;
    if (order.progress >= order.objective.count) {
      order.done = true;
      return true;
    }
    return false;
  }

  /** Забрать награду за выполненный приказ. */
  claim(): Order | null {
    const order = this.active;
    if (!order || !order.done) return null;
    this.completed.add(order.id);
    this.active = null;
    return order;
  }

  /** Строка для интерфейса. */
  describe(): string | null {
    const order = this.active;
    if (!order) return null;
    if (order.done) return `${order.title}: выполнено — доложите командиру`;
    return `${order.title}: ${order.progress} из ${order.objective.count}`;
  }

  serialize(): QuestSnapshot {
    return { active: this.active ? { ...this.active } : null, completed: [...this.completed] };
  }

  restore(snapshot: QuestSnapshot): void {
    this.active = snapshot.active ? { ...snapshot.active } : null;
    this.completed.clear();
    for (const id of snapshot.completed ?? []) this.completed.add(id);
  }
}

/** Сколько приказов вообще есть у стороны — для проверок. */
export function orderCount(faction: Faction): number {
  return TEMPLATES[faction].length;
}
