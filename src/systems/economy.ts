import { ITEMS, TRADE_GOODS, item, tryItem, type ItemDef } from '../data/items';
import { Faction } from '../data/factions';
import { clamp } from '../core/math';
import type { Reputation } from './reputation';

/** Торговый узел: город, поляна или форт, где можно купить и продать. */
export interface Market {
  siteId: string;
  name: string;
  owner: Faction;
  /** Что здесь производят — это дёшево. */
  produces: string[];
  /** Чего здесь не хватает — это дорого. */
  demands: string[];
  /** Что вообще стоит на прилавке. */
  stock: string[];
  /** Есть ли лекарь: лечение, бинты, протезы. */
  healer: boolean;
}

export const MARKETS: readonly Market[] = [
  {
    siteId: 'village',
    name: 'Рынок Тихого Брода',
    owner: Faction.Neutral,
    produces: ['grain', 'salt'],
    demands: ['silk', 'spices', 'furs'],
    stock: ['dagger', 'sword', 'leather', 'bandage', 'salve', 'arrow', 'grain', 'salt', 'wooden-leg', 'wheelchair'],
    healer: true,
  },
  {
    siteId: 'palace',
    name: 'Дворцовая лавка',
    owner: Faction.Palace,
    produces: [],
    demands: ['wine', 'silk', 'spices', 'iron'],
    stock: ['sword', 'mace', 'mail', 'leather', 'bandage', 'salve', 'arrow', 'iron-hand', 'glass-eye'],
    healer: true,
  },
  {
    siteId: 'glade',
    name: 'Лесной торг',
    owner: Faction.Elves,
    produces: ['furs'],
    demands: ['salt', 'grain', 'iron'],
    stock: ['bow', 'arrow', 'dagger', 'leather', 'bandage', 'salve', 'furs', 'glass-eye'],
    healer: true,
  },
  {
    siteId: 'fort',
    name: 'Скупщик в форте',
    owner: Faction.Villain,
    produces: ['iron'],
    demands: ['wine', 'grain', 'silk'],
    stock: ['axe', 'mace', 'sword', 'bandage', 'arrow', 'iron', 'iron-hand', 'wooden-leg'],
    healer: false,
  },
];

const MARKET_BY_SITE = new Map<string, Market>(MARKETS.map((market) => [market.siteId, market]));

export function marketAt(siteId: string): Market | undefined {
  return MARKET_BY_SITE.get(siteId);
}

/** Наценка лавочника при покупке у него и скидка при продаже ему. */
const BUY_MARGIN = 1.3;
const SELL_MARGIN = 0.62;

/** Насколько дорожает товар в городе назначения после ограбления корована. */
const SHORTAGE_PER_ROBBERY = 0.35;
/** За сколько секунд дефицит рассасывается. */
const SHORTAGE_DECAY = 240;

/**
 * Цены, дефицит и последствия грабежа.
 *
 * Ограбить корован — не просто забрать мешки. Товар не доедет, и в городе, куда
 * он шёл, цена на него подскочит. Продавать награбленное выгоднее там, где его
 * ждали, — но именно там вас и будут искать.
 */
export class Economy {
  /** Временный дефицит по узлам: siteId → itemId → надбавка. */
  private readonly shortages = new Map<string, Map<string, number>>();

  /** Базовая цена товара с учётом того, где он нужен, а где его и так полно. */
  basePrice(itemId: string, siteId: string): number {
    const def = tryItem(itemId);
    if (!def) return 0;

    const market = marketAt(siteId);
    if (!market) return def.price;

    let price = def.price;
    if (market.produces.includes(itemId)) price *= 0.62;
    else if (market.demands.includes(itemId)) price *= 1.5;

    price *= 1 + this.shortageOf(siteId, itemId);
    return price;
  }

  /** Сколько просит торговец. */
  buyPrice(itemId: string, siteId: string, reputation?: Reputation): number {
    const market = marketAt(siteId);
    const modifier = market && reputation ? reputation.tradeModifier(market.owner) : 1;
    return Math.max(1, Math.round(this.basePrice(itemId, siteId) * BUY_MARGIN * modifier));
  }

  /** Сколько даёт торговец. */
  sellPrice(itemId: string, siteId: string, reputation?: Reputation): number {
    const market = marketAt(siteId);
    // При продаже хорошая репутация должна помогать, а не мешать, — поэтому
    // множитель переворачиваем.
    const modifier = market && reputation ? 2 - reputation.tradeModifier(market.owner) : 1;
    return Math.max(1, Math.round(this.basePrice(itemId, siteId) * SELL_MARGIN * modifier));
  }

  /** Текущая надбавка из-за дефицита: 0 — товара хватает. */
  shortageOf(siteId: string, itemId: string): number {
    return this.shortages.get(siteId)?.get(itemId) ?? 0;
  }

  /**
   * Корован не доехал: в городе назначения дорожает всё, что он вёз.
   * Это и есть настоящее последствие грабежа — не только золото в кармане.
   */
  registerLostCargo(destinationSiteId: string, cargo: readonly { id: string; count: number }[]): void {
    let bucket = this.shortages.get(destinationSiteId);
    if (!bucket) {
      bucket = new Map();
      this.shortages.set(destinationSiteId, bucket);
    }

    for (const entry of cargo) {
      const current = bucket.get(entry.id) ?? 0;
      // Больше увезли — сильнее подскочит, но не до бесконечности.
      const increase = SHORTAGE_PER_ROBBERY * Math.min(2, entry.count / 6);
      bucket.set(entry.id, clamp(current + increase, 0, 1.8));
    }
  }

  /** Дефицит постепенно рассасывается: подвозят из других мест. */
  update(dt: number): void {
    const decay = dt / SHORTAGE_DECAY;

    for (const [siteId, bucket] of this.shortages) {
      for (const [itemId, value] of bucket) {
        const next = value - decay;
        if (next <= 0.001) bucket.delete(itemId);
        else bucket.set(itemId, next);
      }
      if (bucket.size === 0) this.shortages.delete(siteId);
    }
  }

  /** Что стоит на прилавке этого узла, с ценами. */
  stockOf(siteId: string, reputation?: Reputation): { def: ItemDef; price: number }[] {
    const market = marketAt(siteId);
    if (!market) return [];
    return market.stock
      .map((id) => tryItem(id))
      .filter((def): def is ItemDef => def !== undefined)
      .map((def) => ({ def, price: this.buyPrice(def.id, siteId, reputation) }));
  }

  /** Где выгоднее всего сбыть этот товар — подсказка для игрока. */
  bestMarketFor(itemId: string, reputation?: Reputation): { market: Market; price: number } | null {
    let best: { market: Market; price: number } | null = null;
    for (const market of MARKETS) {
      const price = this.sellPrice(itemId, market.siteId, reputation);
      if (!best || price > best.price) best = { market, price };
    }
    return best;
  }

  serialize(): EconomySnapshot {
    const shortages: Record<string, Record<string, number>> = {};
    for (const [siteId, bucket] of this.shortages) {
      shortages[siteId] = Object.fromEntries(bucket);
    }
    return { shortages };
  }

  restore(snapshot: EconomySnapshot): void {
    this.shortages.clear();
    for (const [siteId, bucket] of Object.entries(snapshot.shortages ?? {})) {
      this.shortages.set(siteId, new Map(Object.entries(bucket)));
    }
  }
}

export interface EconomySnapshot {
  shortages: Record<string, Record<string, number>>;
}

/** Полный список товаров, которые вообще возят корованы. */
export function tradeGoodIds(): string[] {
  return TRADE_GOODS.map((good) => good.id);
}

/** Сколько стоит эта стопка по базовой цене — для оценки добычи. */
export function stackValue(entries: readonly { id: string; count: number }[]): number {
  let total = 0;
  for (const entry of entries) total += (tryItem(entry.id)?.price ?? 0) * entry.count;
  return total;
}

/** Проверка, что все ссылки на предметы в прилавках существуют. */
export function validateMarkets(): string[] {
  const problems: string[] = [];
  const known = new Set(ITEMS.map((entry) => entry.id));

  for (const market of MARKETS) {
    for (const id of [...market.stock, ...market.produces, ...market.demands]) {
      if (!known.has(id)) problems.push(`${market.siteId}: неизвестный предмет ${id}`);
    }
  }
  // item() бросит исключение, если базовый набор поломан.
  item('bandage');
  return problems;
}
