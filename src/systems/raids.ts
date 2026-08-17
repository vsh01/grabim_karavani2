import { Faction } from '../data/factions';
import { Rng } from '../core/rng';
import { distance2D } from '../core/math';
import { getSite } from '../world/sites';
import type { Terrain } from '../world/terrain';
import type { Actor } from '../entities/actor';
import type { Population } from './population';

/** Кто на кого ходит. */
interface RaidPlan {
  id: string;
  attacker: Faction;
  fromSite: string;
  toSite: string;
  size: [number, number];
  weapons: string[];
  armor?: string;
  /** Что показать в журнале, когда отряд вышел. */
  announcement: string;
}

const PLANS: readonly RaidPlan[] = [
  {
    id: 'palace-on-elves',
    attacker: Faction.Palace,
    fromSite: 'barracks',
    toSite: 'glade',
    size: [3, 5],
    weapons: ['sword', 'mace', 'bow'],
    armor: 'mail',
    announcement: 'Стража дворца пошла набегом на поляну эльфов',
  },
  {
    id: 'villain-on-elves',
    attacker: Faction.Villain,
    fromSite: 'fort',
    toSite: 'partisan-camp',
    size: [3, 4],
    weapons: ['axe', 'sword', 'mace'],
    armor: 'leather',
    announcement: 'Разбойники спустились с гор к лагерю партизан',
  },
  {
    id: 'villain-on-palace',
    attacker: Faction.Villain,
    fromSite: 'fort',
    toSite: 'barracks',
    size: [3, 5],
    weapons: ['axe', 'sword', 'bow'],
    armor: 'leather',
    announcement: 'Банда злодея двинулась к казармам',
  },
  {
    id: 'elves-on-palace',
    attacker: Faction.Elves,
    fromSite: 'partisan-camp',
    toSite: 'barracks',
    size: [3, 4],
    weapons: ['bow', 'bow', 'sword'],
    armor: 'leather',
    announcement: 'Партизаны эльфов ушли к казармам дворца',
  },
];

interface ActiveRaid {
  plan: RaidPlan;
  actors: Actor[];
  age: number;
  returning: boolean;
}

/** Пауза между набегами, секунды. */
const RAID_INTERVAL: [number, number] = [110, 210];
/** Сколько отряд воюет на месте, прежде чем повернуть домой. */
const RAID_DURATION = 190;
/** Через сколько секунд после возвращения отряд расходится. */
const RAID_LIFETIME = 320;

/**
 * Мировые набеги.
 *
 * Стороны воюют между собой независимо от игрока: стража ходит на эльфов,
 * банда — на казармы, партизаны — в ответ. Играя за эльфов, вы и правда
 * увидите, как «набигают» солдаты дворца и злодеи, — даже если сами в это
 * время сидите в другом конце карты.
 */
export class RaidSystem {
  private readonly active: ActiveRaid[] = [];
  private readonly rng: Rng;
  private timer: number;

  constructor(
    private readonly population: Population,
    private readonly terrain: Terrain,
    seed: number,
    private readonly onAnnounce: (message: string) => void,
  ) {
    this.rng = new Rng(seed ^ 0x7a1d);
    this.timer = this.rng.range(50, 90);
  }

  get activeRaids(): number {
    return this.active.length;
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.launch();
      this.timer = this.rng.range(RAID_INTERVAL[0], RAID_INTERVAL[1]);
    }

    for (let i = this.active.length - 1; i >= 0; i--) {
      const raid = this.active[i];
      raid.age += dt;

      const survivors = raid.actors.filter((actor) => actor.alive);
      if (survivors.length === 0) {
        this.active.splice(i, 1);
        continue;
      }

      // Отвоевали своё — поворачивают домой.
      if (!raid.returning && raid.age > RAID_DURATION) {
        raid.returning = true;
        const home = getSite(raid.plan.fromSite);
        for (const actor of survivors) actor.escortAnchor.set(home.x, 0, home.z);
      }

      // Дошли до дома — растворяются в гарнизоне.
      if (raid.returning) {
        const home = getSite(raid.plan.fromSite);
        for (const actor of survivors) {
          if (distance2D(actor.position.x, actor.position.z, home.x, home.z) < 25) {
            actor.hasEscortAnchor = false;
            actor.home.set(home.x, 0, home.z);
          }
        }
      }

      if (raid.age > RAID_LIFETIME) {
        for (const actor of survivors) {
          actor.hasEscortAnchor = false;
          this.population.remove(actor);
        }
        this.active.splice(i, 1);
      }
    }
  }

  /** Отправить набег немедленно. */
  launch(planId?: string): ActiveRaid | null {
    const plan = planId ? PLANS.find((entry) => entry.id === planId) : this.rng.pick(PLANS);
    if (!plan) return null;

    const from = getSite(plan.fromSite);
    const to = getSite(plan.toSite);
    const count = this.rng.int(plan.size[0], plan.size[1]);
    const actors: Actor[] = [];

    for (let i = 0; i < count; i++) {
      const x = from.x + this.rng.range(-12, 12);
      const z = from.z + this.rng.range(-12, 12);
      const actor = this.population.spawn({
        faction: plan.attacker,
        x,
        z,
        role: 'patrol',
        name: 'налётчик',
        weapon: this.rng.pick(plan.weapons),
        armor: plan.armor,
        gold: this.rng.int(10, 55),
        toughness: this.rng.range(0.95, 1.15),
      });

      // Идут к цели тем же механизмом, что и сопровождение обоза: якорь ведёт,
      // а драться по дороге они начнут сами, как только увидят врага.
      actor.escortAnchor.set(to.x + this.rng.range(-9, 9), 0, to.z + this.rng.range(-9, 9));
      actor.hasEscortAnchor = true;
      actors.push(actor);
    }

    const raid: ActiveRaid = { plan, actors, age: 0, returning: false };
    this.active.push(raid);
    this.onAnnounce(plan.announcement);
    void this.terrain;
    return raid;
  }

  /** Сводка для отладки и автотестов. */
  report(): { plan: string; alive: number; returning: boolean }[] {
    return this.active.map((raid) => ({
      plan: raid.plan.id,
      alive: raid.actors.filter((actor) => actor.alive).length,
      returning: raid.returning,
    }));
  }
}
