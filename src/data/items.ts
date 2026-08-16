import type { DamageType } from '../entities/body';

export type ItemKind = 'weapon' | 'armor' | 'consumable' | 'prosthetic' | 'goods' | 'misc';

export interface WeaponStats {
  damage: number;
  type: DamageType;
  /** Дальность удара в метрах. Для лука — дальность прицельной стрельбы. */
  range: number;
  /** Ударов в секунду. */
  speed: number;
  twoHanded: boolean;
  ranged: boolean;
  /**
   * Насколько охотно оружие отрубает конечности: множитель к урону,
   * когда конечность уже почти перебита.
   */
  severBonus: number;
}

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  /** Базовая цена в золоте. В разных городах она своя. */
  price: number;
  weight: number;
  description: string;
  weapon?: WeaponStats;
  /** Сколько урона поглощает броня. */
  armor?: number;
  /** Сколько здоровья возвращает. */
  heal?: number;
  /** Останавливает кровотечение. */
  bandage?: boolean;
  /** Протез для конечности такого типа. */
  prostheticFor?: 'arm' | 'leg' | 'eye';
  /** Коляска для безногого. */
  wheelchair?: boolean;
  /** Товар для торговли: его возят корованы. */
  tradeGood?: boolean;
  stackable?: boolean;
}

function weapon(
  damage: number,
  type: DamageType,
  range: number,
  speed: number,
  options: Partial<WeaponStats> = {},
): WeaponStats {
  return {
    damage,
    type,
    range,
    speed,
    twoHanded: false,
    ranged: false,
    severBonus: 1,
    ...options,
  };
}

export const ITEMS: readonly ItemDef[] = [
  // ── Оружие ───────────────────────────────────────────────────────────────
  {
    id: 'fists',
    name: 'кулаки',
    kind: 'weapon',
    price: 0,
    weight: 0,
    description: 'Если совсем ничего нет. Руку ими не отрубишь.',
    weapon: weapon(7, 'blunt', 1.5, 1.9, { severBonus: 0 }),
  },
  {
    id: 'dagger',
    name: 'нож',
    kind: 'weapon',
    price: 35,
    weight: 0.6,
    description: 'Быстрый и тихий. В глаз попадает лучше любого меча.',
    weapon: weapon(15, 'pierce', 1.7, 2.6, { severBonus: 0.7 }),
  },
  {
    id: 'sword',
    name: 'меч',
    kind: 'weapon',
    price: 145,
    weight: 2.4,
    description: 'Ровно то, чем рубят руки.',
    weapon: weapon(27, 'cut', 2.1, 1.6, { severBonus: 1.3 }),
  },
  {
    id: 'axe',
    name: 'топор',
    kind: 'weapon',
    price: 165,
    weight: 3.4,
    description: 'Медленный, тяжёлый и очень убедительный. Конечности отлетают только так.',
    weapon: weapon(36, 'cut', 2.0, 1.15, { severBonus: 1.9 }),
  },
  {
    id: 'mace',
    name: 'булава',
    kind: 'weapon',
    price: 130,
    weight: 3.1,
    description: 'Не рубит, а ломает. Пробивает броню, но конечности оставляет на месте.',
    weapon: weapon(31, 'blunt', 1.9, 1.3, { severBonus: 0 }),
  },
  {
    id: 'bow',
    name: 'эльфийский лук',
    kind: 'weapon',
    price: 210,
    weight: 1.4,
    description: 'Оружие партизана: выстрелил из чащи и ушёл. Нужны обе руки.',
    weapon: weapon(32, 'pierce', 90, 0.85, { twoHanded: true, ranged: true, severBonus: 0.4 }),
  },
  {
    id: 'arrow',
    name: 'стрелы',
    kind: 'misc',
    price: 2,
    weight: 0.05,
    description: 'Пучок стрел.',
    stackable: true,
  },

  // ── Броня ────────────────────────────────────────────────────────────────
  {
    id: 'leather',
    name: 'кожаный доспех',
    kind: 'armor',
    price: 120,
    weight: 5,
    description: 'Не спасёт от топора, но нож удержит.',
    armor: 4,
  },
  {
    id: 'mail',
    name: 'кольчуга',
    kind: 'armor',
    price: 420,
    weight: 12,
    description: 'Дворцовая справа. Тяжело, зато руки остаются при вас.',
    armor: 9,
  },

  // ── Лечение ──────────────────────────────────────────────────────────────
  {
    id: 'bandage',
    name: 'бинт',
    kind: 'consumable',
    price: 12,
    weight: 0.1,
    description: 'Останавливает кровь. Без него отрубленная рука — приговор.',
    bandage: true,
    stackable: true,
  },
  {
    id: 'salve',
    name: 'целебная мазь',
    kind: 'consumable',
    price: 55,
    weight: 0.3,
    description: 'Затягивает раны. Отрубленное не возвращает.',
    heal: 35,
    stackable: true,
  },

  // ── Протезы ──────────────────────────────────────────────────────────────
  {
    id: 'wooden-leg',
    name: 'деревянная нога',
    kind: 'prosthetic',
    price: 180,
    weight: 2.2,
    description: 'Ходить можно, бегать нет. Всё лучше, чем ползать.',
    prostheticFor: 'leg',
  },
  {
    id: 'iron-hand',
    name: 'железная кисть',
    kind: 'prosthetic',
    price: 240,
    weight: 1.8,
    description: 'Держать оружие ею получается. Лук — уже нет.',
    prostheticFor: 'arm',
  },
  {
    id: 'glass-eye',
    name: 'зачарованный глаз',
    kind: 'prosthetic',
    price: 320,
    weight: 0.05,
    description: 'Видит мутно и только при свете, но полэкрана больше не в темноте.',
    prostheticFor: 'eye',
  },
  {
    id: 'wheelchair',
    name: 'коляска',
    kind: 'prosthetic',
    price: 260,
    weight: 14,
    description: 'По дороге катится бодро, по склону и по лесу — почти никак.',
    wheelchair: true,
  },

  // ── Товары для корованов ─────────────────────────────────────────────────
  { id: 'grain', name: 'зерно', kind: 'goods', price: 8, weight: 1, description: 'Мешки зерна.', tradeGood: true, stackable: true },
  { id: 'furs', name: 'меха', kind: 'goods', price: 34, weight: 0.8, description: 'Лесная добыча эльфов.', tradeGood: true, stackable: true },
  { id: 'wine', name: 'вино', kind: 'goods', price: 26, weight: 1.2, description: 'Бочонки к императорскому столу.', tradeGood: true, stackable: true },
  { id: 'salt', name: 'соль', kind: 'goods', price: 18, weight: 1, description: 'Дороже, чем кажется.', tradeGood: true, stackable: true },
  { id: 'iron', name: 'железо', kind: 'goods', price: 42, weight: 3, description: 'Слитки из горных копей.', tradeGood: true, stackable: true },
  { id: 'silk', name: 'шёлк', kind: 'goods', price: 75, weight: 0.4, description: 'Ради такого корован и грабят.', tradeGood: true, stackable: true },
  { id: 'spices', name: 'пряности', kind: 'goods', price: 90, weight: 0.3, description: 'Лёгкие, дорогие, легко унести.', tradeGood: true, stackable: true },
];

const BY_ID = new Map<string, ItemDef>(ITEMS.map((item) => [item.id, item]));

export function item(id: string): ItemDef {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Неизвестный предмет: ${id}`);
  return found;
}

export function tryItem(id: string): ItemDef | undefined {
  return BY_ID.get(id);
}

export const TRADE_GOODS: readonly ItemDef[] = ITEMS.filter((entry) => entry.tradeGood === true);
export const WEAPONS: readonly ItemDef[] = ITEMS.filter((entry) => entry.kind === 'weapon');

/** Стопка предметов в мешке. */
export interface ItemStack {
  id: string;
  count: number;
}

/** Мешок: предметы, золото и то, что надето. */
export class Inventory {
  readonly stacks: ItemStack[] = [];
  gold = 0;
  equippedWeapon = 'fists';
  equippedArmor: string | null = null;

  add(id: string, count = 1): void {
    const def = tryItem(id);
    if (!def) return;
    if (def.stackable) {
      const existing = this.stacks.find((stack) => stack.id === id);
      if (existing) {
        existing.count += count;
        return;
      }
    }
    this.stacks.push({ id, count });
  }

  remove(id: string, count = 1): boolean {
    const index = this.stacks.findIndex((stack) => stack.id === id);
    if (index === -1) return false;
    const stack = this.stacks[index];
    if (stack.count < count) return false;
    stack.count -= count;
    if (stack.count <= 0) this.stacks.splice(index, 1);
    return true;
  }

  count(id: string): number {
    let total = 0;
    for (const stack of this.stacks) if (stack.id === id) total += stack.count;
    return total;
  }

  has(id: string): boolean {
    return this.count(id) > 0;
  }

  get totalWeight(): number {
    let weight = 0;
    for (const stack of this.stacks) weight += (tryItem(stack.id)?.weight ?? 0) * stack.count;
    return weight;
  }

  /** Сколько урона поглощает надетая броня. */
  get armorValue(): number {
    return this.equippedArmor ? (tryItem(this.equippedArmor)?.armor ?? 0) : 0;
  }

  get weapon(): ItemDef {
    return tryItem(this.equippedWeapon) ?? item('fists');
  }

  /** Всё оружие в мешке, включая кулаки. */
  availableWeapons(): ItemDef[] {
    const owned = this.stacks
      .map((stack) => tryItem(stack.id))
      .filter((def): def is ItemDef => def?.kind === 'weapon');
    return [item('fists'), ...owned];
  }

  serialize(): InventorySnapshot {
    return {
      stacks: this.stacks.map((stack) => ({ ...stack })),
      gold: this.gold,
      equippedWeapon: this.equippedWeapon,
      equippedArmor: this.equippedArmor,
    };
  }

  restore(snapshot: InventorySnapshot): void {
    this.stacks.length = 0;
    for (const stack of snapshot.stacks) this.stacks.push({ ...stack });
    this.gold = snapshot.gold;
    this.equippedWeapon = snapshot.equippedWeapon;
    this.equippedArmor = snapshot.equippedArmor;
  }
}

export interface InventorySnapshot {
  stacks: ItemStack[];
  gold: number;
  equippedWeapon: string;
  equippedArmor: string | null;
}
