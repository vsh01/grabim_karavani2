import type { BodySnapshot } from '../entities/body';
import type { InventorySnapshot } from '../data/items';
import type { QuestSnapshot } from './quests';
import type { ReputationSnapshot } from './reputation';
import type { EconomySnapshot } from './economy';
import type { BountySnapshot } from './bounty';
import type { ActorRole } from '../entities/actor';
import { Faction } from '../data/factions';

/**
 * Сохранение и загрузка.
 *
 * Мир целиком в файл не пишется: ландшафт, лес и постройки восстанавливаются из
 * одного числа-сида, поэтому сохранять нужно только то, что изменилось, — людей,
 * раны, обозы, цены и отношения. Снимок получается лёгким и читаемым.
 */

/**
 * Версия формата. Меняется, когда снимок перестаёт читаться по-старому.
 *
 * 2 — появилась награда за голову.
 */
export const SAVE_VERSION = 2;
const STORAGE_PREFIX = 'grabim-korovany-2/save/';
export const SAVE_SLOTS = 3;

export interface ActorSnapshot {
  faction: Faction;
  role: ActorRole;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  homeX: number;
  homeZ: number;
  homeRadius: number;
  wounds: BodySnapshot;
  inventory: InventorySnapshot;
  shopSiteId: string | null;
  commandsFaction: Faction | null;
  inPlayerSquad: boolean;
  /** Снимки первой версии этого не знают, поэтому поле необязательное. */
  huntsPlayer?: boolean;
  corpseAge: number;
}

export interface CaravanSnapshot {
  owner: Faction;
  fromSite: string;
  toSite: string;
  cargo: { id: string; count: number }[];
  gold: number;
  distanceAlong: number;
  looted: boolean;
  /** Номера сопровождающих в общем списке персонажей. */
  members: number[];
}

export interface PlayerSnapshot {
  faction: Faction;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  wounds: BodySnapshot;
  inventory: InventorySnapshot;
}

export interface SaveGame {
  version: number;
  seed: number;
  savedAt: string;
  /** Что показать в списке сохранений. */
  label: string;
  timeOfDay: number;
  player: PlayerSnapshot;
  reputation: ReputationSnapshot;
  quests: QuestSnapshot;
  economy: EconomySnapshot;
  /** Награда за голову по каждой стороне. Появилась во второй версии формата. */
  bounty: BountySnapshot;
  actors: ActorSnapshot[];
  caravans: CaravanSnapshot[];
}

export interface SlotInfo {
  slot: number;
  used: boolean;
  label: string;
  savedAt: string;
}

function slotKey(slot: number): string {
  return `${STORAGE_PREFIX}${slot}`;
}

/** Сохранить снимок в слот. Возвращает false, если браузер не дал места. */
export function writeSlot(slot: number, save: SaveGame): boolean {
  try {
    localStorage.setItem(slotKey(slot), JSON.stringify(save));
    return true;
  } catch (error) {
    console.error('[сохранение] не удалось записать слот', slot, error);
    return false;
  }
}

/** Прочитать снимок из слота. */
export function readSlot(slot: number): SaveGame | null {
  try {
    const raw = localStorage.getItem(slotKey(slot));
    if (!raw) return null;
    return migrate(JSON.parse(raw) as SaveGame);
  } catch (error) {
    console.error('[сохранение] слот', slot, 'не читается', error);
    return null;
  }
}

export function clearSlot(slot: number): void {
  localStorage.removeItem(slotKey(slot));
}

/** Что лежит в слотах — для списка сохранений. */
export function listSlots(): SlotInfo[] {
  const slots: SlotInfo[] = [];

  for (let slot = 1; slot <= SAVE_SLOTS; slot++) {
    const save = readSlot(slot);
    slots.push({
      slot,
      used: save !== null,
      label: save?.label ?? 'пусто',
      savedAt: save ? formatDate(save.savedAt) : '',
    });
  }
  return slots;
}

/**
 * Привести старый снимок к текущему виду.
 * Ломать чужие сохранения обновлением — худшее, что можно сделать, поэтому
 * недостающие поля не отвергаются, а заполняются разумными значениями.
 */
export function migrate(save: SaveGame): SaveGame | null {
  if (typeof save !== 'object' || save === null) return null;
  if (save.version > SAVE_VERSION) {
    console.warn('[сохранение] снимок из более новой версии игры');
    return null;
  }

  // Версия 1 ничего не знала про награду за голову: в том мире её просто не
  // было, значит, никто никого и не ищет.
  if (!save.bounty || typeof save.bounty !== 'object') save.bounty = { values: {} };

  save.version = SAVE_VERSION;
  return save;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Человеческая подпись снимка: за кого играем и где находимся. */
export function describeSave(factionName: string, zoneName: string, gold: number): string {
  return `${factionName} · ${zoneName} · ${gold} зол.`;
}
