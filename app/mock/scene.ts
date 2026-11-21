import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  EdgesGeometry,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  Shape,
  SRGBColorSpace,
  ShapeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  ARENA_DEPTH_M,
  ARENA_WIDTH_M,
  SCREEN,
  SEAT_LIFT_M,
  STAGE,
  TIERS,
  seatFacing,
  seatPosition,
} from "@/lib/arena";
import type { Point, Venue } from "@/lib/types";

/**
 * The three.js side of the 3D mock: black void, a faint stepped floor with
 * thin-line edges, a glowing white screen and one LED panel per seat, drawn
 * as a single InstancedMesh. Mirrors the participant page's `RoomView`.
 */

const PANEL_SIZE_M = 1.7;
const PANEL_RADIUS_M = 0.42;
/** An unlit LED reads as this much white, like `.loader > i`. */
const UNLIT = 0.08;
const LINE_OPACITY = 0.14;
const MAX_PIXEL_RATIO = 2;

export type MockScene = {
  /** Replaces the panels (and the venue outline when given). */
  setSeats: (seats: readonly (Point | null)[], venue?: Venue) => void;
  /** Latest colours, 3 bytes per seat; drawn on the next animation frame. */
  setFrame: (rgb: Uint8Array) => void;
  dispose: () => void;
};

/** sRGB byte to the linear value for an LED lifted off black by `UNLIT`. */
const LED_LINEAR = Float32Array.from({ length: 256 }, (_, v) => {
  const s = UNLIT + (1 - UNLIT) * (v / 255);
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});

function roundedSquare(size: number, radius: number): ShapeGeometry {
  const h = size / 2;
  const s = new Shape();
  s.moveTo(-h + radius, -h);
  s.lineTo(h - radius, -h);
  s.quadraticCurveTo(h, -h, h, -h + radius);
  s.lineTo(h, h - radius);
  s.quadraticCurveTo(h, h, h - radius, h);
  s.lineTo(-h + radius, h);
  s.quadraticCurveTo(-h, h, -h, h - radius);
  s.lineTo(-h, -h + radius);
  s.quadraticCurveTo(-h, -h, -h + radius, -h);
  return new ShapeGeometry(s, 6);
}

export function createMockScene(container: HTMLElement): MockScene {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false });
  renderer.setClearColor(0x000000, 1);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";

  const scene = new Scene();
  const camera = new PerspectiveCamera(42, 1, 0.5, 600);
  camera.position.set(0, 72, ARENA_DEPTH_M + 44);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 14);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 8;
  controls.maxDistance = 220;
  controls.update();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.2, 0.25, 0.85);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  // -- Static set: stepped floor, stage, screen -----------------------------
  const lineMaterial = track(
    new LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: LINE_OPACITY,
    }),
  );
  const slab = (
    w: number,
    top: number,
    bottom: number,
    d: number,
    cx: number,
    cz: number,
    material: Material,
  ) => {
    const geo = track(new BoxGeometry(w, top - bottom, d));
    const mesh = new Mesh(geo, material);
    mesh.position.set(cx, (top + bottom) / 2, cz);
    scene.add(mesh);
    const edges = track(new EdgesGeometry(geo));
    const lines = new LineSegments(edges, lineMaterial);
    lines.position.copy(mesh.position);
    scene.add(lines);
  };
  // Faint top-to-bottom gradient: far (screen side) 3% white to near 0.6%.
  TIERS.forEach((t, i) => {
    const f = i / Math.max(1, TIERS.length - 1);
    const grey = 0.03 + (0.006 - 0.03) * f;
    const material = track(
      new MeshBasicMaterial({
        color: new Color().setRGB(grey, grey, grey, SRGBColorSpace),
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      }),
    );
    slab(
      ARENA_WIDTH_M,
      t.height,
      -0.4,
      t.zTo - t.zFrom,
      0,
      (t.zFrom + t.zTo) / 2,
      material,
    );
  });
  const stageMaterial = track(
    new MeshBasicMaterial({
      color: new Color().setRGB(0.07, 0.07, 0.07, SRGBColorSpace),
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    }),
  );
  slab(
    STAGE.width,
    STAGE.height,
    -0.4,
    STAGE.depth,
    0,
    STAGE.zFront - STAGE.depth / 2,
    stageMaterial,
  );

  const screenMaterial = track(
    new MeshBasicMaterial({
      color: new Color(1, 1, 1),
      toneMapped: false,
    }),
  );
  const screen = new Mesh(
    track(new PlaneGeometry(SCREEN.width, SCREEN.height)),
    screenMaterial,
  );
  screen.position.set(0, SCREEN.bottom + SCREEN.height / 2, SCREEN.z);
  scene.add(screen);

  // -- Dynamic set: venue outline and panels --------------------------------
  let outline: Line[] = [];
  let panels: InstancedMesh | null = null;
  let panelGeometry: ShapeGeometry | null = null;
  let panelMaterial: MeshBasicMaterial | null = null;
  let seatCount = 0;
  let pending: Uint8Array | null = null;

  const clearDynamic = () => {
    for (const l of outline) {
      scene.remove(l);
      l.geometry.dispose();
    }
    outline = [];
    if (panels) {
      scene.remove(panels);
      panels.dispose();
      panels = null;
    }
    panelGeometry?.dispose();
    panelMaterial?.dispose();
    panelGeometry = null;
    panelMaterial = null;
  };

  const buildOutline = (venue: Venue) => {
    const material = lineMaterial;
    for (const shape of venue.shapes) {
      if (shape.points.length < 2) continue;
      const pts: number[] = [];
      const ring = [...shape.points, shape.points[0]];
      for (let i = 0; i + 1 < ring.length; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        const steps = 64;
        for (let k = 0; k <= steps; k++) {
          const q = {
            x: a.x + ((b.x - a.x) * k) / steps,
            y: a.y + ((b.y - a.y) * k) / steps,
          };
          const p = seatPosition(q);
          pts.push(p.x, p.y - SEAT_LIFT_M + 0.04, p.z);
        }
      }
      const geo = new BufferGeometry();
      geo.setAttribute("position", new Float32BufferAttribute(pts, 3));
      const line = new Line(geo, material);
      scene.add(line);
      outline.push(line);
    }
  };

  const setSeats: MockScene["setSeats"] = (seats, venue) => {
    clearDynamic();
    if (venue) buildOutline(venue);
    seatCount = seats.length;
    if (seatCount === 0) return;
    panelGeometry = roundedSquare(PANEL_SIZE_M, PANEL_RADIUS_M);
    panelMaterial = new MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
    });
    const mesh = new InstancedMesh(panelGeometry, panelMaterial, seatCount);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    const matrix = new Matrix4();
    const quat = new Quaternion();
    const forward = new Vector3(0, 0, 1);
    const colors = new Float32Array(seatCount * 3).fill(LED_LINEAR[0]);
    seats.forEach((seat, i) => {
      if (!seat) {
        matrix.makeScale(0, 0, 0);
      } else {
        const p = seatPosition(seat);
        const n = seatFacing(seat);
        quat.setFromUnitVectors(forward, new Vector3(n.x, n.y, n.z));
        matrix.compose(new Vector3(p.x, p.y, p.z), quat, new Vector3(1, 1, 1));
      }
      mesh.setMatrixAt(i, matrix);
    });
    const attr = new InstancedBufferAttribute(colors, 3);
    attr.setUsage(DynamicDrawUsage);
    mesh.instanceColor = attr;
    scene.add(mesh);
    panels = mesh;
    if (pending) applyFrame(pending);
  };

  const applyFrame = (rgb: Uint8Array) => {
    const attr = panels?.instanceColor;
    if (!attr || rgb.length !== seatCount * 3) return;
    const out = attr.array as Float32Array;
    for (let i = 0; i < rgb.length; i++) out[i] = LED_LINEAR[rgb[i]];
    attr.needsUpdate = true;
  };

  // The latest frame is drawn from the animation loop, not on every message.
  let dirty = false;
  const setFrame: MockScene["setFrame"] = (rgb) => {
    pending = rgb;
    dirty = true;
  };

  const resize = () => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    bloom.resolution.set(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (dirty && pending) {
      applyFrame(pending);
      dirty = false;
    }
    controls.update();
    composer.render();
  };
  raf = requestAnimationFrame(loop);

  return {
    setSeats,
    setFrame,
    dispose: () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      clearDynamic();
      for (const d of disposables) d.dispose();
      composer.dispose();
      bloom.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
