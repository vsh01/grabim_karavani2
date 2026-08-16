import * as THREE from 'three';
import { Actor } from '../entities/actor';
import { BodyPart, LIMBS, PART_NAMES, type Body, type DamageReport } from '../entities/body';
import type { Player } from '../entities/player';
import type { WeaponStats } from '../data/items';
import { item } from '../data/items';
import type { Terrain } from '../world/terrain';
import type { BloodEffects } from './effects';

/** Что произошло при ударе — для журнала событий и интерфейса. */
export interface CombatEvent {
  attackerName: string;
  victimName: string;
  /** Кого задели. null — значит, пострадал игрок. */
  victim: Actor | null;
  /** Пострадал игрок, а не персонаж мира. */
  victimIsPlayer: boolean;
  part: BodyPart;
  damage: number;
  severed: boolean;
  killed: boolean;
  message: string;
  position: THREE.Vector3;
}

export interface CombatTargets {
  actors: readonly Actor[];
  player: Player;
}

interface Arrow {
  active: boolean;
  fromPlayer: boolean;
  ownerId: number;
  damage: number;
  stats: WeaponStats;
  life: number;
  attackerName: string;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly mesh: THREE.Mesh;
}

const ARROW_POOL = 32;
const ARROW_GRAVITY = 9.2;
const ARROW_SPEED = 62;

/** Запасные направления удара, если прицел прошёл впритирку мимо. */
const MELEE_FORGIVENESS = [-0.07, 0.07, -0.14, 0.14];

/** Повернуть направление вокруг вертикали. */
function rotateAroundY(direction: THREE.Vector3, angle: number): THREE.Vector3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = direction.x * cos + direction.z * sin;
  const z = -direction.x * sin + direction.z * cos;
  direction.x = x;
  direction.z = z;
  return direction;
}

/**
 * Бой: ближние удары, стрелы и разбор попаданий по частям тела.
 *
 * Куда попал — та часть и получает урон. Рубящее оружие отрубает конечности,
 * дробящее калечит, колющее сильнее кровит. Правила одинаковы для игрока и для
 * всех остальных: если стражнику можно отрубить руку, то и вам тоже.
 */
export class CombatSystem {
  readonly group = new THREE.Group();

  /** Номер кадра нужен, чтобы не пересчитывать точки попадания по сто раз. */
  private frame = 0;
  private readonly arrows: Arrow[] = [];
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly segment = new THREE.Vector3();

  constructor(
    private readonly terrain: Terrain,
    private readonly blood: BloodEffects,
    private readonly onEvent: (event: CombatEvent) => void,
  ) {
    this.group.name = 'combat';

    const geometry = new THREE.CylinderGeometry(0.012, 0.012, 0.72, 4);
    geometry.rotateX(Math.PI / 2);
    const material = new THREE.MeshLambertMaterial({ color: 0x6b5540, flatShading: true });

    for (let i = 0; i < ARROW_POOL; i++) {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.arrows.push({
        active: false,
        fromPlayer: false,
        ownerId: -1,
        damage: 0,
        stats: item('bow').weapon as WeaponStats,
        life: 0,
        attackerName: '',
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        mesh,
      });
    }
  }

  beginFrame(): void {
    this.frame++;
  }

  // ── Ближний бой ────────────────────────────────────────────────────────────

  /**
   * Удар игрока. Луч идёт из глаз по направлению взгляда — куда смотришь, туда
   * и бьёшь, включая прицельный удар по руке или по глазу.
   */
  playerMelee(player: Player, targets: CombatTargets): CombatEvent | null {
    const stats = playerWeaponStats(player);
    if (stats.ranged) return null;

    player.getEyePosition(this.origin);
    player.getLookDirection(this.direction);

    // Основной луч идёт точно по прицелу: куда навёл, туда и попал. Это и даёт
    // возможность целенаправленно рубить руку или бить в глаз.
    let victim = this.findActorAlongRay(this.origin, this.direction, stats.range, targets.actors);

    // Если прицел прошёл мимо — пробуем соседние направления. Удар мечом это
    // всё-таки замах, а не укол иглой, и промах в пару сантиметров не должен
    // ощущаться как несправедливость.
    if (!victim) {
      for (const offset of MELEE_FORGIVENESS) {
        player.getLookDirection(this.direction);
        rotateAroundY(this.direction, offset);
        victim = this.findActorAlongRay(this.origin, this.direction, stats.range, targets.actors);
        if (victim) break;
      }
    }

    if (!victim) return null;

    return this.applyHit(
      player.characterName,
      victim.actor,
      victim.part,
      stats.damage * player.wounds.meleeDamageMultiplier,
      stats,
      victim.point,
    );
  }

  /** Удар персонажа мира. Целится в игрока или в другого персонажа. */
  actorMelee(attacker: Actor, targets: CombatTargets): CombatEvent | null {
    const stats = attacker.weaponStats;
    if (stats.ranged) return null;

    this.origin.set(attacker.position.x, attacker.position.y + 1.45, attacker.position.z);
    // Целится не идеально: разброс и делает так, что руки и ноги тоже отлетают.
    aimAt(this.direction, attacker, attacker.target, targets.player, 0.09);

    const damage = stats.damage * attacker.wounds.meleeDamageMultiplier;

    const actorHit = this.findActorAlongRay(this.origin, this.direction, stats.range, targets.actors, attacker.id);
    const playerHit = targets.player.wounds.alive
      ? targets.player.raycast(this.origin, this.direction, stats.range, this.frame)
      : null;

    // Кто ближе, тот и получает.
    if (playerHit && (!actorHit || playerHit.distance <= actorHit.distance)) {
      return this.applyHitToPlayer(attacker.name, targets.player, playerHit.part, damage, stats, playerHit.point);
    }
    if (actorHit) {
      return this.applyHit(attacker.name, actorHit.actor, actorHit.part, damage, stats, actorHit.point);
    }
    return null;
  }

  // ── Стрельба ───────────────────────────────────────────────────────────────

  playerShoot(player: Player): boolean {
    const stats = playerWeaponStats(player);
    if (!stats.ranged) return false;
    if (!player.wounds.canUseTwoHanded) return false;
    if (!player.inventory.remove('arrow', 1)) return false;

    player.getEyePosition(this.origin);
    player.getLookDirection(this.direction);
    this.spawnArrow(this.origin, this.direction, stats, stats.damage, true, -1, player.characterName);
    return true;
  }

  actorShoot(attacker: Actor, targets: CombatTargets): boolean {
    const stats = attacker.weaponStats;
    if (!stats.ranged) return false;
    if (!attacker.wounds.canUseTwoHanded) return false;

    this.origin.set(attacker.position.x, attacker.position.y + 1.5, attacker.position.z);
    aimAt(this.direction, attacker, attacker.target, targets.player, 0.035);
    // Стрела летит по дуге, поэтому берём чуть выше цели.
    this.direction.y += 0.045;
    this.direction.normalize();

    this.spawnArrow(this.origin, this.direction, stats, stats.damage, false, attacker.id, attacker.name);
    return true;
  }

  private spawnArrow(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    stats: WeaponStats,
    damage: number,
    fromPlayer: boolean,
    ownerId: number,
    attackerName: string,
  ): void {
    const arrow = this.arrows.find((candidate) => !candidate.active);
    if (!arrow) return;

    arrow.active = true;
    arrow.fromPlayer = fromPlayer;
    arrow.ownerId = ownerId;
    arrow.damage = damage;
    arrow.stats = stats;
    arrow.life = 6;
    arrow.attackerName = attackerName;
    arrow.position.copy(origin).addScaledVector(direction, 0.6);
    arrow.velocity.copy(direction).multiplyScalar(ARROW_SPEED);
    arrow.mesh.visible = true;
    arrow.mesh.position.copy(arrow.position);
  }

  /** Двигать стрелы и проверять попадания вдоль пройденного за кадр отрезка. */
  update(dt: number, targets: CombatTargets): void {
    for (const arrow of this.arrows) {
      if (!arrow.active) continue;

      arrow.life -= dt;
      if (arrow.life <= 0) {
        this.retireArrow(arrow);
        continue;
      }

      arrow.velocity.y -= ARROW_GRAVITY * dt;
      this.segment.copy(arrow.velocity).multiplyScalar(dt);
      const travelled = this.segment.length();
      if (travelled <= 0) continue;

      this.direction.copy(this.segment).divideScalar(travelled);

      const actorHit = this.findActorAlongRay(
        arrow.position,
        this.direction,
        travelled,
        targets.actors,
        arrow.fromPlayer ? -1 : arrow.ownerId,
      );
      const playerHit =
        !arrow.fromPlayer && targets.player.wounds.alive
          ? targets.player.raycast(arrow.position, this.direction, travelled, this.frame)
          : null;

      if (playerHit && (!actorHit || playerHit.distance <= actorHit.distance)) {
        this.applyHitToPlayer(arrow.attackerName, targets.player, playerHit.part, arrow.damage, arrow.stats, playerHit.point);
        this.retireArrow(arrow);
        continue;
      }
      if (actorHit) {
        this.applyHit(arrow.attackerName, actorHit.actor, actorHit.part, arrow.damage, arrow.stats, actorHit.point);
        this.retireArrow(arrow);
        continue;
      }

      arrow.position.add(this.segment);

      // Воткнулась в землю.
      if (arrow.position.y <= this.terrain.heightAt(arrow.position.x, arrow.position.z)) {
        this.retireArrow(arrow);
        continue;
      }

      arrow.mesh.position.copy(arrow.position);
      arrow.mesh.lookAt(arrow.position.x + arrow.velocity.x, arrow.position.y + arrow.velocity.y, arrow.position.z + arrow.velocity.z);
    }
  }

  private retireArrow(arrow: Arrow): void {
    arrow.active = false;
    arrow.mesh.visible = false;
  }

  // ── Разбор попадания ───────────────────────────────────────────────────────

  private findActorAlongRay(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    actors: readonly Actor[],
    ignoreId = -1,
  ): { actor: Actor; part: BodyPart; distance: number; point: THREE.Vector3 } | null {
    let best: { actor: Actor; part: BodyPart; distance: number; point: THREE.Vector3 } | null = null;

    for (const actor of actors) {
      if (actor.id === ignoreId || !actor.alive) continue;
      const hit = actor.raycast(origin, direction, maxDistance, this.frame);
      if (!hit) continue;
      if (!best || hit.distance < best.distance) best = hit;
    }

    return best;
  }

  private applyHit(
    attackerName: string,
    victim: Actor,
    part: BodyPart,
    damage: number,
    stats: WeaponStats,
    point: THREE.Vector3,
  ): CombatEvent {
    const report = this.damageBody(victim.wounds, part, damage, stats, victim.inventory.armorValue);

    if (report.severed) {
      // Саму конечность с модели снимает система населения: ей же её и ронять
      // на землю, чтобы отрубленная рука осталась лежать на месте боя.
      this.blood.spawn(point.x, point.y, point.z, 26, 4.6);
    } else if (report.applied > 0) {
      this.blood.spawn(point.x, point.y, point.z, 8, 2.2);
    }

    // Получив по спине, разворачиваемся к обидчику.
    if (report.applied > 0 && !victim.target) victim.stateTimer = 0;

    const event: CombatEvent = {
      attackerName,
      victimName: victim.name,
      victim,
      victimIsPlayer: false,
      part,
      damage: report.applied,
      severed: report.severed,
      killed: report.killed,
      message: report.message,
      position: point.clone(),
    };
    this.onEvent(event);
    return event;
  }

  private applyHitToPlayer(
    attackerName: string,
    player: Player,
    part: BodyPart,
    damage: number,
    stats: WeaponStats,
    point: THREE.Vector3,
  ): CombatEvent {
    const report = this.damageBody(player.wounds, part, damage, stats, player.inventory.armorValue);
    player.syncWithWounds();

    if (report.severed) this.blood.spawn(point.x, point.y, point.z, 30, 4.8);
    else if (report.applied > 0) this.blood.spawn(point.x, point.y, point.z, 10, 2.4);

    const event: CombatEvent = {
      attackerName,
      victimName: player.characterName,
      victim: null,
      victimIsPlayer: true,
      part,
      damage: report.applied,
      severed: report.severed,
      killed: report.killed,
      message: report.message,
      position: point.clone(),
    };
    this.onEvent(event);
    return event;
  }

  /**
   * Общий расчёт урона.
   * По конечностям рубящее оружие бьёт с надбавкой — топором руку отрубить
   * заметно проще, чем ножом, а булавой не выйдет вовсе.
   */
  private damageBody(
    wounds: Body,
    part: BodyPart,
    damage: number,
    stats: WeaponStats,
    armor: number,
  ): DamageReport {
    const limbBonus = LIMBS.includes(part) ? Math.max(1, stats.severBonus) : 1;
    return wounds.damage(part, damage * limbBonus, { type: stats.type, armor });
  }
}

function playerWeaponStats(player: Player): WeaponStats {
  return player.inventory.weapon.weapon ?? (item('fists').weapon as WeaponStats);
}

/**
 * Навести направление на цель с разбросом.
 * Разброс — это не только промахи: именно из-за него удар прилетает то в плечо,
 * то в ногу, и конечности разлетаются сами собой.
 */
function aimAt(
  out: THREE.Vector3,
  attacker: Actor,
  target: Actor | null,
  player: Player,
  spread: number,
): THREE.Vector3 {
  const aimX = target ? target.position.x : player.position.x;
  const aimY = (target ? target.position.y : player.position.y) + 1.25;
  const aimZ = target ? target.position.z : player.position.z;

  out.set(
    aimX - attacker.position.x + (Math.random() - 0.5) * spread * 10,
    aimY - (attacker.position.y + 1.45) + (Math.random() - 0.5) * spread * 6,
    aimZ - attacker.position.z + (Math.random() - 0.5) * spread * 10,
  );

  if (out.lengthSq() < 1e-6) out.set(0, 0, -1);
  return out.normalize();
}

/** Человеческое название части тела — для сообщений в журнале. */
export function partName(part: BodyPart): string {
  return PART_NAMES[part];
}
