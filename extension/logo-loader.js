import * as THREE from "./vendor/three.module.min.js";

// The GRI symbol (the navy square with its white diamond ring) as an extruded,
// bevelled 3D model. The outlines are vectors fitted to the anti-aliased edges
// of the 160x81 logo PNG, in its pixels (y pointing down). The ring is a white
// inlay that stands slightly proud of both faces of the square.
const NAVY = 0x11186b;
const WHITE = 0xffffff;
const SYMBOL_HEIGHT = 1.5; // scene units
const DEPTH = 0.22;
const RING_DEPTH = 0.28;
const BEVEL = 0.025;
const SPIN_RAD_PER_S = 0.9;

const SQUARE = { left: 4.95, top: 6.6, right: 72.05, bottom: 67.85, radius: 5 };
// The diamonds meet at the equator, where each edge steps in by about 5.75px:
// the top halves are wider than the bottom ones.
const CENTER_X = 38.5;
const EQUATOR_Y = 40;
const RING_OUTER = { top: 23.1, bottom: 17.35 };
const RING_INNER = { top: 11.75, bottom: 6 };

const CENTER = { x: CENTER_X, y: (SQUARE.top + SQUARE.bottom) / 2 };
const SCALE = SYMBOL_HEIGHT / (SQUARE.bottom - SQUARE.top);

function point([x, y]) {
  return new THREE.Vector2((x - CENTER.x) * SCALE, -(y - CENTER.y) * SCALE);
}

// Points along a circle; angles are in degrees, clockwise on screen.
function arc(cx, cy, r, from, to, steps) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

function roundedRect({ left, top, right, bottom, radius: r }) {
  return [
    ...arc(right - r, top + r, r, -90, 0, 8),
    ...arc(right - r, bottom - r, r, 0, 90, 8),
    ...arc(left + r, bottom - r, r, 90, 180, 8),
    ...arc(left + r, top + r, r, 180, 270, 8),
  ];
}

// A diamond whose top and bottom halves have different half-widths.
function steppedDiamond({ top, bottom }) {
  return [
    [CENTER_X, EQUATOR_Y - top],
    [CENTER_X + top, EQUATOR_Y],
    [CENTER_X + bottom, EQUATOR_Y],
    [CENTER_X, EQUATOR_Y + bottom],
    [CENTER_X - bottom, EQUATOR_Y],
    [CENTER_X - top, EQUATOR_Y],
  ];
}

// Extrudes `shapes` to `depth`, centred on z = 0 so the symbol spins about its middle.
function extrude(shapes, depth, color) {
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL,
    // Keep the outer edge of the bevel on the traced outline.
    bevelOffset: -BEVEL,
    bevelSegments: 3,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -depth / 2);
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.15 }));
}

function buildSymbol() {
  const outer = steppedDiamond(RING_OUTER).map(point);
  const inner = steppedDiamond(RING_INNER).map(point);

  const square = new THREE.Shape(roundedRect(SQUARE).map(point));
  square.holes.push(new THREE.Path(outer));
  const core = new THREE.Shape(inner);
  const ring = new THREE.Shape(outer);
  ring.holes.push(new THREE.Path(inner));

  const symbol = new THREE.Group();
  symbol.add(extrude([square, core], DEPTH, NAVY), extrude(ring, RING_DEPTH, WHITE));
  return symbol;
}

// Renders the spinning symbol into `container` and returns a function that
// stops the animation and frees the WebGL context.
export function startLogoLoader(container, { width = 80, height = 80 } = {}) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 20);
  camera.position.z = 3.8;
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(1.5, 2, 3);
  scene.add(key);

  const symbol = buildSymbol();
  scene.add(symbol);

  const started = performance.now();
  let frame = 0;
  const render = (now) => {
    symbol.rotation.y = ((now - started) / 1000) * SPIN_RAD_PER_S;
    renderer.render(scene, camera);
    frame = requestAnimationFrame(render);
  };
  frame = requestAnimationFrame(render);

  return () => {
    cancelAnimationFrame(frame);
    scene.traverse((node) => {
      node.geometry?.dispose();
      node.material?.dispose();
    });
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  };
}
