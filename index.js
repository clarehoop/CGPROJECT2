
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

