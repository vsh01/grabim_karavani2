/**
 * Способ передвижения. Определяется не желанием игрока, а состоянием ног:
 * потерял ногу — ползёшь, купил коляску — катишься, поставил протез — ходишь.
 *
 * Вынесено в отдельный модуль, чтобы логика тела не тянула за собой всю графику.
 */
export enum MovementMode {
  /** Обе ноги на месте. */
  Normal = 'normal',
  /** Протез вместо ноги: ходить можно, бегать нет. */
  Prosthetic = 'prosthetic',
  /** Ноги нет и протеза нет — только ползком. */
  Crawl = 'crawl',
  /** Коляска: по ровному быстро, по склонам и лесу почти никак. */
  Wheelchair = 'wheelchair',
}

export interface MovementParams {
  walk: number;
  sprint: number;
  eyeHeight: number;
  jump: number;
  canJump: boolean;
  /** Насколько сильно уклон режет скорость. */
  slopePenalty: number;
  /** Название для интерфейса. */
  label: string;
}

export const MOVEMENT_PARAMS: Record<MovementMode, MovementParams> = {
  [MovementMode.Normal]: {
    walk: 4.7,
    sprint: 7.8,
    eyeHeight: 1.68,
    jump: 7.2,
    canJump: true,
    slopePenalty: 0.9,
    label: 'на ногах',
  },
  [MovementMode.Prosthetic]: {
    walk: 3.8,
    sprint: 3.8,
    eyeHeight: 1.64,
    jump: 4.4,
    canJump: true,
    slopePenalty: 1.3,
    label: 'на протезе',
  },
  [MovementMode.Crawl]: {
    walk: 0.85,
    sprint: 0.85,
    eyeHeight: 0.5,
    jump: 0,
    canJump: false,
    slopePenalty: 1.6,
    label: 'ползком',
  },
  [MovementMode.Wheelchair]: {
    walk: 3.4,
    sprint: 4.6,
    eyeHeight: 1.15,
    jump: 0,
    canJump: false,
    slopePenalty: 3.4,
    label: 'в коляске',
  },
};
