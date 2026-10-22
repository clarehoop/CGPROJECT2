
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl');



const vertexShaderSource = `
  attribute vec3 aPosition;   // corner position of the cube (model space)
  attribute vec3 aNormal;     // direction the face is pointing

  uniform mat4 uModel;        // moves/scales THIS cube into the world
  uniform mat4 uView;         // where the camera is and where it looks
  uniform mat4 uProjection;   // perspective: far things look smaller

  varying vec3 vNormal;       // handed to the fragment shader

  void main() {
    // Turn the normal the same way the cube is turned. Our cubes are only
    // stretched and moved, never rotated, so this changes nothing here.
    // It would matter if you added rotation.
    vNormal = normalize(mat3(uModel) * aNormal);

    // model -> world -> camera -> screen.
    // Read right to left: first place the cube in the world (uModel),
    // then view it from the camera (uView), then apply perspective (uProjection).
    gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
  }
`;

const fragmentShaderSource = `
  precision mediump float;    // how accurate decimal numbers are (medium is plenty)

  uniform vec3 uColor;        // this cube's color (red, green, blue: 0..1)
  varying vec3 vNormal;       // received from the vertex shader

  void main() {
    // This runs once for EVERY PIXEL inside each triangle. The GPU blends
    // vNormal between the triangle's three corners, so each pixel gets
    // its own value. On a flat cube face all corners share the same
    // normal, so every pixel on that face gets the same one.

    // Simple lighting so we can tell the faces of a cube apart.
    // The light shines from above and slightly to the side.
    vec3 lightDirection = normalize(vec3(0.5, 1.0, 0.3));

    // dot() measures how closely two directions line up:
    //   1 = the face points straight at the light (brightest)
    //   0 = the face is sideways to the light
    //   negative = the face points away, so max() clamps it to 0 (dark)
    float brightness = max(dot(vNormal, lightDirection), 0.0);

    // Keep 30% "ambient" light so faces in shadow aren't pure black.
    float light = 0.3 + 0.7 * brightness;

    // gl_FragColor is the built-in output: the final color of this pixel.
    // Multiplying the cube's color by light darkens it on dim faces.
    gl_FragColor = vec4(uColor * light, 1.0);   // 1.0 = fully opaque
  }
`;

// Compile one shader and report any GLSL errors.
function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

// A "program" for the GPU
// is a vertex shader + a fragment shader linked together.
const program = gl.createProgram();
gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexShaderSource));
gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource));
gl.linkProgram(program);
gl.useProgram(program);



const cubeVertices = new Float32Array([
  // Front face (normal points toward +z)
  -0.5, 0, 0.5,   0, 0, 1,
   0.5, 0, 0.5,   0, 0, 1,
   0.5, 1, 0.5,   0, 0, 1,
  -0.5, 0, 0.5,   0, 0, 1,
   0.5, 1, 0.5,   0, 0, 1,
  -0.5, 1, 0.5,   0, 0, 1,

  // Back face (-z)
  -0.5, 0, -0.5,  0, 0, -1,
   0.5, 1, -0.5,  0, 0, -1,
   0.5, 0, -0.5,  0, 0, -1,
  -0.5, 0, -0.5,  0, 0, -1,
  -0.5, 1, -0.5,  0, 0, -1,
   0.5, 1, -0.5,  0, 0, -1,

  // Top face (+y)
  -0.5, 1, -0.5,  0, 1, 0,
  -0.5, 1,  0.5,  0, 1, 0,
   0.5, 1,  0.5,  0, 1, 0,
  -0.5, 1, -0.5,  0, 1, 0,
   0.5, 1,  0.5,  0, 1, 0,
   0.5, 1, -0.5,  0, 1, 0,

  // Bottom face (-y)
  -0.5, 0, -0.5,  0, -1, 0,
   0.5, 0,  0.5,  0, -1, 0,
  -0.5, 0,  0.5,  0, -1, 0,
  -0.5, 0, -0.5,  0, -1, 0,
   0.5, 0, -0.5,  0, -1, 0,
   0.5, 0,  0.5,  0, -1, 0,

  // Right face (+x)
   0.5, 0, -0.5,  1, 0, 0,
   0.5, 1, -0.5,  1, 0, 0,
   0.5, 1,  0.5,  1, 0, 0,
   0.5, 0, -0.5,  1, 0, 0,
   0.5, 1,  0.5,  1, 0, 0,
   0.5, 0,  0.5,  1, 0, 0,

  // Left face (-x)
  -0.5, 0, -0.5, -1, 0, 0,
  -0.5, 1,  0.5, -1, 0, 0,
  -0.5, 1, -0.5, -1, 0, 0,
  -0.5, 0, -0.5, -1, 0, 0,
  -0.5, 0,  0.5, -1, 0, 0,
  -0.5, 1,  0.5, -1, 0, 0,
]);
const VERTEX_COUNT = 36;

// Copy the vertex data into GPU memory.
//   createBuffer - reserve a new, empty buffer on the GPU
//   bindBuffer   - make it the "current" buffer; the next buffer
//                  commands act on whichever buffer is bound
//                  (ARRAY_BUFFER means "this holds vertex data")
//   bufferData   - copy our numbers into it. STATIC_DRAW is a hint
//                  that we'll fill it once and draw from it many times.
const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, cubeVertices, gl.STATIC_DRAW);

// Tell the GPU how to read the buffer: which numbers are the position
// and which are the normal.
//   stride = bytes from one vertex to the next = 6 floats × 4 bytes = 24
//   offset = where in each vertex this attribute starts
const BYTES_PER_FLOAT = 4;
const stride = 6 * BYTES_PER_FLOAT;

// Each attribute is hooked up in three steps:
//   getAttribLocation       - ask the linked program for the attribute's
//                             slot number (the JS variable holds that
//                             number, not the data itself)
//   enableVertexAttribArray - say "fill this attribute from a buffer"
//   vertexAttribPointer     - say HOW: read from the currently bound
//                             buffer, 3 numbers per vertex, as floats,
//                             not normalized, stepping `stride` bytes
//                             per vertex, starting at this offset

// aPosition: the first 3 numbers of each vertex (x, y, z), offset 0.
const aPosition = gl.getAttribLocation(program, 'aPosition');
gl.enableVertexAttribArray(aPosition);
gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, stride, 0);

// aNormal: the next 3 numbers (nx, ny, nz), so skip past the 3 position
// floats = 12 bytes into each vertex.
const aNormal = gl.getAttribLocation(program, 'aNormal');
gl.enableVertexAttribArray(aNormal);
gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, stride, 3 * BYTES_PER_FLOAT);

// Look up where each uniform lives so we can set it later.
// Unlike attributes, uniforms don't come from the buffer: we send their
// values directly from JavaScript (gl.uniformMatrix4fv, gl.uniform3fv)
// in draw(). As with attributes, these variables hold a LOCATION
// (an address in the program), not the value itself.
//   uModel      - per cube: moves and stretches the cube into place
//   uView       - per frame: the camera's position and direction
//   uProjection - per frame: perspective (far things look smaller)
//   uColor      - per cube: the cube's RGB color
const uModel = gl.getUniformLocation(program, 'uModel');
const uView = gl.getUniformLocation(program, 'uView');
const uProjection = gl.getUniformLocation(program, 'uProjection');
const uColor = gl.getUniformLocation(program, 'uColor');


// ---------------------------------------------------------------------
// 3. THE SCENE: a plain JavaScript list of cubes
//    This part has nothing to do with WebGL - it's just data.
//    The cubes are laid out in a GRID_SIZE × GRID_SIZE grid on the
//    ground plane (y = 0), centered on the origin.
// ---------------------------------------------------------------------
// const GRID_SIZE = 1000;   //bigger
const GRID_SIZE = 100;          // image is resampled to 40×40 → 1,600 cubes
const SPACING = 1.0;
const imageURL = "https://lh3.googleusercontent.com/A0ukoBn7M8k_AjZ8MOC7bH0qHOUHWTuHP2co1Jxr97WsGQA0En5RqQn8OK48JQJYsdcNnTh-ayE6ScqlpQ5y80oxS5LvJUhJRmB3Y5kGxSRti_ZHH0rtIecRCrFhopc2Tdb0p3BkxZ-b1scNUg";

let cubes = [];
function isSky(r, g, b){
  return r > 100 && b - r > 20;
}

function generateMapsFromImage(imageSrc, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, size, size);          // downsample
      const data = ctx.getImageData(0, 0, size, size).data;

      const heightMap = [], colorMap = [], rawMap = [];
      for (let y = 0; y < size; y++) {
        const hRow = [], cRow = [], rawRow = [];
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          hRow.push(0.299 * r + 0.587 * g + 0.114 * b);  // 0..255
          cRow.push([r / 255, g / 255, b / 255]);       // ready for uniform3fv
          rawRow.push([r,g,b]);
        }
        heightMap.push(hRow); colorMap.push(cRow); rawMap.push(rawRow);
      }
      resolve({ heightMap, colorMap, rawMap });
    };
    img.onerror = () => reject(new Error("Failed to load image: " + imageSrc));
    img.src = imageSrc;
  });
}

generateMapsFromImage(imageURL, GRID_SIZE)
  .then(({ heightMap, colorMap, rawMap }) => {
    cubes = [];

    for (let row = 0; row < GRID_SIZE; row++) {
      for (let col = 0; col < GRID_SIZE; col++) {
        const [r,g,b] = rawMap[row][col];
        //if(isSky(r,g,b)) continue;
        
        cubes.push({
          x: (col - (GRID_SIZE - 1) / 2) * SPACING,
          //y: GRID_SIZE - row,
          z: (row - (GRID_SIZE - 1) / 2) * SPACING,
          height: 0.5 + (heightMap[row][col] / 255) * 6,  // 0.5 to 6.5
          color: colorMap[row][col],
        });
      }
    }
    draw();
  })
  .catch(console.error);


// ---------------------------------------------------------------------
// 4. MATRIX HELPERS
//    A 4×4 matrix can move, scale, or rotate points. WebGL stores
//    matrices as 16 numbers in "column-major" order: the first 4 numbers
//    are the first COLUMN, not the first row. That's why the translation
//    (x, y, z) appears in the last 4 numbers below.
//
//    (Real projects usually use a library such as glMatrix for this.)
// ---------------------------------------------------------------------

// Move a point by (x, y, z).
function translation(x, y, z) {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ];
}

// Stretch a point by (sx, sy, sz).
function scaling(sx, sy, sz) {
  return [
    sx, 0,  0,  0,
    0,  sy, 0,  0,
    0,  0,  sz, 0,
    0,  0,  0,  1,
  ];
}

// Multiply two matrices: the result does b first, then a.
function multiply(a, b) {
  const result = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) {
        result[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
      }
    }
  }
  return result;
}

// Perspective projection: makes far-away objects look smaller.
//   fieldOfView - how wide the camera sees, in radians
//   aspect      - canvas width / height, so things aren't stretched
//   near, far   - nothing closer than near or farther than far is drawn
function perspective(fieldOfView, aspect, near, far) {
  const f = 1 / Math.tan(fieldOfView / 2);
  return [
    f / aspect, 0, 0,                               0,
    0,          f, 0,                               0,
    0,          0, (far + near) / (near - far),    -1,
    0,          0, (2 * far * near) / (near - far), 0,
  ];
}

// Camera matrix: place a camera at `eye`, looking at `target`.
// `up` says which way is "up" for the camera (normally +y).
function lookAt(eye, target, up) {
  const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const normalize = (a) => {
    const length = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / length, a[1] / length, a[2] / length];
  };

  // Build the camera's own three axes:
  const zAxis = normalize(subtract(eye, target)); // points backward, away from what we look at
  const xAxis = normalize(cross(up, zAxis));      // points to the camera's right
  const yAxis = cross(zAxis, xAxis);              // points to the camera's up

  return [
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -dot(xAxis, eye), -dot(yAxis, eye), -dot(zAxis, eye), 1,
  ];
}


// ---------------------------------------------------------------------
// 5. DRAW
//    Everything above was SETUP: it ran once and got the shaders, the
//    buffer, and the list of cubes ready. draw() is where we actually
//    produce a picture. It follows the same steps every time:
//
//      a. size the drawing area to match the window
//      b. wipe the previous picture
//      c. set the camera
//      d. for each cube: set its uniforms, then tell the GPU to draw
//
//    Note that we never send the cube's triangles again here - they
//    are already sitting in the GPU buffer. Each cube costs us only a
//    few uniforms plus one draw call.
// ---------------------------------------------------------------------
function draw() {
  // --- a. Size the drawing area -------------------------------------
  // A canvas has two sizes: how big it looks on the page (set by CSS),
  // and how many pixels it actually has. If they don't match, the
  // picture gets stretched and blurry, so we make them match.
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;

  // The viewport tells WebGL which rectangle of the canvas to draw
  // into. After projection, the shader's output positions run from -1
  // to +1 on each axis; the viewport maps that range onto real pixels
  // (here, the whole canvas).
  gl.viewport(0, 0, canvas.width, canvas.height);

  // --- b. Wipe the previous picture ---------------------------------
  // clearColor only CHOOSES the color to clear with: black
  // (red, green, blue, alpha). Nothing is cleared until gl.clear().
  gl.clearColor(0, 0, 0, 1);

  // Depth testing makes near cubes hide far cubes, no matter which
  // order we draw them in. Each frame we clear the depth info too.
  //
  // How it works: alongside the colors, WebGL keeps a DEPTH BUFFER that
  // stores, for every pixel, how far away the closest thing drawn there
  // so far is. When a new pixel arrives, WebGL compares its distance to
  // the stored one and only keeps it if it is closer.
  gl.enable(gl.DEPTH_TEST);

  // Erase both the colors (to black) and the depth info (to "nothing
  // drawn yet") so the last picture doesn't leak into this one.
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // --- c. Set the camera --------------------------------------------
  // The camera is the same for every cube, so set it once.
  //
  // Projection: a 45° (PI / 4) field of view, the canvas's aspect ratio
  // so cubes aren't squashed, and a visible range from 0.1 to 100 units
  // away from the camera. Anything outside that range is not drawn.
  const aspect = canvas.width / canvas.height;
  const dist = GRID_SIZE;
  gl.uniformMatrix4fv(uProjection, false, perspective(Math.PI / 4, aspect, 0.1, dist * 4));

  // View: the camera sits at (14, 14, 18) - up and off to one side -
  // looks at the center of the grid (0, 0, 0), and +y is "up".
  // Try changing the first triple to move the camera around!
  //
  // (The `false` argument means "don't transpose the matrix".
  // WebGL requires it to be false.)
  gl.uniformMatrix4fv(uView, false, lookAt([dist * 0.8, dist * 0.8, dist], [0, 0, 0], [0, 1, 0]));

  // --- d. Draw every cube -------------------------------------------
  // Draw every cube: same triangles each time, different uniforms.
  for (const cube of cubes) {
    // Build this cube's model matrix.
    // First stretch the cube to its height, then move it to its spot.
    // (In multiply(a, b), b happens first, so scaling goes on the right.)
    // y stays 0 in the translation because the cube's bottom already
    // sits at y = 0, so stretching it makes it grow upward.
    const model = multiply(
      translation(cube.x, 0, cube.z),
      scaling(1, cube.height, 1),
    );

    // Send this cube's uniforms to the shaders. They stay set until we
    // change them, so the next cube simply overwrites them.
    gl.uniformMatrix4fv(uModel, false, model);
    gl.uniform3fv(uColor, cube.color);   // 3fv = a vector of 3 floats

    // The actual draw call: "read VERTEX_COUNT (36) vertices from the
    // buffer, starting at vertex 0, and treat every 3 as a triangle."
    // For this call the GPU:
    //   1. runs the vertex shader once per vertex (36 times) to find
    //      where each corner lands on the screen
    //   2. figures out which pixels each triangle covers
    //   3. runs the fragment shader once per covered pixel to color it
    //   4. uses the depth test to keep only the closest pixels
    gl.drawArrays(gl.TRIANGLES, 0, VERTEX_COUNT);
  }
}

// Draw the scene once when the page loads. Nothing moves, so we don't
// need to redraw again unless something changes.
draw();

// Redraw if the browser window changes size: the canvas has a new
// shape, so the viewport and aspect ratio must be updated.
// (To animate, you would instead call draw() every frame with
// requestAnimationFrame and change something - like the camera -
// a little each time.)
window.addEventListener('resize', draw);
