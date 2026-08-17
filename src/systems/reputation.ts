import { ALL_FACTIONS, Faction, baseHostility } from '../data/factions';
import { clamp, clamp01 } from '../core/math';

/** Границы шкалы отношения к игроку. */
export const REPUTATION_MIN = -100;
export const REPUTATION_MAX = 100;

export interface ReputationSnapshot {
  values: Record<string, number>;
}

/**
 * Как стороны относятся лично к игроку.
 *
 * Поверх постоянной вражды фракций между собой лежит личная репутация. Ограбил
 * корован императора — стража начнёт бить, даже если вы за неё играете. Помог
 * эльфам — перестанут стрелять при встрече, хотя обычно эльфы не жалуют чужих.
 */
export class Reputation {
  private readonly values = new Map<Faction, number>();

  constructor(playerFaction: Faction) {
    for (const faction of ALL_FACTIONS) this.values.set(faction, 0);
    // Со своими начинаем в хороших отношениях.
    this.values.set(playerFaction, 45);
  }

  get(faction: Faction): number {
    return this.values.get(faction) ?? 0;
  }

  /** Изменить отношение. Возвращает итоговое значение. */
  change(faction: Faction, delta: number): number {
    const next = clamp(this.get(faction) + delta, REPUTATION_MIN, REPUTATION_MAX);
    this.values.set(faction, next);
    return next;
  }

  set(faction: Faction, value: number): void {
    this.values.set(faction, clamp(value, REPUTATION_MIN, REPUTATION_MAX));
  }

  /**
   * Насколько эта сторона враждебна игроку прямо сейчас: 0 — не тронет,
   * 1 — нападёт при виде.
   *
   * Складывается из постоянной вражды к фракции игрока и личной репутации.
   */
  hostilityTowardsPlayer(faction: Faction, playerFaction: Faction): number {
    const base = baseHostility(faction, playerFaction);
    return clamp01(base - this.get(faction) / 100);
  }

  /** Словесная оценка для интерфейса. */
  describe(faction: Faction): string {
    const value = this.get(faction);
    if (value >= 70) return 'герой';
    if (value >= 35) return 'свой';
    if (value >= 10) return 'дружелюбно';
    if (value > -10) return 'нейтрально';
    if (value > -35) return 'настороженно';
    if (value > -70) return 'враждебно';
    return 'вне закона';
  }

  /** Наценка торговца: своим дешевле, чужим дороже. */
  tradeModifier(faction: Faction): number {
    // От −100 до +100 репутации цена гуляет примерно на четверть в обе стороны.
    return 1 - (this.get(faction) / 100) * 0.22;
  }

  /** Пускают ли вообще торговать. */
  willTrade(faction: Faction): boolean {
    return this.get(faction) > -55;
  }

  serialize(): ReputationSnapshot {
    const values: Record<string, number> = {};
    for (const faction of ALL_FACTIONS) values[faction] = this.get(faction);
    return { values };
  }

  restore(snapshot: ReputationSnapshot): void {
    for (const faction of ALL_FACTIONS) {
      const value = snapshot.values[faction];
      if (typeof value === 'number') this.values.set(faction, value);
    }
  }
}
