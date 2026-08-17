import * as THREE from 'three';
import { Actor, AiState } from '../entities/actor';
import type { Player } from '../entities/player';
import { MovementMode } from '../entities/movement';
import { Faction, baseHostility } from '../data/factions';
import { distance2D, distanceSq2D } from '../core/math';
import type { Terrain } from '../world/terrain';
import type { Forest } from '../world/forest';
import { hasLineOfSight, type CollisionWorld } from './physics';
import type { CombatSystem, CombatTargets } from './combat';

export interface AiWorld {
  terrain: Terrain;
  forest?: Forest;
  /** Стены поселений: сквозь дворец не ходят. */
  colliders?: CollisionWorld;
  actors: Actor[];
  player: Player;
  combat: CombatSystem;
  targets: CombatTargets;
  /** Насколько игрок сейчас враждебен каждой стороне: 0 — свой, 1 — вне закона. */
  playerHostility: (faction: Faction) => number;
}

/** На каком расстоянии срабатывает удар — чуть меньше дальности оружия. */
function attackReach(actor: Actor): number {
  return actor.weaponStats.ranged ? 2.0 : actor.weaponStats.range * 0.85;
}

/** Момент замаха, в который удар засчитывается. */
const STRIKE_POINT = 0.45;

const separation = new THREE.Vector3();
const toTarget = new THREE.Vector3();

/**
 * Поведение персонажей мира.
 *
 * Ничего сложного: заметил — догнал — ударил, потерял много крови — побежал.
 * Важные детали две. Первая: густой лес прячет — эльфа в чаще замечают вдвое
 * позже, поэтому засады работают. Вторая: раненый ведёт себя как раненый —
 * без ноги он ползёт, с одной рукой бьёт слабее и охотнее отступает.
 */
export function updateActorAi(actor: Actor, dt: number, world: AiWorld): void {
  if (!actor.alive) {
    actor.state = AiState.Dead;
    actor.desiredVelocity.set(0, 0, 0);
    return;
  }

  actor.stateTimer -= dt;

  const threat = findThreat(actor, world);
  actor.target = threat.actor;

  const wantsToFlee =
    actor.wounds.bloodFraction < 0.32 ||
    !actor.wounds.canFight ||
    (actor.movementMode === MovementMode.Crawl && threat.distance < 18);

  if (threat.distance < Infinity && wantsToFlee) {
    flee(actor, threat, dt, world);
    return;
  }

  if (threat.distance < Infinity) {
    engage(actor, threat, dt, world);
    return;
  }

  patrol(actor, dt, world);
}

interface Threat {
  actor: Actor | null;
  isPlayer: boolean;
  x: number;
  y: number;
  z: number;
  distance: number;
}

const NO_THREAT: Threat = { actor: null, isPlayer: false, x: 0, y: 0, z: 0, distance: Infinity };

/** Кого этот персонаж считает противником и видит ли он его. */
function findThreat(actor: Actor, world: AiWorld): Threat {
  let best: Threat = NO_THREAT;
  const sight = actor.sightRange;

  const consider = (
    target: { x: number; y: number; z: number },
    faction: Faction,
    hostility: number,
    candidate: Actor | null,
    isPlayer: boolean,
  ): void => {
    if (hostility < 0.5) return;

    const distance = distance2D(actor.position.x, actor.position.z, target.x, target.z);
    if (distance > sight || distance >= best.distance) return;

    // Густой лес прячет: в чаще противника замечают гораздо позже.
    const cover = world.forest?.coverAt(target.x, target.z) ?? 0;
    const effectiveSight = sight * (1 - cover * 0.62);
    if (distance > effectiveSight) return;

    // Совсем вплотную слышно и без обзора.
    if (
      distance > 3 &&
      !hasLineOfSight(
        world.terrain,
        actor.position.x,
        actor.position.y + 1.5,
        actor.position.z,
        target.x,
        target.y + 1.2,
        target.z,
      )
    ) {
      return;
    }

    best = { actor: candidate, isPlayer, x: target.x, y: target.y, z: target.z, distance };
    void faction;
  };

  for (const other of world.actors) {
    if (other === actor || !other.alive) continue;
    consider(other.position, other.faction, baseHostility(actor.faction, other.faction), other, false);
  }

  const player = world.player;
  if (player.wounds.alive) {
    // Охотнику за головой всё равно, как сторона относится к игроку: ему
    // заплатили за конкретного человека.
    const hostility = actor.huntsPlayer ? 1 : world.playerHostility(actor.faction);
    consider(player.position, player.faction, hostility, null, true);
  }

  return best;
}

/** Догнать и ударить. */
function engage(actor: Actor, threat: Threat, dt: number, world: AiWorld): void {
  actor.faceTowards(threat.x, threat.z, dt, 6);

  const stats = actor.weaponStats;
  const reach = attackReach(actor);

  if (stats.ranged) {
    // Лучник держит дистанцию: слишком близко — отходит, слишком далеко — сближается.
    const preferred = 22;
    if (threat.distance < 11) {
      actor.state = AiState.Flee;
      moveAway(actor, threat, actor.maxSpeed * 0.9, world);
    } else if (threat.distance > 62) {
      actor.state = AiState.Chase;
      moveTowards(actor, threat.x, threat.z, actor.chaseSpeed, world);
    } else {
      actor.state = AiState.Attack;
      actor.desiredVelocity.set(0, 0, 0);
      applySeparation(actor, world);
      if (actor.attackCooldown <= 0 && Math.abs(threat.distance - preferred) < 46) {
        if (actor.startAttack()) actor.attackResolved = false;
      }
    }
  } else if (threat.distance > reach) {
    actor.state = AiState.Chase;
    moveTowards(actor, threat.x, threat.z, actor.chaseSpeed, world);
  } else {
    actor.state = AiState.Attack;
    actor.desiredVelocity.set(0, 0, 0);
    applySeparation(actor, world);
    actor.startAttack();
  }

  resolveSwing(actor, threat, world);
}

/**
 * Довести замах до удара.
 * Удар засчитывается в середине анимации, а не в момент нажатия, — иначе бой
 * выглядит так, будто урон прилетает из воздуха.
 */
function resolveSwing(actor: Actor, threat: Threat, world: AiWorld): void {
  if (actor.attackResolved || actor.attackProgress < STRIKE_POINT) return;
  actor.attackResolved = true;

  if (actor.weaponStats.ranged) {
    world.combat.actorShoot(actor, world.targets);
    return;
  }

  if (threat.distance <= attackReach(actor) + 0.4) {
    world.combat.actorMelee(actor, world.targets);
  }
}

/** Уйти от угрозы. Раненый бежит к своим. */
function flee(actor: Actor, threat: Threat, dt: number, world: AiWorld): void {
  actor.state = AiState.Flee;
  const awayX = actor.position.x * 2 - threat.x;
  const awayZ = actor.position.z * 2 - threat.z;
  actor.faceTowards(awayX, awayZ, dt, 4);
  moveAway(actor, threat, actor.chaseSpeed * 0.95, world);
}

/** Обычная жизнь: походить по своему участку и постоять. */
function patrol(actor: Actor, dt: number, world: AiWorld): void {
  // Сопровождение корована держится телеги, а не своего участка.
  if (actor.hasEscortAnchor) {
    actor.state = AiState.Follow;
    const distance = distance2D(actor.position.x, actor.position.z, actor.escortAnchor.x, actor.escortAnchor.z);

    if (distance < 1.6) {
      actor.desiredVelocity.set(0, 0, 0);
      applySeparation(actor, world);
      // На ходу смотрят вперёд, по направлению обоза.
      actor.faceTowards(actor.escortAnchor.x, actor.escortAnchor.z, dt, 2);
      return;
    }

    // Отстал — догоняет бегом, идёт рядом — шагом.
    const speed = distance > 9 ? actor.chaseSpeed : actor.maxSpeed * 0.8;
    actor.faceTowards(actor.escortAnchor.x, actor.escortAnchor.z, dt, 4);
    moveTowards(actor, actor.escortAnchor.x, actor.escortAnchor.z, speed, world);
    return;
  }

  if (actor.role === 'guard' || actor.role === 'commander' || actor.role === 'merchant') {
    // Часовой стоит на посту и только осматривается.
    actor.state = AiState.Hold;
    actor.desiredVelocity.set(0, 0, 0);
    if (actor.stateTimer <= 0) {
      actor.stateTimer = 3 + Math.random() * 4;
      actor.waypoint.set(
        actor.home.x + (Math.random() - 0.5) * 6,
        0,
        actor.home.z + (Math.random() - 0.5) * 6,
      );
    }
    actor.faceTowards(actor.waypoint.x, actor.waypoint.z, dt, 1.6);
    applySeparation(actor, world);
    return;
  }

  actor.state = AiState.Patrol;

  const reached = distanceSq2D(actor.position.x, actor.position.z, actor.waypoint.x, actor.waypoint.z) < 9;
  if (reached || actor.stateTimer <= 0) {
    actor.stateTimer = 6 + Math.random() * 8;
    const angle = Math.random() * Math.PI * 2;
    const radius = actor.homeRadius * (0.35 + Math.random() * 0.65);
    actor.waypoint.set(actor.home.x + Math.cos(angle) * radius, 0, actor.home.z + Math.sin(angle) * radius);
  }

  actor.faceTowards(actor.waypoint.x, actor.waypoint.z, dt, 3);
  moveTowards(actor, actor.waypoint.x, actor.waypoint.z, actor.maxSpeed * 0.55, world);
}

function moveTowards(actor: Actor, x: number, z: number, speed: number, world: AiWorld): void {
  toTarget.set(x - actor.position.x, 0, z - actor.position.z);
  const length = toTarget.length();
  if (length < 0.001) {
    actor.desiredVelocity.set(0, 0, 0);
    return;
  }
  toTarget.divideScalar(length);
  actor.desiredVelocity.set(toTarget.x * speed, 0, toTarget.z * speed);
  applySeparation(actor, world);
}

function moveAway(actor: Actor, threat: Threat, speed: number, world: AiWorld): void {
  toTarget.set(actor.position.x - threat.x, 0, actor.position.z - threat.z);
  const length = toTarget.length();
  if (length < 0.001) {
    actor.desiredVelocity.set(speed, 0, 0);
    return;
  }
  toTarget.divideScalar(length);
  actor.desiredVelocity.set(toTarget.x * speed, 0, toTarget.z * speed);
  applySeparation(actor, world);
}

/**
 * Расталкивание: физика не разводит персонажей между собой, поэтому без этого
 * отряд слипается в одну точку.
 */
function applySeparation(actor: Actor, world: AiWorld): void {
  separation.set(0, 0, 0);
  let count = 0;

  for (const other of world.actors) {
    if (other === actor || !other.alive) continue;
    const distance = distance2D(actor.position.x, actor.position.z, other.position.x, other.position.z);
    if (distance > 1.4 || distance < 0.001) continue;
    separation.x += (actor.position.x - other.position.x) / distance;
    separation.z += (actor.position.z - other.position.z) / distance;
    count++;
  }

  if (count === 0) return;
  separation.multiplyScalar(1.9 / count);
  actor.desiredVelocity.x += separation.x;
  actor.desiredVelocity.z += separation.z;
}
