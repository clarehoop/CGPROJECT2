
const canvas = document.getElementById('c');
const gl = canvas.getContext('webgl');



const vertexShaderSource = `
  // Per-vertex inputs (filled from buffers we upload in Step 4).
  attribute vec3 a_position;  // corner position in the object's own space
  attribute float a_shade;    // brightness of the face this corner belongs to

  // Same-for-the-whole-object inputs (set from JavaScript before each draw).
  uniform mat4 u_model;       // object space -> world space
  uniform mat4 u_view;        // world space  -> camera space  (THE CAMERA)
  uniform mat4 u_projection;  // camera space -> clip space    (perspective)

  // Output passed along to the fragment shader.
  varying float v_shade;

  void main() {
    // vec4(a_position, 1.0) turns the 3D point (x, y, z) into the 4D point
    // (x, y, z, 1). The extra 1 is needed so a 4x4 matrix can TRANSLATE
    // (move) the point, not just rotate/scale it.
    //
    // Read the multiplication from RIGHT to LEFT: first model, then view,
    // then projection. gl_Position is a built-in output: the final position.
    gl_Position = u_projection * u_view * u_model * vec4(a_position, 1.0);

    v_shade = a_shade;
  }
`;

const fragmentShaderSource = `
  // Fragment shaders must say how precise their decimal numbers are.
  // "mediump" (medium precision) is plenty for colors.
  precision mediump float;

  uniform vec3 u_color;   // the object's base color (red, green, blue in 0..1)
  varying float v_shade;  // received from the vertex shader

  void main() {
    // Darken the base color by the face's shade so each side of a box looks
    // a little different. Without this, a box would look like a flat
    // silhouette and you could not tell it is 3D. (This is a cheap stand-in
    // for real lighting, which is a topic for another day.)
    //
    // gl_FragColor is a built-in output: (red, green, blue, alpha/opacity).
    gl_FragColor = vec4(u_color * v_shade, 1.0);
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

const a_position   = gl.getAttribLocation(program, 'a_position');
const a_shade      = gl.getAttribLocation(program, 'a_shade');
const u_model      = gl.getUniformLocation(program, 'u_model');
const u_view       = gl.getUniformLocation(program, 'u_view');
const u_projection = gl.getUniformLocation(program, 'u_projection');
const u_color      = gl.getUniformLocation(program, 'u_color');


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
const GRID_SIZE = 500;  
const SPACING = 1.0;


const HEIGHT_SCALE = 15;
let cubes = [];

function generateMapsFromImage(imageSrc, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, size, size);          // downsample
      const data = ctx.getImageData(0, 0, size, size).data;

      const heightMap = [], colorMap = [];
      for (let y = 0; y < size; y++) {
        const hRow = [], cRow = [];
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          hRow.push(0.299 * r + 0.587 * g + 0.114 * b);
          cRow.push([r / 255, g / 255, b / 255]);
        }
        heightMap.push(hRow);
        colorMap.push(cRow);
      }
      resolve({ heightMap, colorMap });
    };
    img.onerror = () => reject(new Error("Failed to load image: " + imageSrc));
    img.src = imageSrc;
  });
}

// Load BOTH images, then build the grid:
// colors from the color image, heights from the height map.
Promise.all([
  generateMapsFromImage("wave2.png", GRID_SIZE),
  generateMapsFromImage("wave2.png", GRID_SIZE),
]).then(([colorImg, heightImg]) => {
  cubes = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      cubes.push({
        x: (col - (GRID_SIZE - 1) / 2) * SPACING,
        z: (row - (GRID_SIZE - 1) / 2) * SPACING,
        height: 0.5 + (heightImg.heightMap[row][col] / 255) * HEIGHT_SCALE,
        color: colorImg.colorMap[row][col],
      });
    }
  }
  console.log("cubes:", cubes.length);
  draw();
}).catch(console.error);

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


// -----------------------------------------------------------------------------
// Step 7. The animation loop.
// -----------------------------------------------------------------------------

// Camera orbit settings. Try changing these!
const ORBIT_RADIUS = 9.0;          // distance from the center of the scene
const ORBIT_HEIGHT = 4.0;          // how high above the floor the camera is
const ORBIT_SPEED  = 0.3;          // radians per second (~21 s per full circle)
const LOOK_AT      = [0, 0.5, 0];  // the point the camera always faces
const UP           = [0, 1, 0];    // "up" is the +Y direction

// Turn on the depth test. Without it, triangles are simply painted in the
// order we draw them, so a far box drawn later would cover a nearer one.
// With it, the GPU keeps a "depth buffer" that remembers how far away each
// pixel's current color is, and only lets nearer pixels win.
gl.enable(gl.DEPTH_TEST);

// Background color (red, green, blue, alpha): a dark blue-gray.
gl.clearColor(0.1, 0.12, 0.16, 1.0);

// The canvas has two sizes: its size on screen (set by CSS) and the number of
// pixels WebGL draws into (canvas.width / canvas.height). We keep them equal
// so the image is sharp, and tell WebGL to use the whole canvas (viewport).
function resizeCanvas() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  gl.viewport(0, 0, canvas.width, canvas.height);
}

// render() draws ONE frame. requestAnimationFrame asks the browser to call it
// again right before the next screen refresh (usually 60 times per second),
// and passes in the current time in milliseconds.
function render(timeInMilliseconds) {
  resizeCanvas();
  const seconds = timeInMilliseconds / 1000;

  // --- 1. Move the camera --------------------------------------------------
  // The camera travels on a circle around the Y axis. A point on a circle of
  // radius r at angle θ is (r·cos θ, r·sin θ). We make the angle grow with
  // time, so the camera keeps going around. Here the circle lies in the
  // horizontal X-Z plane, raised up to ORBIT_HEIGHT.
  //
  //   Top-down view:          z
  //                           |   * camera at angle θ
  //                           |  /
  //                           | / r
  //                           |/ θ
  //               ------------+------------ x
  //                         scene
  const angle = seconds * ORBIT_SPEED;
  const eye = [
    ORBIT_RADIUS * Math.cos(angle),
    ORBIT_HEIGHT,
    ORBIT_RADIUS * Math.sin(angle),
  ];

  // Point the camera from `eye` at the center of the scene.
  const viewMatrix = lookAt(eye, LOOK_AT, UP);

  // The lens: 45° field of view (converted to radians), matched to the canvas
  // shape. Objects closer than 0.1 or farther than 100 units are not drawn.
  const aspect = canvas.width / canvas.height;
  const projectionMatrix = perspective(45 * Math.PI / 180, aspect, 0.1, 100.0);

  // Send both camera matrices to the shader. They are the same for every
  // object, so we set them once per frame. (The `false` means "do not
  // transpose"; WebGL 1 requires it to be false.)
  gl.uniformMatrix4fv(u_view, false, viewMatrix);
  gl.uniformMatrix4fv(u_projection, false, projectionMatrix);

  // --- 2. Erase the previous frame -----------------------------------------
  // Clear both the colors and the depth buffer, or old frames would linger.
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // --- 3. Draw every object ------------------------------------------------
  // The cube data is already on the GPU (Step 4). For each object, we only
  // change its model matrix and color, then draw the same 36 vertices again.
  unction draw() {
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
    gl.uniformMatrix4fv(uProjection, false, perspective(Math.PI / 4, aspect, 0.1, 100));
  
    // View: the camera sits at (14, 14, 18) - up and off to one side -
    // looks at the center of the grid (0, 0, 0), and +y is "up".
    // Try changing the first triple to move the camera around!
    //
    // (The `false` argument means "don't transpose the matrix".
    // WebGL requires it to be false.)
    gl.uniformMatrix4fv(uView, false, lookAt([14, 14, 18], [0, 0, 0], [0, 1, 0]));
  
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
  

  // --- 4. Ask for the next frame -------------------------------------------
  requestAnimationFrame(render);
}

// Start the loop.
requestAnimationFrame(render);
