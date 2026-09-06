/**
 * The janitor as a rig, not a sprite sheet.
 *
 * Nine raster parts cut from one character sheet (app/public/janitor/
 * parts/), drawn onto a canvas through a small bone hierarchy:
 *
 *   pelvis
 *   ├─ torso ─ head
 *   │        ├─ back upper arm ─ back forearm
 *   │        └─ front upper arm ─ front forearm ─ broom
 *   ├─ back leg
 *   └─ front leg
 *
 * Every pose is a handful of joint angles produced by a function of time
 * and state (walk phase, sweep progress, where the cursor is), so there
 * is nothing to redraw when a motion changes: edit a number. The parts
 * are drawn facing left; the caller flips the whole canvas to face right.
 *
 * Units: "part pixels", the coordinate space of the exported PNGs (half
 * the original sheet). The pelvis is the origin, y down, the floor is
 * at FLOOR_Y. The caller scales so that FIGURE_H maps to --janitor-h.
 */

export type PartName =
  | 'head'
  | 'torso'
  | 'upperarm-a'
  | 'upperarm-b'
  | 'forearm-a'
  | 'forearm-b'
  | 'leg-a'
  | 'leg-b'
  | 'broom';

export type Parts = Record<PartName, HTMLImageElement>;

const PART_FILES: PartName[] = [
  'head', 'torso', 'upperarm-a', 'upperarm-b', 'forearm-a', 'forearm-b', 'leg-a', 'leg-b', 'broom',
];

export function loadParts(): Promise<Parts> {
  return Promise.all(
    PART_FILES.map(
      (n) =>
        new Promise<[PartName, HTMLImageElement]>((res, rej) => {
          const img = new Image();
          img.onload = () => res([n, img]);
          img.onerror = rej;
          img.src = `/janitor/parts/${n}.png`;
        }),
    ),
  ).then((pairs) => Object.fromEntries(pairs) as Parts);
}

/* ---------- geometry (part pixels) --------------------------------- */

// Where each part pivots, in its own pixel space.
const PIVOT = {
  head: { x: 77, y: 113 }, // neck
  torso: { x: 58, y: 157 }, // hips
  upperarm: { x: 21, y: 7 }, // shoulder
  forearm: { x: 16, y: 6 }, // elbow
  leg: { x: 43, y: 14 }, // hip
  broom: { x: 46, y: 154 }, // the hand's grip on the handle
} as const;

// Attachment points on the torso, relative to the hips pivot.
const TORSO_NECK = { x: 8, y: -150 };
const TORSO_SHOULDER_FRONT = { x: -40, y: -132 };
const TORSO_SHOULDER_BACK = { x: 40, y: -132 };
const UPPER_ARM_LEN = 56; // shoulder pivot to elbow
const FOREARM_HAND = 66; // elbow pivot to palm
const HIP_FRONT = { x: -7, y: -6 };
const HIP_BACK = { x: 7, y: -6 };
const LEG_LEN = 238; // hip pivot to sole

/** Floor, below the pelvis, when the legs hang straight. */
export const FLOOR_Y = HIP_FRONT.y + LEG_LEN;
/** Head top to sole, standing. Used to scale him to --janitor-h. */
export const FIGURE_H = FLOOR_Y - (TORSO_NECK.y - 113);

/* ---------- pose ---------------------------------------------------- */

export type Pose = {
  /** Vertical bob of the whole body, part px, negative is up. */
  bob: number;
  torso: number;
  head: number;
  frontLeg: number;
  backLeg: number;
  /** Broom angle in world space: 0 upright, positive = bristles forward. */
  broom: number;
  /** Where the bristles touch, x in pelvis space (negative = in front). */
  broomTipX: number;
  /** Front hand's grip, px from the top of the handle. */
  grip: number;
  /** Both hands on the handle (sweeping) or just the front one. */
  twoHands: boolean;
  /** Back arm when it is free: upper and forearm angles. */
  backUpper: number;
  backFore: number;
};

const deg = (d: number) => (d * Math.PI) / 180;

/**
 * Walk. `phase` advances with distance travelled so the feet match the
 * ground. The broom is carried upright a little ahead of the front foot.
 */
export function walkPose(phase: number, hurry: number, look: number): Pose {
  const s = Math.sin(phase);
  const swing = 26 + 8 * hurry;
  return {
    bob: -4 * (0.5 + 0.5 * Math.cos(2 * phase)),
    torso: 4 + 6 * hurry,
    head: -3 - 4 * hurry + look,
    frontLeg: swing * s,
    backLeg: -swing * s,
    broom: 4 + 3 * Math.sin(phase + 0.6),
    broomTipX: -66 - 6 * s,
    grip: 118,
    twoHands: false,
    backUpper: -22 * s - 6,
    backFore: 12 + 6 * Math.max(0, -s),
  };
}

/** One broom stroke, u in 0..1: wind-up, contact, follow-through. The
 *  bristles stay on the floor and travel from behind his feet to well in
 *  front; the arms follow the handle. */
export function sweepPose(u: number, look: number): Pose {
  const wind = 1 - Math.min(1, u / 0.3);
  const swing = u < 0.3 ? 0 : easeOut((u - 0.3) / 0.5);
  return {
    bob: 3 * (1 - swing),
    torso: 10 + 4 * wind + 6 * swing,
    head: -6 + look,
    frontLeg: 20,
    backLeg: -16,
    broom: -26 * wind + 44 * swing,
    broomTipX: 40 * wind - 150 * swing - 10,
    grip: 52,
    twoHands: true,
    backUpper: 0,
    backFore: 0,
  };
}

/** Leaning on the broom. `breath` 0..1 slow loop. */
export function leanPose(breath: number, look: number): Pose {
  const b = Math.sin(breath * Math.PI * 2);
  return {
    bob: 1.5 * b,
    torso: 6 + 0.8 * b,
    head: -4 + 1.2 * b + look,
    frontLeg: 6,
    backLeg: -12,
    broom: -6,
    broomTipX: -30,
    grip: 60,
    twoHands: false,
    backUpper: -4,
    backFore: 3,
  };
}

function easeOut(t: number) {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
}

/* ---------- draw ---------------------------------------------------- */

const SECOND_GRIP = 84; // part px further down the handle for the back hand
const BROOM_LEN = 386;

/**
 * Draw him with the pelvis at (0,0) of the current transform, in part
 * pixels, facing left. Caller sets translate/scale/flip.
 */
export function drawJanitor(ctx: CanvasRenderingContext2D, p: Parts, pose: Pose) {
  ctx.save();
  ctx.translate(0, pose.bob);

  // Broom in pelvis space: tip on the floor, handle leaning by `broom`.
  const th = deg(pose.broom);
  const along = { x: -Math.sin(th), y: Math.cos(th) }; // unit vector grip -> tip
  const tip = { x: pose.broomTipX, y: FLOOR_Y - pose.bob };
  const gripToTip = BROOM_LEN - pose.grip;
  const grip = { x: tip.x - along.x * gripToTip, y: tip.y - along.y * gripToTip };
  const grip2 = { x: grip.x + along.x * SECOND_GRIP, y: grip.y + along.y * SECOND_GRIP };

  // Shoulders in pelvis space.
  const shF = rot(TORSO_SHOULDER_FRONT, pose.torso);
  const shB = rot(TORSO_SHOULDER_BACK, pose.torso);
  const front = ik(shF, grip);
  const back = pose.twoHands ? ik(shB, grip2) : null;

  leg(ctx, p['leg-b'], HIP_BACK, pose.backLeg);

  // Back arm: behind the torso.
  if (back) armWorld(ctx, p['upperarm-b'], p['forearm-b'], shB, back.upper, back.fore);
  else armWorld(ctx, p['upperarm-b'], p['forearm-b'], shB, pose.torso + pose.backUpper, pose.backFore);

  // Torso + head.
  ctx.save();
  ctx.rotate(deg(pose.torso));
  part(ctx, p.torso, PIVOT.torso, 0, 0, 0);
  ctx.save();
  ctx.translate(TORSO_NECK.x, TORSO_NECK.y);
  ctx.rotate(deg(pose.head));
  ctx.drawImage(p.head, -PIVOT.head.x, -PIVOT.head.y);
  ctx.restore();
  ctx.restore();

  leg(ctx, p['leg-a'], HIP_FRONT, pose.frontLeg);

  // Broom, then the front arm over it so the hand grips the handle.
  ctx.save();
  ctx.translate(grip.x, grip.y);
  ctx.rotate(th);
  ctx.drawImage(p.broom, -PIVOT.broom.x, -pose.grip);
  ctx.restore();
  armWorld(ctx, p['upperarm-a'], p['forearm-a'], shF, front.upper, front.fore);

  ctx.restore();
}

function rot(v: { x: number; y: number }, a: number) {
  const r = deg(a);
  return { x: v.x * Math.cos(r) - v.y * Math.sin(r), y: v.x * Math.sin(r) + v.y * Math.cos(r) };
}

/**
 * Two-bone IK from a shoulder to a hand target. Returns the upper arm's
 * world angle and the forearm's angle relative to it, elbow bent
 * backwards (away from the direction he faces).
 */
function ik(s: { x: number; y: number }, t: { x: number; y: number }) {
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const d = Math.max(8, Math.min(UPPER_ARM_LEN + FOREARM_HAND - 1, Math.hypot(dx, dy)));
  // angle of the shoulder->target line, measured from "straight down",
  // positive toward -x (forward)
  const base = Math.atan2(-dx, dy);
  const cosA = (UPPER_ARM_LEN ** 2 + d * d - FOREARM_HAND ** 2) / (2 * UPPER_ARM_LEN * d);
  const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
  const cosB = (UPPER_ARM_LEN ** 2 + FOREARM_HAND ** 2 - d * d) / (2 * UPPER_ARM_LEN * FOREARM_HAND);
  const b = Math.acos(Math.max(-1, Math.min(1, cosB)));
  // elbow behind him: upper arm swings less forward than the line, forearm bends forward
  const upper = base - a;
  const fore = Math.PI - b;
  return { upper: (upper * 180) / Math.PI, fore: (fore * 180) / Math.PI };
}

function part(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  pivot: { x: number; y: number },
  x: number,
  y: number,
  rotDeg: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(deg(rotDeg));
  ctx.drawImage(img, -pivot.x, -pivot.y);
  ctx.restore();
}

function leg(ctx: CanvasRenderingContext2D, img: HTMLImageElement, hip: { x: number; y: number }, r: number) {
  part(ctx, img, PIVOT.leg, hip.x, hip.y, r);
}

/** Upper arm at a world angle from a world shoulder point, forearm relative. */
function armWorld(
  ctx: CanvasRenderingContext2D,
  upper: HTMLImageElement,
  fore: HTMLImageElement,
  shoulder: { x: number; y: number },
  upperDeg: number,
  foreDeg: number,
) {
  ctx.save();
  ctx.translate(shoulder.x, shoulder.y);
  ctx.rotate(deg(upperDeg));
  ctx.drawImage(upper, -PIVOT.upperarm.x, -PIVOT.upperarm.y);
  ctx.translate(0, UPPER_ARM_LEN);
  ctx.rotate(deg(foreDeg));
  ctx.drawImage(fore, -PIVOT.forearm.x, -PIVOT.forearm.y);
  ctx.restore();
}
