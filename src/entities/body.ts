import { clamp, clamp01 } from '../core/math';
import { MovementMode } from './movement';

/**
 * Части тела, по которым считаются попадания.
 *
 * Это ядро того самого требования: убить можно, а можно отрубить руку, выбить
 * глаз или оставить без ноги. Всё, что происходит с телом, живёт здесь — без
 * трёхмерной графики и без интерфейса, поэтому логику легко проверить тестами.
 */
export enum BodyPart {
  Head = 'head',
  Torso = 'torso',
  LeftEye = 'leftEye',
  RightEye = 'rightEye',
  LeftArm = 'leftArm',
  RightArm = 'rightArm',
  LeftLeg = 'leftLeg',
  RightLeg = 'rightLeg',
}

export const ALL_BODY_PARTS: readonly BodyPart[] = [
  BodyPart.Head,
  BodyPart.Torso,
  BodyPart.LeftEye,
  BodyPart.RightEye,
  BodyPart.LeftArm,
  BodyPart.RightArm,
  BodyPart.LeftLeg,
  BodyPart.RightLeg,
];

export const ARMS: readonly BodyPart[] = [BodyPart.LeftArm, BodyPart.RightArm];
export const LEGS: readonly BodyPart[] = [BodyPart.LeftLeg, BodyPart.RightLeg];
export const EYES: readonly BodyPart[] = [BodyPart.LeftEye, BodyPart.RightEye];

/** Части, потеря которых означает мгновенную смерть. */
export const VITAL_PARTS: readonly BodyPart[] = [BodyPart.Head, BodyPart.Torso];

/** Части, которые можно отрубить и заменить протезом. */
export const LIMBS: readonly BodyPart[] = [...ARMS, ...LEGS];

export const PART_NAMES: Record<BodyPart, string> = {
  [BodyPart.Head]: 'голова',
  [BodyPart.Torso]: 'туловище',
  [BodyPart.LeftEye]: 'левый глаз',
  [BodyPart.RightEye]: 'правый глаз',
  [BodyPart.LeftArm]: 'левая рука',
  [BodyPart.RightArm]: 'правая рука',
  [BodyPart.LeftLeg]: 'левая нога',
  [BodyPart.RightLeg]: 'правая нога',
};

/**
 * Как сказать о потере каждой части: «рука отрублена», но «глаз выбит».
 * Сообщения читает живой человек, поэтому род и слово подбираем по месту.
 */
const LOST_FORM: Record<BodyPart, string> = {
  [BodyPart.Head]: 'отсечена',
  [BodyPart.Torso]: 'разрублено',
  [BodyPart.LeftEye]: 'выбит',
  [BodyPart.RightEye]: 'выбит',
  [BodyPart.LeftArm]: 'отрублена',
  [BodyPart.RightArm]: 'отрублена',
  [BodyPart.LeftLeg]: 'отрублена',
  [BodyPart.RightLeg]: 'отрублена',
};

/** «левая рука отрублена», «правый глаз выбит». */
export function describeLoss(part: BodyPart): string {
  return `${PART_NAMES[part]} ${LOST_FORM[part]}`;
}

/** Короткая форма для схемы тела: «отрублена», «выбит». */
export function lossWord(part: BodyPart): string {
  return LOST_FORM[part];
}

/** Тип урона решает, отрубит ли удар конечность или только покалечит. */
export type DamageType = 'cut' | 'blunt' | 'pierce';

export interface PartStatus {
  hp: number;
  maxHp: number;
  /** Отрублена. Само не отрастёт — только протез. */
  severed: boolean;
  /** Вместо потерянной части стоит протез. */
  prosthetic: boolean;
  /** Сколько крови теряется в секунду из этой раны. */
  bleeding: number;
}

const MAX_HP: Record<BodyPart, number> = {
  [BodyPart.Head]: 48,
  [BodyPart.Torso]: 105,
  [BodyPart.LeftEye]: 6,
  [BodyPart.RightEye]: 6,
  [BodyPart.LeftArm]: 42,
  [BodyPart.RightArm]: 42,
  [BodyPart.LeftLeg]: 56,
  [BodyPart.RightLeg]: 56,
};

/** Кровотечение из свежей культи, единиц крови в секунду. */
const SEVER_BLEED: Record<BodyPart, number> = {
  [BodyPart.Head]: 0,
  [BodyPart.Torso]: 0,
  [BodyPart.LeftEye]: 0.6,
  [BodyPart.RightEye]: 0.6,
  [BodyPart.LeftArm]: 3.1,
  [BodyPart.RightArm]: 3.1,
  [BodyPart.LeftLeg]: 3.8,
  [BodyPart.RightLeg]: 3.8,
};

export const MAX_BLOOD = 100;

export type DeathCause = 'wounds' | 'bleeding' | 'beheaded' | null;

export interface DamageOptions {
  type?: DamageType;
  /** Броня поглощает часть урона. */
  armor?: number;
}

export interface DamageReport {
  part: BodyPart;
  /** Урон после брони. */
  applied: number;
  severed: boolean;
  killed: boolean;
  /** Короткое сообщение для журнала событий. */
  message: string;
}

/**
 * Состояние тела: части, кровь, жив или нет.
 * Один и тот же класс используется и для игрока, и для всех NPC — враги теряют
 * руки и истекают кровью ровно по тем же правилам.
 */
export class Body {
  readonly parts: Record<BodyPart, PartStatus>;
  blood = MAX_BLOOD;
  alive = true;
  deathCause: DeathCause = null;
  /** Коляска в снаряжении: без неё безногий только ползает. */
  hasWheelchair = false;

  constructor(toughness = 1) {
    this.parts = {} as Record<BodyPart, PartStatus>;
    for (const part of ALL_BODY_PARTS) {
      const maxHp = Math.round(MAX_HP[part] * toughness);
      this.parts[part] = { hp: maxHp, maxHp, severed: false, prosthetic: false, bleeding: 0 };
    }
  }

  get(part: BodyPart): PartStatus {
    return this.parts[part];
  }

  /** Общее состояние: 0 — при смерти, 1 — здоров. Считается по голове и торсу. */
  get vitality(): number {
    const head = this.parts[BodyPart.Head];
    const torso = this.parts[BodyPart.Torso];
    return clamp01((head.hp + torso.hp) / (head.maxHp + torso.maxHp));
  }

  get bloodFraction(): number {
    return clamp01(this.blood / MAX_BLOOD);
  }

  /** Суммарная скорость потери крови, единиц в секунду. */
  get bleedRate(): number {
    let rate = 0;
    for (const part of ALL_BODY_PARTS) rate += this.parts[part].bleeding;
    return rate;
  }

  get isBleeding(): boolean {
    return this.bleedRate > 0.001;
  }

  /** Сколько секунд осталось, если не перевязаться. */
  get secondsUntilBleedOut(): number {
    const rate = this.bleedRate;
    return rate > 0.001 ? this.blood / rate : Infinity;
  }

  /**
   * Нанести урон в конкретную часть тела.
   * Рубящий удар отрубает конечность, дробящий калечит, колющий больше кровит.
   */
  damage(part: BodyPart, amount: number, options: DamageOptions = {}): DamageReport {
    const type: DamageType = options.type ?? 'cut';
    const status = this.parts[part];

    const applied = Math.max(0, amount - (options.armor ?? 0));
    const report: DamageReport = { part, applied, severed: false, killed: false, message: '' };

    if (!this.alive || applied <= 0) {
      report.applied = 0;
      report.message = this.alive ? 'удар не пробил' : '';
      return report;
    }

    // Уже отрубленную часть бить бесполезно: урона нет.
    if (status.severed && !status.prosthetic) {
      report.applied = 0;
      report.message = `${PART_NAMES[part]}: рубить уже нечего`;
      return report;
    }

    // Протез принимает удар на себя и ломается, но не кровоточит.
    if (status.prosthetic) {
      status.hp -= applied;
      if (status.hp <= 0) {
        status.prosthetic = false;
        status.hp = 0;
        report.severed = true;
        report.message = `протез (${PART_NAMES[part]}) разбит`;
      } else {
        report.message = `удар по протезу (${PART_NAMES[part]})`;
      }
      return report;
    }

    status.hp = Math.max(0, status.hp - applied);

    // Открытая рана кровоточит и без потери конечности.
    const bleedFromWound = type === 'pierce' ? applied * 0.03 : applied * 0.018;
    status.bleeding = Math.min(SEVER_BLEED[part] || 1.2, status.bleeding + bleedFromWound);

    if (VITAL_PARTS.includes(part)) {
      if (status.hp <= 0) {
        this.kill(part === BodyPart.Head ? 'beheaded' : 'wounds');
        report.killed = true;
        report.message = part === BodyPart.Head ? 'удар в голову — насмерть' : 'смертельная рана в туловище';
      } else {
        report.message = `рана: ${PART_NAMES[part]}`;
      }
      return report;
    }

    if (status.hp <= 0) {
      // Дробящее оружие не рубит: конечность просто перестаёт работать.
      const canSever = type !== 'blunt';
      if (canSever) {
        this.sever(part);
        report.severed = true;
        report.message = `${describeLoss(part)}!`;
      } else {
        status.bleeding = Math.max(status.bleeding, 0.6);
        report.message = `${PART_NAMES[part]} перебита`;
      }
    } else {
      report.message = `рана: ${PART_NAMES[part]}`;
    }

    return report;
  }

  /** Отрубить часть тела. Глаз «отрубается» тоже — это потеря зрения. */
  sever(part: BodyPart): void {
    const status = this.parts[part];
    if (status.severed) return;
    if (VITAL_PARTS.includes(part)) {
      this.kill('beheaded');
      return;
    }

    status.severed = true;
    status.prosthetic = false;
    status.hp = 0;
    status.bleeding = SEVER_BLEED[part];
  }

  /** Течение времени: кровь уходит, и если её не остановить — конец. */
  tick(dt: number): void {
    if (!this.alive) return;

    const rate = this.bleedRate;
    if (rate > 0) {
      this.blood = Math.max(0, this.blood - rate * dt);
      if (this.blood <= 0) {
        this.kill('bleeding');
        return;
      }
    } else if (this.blood < MAX_BLOOD) {
      // Без кровотечения кровь медленно восстанавливается сама.
      this.blood = Math.min(MAX_BLOOD, this.blood + dt * 0.45);
    }
  }

  private kill(cause: DeathCause): void {
    if (!this.alive) return;
    this.alive = false;
    this.deathCause = cause;
    for (const part of ALL_BODY_PARTS) this.parts[part].bleeding = 0;
  }

  /**
   * Перевязать рану. Возвращает часть, которую перевязали, или null —
   * если перевязывать нечего.
   */
  bandage(part?: BodyPart): BodyPart | null {
    if (part) {
      if (this.parts[part].bleeding <= 0) return null;
      this.parts[part].bleeding = 0;
      return part;
    }

    // Без указания части перевязываем самую опасную рану.
    let worst: BodyPart | null = null;
    let worstRate = 0;
    for (const candidate of ALL_BODY_PARTS) {
      const rate = this.parts[candidate].bleeding;
      if (rate > worstRate) {
        worstRate = rate;
        worst = candidate;
      }
    }
    if (!worst) return null;
    this.parts[worst].bleeding = 0;
    return worst;
  }

  /** Лечение: затягивает раны, но отрубленное не возвращает. */
  heal(amount: number): void {
    for (const part of ALL_BODY_PARTS) {
      const status = this.parts[part];
      // Кровь останавливают везде, включая культю: лекарь умеет прижигать.
      // А вот отрастить отрубленное лечение не может — только протез.
      status.bleeding = 0;
      if (status.severed) continue;
      status.hp = Math.min(status.maxHp, status.hp + amount);
    }
    this.blood = Math.min(MAX_BLOOD, this.blood + amount * 0.8);
    if (this.blood > 0 && this.parts[BodyPart.Torso].hp > 0 && this.parts[BodyPart.Head].hp > 0) {
      this.alive = true;
      this.deathCause = null;
    }
  }

  /** Поставить протез вместо отрубленной части. */
  attachProsthetic(part: BodyPart): boolean {
    const status = this.parts[part];
    if (!status.severed || status.prosthetic) return false;
    status.prosthetic = true;
    status.bleeding = 0;
    // Протез крепче не станет: половина запаса прочности.
    status.hp = Math.round(status.maxHp * 0.5);
    return true;
  }

  isLost(part: BodyPart): boolean {
    return this.parts[part].severed && !this.parts[part].prosthetic;
  }

  isUsable(part: BodyPart): boolean {
    const status = this.parts[part];
    if (status.severed && !status.prosthetic) return false;
    return status.hp > 0;
  }

  /** Целые (или протезированные) руки. */
  get workingArms(): number {
    return ARMS.filter((arm) => this.isUsable(arm)).length;
  }

  get workingLegs(): number {
    return LEGS.filter((leg) => this.isUsable(leg)).length;
  }

  /** Можно ли держать лук и двуручное оружие. */
  get canUseTwoHanded(): boolean {
    return this.workingArms === 2;
  }

  get canFight(): boolean {
    return this.workingArms > 0;
  }

  /** Как теперь передвигаться — прямое следствие состояния ног. */
  get movementMode(): MovementMode {
    const legs = this.workingLegs;
    if (legs === 2) {
      const onProsthetic = LEGS.some((leg) => this.parts[leg].prosthetic);
      return onProsthetic ? MovementMode.Prosthetic : MovementMode.Normal;
    }
    if (legs === 1) {
      // На одной ноге далеко не уйдёшь: либо коляска, либо ползком.
      return this.hasWheelchair ? MovementMode.Wheelchair : MovementMode.Crawl;
    }
    return this.hasWheelchair ? MovementMode.Wheelchair : MovementMode.Crawl;
  }

  /** Какой глаз потерян: от этого зависит, какая половина экрана погаснет. */
  get visionLoss(): 'none' | 'left' | 'right' | 'both' {
    const left = this.isLost(BodyPart.LeftEye);
    const right = this.isLost(BodyPart.RightEye);
    if (left && right) return 'both';
    if (left) return 'left';
    if (right) return 'right';
    return 'none';
  }

  /** Насколько ослаблен взгляд протезированным глазом: 0 — не ослаблен. */
  get visionDimming(): number {
    let dimming = 0;
    for (const eye of EYES) if (this.parts[eye].prosthetic) dimming += 0.3;
    return clamp01(dimming);
  }

  /** Множитель урона в ближнем бою от состояния рук. */
  get meleeDamageMultiplier(): number {
    const arms = this.workingArms;
    if (arms === 0) return 0.25;
    if (arms === 1) return 0.6;
    return 1;
  }

  /** Общий множитель скорости от ран и кровопотери. */
  get speedMultiplier(): number {
    const pain = 1 - (1 - this.vitality) * 0.35;
    const weakness = 0.55 + 0.45 * this.bloodFraction;
    return clamp(pain * weakness, 0.25, 1);
  }

  /** Краткая сводка для журнала и подсказок. */
  describeInjuries(): string[] {
    const lines: string[] = [];
    for (const part of ALL_BODY_PARTS) {
      const status = this.parts[part];
      if (status.prosthetic) lines.push(`${PART_NAMES[part]}: протез`);
      else if (status.severed) lines.push(`${PART_NAMES[part]}: ${lossWord(part)}`);
      else if (status.bleeding > 0) lines.push(`${PART_NAMES[part]}: кровит`);
      else if (status.hp < status.maxHp * 0.6) lines.push(`${PART_NAMES[part]}: ранена`);
    }
    return lines;
  }

  /** Снимок для сохранения. */
  serialize(): BodySnapshot {
    const parts = {} as Record<BodyPart, PartStatus>;
    for (const part of ALL_BODY_PARTS) parts[part] = { ...this.parts[part] };
    return { parts, blood: this.blood, alive: this.alive, deathCause: this.deathCause, hasWheelchair: this.hasWheelchair };
  }

  restore(snapshot: BodySnapshot): void {
    for (const part of ALL_BODY_PARTS) {
      const saved = snapshot.parts[part];
      if (saved) Object.assign(this.parts[part], saved);
    }
    this.blood = snapshot.blood;
    this.alive = snapshot.alive;
    this.deathCause = snapshot.deathCause;
    this.hasWheelchair = snapshot.hasWheelchair;
  }
}

export interface BodySnapshot {
  parts: Record<BodyPart, PartStatus>;
  blood: number;
  alive: boolean;
  deathCause: DeathCause;
  hasWheelchair: boolean;
}
