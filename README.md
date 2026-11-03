# Cube World: Ocean in Motion

A seascape built only from cubes with WebGL. CS 5160 Project 2.

## Running it

Run at https://cg-ocean.vercel.app/


## Levels (tabs at the top of the page)

| Tab | What it shows | Graphics concept |
| --- | --- | --- |
| Level 0 | One 2×2×2 cube | Model, view, projection matrices; pinhole camera |
| Level 1 | Grid of cubes (10 to 400 wide) with random heights and random colors, orbiting camera | Translation, scaling, color interpolation, `lookAt` camera path |
| Level 2 | Color + height sampled from `wave2.png`, cropped to a square (50 to 400 cubes wide) | `getImageData`, height and color maps, height mapping |
| Level 3 | Sea = `wave2.png` heights/colors + a rolling wave made of two cubic Bézier curves; clouds on 3D Bézier paths | Bézier curves, rotation, hierarchical transforms |
| Level 4 | Lighting, skybox, fog, boat, seagulls, storm, day/night | Blinn-Phong lighting, fog, skybox |

## Files

- `index.html`: page layout, header and controls
- `style.css`: page styling
- `index.js`: all WebGL code (sections are numbered at the top of the file)
- `*.png`: color images and grayscale height maps

## Code sources

This project started from two WebGL examples given in class. Comments in
`index.js` mark each part as **[REUSED]**, **[CHANGED]** or **[NEW]**.

| From the class examples | What I changed or added |
| --- | --- |
| Cube vertices with normals, bottom at y = 0 (webgl-cubes-v2) | Each cube is drawn with instancing (one draw call for all cubes) instead of one draw call per cube |
| `translation`, `scaling`, `multiply`, `perspective`, `lookAt` (webgl-cubes-v2) | Added `rotationX/Y/Z`, `chain`, and Bézier curve helpers |
| Grid layout + random heights/colors (webgl-cubes-v2) | Adjustable resolution (10 to 400), fixed world size, seeded random, separate top/bottom vertex colors |
| Diffuse lighting `max(dot(N, L), 0)` + ambient (webgl-cubes-v2) | Sun/moon light uniforms, specular highlights, fog, emissive sky, day/night |
| Camera orbiting on a circle with `lookAt` (camera-move) | Orbit on a sphere, mouse drag and scroll zoom, per-level camera |
| Animation loop and `resizeCanvas` (camera-move) | Frame-time-based motion, fps counter, pixel-density aware canvas |
| Per-face shading idea (camera-move) | Computed from the face normal in the shader |
| Full-window canvas page (both) | Header, level tabs, side panel, controls, Apple-style UI |

New for this project: image sampling from `wave2.png` (Level 2), the Bézier
sea and Bézier clouds (Level 3), and the skybox, fog, boat, seagulls, storm
and wave editor (Level 4).
