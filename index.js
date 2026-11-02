'use strict';
// =====================================================================
// CUBE WORLD: OCEAN IN MOTION
// Everything on screen is the SAME cube model, moved (translated),
// stretched (scaled) and turned (rotated) into place with 4x4 matrices.
//
// File map:
//   1. WebGL setup + shaders
//   2. The one cube model
//   3. CubeBatch: a list of cubes drawn in a single draw call
//   4. Matrix helpers (translation, scaling, rotation, camera)
//   5. Bézier curve helpers
//   6. Level 1: procedural landscape
//   7. Level 2: landscape sampled from images
//   8. Level 3: Bézier waves + Bézier clouds
//   9. Level 4: lighting, skybox, fog, boat, gulls, storm
//  10. Camera (orbit + mouse)
//  11. The render loop
//  12. User interface wiring
// =====================================================================


//WEB GL Setup 
const canvas = document.getElementById('glcanvas');
const gl = canvas.getContext('webgl', { antialias: true });

// "Instancing" lets us draw thousands of copies of the cube with ONE draw
// call. Each copy ("instance") gets its own position, size and colors.
// Drawing 40,000 cubes one call at a time would be far too slow.
const instancing = gl && gl.getExtension('ANGLE_instanced_arrays');
if (!gl || !instancing) {
  document.getElementById('status').hidden = false;
  document.getElementById('status').textContent = 'Sorry, this browser does not support WebGL instancing.';
  throw new Error('WebGL instancing not available');
}

//Write the Vertex and fragment shader setups for WEBGL
const vertexShaderSource = `
  // ---- Per-vertex inputs: the corners of the one cube model ----
  attribute vec3 a_position;   // corner position, cube spans x,z in [-0.5,0.5], y in [0,1]
  attribute vec3 a_normal;     // direction the face points (for lighting)

  // ---- Per-instance inputs: one set per cube copy ----
  attribute vec3  a_offset;      // TRANSLATION: where this cube goes
  attribute vec3  a_scale;       // SCALING: how wide / tall / deep it is
  attribute vec3  a_colorBottom; // color of the 4 bottom corners
  attribute vec3  a_colorTop;    // color of the 4 top corners
  attribute float a_rotY;        // ROTATION around the y axis (radians)

  // ---- Same for the whole draw call ----
  uniform mat4 u_model;       // extra object transform (e.g. a whole cloud or boat)
  uniform mat4 u_view;        // world space  -> camera space  (the camera)
  uniform mat4 u_projection;  // camera space -> clip space    (perspective)

  varying vec3  v_color;
  varying vec3  v_normal;
  varying vec3  v_worldPos;
  varying float v_faceShade;

  vec3 rotateY(vec3 p, float a) {
    float c = cos(a);
    float s = sin(a);
    return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  }

  void main() {
    // Instance transform: scale first, then rotate, then translate.
    vec3 local = rotateY(a_position * a_scale, a_rotY) + a_offset;

    // Then the object (model), camera (view) and lens (projection) transforms.
    vec4 world = u_model * vec4(local, 1.0);
    v_worldPos = world.xyz;
    gl_Position = u_projection * u_view * world;

    // Normals must be divided by the scale (not multiplied) to stay
    // perpendicular to stretched faces (the "inverse transpose" rule).
    vec3 n = rotateY(a_normal / a_scale, a_rotY);
    v_normal = (u_model * vec4(n, 0.0)).xyz;

    // a_position.y is 0 on bottom corners and 1 on top corners, so this picks
    // the bottom color or the top color. The GPU then INTERPOLATES (blends)
    // between them across every face, giving a smooth vertical gradient.
    v_color = mix(a_colorBottom, a_colorTop, a_position.y);

    // Cheap stand-in for lighting, used when real lighting is off:
    // each face gets a fixed brightness so the cube still looks 3D.
    v_faceShade = a_normal.y > 0.5 ? 1.0 : (a_normal.y < -0.5 ? 0.45 : (abs(a_normal.x) > 0.5 ? 0.8 : 0.65));
  }
`;

const fragmentShaderSource = `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
  #else
    precision mediump float;
  #endif

  varying vec3  v_color;
  varying vec3  v_normal;
  varying vec3  v_worldPos;
  varying float v_faceShade;

  uniform float u_emissive;   // 1 = glows on its own (sky, sun): ignore lighting
  uniform float u_lighting;   // 1 = use sun lighting, 0 = use face shade
  uniform float u_fog;        // 1 = blend toward fog color with distance
  uniform float u_specular;   // strength of shiny highlights
  uniform vec3  u_tint;       // multiplies the color (e.g. grey storm clouds)
  uniform vec3  u_lightDir;   // direction TOWARD the sun (or moon)
  uniform vec3  u_lightColor;
  uniform vec3  u_ambient;    // light that comes from everywhere (sky bounce)
  uniform vec3  u_fogColor;
  uniform float u_fogDensity;
  uniform vec3  u_cameraPos;

  void main() {
    vec3 base = v_color * u_tint;
    vec3 color;

    if (u_emissive > 0.5) {
      color = base;
    } else if (u_lighting > 0.5) {
      // Blinn-Phong lighting
      vec3 N = normalize(v_normal);
      vec3 L = normalize(u_lightDir);
      vec3 V = normalize(u_cameraPos - v_worldPos);
      float diffuse = max(dot(N, L), 0.0);        // Lambert: faces toward the sun are brighter
      vec3 H = normalize(L + V);                  // halfway vector
      float spec = diffuse > 0.0 ? pow(max(dot(N, H), 0.0), 48.0) * u_specular : 0.0;
      color = base * (u_ambient + u_lightColor * diffuse) + u_lightColor * spec;
    } else {
      color = base * v_faceShade;
    }

    if (u_fog > 0.5) {
      // Exponential-squared fog: far things fade into the fog color.
      float d = length(v_worldPos - u_cameraPos);
      float f = 1.0 - exp(-pow(d * u_fogDensity, 2.0));
      color = mix(color, u_fogColor, clamp(f, 0.0, 1.0));
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

const program = gl.createProgram();
gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexShaderSource));
gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(gl.getProgramInfoLog(program));
}
gl.useProgram(program);

// Look up every attribute and uniform once.
const attr = {};
for (const name of ['a_position', 'a_normal', 'a_offset', 'a_scale', 'a_colorBottom', 'a_colorTop', 'a_rotY']) {
  attr[name] = gl.getAttribLocation(program, name);
}
const uni = {};
for (const name of ['u_model', 'u_view', 'u_projection', 'u_emissive', 'u_lighting', 'u_fog', 'u_specular',
  'u_tint', 'u_lightDir', 'u_lightColor', 'u_ambient', 'u_fogColor', 'u_fogDensity', 'u_cameraPos']) {
  uni[name] = gl.getUniformLocation(program, name);
}


// =====================================================================
// 2. THE ONE CUBE MODEL
//    A unit cube: x and z from -0.5 to 0.5, y from 0 to 1.
//    Its bottom sits on y = 0, so scaling in y makes it grow UPWARD.
//    6 faces × 2 triangles × 3 corners = 36 vertices.
//    Each vertex: position (x, y, z) then normal (nx, ny, nz).
// =====================================================================
const cubeVertices = new Float32Array([
  // Front (+z)
  -0.5, 0, 0.5,  0, 0, 1,    0.5, 0, 0.5,  0, 0, 1,    0.5, 1, 0.5,  0, 0, 1,
  -0.5, 0, 0.5,  0, 0, 1,    0.5, 1, 0.5,  0, 0, 1,   -0.5, 1, 0.5,  0, 0, 1,
  // Back (-z)
  -0.5, 0, -0.5, 0, 0, -1,   0.5, 1, -0.5, 0, 0, -1,   0.5, 0, -0.5, 0, 0, -1,
  -0.5, 0, -0.5, 0, 0, -1,  -0.5, 1, -0.5, 0, 0, -1,   0.5, 1, -0.5, 0, 0, -1,
  // Top (+y)
  -0.5, 1, -0.5, 0, 1, 0,   -0.5, 1, 0.5,  0, 1, 0,    0.5, 1, 0.5,  0, 1, 0,
  -0.5, 1, -0.5, 0, 1, 0,    0.5, 1, 0.5,  0, 1, 0,    0.5, 1, -0.5, 0, 1, 0,
  // Bottom (-y)
  -0.5, 0, -0.5, 0, -1, 0,   0.5, 0, 0.5,  0, -1, 0,  -0.5, 0, 0.5,  0, -1, 0,
  -0.5, 0, -0.5, 0, -1, 0,   0.5, 0, -0.5, 0, -1, 0,   0.5, 0, 0.5,  0, -1, 0,
  // Right (+x)
   0.5, 0, -0.5, 1, 0, 0,    0.5, 1, -0.5, 1, 0, 0,    0.5, 1, 0.5,  1, 0, 0,
   0.5, 0, -0.5, 1, 0, 0,    0.5, 1, 0.5,  1, 0, 0,    0.5, 0, 0.5,  1, 0, 0,
  // Left (-x)
  -0.5, 0, -0.5, -1, 0, 0,  -0.5, 1, 0.5,  -1, 0, 0,  -0.5, 1, -0.5, -1, 0, 0,
  -0.5, 0, -0.5, -1, 0, 0,  -0.5, 0, 0.5,  -1, 0, 0,  -0.5, 1, 0.5,  -1, 0, 0,
]);
const VERTEX_COUNT = 36;

const cubeBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, cubeBuffer);
gl.bufferData(gl.ARRAY_BUFFER, cubeVertices, gl.STATIC_DRAW);
gl.enableVertexAttribArray(attr.a_position);
gl.vertexAttribPointer(attr.a_position, 3, gl.FLOAT, false, 24, 0);
gl.enableVertexAttribArray(attr.a_normal);
gl.vertexAttribPointer(attr.a_normal, 3, gl.FLOAT, false, 24, 12);

// Per-instance attributes: a divisor of 1 means "advance to the next value
// once per cube copy" instead of once per vertex.
for (const name of ['a_offset', 'a_scale', 'a_colorBottom', 'a_colorTop', 'a_rotY']) {
  gl.enableVertexAttribArray(attr[name]);
  instancing.vertexAttribDivisorANGLE(attr[name], 1);
}


// =====================================================================
// 3. CUBEBATCH: a list of cube instances drawn with one draw call
//    Each cube uses 13 numbers:
//      offset x,y,z | scale x,y,z | bottom r,g,b | top r,g,b | rotY
// =====================================================================
const FLOATS_PER_CUBE = 13;

class CubeBatch {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = capacity;
    this.data = new Float32Array(capacity * FLOATS_PER_CUBE);
    this.buffer = gl.createBuffer();
    this.dirty = true;   // true = data changed, must be re-sent to the GPU
  }

  // Fast version (no arrays created) for code that runs every frame.
  set(i, x, y, z, sx, sy, sz, br, bg, bb, tr, tg, tb, rotY) {
    const d = this.data, o = i * FLOATS_PER_CUBE;
    d[o] = x;      d[o + 1] = y;   d[o + 2] = z;
    d[o + 3] = sx; d[o + 4] = sy;  d[o + 5] = sz;
    d[o + 6] = br; d[o + 7] = bg;  d[o + 8] = bb;
    d[o + 9] = tr; d[o + 10] = tg; d[o + 11] = tb;
    d[o + 12] = rotY || 0;
    this.dirty = true;
  }

  // Friendlier version: colors as [r, g, b] arrays.
  setCube(i, [x, y, z], [sx, sy, sz], bottom, top = bottom, rotY = 0) {
    this.set(i, x, y, z, sx, sy, sz, bottom[0], bottom[1], bottom[2], top[0], top[1], top[2], rotY);
  }

  dispose() { gl.deleteBuffer(this.buffer); }
}

let cubesDrawnThisFrame = 0;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// Draw every cube in the batch. `model` moves the whole batch at once.
function drawBatch(batch, model = IDENTITY) {
  if (!batch || batch.count === 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, batch.buffer);
  if (batch.dirty) {
    gl.bufferData(gl.ARRAY_BUFFER, batch.data.subarray(0, batch.count * FLOATS_PER_CUBE), gl.DYNAMIC_DRAW);
    batch.dirty = false;
  }
  const stride = FLOATS_PER_CUBE * 4;
  gl.vertexAttribPointer(attr.a_offset, 3, gl.FLOAT, false, stride, 0);
  gl.vertexAttribPointer(attr.a_scale, 3, gl.FLOAT, false, stride, 12);
  gl.vertexAttribPointer(attr.a_colorBottom, 3, gl.FLOAT, false, stride, 24);
  gl.vertexAttribPointer(attr.a_colorTop, 3, gl.FLOAT, false, stride, 36);
  gl.vertexAttribPointer(attr.a_rotY, 1, gl.FLOAT, false, stride, 48);
  gl.uniformMatrix4fv(uni.u_model, false, model);
  instancing.drawArraysInstancedANGLE(gl.TRIANGLES, 0, VERTEX_COUNT, batch.count);
  cubesDrawnThisFrame += batch.count;
}

// Material switches for the next draw calls.
function setMaterial({ emissive = 0, specular = 0, tint = [1, 1, 1], fog = env.fogOn } = {}) {
  gl.uniform1f(uni.u_emissive, emissive);
  gl.uniform1f(uni.u_specular, specular);
  gl.uniform3fv(uni.u_tint, tint);
  gl.uniform1f(uni.u_fog, fog ? 1 : 0);
}


// =====================================================================
// 4. MATRIX HELPERS (column-major, the order WebGL expects)
//    In multiply(a, b) the transform b happens FIRST, then a.
// =====================================================================
function translation(x, y, z) {
  return [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  x, y, z, 1];
}
function scaling(sx, sy, sz) {
  return [sx, 0, 0, 0,  0, sy, 0, 0,  0, 0, sz, 0,  0, 0, 0, 1];
}
function rotationX(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0,  0, c, s, 0,  0, -s, c, 0,  0, 0, 0, 1];
}
function rotationY(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, -s, 0,  0, 1, 0, 0,  s, 0, c, 0,  0, 0, 0, 1];
}
function rotationZ(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, 0,  -s, c, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1];
}
function multiply(a, b) {
  const r = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) r[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    }
  }
  return r;
}
// chain(A, B, C) = A * B * C  (C happens first)
function chain(...matrices) { return matrices.reduce(multiply); }

function perspective(fieldOfView, aspect, near, far) {
  const f = 1 / Math.tan(fieldOfView / 2);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// The pinhole camera: sits at `eye`, looks at `target`.
function lookAt(eye, target, up) {
  const zAxis = normalize(sub(eye, target));
  const xAxis = normalize(cross(up, zAxis));
  const yAxis = cross(zAxis, xAxis);
  return [
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -dot(xAxis, eye), -dot(yAxis, eye), -dot(zAxis, eye), 1,
  ];
}

// Small seeded random generator, so "random" scenes can be repeated.
function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


// =====================================================================
// 5. BÉZIER CURVES
//    A cubic Bézier curve blends 4 control points P0..P3 with the
//    Bernstein polynomials:
//      B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3,  t in [0,1]
//    The curve starts at P0, ends at P3, and is "pulled" toward P1, P2.
// =====================================================================
function bezier1(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
// Works for 2D or 3D points: apply the formula to each coordinate.
function bezierPoint(P, t) {
  return P[0].map((_, k) => bezier1(P[0][k], P[1][k], P[2][k], P[3][k], t));
}
// Derivative (direction of travel): B'(t) = 3(1-t)^2 (P1-P0) + 6(1-t)t (P2-P1) + 3t^2 (P3-P2)
function bezierTangent(P, t) {
  const u = 1 - t;
  return P[0].map((_, k) =>
    3 * u * u * (P[1][k] - P[0][k]) + 6 * u * t * (P[2][k] - P[1][k]) + 3 * t * t * (P[3][k] - P[2][k]));
}


// =====================================================================
// SHARED STATE (changed by the controls in the side panel)
// =====================================================================
const WORLD_SIZE = 100;   // the landscape is always 100 units wide; more cubes = smaller cubes

const state = {
  level: '0',
  gridN: 50, seed: 7, heightScale: 12,
  imageRes: 100,
  seaRes: 140, imageSeaScale: 4, waveAmp: 7, waveSpeed: 8, cloudCount: 9, showPaths: false,
  lighting: true, fog: true, skybox: true, extras: true, storm: false, sunAngle: 35, dayCycle: false,
  autoOrbit: true, orbitSpeed: 0.15,
};

let ground = null;            // the main CubeBatch for the current level
let buildToken = 0;           // used to ignore old image loads after switching level
const statusEl = document.getElementById('status');
function showStatus(text) { statusEl.hidden = !text; statusEl.textContent = text || ''; }

function replaceGround(batch) {
  if (ground) ground.dispose();
  ground = batch;
}


// =====================================================================
// 6. LEVEL 0 + LEVEL 1: SINGLE CUBE AND PROCEDURAL LANDSCAPE
// =====================================================================
function buildSingleCube() {
  // Level 0: one 2 x 2 x 2 cube, centered on the origin.
  // Scale the unit cube by 2, then move it down 1 so its center is at y = 0.
  const b = new CubeBatch(1);
  b.setCube(0, [0, -1, 0], [2, 2, 2], [0.2, 0.6, 0.9]);
  replaceGround(b);
}

// Ocean palette: height 0..1 -> deep blue -> teal -> white foam.
const DEEP = [0.03, 0.16, 0.36], TEAL = [0.04, 0.48, 0.62], LIGHT = [0.35, 0.76, 0.84], FOAM = [0.93, 0.97, 1.0];
function oceanColor(n, out) {
  let a, b, t;
  if (n < 0.6)       { a = DEEP;  b = TEAL;  t = n / 0.6; }
  else if (n < 0.85) { a = TEAL;  b = LIGHT; t = (n - 0.6) / 0.25; }
  else               { a = LIGHT; b = FOAM;  t = Math.min(1, (n - 0.85) / 0.15); }
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

// Level 1: a grid of cubes with RANDOM heights and RANDOM colors.
function buildRandomGrid() {
  const N = state.gridN;
  const spacing = WORLD_SIZE / N;
  const size = spacing * 0.85;               // leave a small gap so each cube is visible
  const rand = seededRandom(state.seed);     // same seed = same "random" landscape
  const b = new CubeBatch(N * N);

  let i = 0;
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      // 1a. TRANSLATION: center the grid on the origin in the x-z plane.
      const x = (col - (N - 1) / 2) * spacing;
      const z = (row - (N - 1) / 2) * spacing;

      // 1b. SCALING in y (the direction orthogonal to the x-z plane)
      // by a random amount.
      const height = 0.3 + rand() * state.heightScale;

      // 1c. VERTEX COLORS: a random color for the 4 top corners and a
      // darker random color for the 4 bottom corners. The fragment shader
      // blends (interpolates) between them up each side of the cube.
      const top = [rand(), rand(), rand()];
      const bottom = [rand() * 0.4, rand() * 0.4, rand() * 0.4];

      b.setCube(i++, [x, 0, z], [size, height, size], bottom, top);
    }
  }
  replaceGround(b);
}


// =====================================================================
// 7. LEVEL 2: LANDSCAPE FROM IMAGE DATA
//    Everything comes from one picture, wave2.png:
//      color  = the pixel colors
//      height = the pixel brightness (the image read as grayscale)
// =====================================================================
const IMAGE_SRC = 'wave2.png';
const pixelCache = {};

// Load an image and read ALL its pixels once with getImageData.
function loadPixels(src) {
  if (!pixelCache[src]) {
    pixelCache[src] = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        try {
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          resolve({ width: c.width, height: c.height, data });
        } catch (err) {
          reject(new Error('The browser blocked reading the image pixels. Open this page through a local web server (for example VS Code Live Server or "python3 -m http.server"), not by double-clicking the file.'));
        }
      };
      img.onerror = () => reject(new Error('Could not load ' + src));
      img.src = src;
    });
    pixelCache[src].catch(() => delete pixelCache[src]);
  }
  return pixelCache[src];
}

// SAMPLING: one grid cell covers a rectangle of many pixels
// (e.g. a 1000 px image on a 100-cube grid = 10 x 10 pixels per cube).
// We AVERAGE every pixel in that rectangle, which is a box filter.
// Picking just one pixel would flicker/alias on detailed images.
function averageBlock(img, u0, v0, u1, v1, out) {
  const x0 = Math.floor(u0 * img.width), x1 = Math.max(x0 + 1, Math.floor(u1 * img.width));
  const y0 = Math.floor(v0 * img.height), y1 = Math.max(y0 + 1, Math.floor(v1 * img.height));
  let r = 0, g = 0, b = 0, count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * img.width + x) * 4;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2];
      count++;
    }
  }
  out[0] = r / count / 255; out[1] = g / count / 255; out[2] = b / count / 255;
  return out;
}

// Sample the image into an N x N grid. The image is 882 x 620 (not square),
// so we CROP to the centered 620 x 620 square: the grid is square and the
// picture is not stretched. Returns a color and a brightness (0..1) per cell.
const sampleCache = {};
function sampleSquare(img, N) {
  if (sampleCache[N]) return sampleCache[N];
  const side = Math.min(img.width, img.height);
  const uStart = (img.width - side) / 2 / img.width, uSize = side / img.width;
  const vStart = (img.height - side) / 2 / img.height, vSize = side / img.height;
  const colors = new Float32Array(N * N * 3);
  const brightness = new Float32Array(N * N);
  const c = [0, 0, 0];
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      averageBlock(img,
        uStart + (col / N) * uSize, vStart + (row / N) * vSize,
        uStart + ((col + 1) / N) * uSize, vStart + ((row + 1) / N) * vSize, c);
      const i = row * N + col;
      colors[i * 3] = c[0]; colors[i * 3 + 1] = c[1]; colors[i * 3 + 2] = c[2];
      // Luminance: how bright the pixel looks to a human eye, 0..1.
      brightness[i] = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    }
  }
  return (sampleCache[N] = { N, colors, brightness });
}

async function buildImageTerrain() {
  const token = ++buildToken;
  showStatus('Loading image…');
  let img;
  try {
    img = await loadPixels(IMAGE_SRC);
  } catch (err) {
    if (token === buildToken) showStatus(err.message);
    return;
  }
  if (token !== buildToken) return;   // the user switched levels while loading

  const N = state.imageRes;
  const { colors, brightness } = sampleSquare(img, N);
  const spacing = WORLD_SIZE / N;
  const b = new CubeBatch(N * N);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const i = row * N + col;
      const r = colors[i * 3], g = colors[i * 3 + 1], bl = colors[i * 3 + 2];
      // HEIGHT MAPPING: brightness 0..1 (from 0..255) -> a real height.
      const height = 0.3 + brightness[i] * state.heightScale;
      const x = (col - (N - 1) / 2) * spacing;
      const z = (row - (N - 1) / 2) * spacing;
      b.set(i, x, 0, z, spacing, height, spacing, r * 0.45, g * 0.45, bl * 0.45, r, g, bl, 0);
    }
  }
  replaceGround(b);
  showStatus('');
}


// =====================================================================
// 8. LEVEL 3: BÉZIER WAVES + BÉZIER CLOUDS
// =====================================================================

// ---- 8a. The wave cross-section --------------------------------------
// One wavelength of the sea surface is drawn as TWO cubic Bézier curves
// (x = position across the wave 0..1, y = height 0..1):
//   segment A: the long gentle back of the wave rising to the crest
//   segment B: the steep front face falling back down
// Both have flat tangents at the crest and the ends, so the wave is
// smooth (C1 continuous) and repeats without a seam.
const DEFAULT_WAVE = [
  [[0, 0], [0.35, 0], [0.55, 1], [0.7, 1]],
  [[0.7, 1], [0.84, 1], [0.88, 0], [1, 0]],
];
let waveCurve = DEFAULT_WAVE.map((seg) => seg.map((p) => p.slice()));

// The curve gives points (x(t), y(t)), but we need "height at position x".
// So we sample the curve densely once and store a lookup table (LUT).
const LUT_SIZE = 512;
const waveLUT = new Float32Array(LUT_SIZE);
function rebuildWaveLUT() {
  const pts = [];
  for (const seg of waveCurve) {
    for (let i = 0; i <= 200; i++) pts.push(bezierPoint(seg, i / 200));
  }
  pts.sort((a, b) => a[0] - b[0]);
  let j = 0;
  for (let i = 0; i < LUT_SIZE; i++) {
    const x = i / (LUT_SIZE - 1);
    while (j < pts.length - 2 && pts[j + 1][0] < x) j++;
    const a = pts[j], b = pts[j + 1];
    const t = b[0] > a[0] ? clamp((x - a[0]) / (b[0] - a[0]), 0, 1) : 0;
    waveLUT[i] = a[1] + (b[1] - a[1]) * t;
  }
}
rebuildWaveLUT();

// Height of the wave profile at u (repeats every 1.0).
function waveProfile(u) {
  u -= Math.floor(u);
  const f = u * (LUT_SIZE - 1);
  const i = Math.floor(f);
  const a = waveLUT[i], b = waveLUT[Math.min(i + 1, LUT_SIZE - 1)];
  return a + (b - a) * (f - i);
}

// A second, 1D Bézier bends the crest line so the waves are not
// perfectly straight: the crest is shifted by crestBend(z).
const CREST_BEND = [0, 14, -10, 2];
function crestBend(z) {
  const s = clamp((z + WORLD_SIZE / 2) / WORLD_SIZE, 0, 1);
  return bezier1(CREST_BEND[0], CREST_BEND[1], CREST_BEND[2], CREST_BEND[3], s);
}

const SEA_BASE = 0.6;
const MAIN_WAVELENGTH = 38, SWELL_WAVELENGTH = 16;
function waveAmplitude() { return state.waveAmp * (state.level === '4' && state.storm ? 1.6 : 1); }

// The moving Bézier wave at world point (x, z) and time t: the main wave
// travels along +x, plus a smaller cross swell travelling diagonally.
function waveHeight(x, z, t, bend = crestBend(z)) {
  const amp = waveAmplitude();
  const u1 = (x + bend - t * state.waveSpeed) / MAIN_WAVELENGTH;
  const u2 = (0.55 * x - 0.83 * z - t * state.waveSpeed * 0.6) / SWELL_WAVELENGTH;
  return amp * waveProfile(u1) + amp * 0.2 * waveProfile(u2);
}

// The still sea surface from wave2.png: brightness -> height.
let seaImage = null;   // { N, colors, brightness } once the image is sampled
function imageHeightAt(x, z) {
  if (!seaImage) return 0;
  const N = seaImage.N;
  const col = clamp(Math.round((x / WORLD_SIZE + 0.5) * N - 0.5), 0, N - 1);
  const row = clamp(Math.round((z / WORLD_SIZE + 0.5) * N - 0.5), 0, N - 1);
  return seaImage.brightness[row * N + col] * state.imageSeaScale;
}

// Final sea height = image height + Bézier wave on top.
function seaHeight(x, z, t) {
  return SEA_BASE + imageHeightAt(x, z) + waveHeight(x, z, t);
}

async function loadSeaImage() {
  const N = state.seaRes;
  try {
    const img = await loadPixels(IMAGE_SRC);
    if (state.seaRes !== N) return;   // resolution changed while loading
    seaImage = sampleSquare(img, N);
    // Color the far ocean with the image's average color, a little darker.
    const avg = [0, 0, 0];
    for (let i = 0; i < N * N; i++) for (let k = 0; k < 3; k++) avg[k] += seaImage.colors[i * 3 + k] / (N * N);
    oceanFloor.setCube(0, [0, -0.5, 0], [3000, 1, 3000], avg.map((v) => v * 0.6), avg.map((v) => v * 0.75));
  } catch (err) {
    showStatus(err.message);
  }
}

let sea = null;
function buildSea() {
  if (sea) sea.dispose();
  sea = new CubeBatch(state.seaRes * state.seaRes);
}

// Every frame: re-scale every sea cube to the current wave height.
const tmpColor = [0, 0, 0];
function updateSea(t) {
  const N = state.seaRes;
  const spacing = WORLD_SIZE / N;
  const amp = waveAmplitude();
  const img = seaImage && seaImage.N === N ? seaImage : null;
  let i = 0;
  for (let row = 0; row < N; row++) {
    const z = (row - (N - 1) / 2) * spacing;
    const bend = crestBend(z);
    for (let col = 0; col < N; col++, i++) {
      const x = (col - (N - 1) / 2) * spacing;
      const wave = waveHeight(x, z, t, bend);
      const n = clamp(wave / (amp * 1.15), 0, 1);   // 0 = trough, 1 = crest

      // Base color + still height from the image (blue palette until it loads).
      let r, g, b, imgH = 0;
      if (img) {
        r = img.colors[i * 3]; g = img.colors[i * 3 + 1]; b = img.colors[i * 3 + 2];
        imgH = img.brightness[i] * state.imageSeaScale;
      } else {
        oceanColor(n, tmpColor);
        r = tmpColor[0]; g = tmpColor[1]; b = tmpColor[2];
      }
      // White foam where the Bézier wave is near its crest.
      const foam = smoothstep(0.75, 1, n) * 0.6;
      // Troughs a little darker, crests lighter: makes the rolling wave easy to see.
      const shade = 0.7 + 0.3 * n;
      r *= shade; g *= shade; b *= shade;
      r += (FOAM[0] - r) * foam; g += (FOAM[1] - g) * foam; b += (FOAM[2] - b) * foam;

      const h = SEA_BASE + imgH + wave;
      sea.set(i, x, 0, z, spacing, h, spacing, r * 0.35, g * 0.35, b * 0.35, r, g, b, 0);
    }
  }
}

// A huge flat cube under the sea so the ocean reaches the horizon.
const oceanFloor = new CubeBatch(1);
oceanFloor.setCube(0, [0, -0.5, 0], [3000, 1, 3000], DEEP, DEEP);

// ---- 8b. Clouds that drift along 3D Bézier paths ---------------------
let clouds = [];
let cloudPathMarkers = null;

function makeCloud(rand) {
  // A cloud is 5-10 "puff" cubes, each scaled, rotated and translated.
  const puffCount = 5 + Math.floor(rand() * 6);
  const puffs = new CubeBatch(puffCount);
  for (let i = 0; i < puffCount; i++) {
    const s = [3 + rand() * 5, 1.5 + rand() * 2.5, 2.5 + rand() * 3.5];
    const offset = [(rand() - 0.5) * 10, rand() * 2 - s[1] / 2, (rand() - 0.5) * 5];
    // Gray-blue bottoms and white tops: interpolated like real cloud shading.
    puffs.setCube(i, offset, s, [0.72, 0.76, 0.84], [1, 1, 1], rand() * Math.PI);
  }

  // The path: start far off the west edge, end far off the east edge.
  // P1 and P2 pull the cloud sideways and up/down, making a gentle S-curve.
  const y = 20 + rand() * 12;
  const z = (rand() - 0.5) * 90;
  const path = [
    [-130, y, z],
    [-45, y + (rand() - 0.5) * 14, z + (rand() - 0.5) * 70],
    [45, y + (rand() - 0.5) * 14, z + (rand() - 0.5) * 70],
    [130, y, z + (rand() - 0.5) * 40],
  ];
  return { puffs, path, t: rand(), speed: 1 / (40 + rand() * 40), size: 0.8 + rand() * 0.7 };
}

function buildClouds() {
  for (const c of clouds) c.puffs.dispose();
  const rand = seededRandom(1234);
  clouds = [];
  for (let i = 0; i < state.cloudCount; i++) clouds.push(makeCloud(rand));

  // Little markers along each Bézier path, for the "show paths" option.
  if (cloudPathMarkers) cloudPathMarkers.dispose();
  const SAMPLES = 40;
  cloudPathMarkers = new CubeBatch(Math.max(1, clouds.length * (SAMPLES + 4)));
  cloudPathMarkers.count = clouds.length * (SAMPLES + 4);
  let i = 0;
  for (const c of clouds) {
    for (let s = 0; s < SAMPLES; s++) {
      const p = bezierPoint(c.path, s / (SAMPLES - 1));
      cloudPathMarkers.setCube(i++, p, [0.6, 0.6, 0.6], [1, 0.85, 0.2]);
    }
    for (const p of c.path) cloudPathMarkers.setCube(i++, [p[0], p[1] - 1, p[2]], [2, 2, 2], [1, 0.3, 0.3]);
  }
}

function updateClouds(dt) {
  for (const c of clouds) {
    c.t += c.speed * dt * (state.level === '4' && state.storm ? 2.5 : 1);
    if (c.t > 1) c.t -= 1;   // drifted far away: go back to the start
  }
}

function cloudModel(c) {
  const p = bezierPoint(c.path, c.t);
  const tangent = bezierTangent(c.path, c.t);
  const yaw = Math.atan2(-tangent[2], tangent[0]);   // turn the cloud to face its direction
  // Grow in at the start and shrink out at the end, so clouds never "pop".
  const fade = smoothstep(0, 0.1, c.t) * (1 - smoothstep(0.9, 1, c.t));
  const s = Math.max(0.001, c.size * fade);
  return chain(translation(p[0], p[1], p[2]), rotationY(yaw), scaling(s, s, s));
}


// =====================================================================
// 9. LEVEL 4: LIGHT, SKYBOX, FOG, BOAT, SEAGULLS, STORM
// =====================================================================
const env = {
  fogOn: false,
  lightDir: [0.5, 0.8, 0.3], lightColor: [1, 1, 1], ambient: [0.3, 0.3, 0.3],
  zenith: [0.2, 0.45, 0.85], horizon: [0.7, 0.85, 0.97],
  fogDensity: 0.007, flash: 0, nextFlash: 3,
  sunDir: [0.5, 0.8, 0.3], celestialColor: [1, 0.95, 0.7],
};

// Sky palettes for different sun heights.
const SKY = {
  day:    { zenith: [0.20, 0.45, 0.85], horizon: [0.70, 0.85, 0.97], light: [1.0, 0.96, 0.88], ambient: 0.35 },
  sunset: { zenith: [0.22, 0.24, 0.50], horizon: [0.98, 0.55, 0.32], light: [1.0, 0.62, 0.38], ambient: 0.25 },
  night:  { zenith: [0.01, 0.015, 0.05], horizon: [0.05, 0.07, 0.15], light: [0.35, 0.42, 0.62], ambient: 0.10 },
};
function blendSky(a, b, t) {
  return {
    zenith: mix3(a.zenith, b.zenith, t), horizon: mix3(a.horizon, b.horizon, t),
    light: mix3(a.light, b.light, t), ambient: a.ambient + (b.ambient - a.ambient) * t,
  };
}

function updateEnvironment(dt) {
  if (state.dayCycle) {
    state.sunAngle = (state.sunAngle + dt * 8) % 360;
    syncControl('sunAngle');
  }
  const a = state.sunAngle * Math.PI / 180;
  const sunDir = normalize([Math.cos(a), Math.sin(a), 0.35]);
  const e = sunDir[1];   // sun height: 1 = overhead, negative = below horizon

  let sky;
  if (e >= 0.25) sky = SKY.day;
  else if (e >= 0) sky = blendSky(SKY.sunset, SKY.day, e / 0.25);
  else if (e >= -0.15) sky = blendSky(SKY.night, SKY.sunset, (e + 0.15) / 0.15);
  else sky = SKY.night;

  let zenith = sky.zenith, horizon = sky.horizon, light = sky.light, ambient = sky.ambient;
  // At night, the moon (opposite the sun) becomes the light source.
  env.sunDir = e >= -0.05 ? sunDir : [-sunDir[0], -sunDir[1], -sunDir[2]];
  env.celestialColor = e >= -0.05 ? mix3([1, 0.55, 0.25], [1, 0.97, 0.75], clamp(e * 3, 0, 1)) : [0.85, 0.9, 1.0];

  if (state.storm) {
    const gray = [0.32, 0.35, 0.4];
    const dim = clamp(e + 0.3, 0.15, 1);
    zenith = mix3(zenith, gray.map((v) => v * 0.6 * dim), 0.8);
    horizon = mix3(horizon, gray.map((v) => v * dim), 0.8);
    light = light.map((v) => v * 0.35);
    ambient *= 0.8;
    // Lightning: occasional bright flash that fades quickly.
    env.nextFlash -= dt;
    if (env.nextFlash <= 0) { env.flash = 1; env.nextFlash = 2 + Math.random() * 5; }
  }
  env.flash *= Math.exp(-dt * 9);
  const f = env.flash;

  env.zenith = zenith.map((v) => v + f * 0.6);
  env.horizon = horizon.map((v) => v + f * 0.6);
  env.lightDir = env.sunDir;
  env.lightColor = light;
  env.ambient = [ambient + f * 0.8 + zenith[0] * 0.2, ambient + f * 0.8 + zenith[1] * 0.2, ambient + f * 0.8 + zenith[2] * 0.2];
  env.fogDensity = state.storm ? 0.015 : 0.0065;
}

// ---- Skybox: a giant cube around the camera, horizon color on the
// bottom corners and sky color on the top corners (interpolated). ----
const SKY_SIZE = 800;
const skybox = new CubeBatch(1);
const sunCube = new CubeBatch(1);

// ---- Boat: a few cubes positioned relative to the boat (forward = +x) ----
const boat = new CubeBatch(6);
boat.setCube(0, [0, 0, 0], [4.0, 0.9, 1.7], [0.25, 0.13, 0.06], [0.55, 0.32, 0.15]);           // hull
boat.setCube(1, [2.3, 0.15, 0], [1.0, 0.75, 1.1], [0.25, 0.13, 0.06], [0.55, 0.32, 0.15]);     // bow
boat.setCube(2, [-0.9, 0.9, 0], [1.4, 0.8, 1.2], [0.85, 0.85, 0.8], [0.98, 0.98, 0.95]);       // cabin
boat.setCube(3, [0.5, 0.9, 0], [0.15, 4.5, 0.15], [0.35, 0.2, 0.1], [0.45, 0.28, 0.14]);       // mast
boat.setCube(4, [1.25, 1.5, 0], [1.3, 3.4, 0.08], [0.88, 0.86, 0.8], [1, 1, 1]);              // sail
boat.setCube(5, [0.85, 5.0, 0], [0.6, 0.4, 0.05], [0.9, 0.15, 0.15], [1, 0.25, 0.2]);         // flag
let boatPitch = 0, boatRoll = 0;

function boatModel(t) {
  const x = 0, z = 0, d = 1.0;
  const h = seaHeight(x, z, t);
  // Tilt the boat to match the slope of the water (finite differences).
  const slopeX = (seaHeight(x + d, z, t) - seaHeight(x - d, z, t)) / (2 * d);
  const slopeZ = (seaHeight(x, z + d, t) - seaHeight(x, z - d, t)) / (2 * d);
  boatPitch += (clamp(Math.atan(slopeX), -0.6, 0.6) - boatPitch) * 0.15;
  boatRoll += (clamp(-Math.atan(slopeZ), -0.4, 0.4) - boatRoll) * 0.15;
  return chain(translation(x, h - 0.5, z), rotationZ(boatPitch), rotationX(boatRoll), scaling(1.6, 1.6, 1.6));
}

// ---- Seagulls: fly in circles made from 4 Bézier segments ----
// A quarter circle is closely approximated by a cubic Bézier whose
// handles are k = 0.5523 x radius long.
const gullBody = new CubeBatch(3);
gullBody.setCube(0, [0, -0.2, 0], [0.5, 0.45, 1.8], [0.85, 0.85, 0.85], [1, 1, 1]);   // body
gullBody.setCube(1, [0, 0.0, 1.0], [0.42, 0.42, 0.5], [0.9, 0.9, 0.9], [1, 1, 1]);   // head
gullBody.setCube(2, [0, 0.08, 1.35], [0.12, 0.1, 0.35], [1, 0.6, 0.1]);               // beak
const gullWing = new CubeBatch(1);
gullWing.setCube(0, [1.3, 0, 0], [2.6, 0.1, 0.8], [0.55, 0.58, 0.62], [0.85, 0.87, 0.9]);

function makeCirclePath(center, r) {
  const k = 0.5523 * r;
  const segments = [];
  for (let q = 0; q < 4; q++) {
    const a0 = q * Math.PI / 2, a1 = a0 + Math.PI / 2;
    const A = [center[0] + r * Math.cos(a0), center[1], center[2] + r * Math.sin(a0)];
    const B = [center[0] + r * Math.cos(a1), center[1] + (q % 2 ? -1.5 : 1.5), center[2] + r * Math.sin(a1)];
    const tA = [-Math.sin(a0), 0, Math.cos(a0)], tB = [-Math.sin(a1), 0, Math.cos(a1)];
    segments.push([A, [A[0] + k * tA[0], A[1], A[2] + k * tA[2]], [B[0] - k * tB[0], B[1], B[2] - k * tB[2]], B]);
  }
  // Keep the heights continuous where segments meet.
  for (let q = 0; q < 4; q++) segments[q][0][1] = segments[(q + 3) % 4][3][1];
  return segments;
}
const gulls = [];
{
  const rand = seededRandom(99);
  for (let i = 0; i < 6; i++) {
    const center = [(rand() - 0.5) * 50, 14 + rand() * 10, (rand() - 0.5) * 50];
    gulls.push({ path: makeCirclePath(center, 8 + rand() * 10), phase: rand() * 4, speed: 0.12 + rand() * 0.1, flapPhase: rand() * 6 });
  }
}

function drawGulls(t) {
  for (const g of gulls) {
    const s = (g.phase + t * g.speed) % 4;
    const seg = g.path[Math.floor(s)];
    const local = s - Math.floor(s);
    const p = bezierPoint(seg, local);
    const tan = bezierTangent(seg, local);
    const yaw = Math.atan2(tan[0], tan[2]);   // local +z (beak) faces the direction of travel
    const G = chain(translation(p[0], p[1], p[2]), rotationY(yaw), rotationZ(-0.25));
    const flap = Math.sin(t * 7 + g.flapPhase) * 0.55;
    drawBatch(gullBody, G);
    drawBatch(gullWing, chain(G, translation(0.2, 0.05, 0), rotationZ(flap)));                     // right wing
    drawBatch(gullWing, chain(G, translation(-0.2, 0.05, 0), rotationY(Math.PI), rotationZ(flap))); // left wing (mirrored)
  }
}

// ---- Rain: thin falling cubes ----
const RAIN_COUNT = 2000;
const rain = new CubeBatch(RAIN_COUNT);
const rainDrops = [];
{
  const rand = seededRandom(5);
  for (let i = 0; i < RAIN_COUNT; i++) {
    rainDrops.push({ x: (rand() - 0.5) * 130, y: rand() * 70, z: (rand() - 0.5) * 130, v: 45 + rand() * 25 });
  }
}
function updateRain(dt) {
  for (let i = 0; i < RAIN_COUNT; i++) {
    const d = rainDrops[i];
    d.y -= d.v * dt;
    if (d.y < 0) { d.y += 70; d.x = (Math.random() - 0.5) * 130; d.z = (Math.random() - 0.5) * 130; }
    rain.set(i, d.x, d.y, d.z, 0.07, 1.4, 0.07, 0.55, 0.6, 0.7, 0.75, 0.8, 0.9, 0);
  }
}


// =====================================================================
// 10. CAMERA: orbits the look-at point; drag to turn, scroll to zoom
// =====================================================================
const camera = { yaw: 0.8, pitch: 0.5, radius: 120, target: [0, 0, 0], minR: 3, maxR: 400 };

function cameraEye() {
  const cp = Math.cos(camera.pitch);
  return [
    camera.target[0] + camera.radius * cp * Math.cos(camera.yaw),
    camera.target[1] + camera.radius * Math.sin(camera.pitch),
    camera.target[2] + camera.radius * cp * Math.sin(camera.yaw),
  ];
}

let dragging = null;
canvas.addEventListener('pointerdown', (e) => { dragging = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  camera.yaw += (e.clientX - dragging.x) * 0.006;
  camera.pitch = clamp(camera.pitch + (e.clientY - dragging.y) * 0.006, 0.03, 1.5);
  dragging = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', () => { dragging = null; });
canvas.addEventListener('pointercancel', () => { dragging = null; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camera.radius = clamp(camera.radius * Math.exp(e.deltaY * 0.001), camera.minR, camera.maxR);
}, { passive: false });


// =====================================================================
// LEVEL DESCRIPTIONS (shown in the side panel)
// =====================================================================
const LEVELS = {
  '0': {
    tab: 'Level 0 · Cube',
    camera: { radius: 8, pitch: 0.45, target: [0, 0, 0], minR: 3, maxR: 40 },
    info: `<h2>Level 0: a single cube</h2>
      <p>One 2 × 2 × 2 cube centered on the origin. The model is a unit cube
      (36 vertices = 6 faces × 2 triangles × 3 corners). Its model matrix
      scales it by 2 and translates it down by 1 so its center sits at (0, 0, 0).</p>
      <ul><li><b>Pinhole camera:</b> <code>lookAt(eye, target, up)</code> + perspective projection.</li>
      <li>Each face gets a fixed brightness so the cube reads as 3D.</li></ul>`,
  },
  '1': {
    tab: 'Level 1 · Random grid',
    camera: { radius: 115, pitch: 0.5, target: [0, 2, 0], minR: 10, maxR: 400 },
    info: `<h2>Level 1: random cube landscape</h2>
      <ul><li><b>1a Translation:</b> the same cube is copied into a grid on the x-z
      plane, each copy moved to <code>(x, 0, z)</code>. The landscape is always 100
      units wide, so a higher resolution means more, smaller cubes. All copies
      are drawn in <b>one draw call</b> (instancing); watch the frame rate.</li>
      <li><b>1b Scaling:</b> each cube is stretched in y by a random amount. The
      model's bottom sits at y = 0, so it grows upward.
      Model matrix = <code>translate(x, 0, z) × scale(s, h, s)</code>.</li>
      <li><b>1c Vertex colors:</b> the 4 top corners get a random color and the
      4 bottom corners a darker random color. The GPU <b>interpolates</b> between
      them, so each side shows a gradient.</li>
      <li><b>1d Camera path:</b> the camera moves on a circle,
      <code>eye = (r cos θ, h, r sin θ)</code>, with θ growing over time, and always
      looks at the center. Drag to move it yourself.</li></ul>`,
  },
  '2': {
    tab: 'Level 2 · Image data',
    camera: { radius: 115, pitch: 0.6, target: [0, 2, 0], minR: 10, maxR: 400 },
    info: `<h2>Level 2: landscape from an image</h2>
      <p><code>wave2.png</code> is read with <code>getImageData</code>. Its colors
      color the cubes, and its brightness (the image as grayscale) sets their heights.</p>
      <ul><li><b>Square grid:</b> the image is 882 × 620, so we crop the centered
      620 × 620 square. The grid is N × N and the picture is not stretched.</li>
      <li><b>Sampling:</b> each cube covers a block of pixels (620 px on a
      100-cube grid ≈ 6 × 6 pixels). The cube takes the <b>average</b> of that
      block (a box filter), which avoids noisy, flickering results.</li>
      <li><b>Height:</b> brightness <code>0.299R + 0.587G + 0.114B</code>, 0-255 → 0-1,
      then <code>height = 0.3 + brightness × heightScale</code>.</li>
      <li>Start at a low resolution and step up to 400 cubes wide on a fast computer.</li></ul>`,
  },
  '3': {
    tab: 'Level 3 · Bézier sea + clouds',
    camera: { radius: 110, pitch: 0.28, target: [0, 12, 0], minR: 10, maxR: 400 },
    info: `<h2>Level 3: Bézier waves and clouds</h2>
      <p><b>Sea = image + Bézier wave.</b> Each sea cube's height is</p>
      <p><code>height = brightness(wave2.png) × imageHeight + wave(x, z, time)</code></p>
      <ul><li><b>Image part:</b> the whirlpool from Level 2 gives the still surface and
      the colors.</li>
      <li><b>Bézier part:</b> one wavelength is two cubic Bézier curves,
      <code>B(t) = (1−t)³P0 + 3(1−t)²t P1 + 3(1−t)t² P2 + t³P3</code>: a gentle back
      and a steep front. Every frame it is evaluated at
      <code>(x − speed·time) / wavelength</code>, so the wave rolls across the image.
      A 1D Bézier bends the crest line, and cubes near a crest turn to white foam.
      Drag the dots below to reshape the wave.</li></ul>
      <p><b>Clouds:</b> 5-10 cubes each, scaled, rotated and translated into a puff.
      Each cloud follows a 3D cubic Bézier path, turns to face its tangent
      <code>B'(t)</code>, and returns to the start when it drifts too far.</p>`,
  },
  '4': {
    tab: 'Level 4 · Full scene',
    camera: { radius: 85, pitch: 0.2, target: [0, 9, 0], minR: 10, maxR: 380 },
    info: `<h2>Level 4: light, sky and atmosphere</h2>
      <ul><li><b>Lighting:</b> Blinn-Phong. Diffuse = max(N·L, 0); specular uses the
      halfway vector for sun glints on the water.</li>
      <li><b>Skybox:</b> a huge cube centered on the camera; horizon color on its
      bottom corners and sky color on top, blended by interpolation.</li>
      <li><b>Fog:</b> distance-based exponential fog fades the far sea into the horizon.</li>
      <li><b>Boat:</b> rides the Bézier wave and tilts with the water slope.</li>
      <li><b>Seagulls:</b> circle on four Bézier quarter-circles; wings flap by rotation.</li>
      <li><b>Storm:</b> rain cubes, lightning flashes, bigger waves, grey clouds.</li></ul>`,
  },
};


// =====================================================================
// 11. THE RENDER LOOP
// =====================================================================
gl.enable(gl.DEPTH_TEST);

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  gl.viewport(0, 0, canvas.width, canvas.height);
}

const hud = document.getElementById('hud');
let lastTime = 0, fpsTime = 0, fpsFrames = 0, fps = 0, simTime = 0;

function render(nowMs) {
  const now = nowMs / 1000;
  const dt = Math.min(0.1, now - lastTime || 0);
  lastTime = now;
  simTime += dt;
  resizeCanvas();
  cubesDrawnThisFrame = 0;
  const level = state.level;
  const isSea = level === '3' || level === '4';
  const full = level === '4';

  // ---- Camera (Level 1d: orbit around the look-at point) ----
  if (state.autoOrbit && !dragging) camera.yaw += state.orbitSpeed * dt;
  const eye = cameraEye();
  gl.uniformMatrix4fv(uni.u_view, false, lookAt(eye, camera.target, [0, 1, 0]));
  gl.uniformMatrix4fv(uni.u_projection, false,
    perspective(Math.PI / 4, canvas.width / canvas.height, level === '0' ? 0.1 : 0.5, 3000));
  gl.uniform3fv(uni.u_cameraPos, eye);

  // ---- Lighting / fog settings ----
  if (full) updateEnvironment(dt);
  env.fogOn = full && state.fog;
  gl.uniform1f(uni.u_lighting, full && state.lighting ? 1 : 0);
  gl.uniform3fv(uni.u_lightDir, env.lightDir);
  gl.uniform3fv(uni.u_lightColor, env.lightColor);
  gl.uniform3fv(uni.u_ambient, env.ambient);
  gl.uniform3fv(uni.u_fogColor, env.horizon);
  gl.uniform1f(uni.u_fogDensity, env.fogDensity);

  // ---- Clear ----
  if (full) gl.clearColor(env.horizon[0], env.horizon[1], env.horizon[2], 1);
  else if (isSea) gl.clearColor(0.62, 0.8, 0.95, 1);
  else gl.clearColor(0.06, 0.09, 0.13, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // ---- Skybox and sun (drawn first, without writing depth, so
  //      everything else is drawn in front of them) ----
  if (full && state.skybox) {
    gl.depthMask(false);
    setMaterial({ emissive: 1, fog: false });
    skybox.setCube(0, [0, -SKY_SIZE * 0.2, 0], [SKY_SIZE, SKY_SIZE, SKY_SIZE], env.horizon, env.zenith);
    drawBatch(skybox, translation(eye[0], eye[1], eye[2]));
    const c = env.celestialColor;
    sunCube.setCube(0, [0, -10, 0], [20, 20, 20], c, c, Math.PI / 4);
    const sp = env.sunDir;
    drawBatch(sunCube, chain(translation(eye[0] + sp[0] * 330, eye[1] + sp[1] * 330, eye[2] + sp[2] * 330), rotationX(0.6)));
    gl.depthMask(true);
  }

  if (isSea) {
    // ---- The Bézier sea ----
    updateSea(simTime);
    setMaterial({ specular: 0.9 });
    drawBatch(oceanFloor);
    drawBatch(sea);

    // ---- Clouds ----
    updateClouds(dt);
    const cloudTint = full && state.storm ? [0.45, 0.47, 0.52] : [1, 1, 1];
    setMaterial({ tint: cloudTint });
    for (const c of clouds) drawBatch(c.puffs, cloudModel(c));
    if (state.showPaths) { setMaterial({ emissive: 1, fog: false }); drawBatch(cloudPathMarkers); }

    if (full && state.extras) {
      setMaterial({ specular: 0.3 });
      drawBatch(boat, boatModel(simTime));
      setMaterial();
      drawGulls(simTime);
    }
    if (full && state.storm) {
      updateRain(dt);
      setMaterial({ emissive: 1 });
      drawBatch(rain);
    }
  } else {
    setMaterial();
    drawBatch(ground);
  }

  // ---- Frame rate counter ----
  fpsFrames++;
  if (now - fpsTime > 0.5) {
    fps = Math.round(fpsFrames / (now - fpsTime));
    fpsTime = now;
    fpsFrames = 0;
    hud.textContent = `${fps} fps · ${cubesDrawnThisFrame.toLocaleString()} cubes`;
  }

  requestAnimationFrame(render);
}


// =====================================================================
// 12. USER INTERFACE
// =====================================================================
function rebuild() {
  buildToken++;
  showStatus('');
  const level = state.level;
  if (level === '0') buildSingleCube();
  else if (level === '1') buildRandomGrid();
  else if (level === '2') buildImageTerrain();
  else {
    if (!sea || sea.capacity !== state.seaRes * state.seaRes) buildSea();
    if (!seaImage || seaImage.N !== state.seaRes) loadSeaImage();
    if (clouds.length !== state.cloudCount) buildClouds();
  }
}

function setLevel(level) {
  state.level = level;
  const cfg = LEVELS[level];
  Object.assign(camera, cfg.camera, { target: cfg.camera.target.slice() });
  document.getElementById('level-info').innerHTML = cfg.info;
  for (const btn of document.querySelectorAll('#tabs button')) btn.classList.toggle('active', btn.dataset.level === level);
  for (const el of document.querySelectorAll('[data-levels]')) el.hidden = !el.dataset.levels.split(' ').includes(level);
  rebuild();
  if (level === '3' || level === '4') drawWaveEditor();
}

// Build the tab buttons.
const tabs = document.getElementById('tabs');
// (An explicit list, because objects put number-like keys such as '2' first.)
for (const key of ['0', '1', '2', '3', '4']) {
  const cfg = LEVELS[key];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = cfg.tab;
  btn.dataset.level = key;
  btn.addEventListener('click', () => setLevel(key));
  tabs.appendChild(btn);
}

// Connect every input with a data-key to the matching state value.
const REBUILD_ON = new Set(['gridN', 'heightScale', 'imageRes', 'seaRes', 'cloudCount']);
function syncControl(key) {
  const out = document.querySelector(`[data-out="${key}"]`);
  if (out) out.textContent = key === 'sunAngle' ? `${Math.round(state[key])}°` : state[key];
  const input = document.querySelector(`[data-key="${key}"]`);
  if (input && input.type === 'range' && document.activeElement !== input) input.value = state[key];
}
for (const input of document.querySelectorAll('[data-key]')) {
  const key = input.dataset.key;
  const read = () => {
    if (input.type === 'checkbox') return input.checked;
    const v = input.value;
    return typeof state[key] === 'number' ? Number(v) : v;
  };
  if (input.type === 'checkbox') input.checked = state[key];
  else input.value = state[key];
  syncControl(key);
  // Range sliders update live; heavy rebuilds happen when they are released.
  input.addEventListener('input', () => {
    state[key] = read();
    syncControl(key);
    if (REBUILD_ON.has(key) && input.type !== 'range') rebuild();
  });
  input.addEventListener('change', () => {
    state[key] = read();
    if (REBUILD_ON.has(key) && input.type === 'range') rebuild();
  });
}

document.getElementById('reroll').addEventListener('click', () => {
  state.seed = Math.floor(Math.random() * 100000);
  rebuild();
});
document.getElementById('reset-camera').addEventListener('click', () => {
  const cfg = LEVELS[state.level].camera;
  Object.assign(camera, cfg, { target: cfg.target.slice(), yaw: 0.8 });
});

// ---- Interactive Bézier wave editor (2D canvas) ----
const editorCanvas = document.getElementById('bezier-editor');
const ectx = editorCanvas.getContext('2d');
const EDIT_PAD = 14, Y_MIN = -0.2, Y_MAX = 1.45;
const toScreen = ([x, y]) => [
  EDIT_PAD + x * (editorCanvas.width - 2 * EDIT_PAD),
  editorCanvas.height - EDIT_PAD - (y - Y_MIN) / (Y_MAX - Y_MIN) * (editorCanvas.height - 2 * EDIT_PAD),
];
const toCurve = (sx, sy) => [
  (sx - EDIT_PAD) / (editorCanvas.width - 2 * EDIT_PAD),
  Y_MIN + (editorCanvas.height - EDIT_PAD - sy) / (editorCanvas.height - 2 * EDIT_PAD) * (Y_MAX - Y_MIN),
];
// The draggable points: two handles of each segment plus the shared crest.
const editorHandles = () => [
  { id: 'A1', p: waveCurve[0][1] }, { id: 'A2', p: waveCurve[0][2] },
  { id: 'crest', p: waveCurve[0][3] },
  { id: 'B1', p: waveCurve[1][1] }, { id: 'B2', p: waveCurve[1][2] },
];

function enforceWaveRules() {
  // Control points must stay in left-to-right order so each x has one height.
  const [A, B] = waveCurve;
  const c = A[3];
  c[0] = clamp(c[0], 0.1, 0.95);
  c[1] = clamp(c[1], 0.2, 1.4);
  for (const p of [A[1], A[2], B[1], B[2]]) p[1] = clamp(p[1], Y_MIN, Y_MAX);
  A[1][0] = clamp(A[1][0], 0, c[0]);
  A[2][0] = clamp(A[2][0], A[1][0], c[0]);
  B[1][0] = clamp(B[1][0], c[0], 1);
  B[2][0] = clamp(B[2][0], B[1][0], 1);
  B[0][0] = c[0]; B[0][1] = c[1];   // segment B starts where A ends
}

// Colors come from CSS variables in style.css, so they follow light/dark mode.
const cssColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawWaveEditor() {
  const w = editorCanvas.width, h = editorCanvas.height;
  ectx.clearRect(0, 0, w, h);
  // Baseline (height 0) and crest guide (height 1)
  ectx.strokeStyle = cssColor('--editor-grid');
  ectx.lineWidth = 1;
  for (const y of [0, 1]) {
    const [, sy] = toScreen([0, y]);
    ectx.beginPath(); ectx.moveTo(EDIT_PAD, sy); ectx.lineTo(w - EDIT_PAD, sy); ectx.stroke();
  }
  // Control polygons
  ectx.setLineDash([4, 4]);
  ectx.strokeStyle = cssColor('--editor-polygon');
  for (const seg of waveCurve) {
    ectx.beginPath();
    seg.forEach((p, i) => { const [sx, sy] = toScreen(p); i ? ectx.lineTo(sx, sy) : ectx.moveTo(sx, sy); });
    ectx.stroke();
  }
  ectx.setLineDash([]);
  // The curve itself, filled like water
  ectx.beginPath();
  ectx.moveTo(...toScreen([0, Y_MIN]));
  for (const seg of waveCurve) {
    for (let i = 0; i <= 60; i++) ectx.lineTo(...toScreen(bezierPoint(seg, i / 60)));
  }
  ectx.lineTo(...toScreen([1, Y_MIN]));
  ectx.closePath();
  ectx.fillStyle = cssColor('--editor-fill');
  ectx.fill();
  ectx.beginPath();
  for (const seg of waveCurve) {
    for (let i = 0; i <= 60; i++) {
      const [sx, sy] = toScreen(bezierPoint(seg, i / 60));
      i === 0 && seg === waveCurve[0] ? ectx.moveTo(sx, sy) : ectx.lineTo(sx, sy);
    }
  }
  ectx.strokeStyle = cssColor('--editor-curve');
  ectx.lineWidth = 2.5;
  ectx.stroke();
  // Points: fixed ends (gray), handles (yellow), crest (white)
  const dotAt = (p, color, r) => {
    const [sx, sy] = toScreen(p);
    ectx.beginPath(); ectx.arc(sx, sy, r, 0, Math.PI * 2); ectx.fillStyle = color; ectx.fill();
  };
  dotAt(waveCurve[0][0], cssColor('--editor-end'), 4);
  dotAt(waveCurve[1][3], cssColor('--editor-end'), 4);
  for (const hdl of editorHandles()) dotAt(hdl.p, hdl.id === 'crest' ? cssColor('--editor-crest') : cssColor('--editor-handle'), hdl.id === 'crest' ? 7 : 6);
}

let editorDrag = null;
function editorPointer(e) {
  const r = editorCanvas.getBoundingClientRect();
  return [(e.clientX - r.left) * editorCanvas.width / r.width, (e.clientY - r.top) * editorCanvas.height / r.height];
}
editorCanvas.addEventListener('pointerdown', (e) => {
  const [mx, my] = editorPointer(e);
  let best = null, bestD = 16;
  for (const hdl of editorHandles()) {
    const [sx, sy] = toScreen(hdl.p);
    const d = Math.hypot(sx - mx, sy - my);
    if (d < bestD) { best = hdl; bestD = d; }
  }
  if (best) { editorDrag = best; editorCanvas.setPointerCapture(e.pointerId); }
});
editorCanvas.addEventListener('pointermove', (e) => {
  if (!editorDrag) return;
  const [cx, cy] = toCurve(...editorPointer(e));
  const p = editorDrag.p;
  if (editorDrag.id === 'crest') {
    // Moving the crest drags its two neighboring handles along with it.
    const dx = cx - p[0], dy = cy - p[1];
    for (const q of [waveCurve[0][2], waveCurve[1][1]]) { q[0] += dx; q[1] += dy; }
  }
  p[0] = cx; p[1] = cy;
  enforceWaveRules();
  rebuildWaveLUT();
  drawWaveEditor();
});
editorCanvas.addEventListener('pointerup', () => { editorDrag = null; });
document.getElementById('reset-wave').addEventListener('click', () => {
  waveCurve = DEFAULT_WAVE.map((seg) => seg.map((p) => p.slice()));
  rebuildWaveLUT();
  drawWaveEditor();
});


// Redraw the editor when the system switches between light and dark mode.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawWaveEditor);

// ---- Start ----
setLevel('0');
requestAnimationFrame(render);
