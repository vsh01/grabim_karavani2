import * as THREE from 'three';
import { BodyPart } from './body';
import { Faction, FACTIONS } from '../data/factions';
import { clamp01, damp, lerp } from '../core/math';

/**
 * Человекоподобная модель из простых коробок.
 *
 * Собрана на шарнирах, поэтому руки и ноги можно не только анимировать, но и
 * отрубать: часть просто снимается с шарнира, а на её месте остаётся культя.
 * Одна модель обслуживает и эльфов, и стражу, и разбойников — меняются цвета
 * и головной убор.
 */

interface GeometrySet {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
  stump: THREE.BufferGeometry;
  weapon: THREE.BufferGeometry;
  hood: THREE.BufferGeometry;
  helmet: THREE.BufferGeometry;
}

let sharedGeometry: GeometrySet | null = null;

function geometries(): GeometrySet {
  if (sharedGeometry) return sharedGeometry;
  sharedGeometry = {
    torso: new THREE.BoxGeometry(0.44, 0.62, 0.26),
    head: new THREE.BoxGeometry(0.24, 0.26, 0.24),
    arm: new THREE.BoxGeometry(0.13, 0.58, 0.14),
    leg: new THREE.BoxGeometry(0.16, 0.84, 0.17),
    stump: new THREE.BoxGeometry(0.15, 0.12, 0.16),
    weapon: new THREE.BoxGeometry(0.05, 0.78, 0.11),
    hood: new THREE.ConeGeometry(0.19, 0.3, 6),
    helmet: new THREE.BoxGeometry(0.27, 0.16, 0.27),
  };
  return sharedGeometry;
}

interface MaterialSet {
  cloth: THREE.MeshLambertMaterial;
  accent: THREE.MeshLambertMaterial;
  skin: THREE.MeshLambertMaterial;
  boot: THREE.MeshLambertMaterial;
  steel: THREE.MeshLambertMaterial;
  wound: THREE.MeshLambertMaterial;
}

const materialCache = new Map<Faction, MaterialSet>();

function materials(faction: Faction): MaterialSet {
  const cached = materialCache.get(faction);
  if (cached) return cached;

  const info = FACTIONS[faction];
  const set: MaterialSet = {
    cloth: new THREE.MeshLambertMaterial({ color: info.color, flatShading: true }),
    accent: new THREE.MeshLambertMaterial({ color: info.accent, flatShading: true }),
    skin: new THREE.MeshLambertMaterial({ color: info.skin, flatShading: true }),
    boot: new THREE.MeshLambertMaterial({ color: 0x2e2519, flatShading: true }),
    steel: new THREE.MeshLambertMaterial({ color: 0x9aa2a8, flatShading: true }),
    wound: new THREE.MeshLambertMaterial({ color: 0x7a1f1f, flatShading: true }),
  };
  materialCache.set(faction, set);
  return set;
}

/** Что модель сейчас делает — от этого зависит поза. */
export interface HumanoidState {
  /** Скорость движения в м/с: гонит цикл шага. */
  speed: number;
  /** Идёт замах, 0..1. */
  attack: number;
  /** Ползёт на животе. */
  crawling: boolean;
  /** Мёртв: падает и замирает. */
  dead: boolean;
}

const HIP_HEIGHT = 0.86;

export class Humanoid {
  readonly root = new THREE.Group();

  private readonly hips = new THREE.Group();
  private readonly chest = new THREE.Group();
  private readonly shoulders: Record<'left' | 'right', THREE.Group>;
  private readonly hipJoints: Record<'left' | 'right', THREE.Group>;
  private readonly limbMeshes = new Map<BodyPart, THREE.Mesh>();
  private readonly stumps = new Map<BodyPart, THREE.Mesh>();
  private readonly headMesh: THREE.Mesh;
  private readonly headwear: THREE.Mesh;
  private readonly weaponMesh: THREE.Mesh;

  private walkPhase = Math.random() * Math.PI * 2;
  private fallProgress = 0;
  private leanProgress = 0;

  constructor(readonly faction: Faction, scale = 1) {
    const geometry = geometries();
    const material = materials(faction);

    this.root.name = 'humanoid';
    this.root.scale.setScalar(scale);

    this.hips.position.y = HIP_HEIGHT;
    this.root.add(this.hips);

    // Ноги висят на тазобедренных шарнирах, поэтому вращаются от бедра.
    this.hipJoints = {
      left: new THREE.Group(),
      right: new THREE.Group(),
    };
    this.hipJoints.left.position.set(-0.13, 0, 0);
    this.hipJoints.right.position.set(0.13, 0, 0);
    this.hips.add(this.hipJoints.left, this.hipJoints.right);

    for (const [side, part] of [
      ['left', BodyPart.LeftLeg],
      ['right', BodyPart.RightLeg],
    ] as const) {
      const mesh = new THREE.Mesh(geometry.leg, material.boot);
      mesh.position.y = -0.42;
      mesh.name = part;
      this.hipJoints[side].add(mesh);
      this.limbMeshes.set(part, mesh);

      const stump = new THREE.Mesh(geometry.stump, material.wound);
      stump.position.y = -0.08;
      stump.visible = false;
      this.hipJoints[side].add(stump);
      this.stumps.set(part, stump);
    }

    this.chest.position.y = 0.31;
    this.hips.add(this.chest);

    const torso = new THREE.Mesh(geometry.torso, material.cloth);
    this.chest.add(torso);

    this.headMesh = new THREE.Mesh(geometry.head, material.skin);
    this.headMesh.position.y = 0.45;
    this.headMesh.name = BodyPart.Head;
    this.chest.add(this.headMesh);

    // Головной убор — самый дешёвый способ различать стороны издалека.
    this.headwear = this.createHeadwear(faction, geometry, material);
    this.chest.add(this.headwear);

    this.shoulders = {
      left: new THREE.Group(),
      right: new THREE.Group(),
    };
    this.shoulders.left.position.set(-0.29, 0.24, 0);
    this.shoulders.right.position.set(0.29, 0.24, 0);
    this.chest.add(this.shoulders.left, this.shoulders.right);

    for (const [side, part] of [
      ['left', BodyPart.LeftArm],
      ['right', BodyPart.RightArm],
    ] as const) {
      const mesh = new THREE.Mesh(geometry.arm, material.skin);
      mesh.position.y = -0.29;
      mesh.name = part;
      this.shoulders[side].add(mesh);
      this.limbMeshes.set(part, mesh);

      const stump = new THREE.Mesh(geometry.stump, material.wound);
      stump.position.y = -0.06;
      stump.visible = false;
      this.shoulders[side].add(stump);
      this.stumps.set(part, stump);
    }

    this.weaponMesh = new THREE.Mesh(geometry.weapon, material.steel);
    this.weaponMesh.position.set(0, -0.5, 0.14);
    this.weaponMesh.rotation.x = -0.35;
    this.shoulders.right.add(this.weaponMesh);
  }

  private createHeadwear(faction: Faction, geometry: GeometrySet, material: MaterialSet): THREE.Mesh {
    if (faction === Faction.Palace) {
      const helmet = new THREE.Mesh(geometry.helmet, material.steel);
      helmet.position.y = 0.55;
      return helmet;
    }
    const hood = new THREE.Mesh(geometry.hood, faction === Faction.Elves ? material.accent : material.cloth);
    hood.position.y = 0.6;
    return hood;
  }

  /** Показывать ли оружие в руке. */
  setWeaponVisible(visible: boolean): void {
    this.weaponMesh.visible = visible;
  }

  setWeaponColor(color: number): void {
    // Материал общий на фракцию, поэтому цвет меняем через клон только при нужде.
    if ((this.weaponMesh.material as THREE.MeshLambertMaterial).color.getHex() === color) return;
    this.weaponMesh.material = new THREE.MeshLambertMaterial({ color, flatShading: true });
  }

  /**
   * Снять часть тела с шарнира.
   * Возвращает саму сетку и её мировое положение — чтобы система трупов могла
   * бросить отрубленную конечность на землю.
   */
  severPart(part: BodyPart): { mesh: THREE.Mesh; position: THREE.Vector3; quaternion: THREE.Quaternion } | null {
    if (part === BodyPart.Head) {
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      this.headMesh.getWorldPosition(position);
      this.headMesh.getWorldQuaternion(quaternion);
      this.headMesh.visible = false;
      this.headwear.visible = false;
      return { mesh: this.headMesh, position, quaternion };
    }

    const mesh = this.limbMeshes.get(part);
    if (!mesh || !mesh.visible) return null;

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    mesh.getWorldPosition(position);
    mesh.getWorldQuaternion(quaternion);

    mesh.visible = false;
    const stump = this.stumps.get(part);
    if (stump) stump.visible = true;

    return { mesh, position, quaternion };
  }

  /** Вернуть часть на место — например, когда поставили протез. */
  restorePart(part: BodyPart, prosthetic: boolean): void {
    const mesh = this.limbMeshes.get(part);
    if (!mesh) return;
    mesh.visible = true;
    const stump = this.stumps.get(part);
    if (stump) stump.visible = false;
    if (prosthetic) {
      mesh.material = new THREE.MeshLambertMaterial({ color: 0x6b5540, flatShading: true });
    }
  }

  /** Поза и походка. Вызывается каждый кадр. */
  update(dt: number, state: HumanoidState): void {
    if (state.dead) {
      // Падение: заваливаемся на спину и оседаем.
      this.fallProgress = Math.min(1, this.fallProgress + dt * 2.6);
      const t = this.fallProgress;
      this.root.rotation.x = lerp(0, -Math.PI / 2, t * t);
      this.hips.position.y = lerp(HIP_HEIGHT, 0.24, t);
      return;
    }

    const intensity = clamp01(state.speed / 4.5);
    this.walkPhase += dt * (3.4 + state.speed * 1.5);

    const targetLean = state.crawling ? 1 : 0;
    this.leanProgress = damp(this.leanProgress, targetLean, 0.001, dt);

    // Ползком: тело почти лежит, шага нет — есть подтягивание руками.
    this.root.rotation.x = -this.leanProgress * 1.32;
    this.hips.position.y = lerp(HIP_HEIGHT, 0.3, this.leanProgress);

    const swing = Math.sin(this.walkPhase) * 0.6 * intensity * (1 - this.leanProgress * 0.7);
    this.hipJoints.left.rotation.x = swing;
    this.hipJoints.right.rotation.x = -swing;

    const armSwing = -swing * 0.65;
    this.shoulders.left.rotation.x = armSwing;

    // Правая рука либо машет при ходьбе, либо бьёт.
    if (state.attack > 0) {
      const swingArc = Math.sin(state.attack * Math.PI);
      this.shoulders.right.rotation.x = lerp(0.4, -2.4, swingArc);
      this.shoulders.right.rotation.z = lerp(0, -0.5, swingArc);
    } else {
      this.shoulders.right.rotation.x = -armSwing;
      this.shoulders.right.rotation.z = 0;
    }

    // Лёгкое покачивание при ходьбе.
    this.hips.position.y += Math.abs(Math.sin(this.walkPhase)) * 0.035 * intensity;
    this.chest.rotation.y = Math.sin(this.walkPhase) * 0.09 * intensity;
  }

  /** Мгновенно поставить в позу трупа, без анимации падения. */
  collapse(): void {
    this.fallProgress = 1;
    this.root.rotation.x = -Math.PI / 2;
    this.hips.position.y = 0.24;
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}

/** Отдельная отрубленная конечность, лежащая на земле. */
export function createSeveredLimb(source: THREE.Mesh): THREE.Mesh {
  const limb = new THREE.Mesh(source.geometry, source.material);
  limb.castShadow = false;
  limb.name = `severed-${source.name}`;
  return limb;
}
