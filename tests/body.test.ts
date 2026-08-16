import { describe, expect, it } from 'vitest';
import { Body, BodyPart, MAX_BLOOD } from '../src/entities/body';
import { MovementMode } from '../src/entities/movement';

/** Довести часть тела до нуля указанным типом урона. */
function destroy(body: Body, part: BodyPart, type: 'cut' | 'blunt' | 'pierce' = 'cut'): void {
  for (let i = 0; i < 40 && body.get(part).hp > 0 && body.alive; i++) {
    body.damage(part, 15, { type });
  }
}

describe('раны и части тела', () => {
  it('свежее тело целое и здоровое', () => {
    const body = new Body();
    expect(body.alive).toBe(true);
    expect(body.vitality).toBe(1);
    expect(body.blood).toBe(MAX_BLOOD);
    expect(body.isBleeding).toBe(false);
    expect(body.movementMode).toBe(MovementMode.Normal);
  });

  it('броня съедает часть урона', () => {
    const body = new Body();
    const report = body.damage(BodyPart.Torso, 12, { type: 'cut', armor: 9 });
    expect(report.applied).toBe(3);

    const blocked = body.damage(BodyPart.Torso, 5, { type: 'cut', armor: 9 });
    expect(blocked.applied).toBe(0);
  });

  it('рубящий удар отрубает руку, дробящий — нет', () => {
    const cutBody = new Body();
    destroy(cutBody, BodyPart.RightArm, 'cut');
    expect(cutBody.get(BodyPart.RightArm).severed).toBe(true);
    expect(cutBody.isLost(BodyPart.RightArm)).toBe(true);

    const bluntBody = new Body();
    destroy(bluntBody, BodyPart.RightArm, 'blunt');
    expect(bluntBody.get(BodyPart.RightArm).severed).toBe(false);
    expect(bluntBody.get(BodyPart.RightArm).hp).toBe(0);
  });

  it('удар в голову убивает', () => {
    const body = new Body();
    destroy(body, BodyPart.Head);
    expect(body.alive).toBe(false);
    expect(body.deathCause).toBe('beheaded');
  });
});

describe('кровотечение', () => {
  it('отрубленная рука кровит, и без перевязки это смерть', () => {
    const body = new Body();
    destroy(body, BodyPart.LeftArm);

    expect(body.isBleeding).toBe(true);
    // Времени добежать до бинта хватает, но немного: около полуминуты.
    expect(body.secondsUntilBleedOut).toBeGreaterThan(20);
    expect(body.secondsUntilBleedOut).toBeLessThan(45);

    // Прошла минута без помощи.
    for (let i = 0; i < 1200; i++) body.tick(0.05);

    expect(body.alive).toBe(false);
    expect(body.deathCause).toBe('bleeding');
  });

  it('перевязка останавливает кровь и спасает жизнь', () => {
    const body = new Body();
    destroy(body, BodyPart.LeftArm);

    for (let i = 0; i < 40; i++) body.tick(0.05);
    const bandaged = body.bandage();

    expect(bandaged).toBe(BodyPart.LeftArm);
    expect(body.isBleeding).toBe(false);

    for (let i = 0; i < 600; i++) body.tick(0.05);
    expect(body.alive).toBe(true);
    // Рука при этом так и не отросла.
    expect(body.isLost(BodyPart.LeftArm)).toBe(true);
  });

  it('без кровотечения кровь медленно восстанавливается', () => {
    const body = new Body();
    body.blood = 40;
    for (let i = 0; i < 200; i++) body.tick(0.05);
    expect(body.blood).toBeGreaterThan(40);
    expect(body.blood).toBeLessThanOrEqual(MAX_BLOOD);
  });

  it('перевязывать нечего — возвращается null', () => {
    const body = new Body();
    expect(body.bandage()).toBeNull();
  });
});

describe('потеря ноги решает, как теперь передвигаться', () => {
  it('без ноги — только ползком', () => {
    const body = new Body();
    destroy(body, BodyPart.LeftLeg);
    expect(body.movementMode).toBe(MovementMode.Crawl);
  });

  it('с коляской — катится', () => {
    const body = new Body();
    destroy(body, BodyPart.LeftLeg);
    body.hasWheelchair = true;
    expect(body.movementMode).toBe(MovementMode.Wheelchair);
  });

  it('с протезом — снова на ногах, но бегать уже нельзя', () => {
    const body = new Body();
    destroy(body, BodyPart.LeftLeg);
    expect(body.attachProsthetic(BodyPart.LeftLeg)).toBe(true);
    expect(body.movementMode).toBe(MovementMode.Prosthetic);
    expect(body.workingLegs).toBe(2);
  });

  it('протез на целую ногу не поставить', () => {
    const body = new Body();
    expect(body.attachProsthetic(BodyPart.RightLeg)).toBe(false);
  });

  it('протез принимает удар на себя и ломается, не оставляя раны', () => {
    const body = new Body();
    destroy(body, BodyPart.LeftLeg);
    body.attachProsthetic(BodyPart.LeftLeg);
    body.bandage(BodyPart.LeftLeg);

    for (let i = 0; i < 20 && body.get(BodyPart.LeftLeg).prosthetic; i++) {
      body.damage(BodyPart.LeftLeg, 12, { type: 'cut' });
    }

    expect(body.get(BodyPart.LeftLeg).prosthetic).toBe(false);
    expect(body.get(BodyPart.LeftLeg).bleeding).toBe(0);
    expect(body.movementMode).toBe(MovementMode.Crawl);
  });
});

describe('глаза и руки', () => {
  it('выбитый глаз гасит свою половину обзора', () => {
    const body = new Body();
    destroy(body, BodyPart.LeftEye, 'pierce');
    expect(body.visionLoss).toBe('left');
    expect(body.alive).toBe(true);

    destroy(body, BodyPart.RightEye, 'pierce');
    expect(body.visionLoss).toBe('both');
  });

  it('зачарованный глаз убирает черноту, но зрение остаётся мутным', () => {
    const body = new Body();
    destroy(body, BodyPart.LeftEye, 'pierce');
    body.attachProsthetic(BodyPart.LeftEye);
    expect(body.visionLoss).toBe('none');
    expect(body.visionDimming).toBeGreaterThan(0);
  });

  it('одна рука бьёт слабее, без обеих драться нечем', () => {
    const body = new Body();
    expect(body.meleeDamageMultiplier).toBe(1);
    expect(body.canUseTwoHanded).toBe(true);

    destroy(body, BodyPart.RightArm);
    expect(body.workingArms).toBe(1);
    expect(body.canUseTwoHanded).toBe(false);
    expect(body.meleeDamageMultiplier).toBeLessThan(1);
    expect(body.canFight).toBe(true);

    body.bandage();
    destroy(body, BodyPart.LeftArm);
    expect(body.canFight).toBe(false);
  });

  it('по отрубленному бить уже некуда', () => {
    const body = new Body();
    destroy(body, BodyPart.RightArm);
    const report = body.damage(BodyPart.RightArm, 30, { type: 'cut' });
    expect(report.applied).toBe(0);
    expect(report.killed).toBe(false);
  });
});

describe('лечение и сохранение', () => {
  it('лечение затягивает раны, но отрубленное не возвращает', () => {
    const body = new Body();
    body.damage(BodyPart.Torso, 40, { type: 'cut' });
    destroy(body, BodyPart.RightLeg);

    body.heal(100);

    expect(body.get(BodyPart.Torso).hp).toBe(body.get(BodyPart.Torso).maxHp);
    expect(body.isBleeding).toBe(false);
    expect(body.isLost(BodyPart.RightLeg)).toBe(true);
    expect(body.movementMode).toBe(MovementMode.Crawl);
  });

  it('состояние тела переживает сохранение и загрузку', () => {
    const body = new Body();
    destroy(body, BodyPart.LeftArm);
    destroy(body, BodyPart.RightLeg);
    body.attachProsthetic(BodyPart.RightLeg);
    body.hasWheelchair = true;
    body.blood = 61.5;

    const snapshot = JSON.parse(JSON.stringify(body.serialize()));

    const restored = new Body();
    restored.restore(snapshot);

    expect(restored.isLost(BodyPart.LeftArm)).toBe(true);
    expect(restored.get(BodyPart.RightLeg).prosthetic).toBe(true);
    expect(restored.hasWheelchair).toBe(true);
    expect(restored.blood).toBeCloseTo(61.5, 5);
    expect(restored.movementMode).toBe(body.movementMode);
    expect(restored.describeInjuries()).toEqual(body.describeInjuries());
  });

  it('скорость падает от ран и кровопотери', () => {
    const body = new Body();
    expect(body.speedMultiplier).toBeCloseTo(1, 5);

    body.damage(BodyPart.Torso, 70, { type: 'blunt' });
    body.blood = 35;
    expect(body.speedMultiplier).toBeLessThan(0.8);
    expect(body.speedMultiplier).toBeGreaterThanOrEqual(0.25);
  });
});
