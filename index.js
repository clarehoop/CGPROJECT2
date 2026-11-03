'use strict';
// =====================================================================
// CUBE WORLD: Ocean Waves
// Built using cube model that is translated and scaled
//
// what's in this file:
//   webgl setup + shaders
//   the cube model
//   cubebatch (draws lots of cubes in one draw call)
//   matrix helpers
//   bezier curves
//   level 0 + level 1 (single cube, random grid)
//   level 2 (landscape from wave2.png)
//   level 3 (bezier waves + bezier clouds)
//   level 4 (lighting, skybox, fog, boat, gulls, storm)
//   camera
//   level descriptions for the side panel
//   render loop
//   user interface
//
// code sources
// I started from two examples we were given in class:
//   webgl-cubes-v2 - grid of cubes with random heights and colors
//                    (cube with bottom at y = 0, normals, matrix helpers,
//                    grid layout, simple diffuse lighting)
//   camera-move    - camera orbiting a scene (lookAt on a circle,
//                    animation loop, resizeCanvas, face shading)
// tags I use in the comments:
//   [REUSED]  taken from a class example, little or no change
//   [CHANGED] based on a class example but I changed it
//   [NEW]     I wrote it for this project
//   [HELP]    I asked claude (ai) for help with this part, I used its
//             suggestions as a starting point then tuned and changed them
// =====================================================================


//WEB GL Setup 
// [REUSED] getting the canvas + webgl context is from both class examples
// (the id "glcanvas" is from camera-move)

// [CHANGED] I turned on antialiasing so the cube edges are smoother
const canvas = document.getElementById('glcanvas');
const gl = canvas.getContext('webgl', { antialias: true });


// [NEW] The class examples call drawArrays once per cube, but I am introducing instancing for performance issues
// when drawing >40,000 cubes
const instancing = gl && gl.getExtension('ANGLE_instanced_arrays');
if (!gl || !instancing) {
  document.getElementById('status').hidden = false;
  document.getElementById('status').textContent = 'Sorry, this browser does not support WebGL instancing.';
  throw new Error('WebGL instancing not available');
}


// VERTEX SHADER
//
// [REUSED] from camera-move: the a_/u_/v_ naming, the u_model / u_view /
//   u_projection uniforms, and the line projection * view * model * position
//
// [REUSED] from webgl-cubes-v2: the a_normal attribute for each face
//
// [CHANGED] camera-move stored a fixed brightness per face in a buffer
//   (cubeShades). Here the same idea (v_faceShade) is worked out from the normal
//
// [NEW] attributes per-instance (a_offset, a_scale, a_rotY, a_colorBottom,
//   a_colorTop), the rotateY helper, normals divided by the scale, and the
//   bottom/top vertex color blend (the examples used one u_color per cube)
//
const vertexShaderSource = `
  // per vertex: the corners of the cube model
  attribute vec3 a_position;   // corner position, cube goes from -0.5 to 0.5 in x and z, 0 to 1 in y
  attribute vec3 a_normal;     // which way the face points (for lighting)

  // per instance: one set for each cube copy
  attribute vec3  a_offset;      // translation - where the cube goes
  attribute vec3  a_scale;       // scaling - how wide / tall / deep
  attribute vec3  a_colorBottom; // color of the bottom 4 corners
  attribute vec3  a_colorTop;    // color of the top 4 corners
  attribute float a_rotY;        // rotation around y (radians)

  // same for the whole draw call
  uniform mat4 u_model;       // moves a whole object, like a cloud or the boat
  uniform mat4 u_view;        // world -> camera (the camera)
  uniform mat4 u_projection;  // camera -> clip space (perspective)

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
    // scale first, then rotate, then translate
    vec3 local = rotateY(a_position * a_scale, a_rotY) + a_offset;

    // then model, view and projection like in the class examples
    vec4 world = u_model * vec4(local, 1.0);
    v_worldPos = world.xyz;
    gl_Position = u_projection * u_view * world;

    // I divide normals by the scale (not multiply) so they stay
    // perpendicular when a cube gets stretched (inverse transpose rule)
    vec3 n = rotateY(a_normal / a_scale, a_rotY);
    v_normal = (u_model * vec4(n, 0.0)).xyz;

    // a_position.y is 0 on the bottom corners and 1 on the top ones so this
    // picks bottom or top color, then the gpu interpolates between them
    // across each face which gives the gradient
    v_color = mix(a_colorBottom, a_colorTop, a_position.y);

    // fake lighting for when real lighting is off, each face gets
    // its own brightness so the cube still looks 3d
    v_faceShade = a_normal.y > 0.5 ? 1.0 : (a_normal.y < -0.5 ? 0.45 : (abs(a_normal.x) > 0.5 ? 0.8 : 0.65));
  }
`;

// FRAGMENT SHADER
//
// [CHANGED] webgl-cubes-v2 had simple lighting: brightness = max(dot(N, L), 0)
//   plus 30% ambient, with a fixed light direction. That diffuse term is kept,
//   but the light direction, color and ambient are now uniforms (for the sun
//   and moon in Level 4)
//
// [NEW] specular highlights (Blinn-Phong), distance fog, "emissive" for the
//   sky and sun, and a color tint (grey storm clouds)
//
// [HELP] I asked claude to explain blinn-phong and exponential fog and how
//   to write them in glsl, then I picked the shininess (48) and fog
//   amounts myself by testing what looked right on the ocean
//
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

  uniform float u_emissive;   // 1 = glows on its own (sky, sun), no lighting
  uniform float u_lighting;   // 1 = sun lighting, 0 = face shade
  uniform float u_fog;        // 1 = fade to fog color with distance
  uniform float u_specular;   // how shiny
  uniform vec3  u_tint;       // multiplies the color (grey storm clouds)
  uniform vec3  u_lightDir;   // direction toward the sun (or moon)
  uniform vec3  u_lightColor;
  uniform vec3  u_ambient;    // light from everywhere
  uniform vec3  u_fogColor;
  uniform float u_fogDensity;
  uniform vec3  u_cameraPos;

  void main() {
    vec3 base = v_color * u_tint;
    vec3 color;

    if (u_emissive > 0.5) {
      color = base;
    } else if (u_lighting > 0.5) {
      // blinn-phong lighting
      vec3 N = normalize(v_normal);
      vec3 L = normalize(u_lightDir);
      vec3 V = normalize(u_cameraPos - v_worldPos);
      float diffuse = max(dot(N, L), 0.0);        // faces pointing at the sun are brighter
      vec3 H = normalize(L + V);                  // halfway vector for the highlight
      float spec = diffuse > 0.0 ? pow(max(dot(N, H), 0.0), 48.0) * u_specular : 0.0;
      color = base * (u_ambient + u_lightColor * diffuse) + u_lightColor * spec;
    } else {
      color = base * v_faceShade;
    }

    if (u_fog > 0.5) {
      // exponential fog, far away things fade into the fog color
      float d = length(v_worldPos - u_cameraPos);
      float f = 1.0 - exp(-pow(d * u_fogDensity, 2.0));
      color = mix(color, u_fogColor, clamp(f, 0.0, 1.0));
    }

    gl_FragColor = vec4(color, 1.0);
  }
`;
// webgl reqs
// [REUSED] compileShader is from webgl-cubes-v2 (throws on a GLSL error)
// [REUSED] checking LINK_STATUS after linking is from camera-move
//
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

// look up every attribute and uniform once
// [CHANGED] the examples looked up each location on its own line, now
// a loop stores them in the attr and uni objects
const attr = {};
for (const name of ['a_position', 'a_normal', 'a_offset', 'a_scale', 'a_colorBottom', 'a_colorTop', 'a_rotY']) {
  attr[name] = gl.getAttribLocation(program, name);
}
const uni = {};
for (const name of ['u_model', 'u_view', 'u_projection', 'u_emissive', 'u_lighting', 'u_fog', 'u_specular',
  'u_tint', 'u_lightDir', 'u_lightColor', 'u_ambient', 'u_fogColor', 'u_fogDensity', 'u_cameraPos']) {
  uni[name] = gl.getUniformLocation(program, name);
}



// the cube model
// [REUSED] These 36 vertices and the buffer layout are copied from webgl-cubes-v2
const cubeVertices = new Float32Array([
  // front (+z)
  -0.5, 0, 0.5,  0, 0, 1,    0.5, 0, 0.5,  0, 0, 1,    0.5, 1, 0.5,  0, 0, 1,
  -0.5, 0, 0.5,  0, 0, 1,    0.5, 1, 0.5,  0, 0, 1,   -0.5, 1, 0.5,  0, 0, 1,
  // back (-z)
  -0.5, 0, -0.5, 0, 0, -1,   0.5, 1, -0.5, 0, 0, -1,   0.5, 0, -0.5, 0, 0, -1,
  -0.5, 0, -0.5, 0, 0, -1,  -0.5, 1, -0.5, 0, 0, -1,   0.5, 1, -0.5, 0, 0, -1,
  // top (+y)
  -0.5, 1, -0.5, 0, 1, 0,   -0.5, 1, 0.5,  0, 1, 0,    0.5, 1, 0.5,  0, 1, 0,
  -0.5, 1, -0.5, 0, 1, 0,    0.5, 1, 0.5,  0, 1, 0,    0.5, 1, -0.5, 0, 1, 0,
  // bottom (-y)
  -0.5, 0, -0.5, 0, -1, 0,   0.5, 0, 0.5,  0, -1, 0,  -0.5, 0, 0.5,  0, -1, 0,
  -0.5, 0, -0.5, 0, -1, 0,   0.5, 0, -0.5, 0, -1, 0,   0.5, 0, 0.5,  0, -1, 0,
  // right (+x)
   0.5, 0, -0.5, 1, 0, 0,    0.5, 1, -0.5, 1, 0, 0,    0.5, 1, 0.5,  1, 0, 0,
   0.5, 0, -0.5, 1, 0, 0,    0.5, 1, 0.5,  1, 0, 0,    0.5, 0, 0.5,  1, 0, 0,
  // left (-x)
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

// [NEW] per-instance attributes advance to the next value once per cube copy
// instead of once per vertex
for (const name of ['a_offset', 'a_scale', 'a_colorBottom', 'a_colorTop', 'a_rotY']) {
  gl.enableVertexAttribArray(attr[name]);
  instancing.vertexAttribDivisorANGLE(attr[name], 1);
}



//   CUBEBATCH - a list of cube instances drawn with one draw call
//
//    [NEW] Replaces the examples' "for each cube: set uModel, set uColor,
//    drawArrays" loop. Each cube's translation, scale, colors and rotation
//    are stored in one GPU buffer and drawn together.
//    Each cube uses 13 numbers:
//      offset x,y,z | scale x,y,z | bottom r,g,b | top r,g,b | rotY

const FLOATS_PER_CUBE = 13;

class CubeBatch {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = capacity;
    this.data = new Float32Array(capacity * FLOATS_PER_CUBE);
    this.buffer = gl.createBuffer();
    this.dirty = true;   // true = data changed re send to gpu
  }

  // fast version (no arrays created) for code that runs every frame
  set(i, x, y, z, sx, sy, sz, br, bg, bb, tr, tg, tb, rotY) {
    const d = this.data, o = i * FLOATS_PER_CUBE;
    d[o] = x;      d[o + 1] = y;   d[o + 2] = z;
    d[o + 3] = sx; d[o + 4] = sy;  d[o + 5] = sz;
    d[o + 6] = br; d[o + 7] = bg;  d[o + 8] = bb;
    d[o + 9] = tr; d[o + 10] = tg; d[o + 11] = tb;
    d[o + 12] = rotY || 0;
    this.dirty = true;
  }

  // friendlier version: colors as [r, g, b] arrays
  setCube(i, [x, y, z], [sx, sy, sz], bottom, top = bottom, rotY = 0) {
    this.set(i, x, y, z, sx, sy, sz, bottom[0], bottom[1], bottom[2], top[0], top[1], top[2], rotY);
  }

  dispose() { gl.deleteBuffer(this.buffer); }
}

let cubesDrawnThisFrame = 0;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// draws every cube in a batch, model moves the whole batch at once
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

// switches for the next draw calls (glow, shiny, tint, fog)
function setMaterial({ emissive = 0, specular = 0, tint = [1, 1, 1], fog = env.fogOn } = {}) {
  gl.uniform1f(uni.u_emissive, emissive);
  gl.uniform1f(uni.u_specular, specular);
  gl.uniform3fv(uni.u_tint, tint);
  gl.uniform1f(uni.u_fog, fog ? 1 : 0);
}



//   MATRIX HELPERS 
//
//    [REUSED] translation, scaling, multiply, perspective and lookAt are
//    from webgl-cubes-v2
//
//    [CHANGED] the small vector helpers (dot, cross, normalize) were inside
//    lookAt, I moved them out here so other code can use them
//
//    [NEW] rotationX / rotationY / rotationZ, chain, mix3, clamp,
//    smoothstep and seededRandom.
//    in multiply(a, b) the transform b happens FIRST, then a

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
// chain(a, b, c) = a * b * c  (C happens first)
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

// pinhole camera, sits at eye and looks at target
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

// seeded random so the same seed gives the same random scene
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




//   BEZIER CURVES
//
//    [NEW] not in the class code examples, I wrote these from the cubic
//    bezier formula in the curves slides (09-01 / 09-02)
//
//    B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3,  t from 0 to 1
//    starts at P0, ends at P3, and gets pulled toward P1 and P2

function bezier1(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
// works for 2d or 3d points, does the formula on each coordinate
function bezierPoint(P, t) {
  return P[0].map((_, k) => bezier1(P[0][k], P[1][k], P[2][k], P[3][k], t));
}
// derivative = direction it's moving: B'(t) = 3(1-t)^2 (P1-P0) + 6(1-t)t (P2-P1) + 3t^2 (P3-P2)
function bezierTangent(P, t) {
  const u = 1 - t;
  return P[0].map((_, k) =>
    3 * u * u * (P[1][k] - P[0][k]) + 6 * u * t * (P[2][k] - P[1][k]) + 3 * t * t * (P[3][k] - P[2][k]));
}




//   SHARED STATE - the controls in the side panel change these

const WORLD_SIZE = 100;   // landscape is always 100 wide

const state = {
  level: '0',
  gridN: 50, seed: 7, heightScale: 12,
  imageRes: 100,
  seaRes: 140, imageSeaScale: 4, waveAmp: 7, waveSpeed: 8, cloudCount: 9,
  lighting: true, fog: true, skybox: true, extras: true, storm: false, sunAngle: 35, dayCycle: false,
  autoOrbit: true, orbitSpeed: 0.15,
};

let ground = null;            // main cubebatch for the level I'm on
let buildToken = 0;           // so old image loads get ignored if I switch levels
const statusEl = document.getElementById('status');
function showStatus(text) { statusEl.hidden = !text; statusEl.textContent = text || ''; }

function replaceGround(batch) {
  if (ground) ground.dispose();
  ground = batch;
}




//   LEVEL 0 + LEVEL 1 - single cube and random grid
//
//    [CHANGED] level 0 uses the idea from camera-move's makeModelMatrix,
//    scale the cube then translate it (scale 2, move down 1)

function buildSingleCube() {
  // level 0: one 2x2x2 cube centered on the origin
  // scale by 2 then move down 1 so the center is at y = 0
  const b = new CubeBatch(1);
  b.setCube(0, [0, -1, 0], [2, 2, 2], [0.2, 0.6, 0.9]);
  replaceGround(b);
}

// ocean colors for height 0 to 1: deep blue -> teal -> white foam
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

// level 1: grid of cubes with random heights and random colors
//
// [REUSED] the grid loop, centering formula (col - (N - 1) / 2) * spacing,
//   and random height + color per cube are from webgl-cubes-v2
//
// [CHANGED] you can change the grid size (10 to 400) and it always stays
//   100 wide so spacing = 100 / N, I also added a small gap between cubes
//   random comes from a seed so "randomize again" works
//   each cube gets two random colors (top and bottom) instead of one to
//   show interpolation
function buildRandomGrid() {
  const N = state.gridN;
  const spacing = WORLD_SIZE / N;
  const size = spacing * 0.85;               // small gap so you can see each cube
  const rand = seededRandom(state.seed);     // same seed = same landscape
  const b = new CubeBatch(N * N);

  let i = 0;
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      // 1a translation - center the grid on the origin in the x-z plane
      const x = (col - (N - 1) / 2) * spacing;
      const z = (row - (N - 1) / 2) * spacing;

      // 1b scaling - stretch in y (orthogonal to x-z) by a random amount
      const height = 0.3 + rand() * state.heightScale;

      // 1c vertex colors - random color on the top 4 corners, darker random
      // color on the bottom 4, the shader blends between them up each side
      const top = [rand(), rand(), rand()];
      const bottom = [rand() * 0.4, rand() * 0.4, rand() * 0.4];

      b.setCube(i++, [x, 0, z], [size, height, size], bottom, top);
    }
  }
  replaceGround(b);
}




//   LEVEL 2 - landscape from image data
//
//    [NEW] not in the class examples, I read the pixels with getImageData
//    (from the w3schools link in the assignment)
//    everything comes from wave2.png:
//      color  = pixel colors (colorMap)
//      height = pixel brightness (heightMap, the image as grayscale)

const IMAGE_SRC = 'wave2.png';
const mapCache = {};

// draw the image onto a size x size canvas so the browser downsamples it,
// then read every pixel with getImageData and save a height + color for each
// wave2.png is 882 x 620 (not square) so I only draw the middle 620 x 620
// square, that way the picture doesn't get stretched
function generateMapsFromImage(imageSrc, size) {
  const key = imageSrc + '@' + size;
  if (!mapCache[key]) {
    mapCache[key] = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const ctx = c.getContext('2d');
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);   // crop + downsample
        let data;
        try {
          data = ctx.getImageData(0, 0, size, size).data;
        } catch (err) {
          reject(new Error('The browser blocked reading the image pixels. Open this page through a local web server (for example VS Code Live Server or "python3 -m http.server"), not by double-clicking the file.'));
          return;
        }

        const heightMap = [], colorMap = [];
        for (let y = 0; y < size; y++) {
          const hRow = [], cRow = [];
          for (let x = 0; x < size; x++) {
            const i = (y * size + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            hRow.push(0.299 * r + 0.587 * g + 0.114 * b);   // brightness 0-255
            cRow.push([r / 255, g / 255, b / 255]);          // color 0-1
          }
          heightMap.push(hRow);
          colorMap.push(cRow);
        }
        resolve({ N: size, heightMap, colorMap });
      };
      img.onerror = () => reject(new Error('Failed to load image: ' + imageSrc));
      img.src = imageSrc;
    });
    mapCache[key].catch(() => delete mapCache[key]);
  }
  return mapCache[key];
}

async function buildImageTerrain() {
  const token = ++buildToken;
  showStatus('Loading image…');
  const N = state.imageRes;
  let maps;
  try {
    maps = await generateMapsFromImage(IMAGE_SRC, N);
  } catch (err) {
    if (token === buildToken) showStatus(err.message);
    return;
  }
  if (token !== buildToken) return;   // switched levels while it was loading

  const { heightMap, colorMap } = maps;
  const spacing = WORLD_SIZE / N;
  const b = new CubeBatch(N * N);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const [r, g, bl] = colorMap[row][col];
      // height mapping - brightness 0-255 -> actual height
      const height = 0.5 + (heightMap[row][col] / 255) * state.heightScale;
      const x = (col - (N - 1) / 2) * spacing;
      const z = (row - (N - 1) / 2) * spacing;
      b.set(row * N + col, x, 0, z, spacing, height, spacing, r * 0.45, g * 0.45, bl * 0.45, r, g, bl, 0);
    }
  }
  replaceGround(b);
  showStatus('');
}




//   LEVEL 3 - bezier waves + bezier clouds
//
//    [NEW] I wrote all of this section for the project

// wave shape
// one wavelength of the sea is two cubic bezier curves
// (x = position across the wave 0-1, y = height 0-1)
//   segment A: the long gentle back of the wave going up to the crest
//   segment B: the steep front coming back down
// both are flat at the crest and at the ends so the wave is smooth
// (C1 continuous) and repeats without a seam
const DEFAULT_WAVE = [
  [[0, 0], [0.35, 0], [0.55, 1], [0.7, 1]],
  [[0.7, 1], [0.84, 1], [0.88, 0], [1, 0]],
];
let waveCurve = DEFAULT_WAVE.map((seg) => seg.map((p) => p.slice()));

// the curve gives points (x(t), y(t)) but I need height at a position x,
// so I sample the curve a lot once and save it in a lookup table
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

// height of the wave at u (repeats every 1)
function waveProfile(u) {
  u -= Math.floor(u);
  const f = u * (LUT_SIZE - 1);
  const i = Math.floor(f);
  const a = waveLUT[i], b = waveLUT[Math.min(i + 1, LUT_SIZE - 1)];
  return a + (b - a) * (f - i);
}

// a second 1d bezier bends the crest line so the waves aren't
// perfectly straight
const CREST_BEND = [0, 14, -10, 2];
function crestBend(z) {
  const s = clamp((z + WORLD_SIZE / 2) / WORLD_SIZE, 0, 1);
  return bezier1(CREST_BEND[0], CREST_BEND[1], CREST_BEND[2], CREST_BEND[3], s);
}

const SEA_BASE = 0.6;
const MAIN_WAVELENGTH = 38, SWELL_WAVELENGTH = 16;
function waveAmplitude() { return state.waveAmp * (state.level === '4' && state.storm ? 1.6 : 1); }

// the moving bezier wave at (x, z) and time t, main wave goes along +x
// plus a smaller swell going diagonally
function waveHeight(x, z, t, bend = crestBend(z)) {
  const amp = waveAmplitude();
  const u1 = (x + bend - t * state.waveSpeed) / MAIN_WAVELENGTH;
  const u2 = (0.55 * x - 0.83 * z - t * state.waveSpeed * 0.6) / SWELL_WAVELENGTH;
  return amp * waveProfile(u1) + amp * 0.2 * waveProfile(u2);
}

// still sea surface from wave2.png, brightness -> height
let seaImage = null;   // { N, heightMap, colorMap } once the image is read
function imageHeightAt(x, z) {
  if (!seaImage) return 0;
  const N = seaImage.N;
  const col = clamp(Math.round((x / WORLD_SIZE + 0.5) * N - 0.5), 0, N - 1);
  const row = clamp(Math.round((z / WORLD_SIZE + 0.5) * N - 0.5), 0, N - 1);
  return (seaImage.heightMap[row][col] / 255) * state.imageSeaScale;
}

// sea height = image height + bezier wave on top
function seaHeight(x, z, t) {
  return SEA_BASE + imageHeightAt(x, z) + waveHeight(x, z, t);
}

async function loadSeaImage() {
  const N = state.seaRes;
  try {
    const maps = await generateMapsFromImage(IMAGE_SRC, N);
    if (state.seaRes !== N) return;   // resolution changed while loading
    seaImage = maps;
    // color the far ocean with the image's average color, a bit darker
    const avg = [0, 0, 0];
    for (const row of seaImage.colorMap) for (const c of row) for (let k = 0; k < 3; k++) avg[k] += c[k] / (N * N);
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

// every frame i change the sea cubes to the wave height
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

      // color height from the image (blue colors until it loads)
      let r, g, b, imgH = 0;
      if (img) {
        [r, g, b] = img.colorMap[row][col];
        imgH = (img.heightMap[row][col] / 255) * state.imageSeaScale;
      } else {
        oceanColor(n, tmpColor);
        r = tmpColor[0]; g = tmpColor[1]; b = tmpColor[2];
      }
      // white foam near the crest of the bezier wave
      const foam = smoothstep(0.75, 1, n) * 0.6;
      // troughs darker and crests lighter so you can see the wave roll
      const shade = 0.7 + 0.3 * n;
      r *= shade; g *= shade; b *= shade;
      r += (FOAM[0] - r) * foam; g += (FOAM[1] - g) * foam; b += (FOAM[2] - b) * foam;

      const h = SEA_BASE + imgH + wave;
      sea.set(i, x, 0, z, spacing, h, spacing, r * 0.35, g * 0.35, b * 0.35, r, g, b, 0);
    }
  }
}

// giant flat cube under the sea so the ocean goes to the horizon
const oceanFloor = new CubeBatch(1);
oceanFloor.setCube(0, [0, -0.5, 0], [3000, 1, 3000], DEEP, DEEP);

// clouds that move along 3d bezier paths
let clouds = [];

function makeCloud(rand) {
  // each cloud is 5-10 cubes that are scaled, rotated and translated
  const puffCount = 5 + Math.floor(rand() * 6);
  const puffs = new CubeBatch(puffCount);
  for (let i = 0; i < puffCount; i++) {
    const s = [3 + rand() * 5, 1.5 + rand() * 2.5, 2.5 + rand() * 3.5];
    const offset = [(rand() - 0.5) * 10, rand() * 2 - s[1] / 2, (rand() - 0.5) * 5];
    // grey-blue bottom and white top, interpolated like real cloud shading
    puffs.setCube(i, offset, s, [0.72, 0.76, 0.84], [1, 1, 1], rand() * Math.PI);
  }

  // path starts way off one edge and ends way off the other edge,
  // P1 and P2 pull it sideways and up/down so it makes an s-curve
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
}

function updateClouds(dt) {
  for (const c of clouds) {
    c.t += c.speed * dt * (state.level === '4' && state.storm ? 2.5 : 1);
    if (c.t > 1) c.t -= 1;   // far away, go back to the start
  }
}

function cloudModel(c) {
  const p = bezierPoint(c.path, c.t);
  const tangent = bezierTangent(c.path, c.t);
  const yaw = Math.atan2(-tangent[2], tangent[0]);   // turn the cloud to face the way it's going
  // grow in at the start and shrink at the end so clouds don't pop in
  const fade = smoothstep(0, 0.1, c.t) * (1 - smoothstep(0.9, 1, c.t));
  const s = Math.max(0.001, c.size * fade);
  return chain(translation(p[0], p[1], p[2]), rotationY(yaw), scaling(s, s, s));
}




//   LEVEL 4 - lighting, skybox, fog, boat, seagulls, storm
//
//    [NEW] all of this section is new for the project
//
//    [HELP] I consulted claude while making level 4, mostly to talk through
//    how to do a skybox with cubes, the day & night sky blending, and the
//    storm (rain & lightning). I used its suggestions and code as a starting point,
//    then I tuned the colors, speeds and amounts and fit them into my own
//    code (cubebatch, setMaterial, the render loop)

const env = {
  fogOn: false,
  lightDir: [0.5, 0.8, 0.3], lightColor: [1, 1, 1], ambient: [0.3, 0.3, 0.3],
  zenith: [0.2, 0.45, 0.85], horizon: [0.7, 0.85, 0.97],
  fogDensity: 0.007, flash: 0, nextFlash: 3,
  sunDir: [0.5, 0.8, 0.3], celestialColor: [1, 0.95, 0.7],
};

// sky colors for different sun heights
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
  const e = sunDir[1];   // sun height, 1 = overhead, negative = below horizon

  let sky;
  if (e >= 0.25) sky = SKY.day;
  else if (e >= 0) sky = blendSky(SKY.sunset, SKY.day, e / 0.25);
  else if (e >= -0.15) sky = blendSky(SKY.night, SKY.sunset, (e + 0.15) / 0.15);
  else sky = SKY.night;

  let zenith = sky.zenith, horizon = sky.horizon, light = sky.light, ambient = sky.ambient;
  // at night the moon (opposite the sun) is the light
  env.sunDir = e >= -0.05 ? sunDir : [-sunDir[0], -sunDir[1], -sunDir[2]];
  env.celestialColor = e >= -0.05 ? mix3([1, 0.55, 0.25], [1, 0.97, 0.75], clamp(e * 3, 0, 1)) : [0.85, 0.9, 1.0];

  if (state.storm) {
    const gray = [0.32, 0.35, 0.4];
    const dim = clamp(e + 0.3, 0.15, 1);
    zenith = mix3(zenith, gray.map((v) => v * 0.6 * dim), 0.8);
    horizon = mix3(horizon, gray.map((v) => v * dim), 0.8);
    light = light.map((v) => v * 0.35);
    ambient *= 0.8;
    // lightning - random bright flash that fades fast
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

// skybox - giant cube around the camera, horizon color on the bottom
// corners and sky color on top (interpolated)
const SKY_SIZE = 800;
const skybox = new CubeBatch(1);
const sunCube = new CubeBatch(1);

// boat - a few cubes placed relative to the boat (front = +x)
// [HELP] I asked claude how to build a simple boat out of cubes and how to
//   make it tilt with the waves (measuring the slope of the sea on each side
//   of the boat), then I picked the shape and colors myself (the black sail)
const boat = new CubeBatch(6);
boat.setCube(0, [0, 0, 0], [4.0, 0.9, 1.7], [0.25, 0.13, 0.06], [0.55, 0.32, 0.15]);           // hull
boat.setCube(3, [0.5, 0.9, 0], [0.15, 4.5, 0.15], [0.35, 0.2, 0.1], [0.45, 0.28, 0.14]);       // mast
boat.setCube(4, [1.25, 1.5, 0], [1.3, 3.4, 0.08], [0.04, 0.04, 0.05], [0.12, 0.12, 0.14]);     // black sail to emulate a pirate ship
let boatPitch = 0, boatRoll = 0;

function boatModel(t) {
  const x = 0, z = 0, d = 1.0;
  const h = seaHeight(x, z, t);
  // tilt the boat to match the slope of the water
  const slopeX = (seaHeight(x + d, z, t) - seaHeight(x - d, z, t)) / (2 * d);
  const slopeZ = (seaHeight(x, z + d, t) - seaHeight(x, z - d, t)) / (2 * d);
  boatPitch += (clamp(Math.atan(slopeX), -0.6, 0.6) - boatPitch) * 0.15;
  boatRoll += (clamp(-Math.atan(slopeZ), -0.4, 0.4) - boatRoll) * 0.15;
  return chain(translation(x, h - 0.5, z), rotationZ(boatPitch), rotationX(boatRoll), scaling(1.6, 1.6, 1.6));
}

// seagulls - fly in circles made from 4 bezier curves
// [HELP] I asked claude how to make a seagull shape from cubes and how to
//   make the wings flap, it also pointed me to the 0.5523 number for making
//   a circle out of bezier curves. I used that with my own bezierPoint and
//   bezierTangent functions from level 3

// a cubic bezier is really close to a quarter circle if the
// handles are 0.5523 x radius long
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
  // keep heights the same where the segments meet
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
    const yaw = Math.atan2(tan[0], tan[2]);   // beak (+z) faces the way it's flying
    const G = chain(translation(p[0], p[1], p[2]), rotationY(yaw), rotationZ(-0.25));
    const flap = Math.sin(t * 7 + g.flapPhase) * 0.55;
    drawBatch(gullBody, G);
    drawBatch(gullWing, chain(G, translation(0.2, 0.05, 0), rotationZ(flap)));                     // right wing
    drawBatch(gullWing, chain(G, translation(-0.2, 0.05, 0), rotationY(Math.PI), rotationZ(flap))); // left wing (flipped)
  }
}

// rain - thin falling cubes
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




//   CAMERA - orbits the look at point, drag to turn, scroll to zoom
//
//    [REUSED] orbit idea is from camera-move, eye goes on a circle
//    eye = (r cos θ, height, r sin θ), θ grows over time, lookAt the center
//
//    [CHANGED] I made the height an angle (pitch) so the camera moves on a
//    sphere, and each level has its own starting distance. the angle grows
//    by speed x frame time
//
//    [NEW] mouse / touch dragging and scroll wheel zoom

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




//   LEVEL DESCRIPTIONS - text + starting camera for each level
//
//    [NEW] all of this

const LEVELS = {
  '0': {
    tab: 'Level 0 · Cube',
    camera: { radius: 8, pitch: 0.45, target: [0, 0, 0], minR: 3, maxR: 40 },
    info: `<h2>Level 0: a single cube</h2>`,
  },
  '1': {
    tab: 'Level 1 · Randomized color and height grid',
    camera: { radius: 115, pitch: 0.5, target: [0, 2, 0], minR: 10, maxR: 400 },
    info: `<h2>Level 1: randomized cube landscape</h2>`,
  },
  '2': {
    tab: 'Level 2 · Wave Image',
    camera: { radius: 115, pitch: 0.6, target: [0, 2, 0], minR: 10, maxR: 400 },
    info: `<h2>Level 2: landscape from an image</h2>`,
  },
  '3': {
    tab: 'Level 3 · Bézier sea + clouds',
    camera: { radius: 110, pitch: 0.28, target: [0, 12, 0], minR: 10, maxR: 400 },
    info: `<h2>Level 3: Bézier waves and clouds</h2>`,
  },
  '4': {
    tab: 'Level 4 · Full scene',
    camera: { radius: 85, pitch: 0.2, target: [0, 9, 0], minR: 10, maxR: 380 },
    info: `<h2>Level 4: light, sky and atmosphere</h2>`,
  },
};




//   RENDER LOOP
//
//    [REUSED] the structure is from camera-move: resizeCanvas, then
//    requestAnimationFrame(render) every frame, set view + projection once
//    per frame, clear color + depth, draw, repeat. gl.enable(DEPTH_TEST)
//    is in both examples
//
//    [CHANGED] resizeCanvas also uses the screen's pixel density (max 1.5
//    for speed), and the far plane is 3000 instead of 100 for the big ocean
//
//    [NEW] frame time (dt) so speed doesn't depend on frame rate, the fps
//    counter, and drawing the skybox, sea, clouds, boat, gulls and rain

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

  // camera (level 1d: orbit around the look at point)
  if (state.autoOrbit && !dragging) camera.yaw += state.orbitSpeed * dt;
  const eye = cameraEye();
  gl.uniformMatrix4fv(uni.u_view, false, lookAt(eye, camera.target, [0, 1, 0]));
  gl.uniformMatrix4fv(uni.u_projection, false,
    perspective(Math.PI / 4, canvas.width / canvas.height, level === '0' ? 0.1 : 0.5, 3000));
  gl.uniform3fv(uni.u_cameraPos, eye);

  // lighting + fog settings
  if (full) updateEnvironment(dt);
  env.fogOn = full && state.fog;
  gl.uniform1f(uni.u_lighting, full && state.lighting ? 1 : 0);
  gl.uniform3fv(uni.u_lightDir, env.lightDir);
  gl.uniform3fv(uni.u_lightColor, env.lightColor);
  gl.uniform3fv(uni.u_ambient, env.ambient);
  gl.uniform3fv(uni.u_fogColor, env.horizon);
  gl.uniform1f(uni.u_fogDensity, env.fogDensity);

  // clear
  if (full) gl.clearColor(env.horizon[0], env.horizon[1], env.horizon[2], 1);
  else if (isSea) gl.clearColor(0.62, 0.8, 0.95, 1);
  else gl.clearColor(0.06, 0.09, 0.13, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // skybox and sun, drawn first without writing depth so everything
  // else draws in front of them
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
    // the bezier sea
    updateSea(simTime);
    setMaterial({ specular: 0.9 });
    drawBatch(oceanFloor);
    drawBatch(sea);

    // clouds
    updateClouds(dt);
    const cloudTint = full && state.storm ? [0.45, 0.47, 0.52] : [1, 1, 1];
    setMaterial({ tint: cloudTint });
    for (const c of clouds) drawBatch(c.puffs, cloudModel(c));

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

  // fps counter
  fpsFrames++;
  if (now - fpsTime > 0.5) {
    fps = Math.round(fpsFrames / (now - fpsTime));
    fpsTime = now;
    fpsFrames = 0;
    hud.textContent = `${fps} fps · ${cubesDrawnThisFrame.toLocaleString()} cubes`;
  }

  requestAnimationFrame(render);
}




//   USER INTERFACE
//
//    [NEW] level menu, sliders, switches and the bezier wave editor,
//    the class examples didn't have any ui
//
//    [HELP] I consulted claude in the building of my UI, primarily for help with user inputs
//      for the different levels so that users could play around with my work
//     I also wanted an "Apple UI" that claude was able to create for me in my CSS
 
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

// make the level menu buttons
const tabs = document.getElementById('tabs');
// I list the keys myself because objects put number keys like '2' first
for (const key of ['0', '1', '2', '3', '4']) {
  const cfg = LEVELS[key];
  const btn = document.createElement('button');
  btn.type = 'button';
  // "Level 3 · Bézier sea + clouds" -> badge "3", title "Level 3", subtitle "Bézier sea + clouds"
  const [title, subtitle] = cfg.tab.split(' · ');
  btn.innerHTML = `<span class="badge">${key}</span><span class="label"><b>${title}</b><small>${subtitle}</small></span>`;
  btn.dataset.level = key;
  btn.addEventListener('click', () => setLevel(key));
  tabs.appendChild(btn);
}

// hook up every input with a data-key to the matching state value
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
  // sliders update live, but big rebuilds wait until you let go
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

// [NEW] show / hide the controls, they start hidden so the panel is just the level info
const controlsToggle = document.getElementById('toggle-controls');
const controlsBox = document.getElementById('controls');
controlsToggle.addEventListener('click', () => {
  controlsBox.hidden = !controlsBox.hidden;
  controlsToggle.setAttribute('aria-expanded', String(!controlsBox.hidden));
});

// bezier wave editor (2d canvas)
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
// the points you can drag: 2 handles per segment + the crest
const editorHandles = () => [
  { id: 'A1', p: waveCurve[0][1] }, { id: 'A2', p: waveCurve[0][2] },
  { id: 'crest', p: waveCurve[0][3] },
  { id: 'B1', p: waveCurve[1][1] }, { id: 'B2', p: waveCurve[1][2] },
];

function enforceWaveRules() {
  // control points have to stay in left to right order so each x has one height
  const [A, B] = waveCurve;
  const c = A[3];
  c[0] = clamp(c[0], 0.1, 0.95);
  c[1] = clamp(c[1], 0.2, 1.4);
  for (const p of [A[1], A[2], B[1], B[2]]) p[1] = clamp(p[1], Y_MIN, Y_MAX);
  A[1][0] = clamp(A[1][0], 0, c[0]);
  A[2][0] = clamp(A[2][0], A[1][0], c[0]);
  B[1][0] = clamp(B[1][0], c[0], 1);
  B[2][0] = clamp(B[2][0], B[1][0], 1);
  B[0][0] = c[0]; B[0][1] = c[1];   // B starts where A ends
}

// colors come from style.css so they switch with light/dark mode
const cssColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawWaveEditor() {
  const w = editorCanvas.width, h = editorCanvas.height;
  ectx.clearRect(0, 0, w, h);
  // lines at height 0 and height 1
  ectx.strokeStyle = cssColor('--editor-grid');
  ectx.lineWidth = 1;
  for (const y of [0, 1]) {
    const [, sy] = toScreen([0, y]);
    ectx.beginPath(); ectx.moveTo(EDIT_PAD, sy); ectx.lineTo(w - EDIT_PAD, sy); ectx.stroke();
  }
  // control polygons (dashed)
  ectx.setLineDash([4, 4]);
  ectx.strokeStyle = cssColor('--editor-polygon');
  for (const seg of waveCurve) {
    ectx.beginPath();
    seg.forEach((p, i) => { const [sx, sy] = toScreen(p); i ? ectx.lineTo(sx, sy) : ectx.moveTo(sx, sy); });
    ectx.stroke();
  }
  ectx.setLineDash([]);
  // the curve, filled in like water
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
  // points: fixed ends (grey), handles (orange), crest
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
    // moving the crest drags the 2 handles next to it too
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


// redraw the editor if light/dark mode changes
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawWaveEditor);

// start
setLevel('0');
requestAnimationFrame(render);
