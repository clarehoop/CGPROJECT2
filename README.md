# Cube World: Ocean in Motion

A seascape built only from cubes with plain WebGL (no three.js). Intro to Computer Graphics, Project 2.

## Running it

The page reads image pixels with `getImageData`, so browsers require it to be served from a web server
(double-clicking `index.html` will block Level 2). From this folder run:


## Levels (tabs at the top of the page)

| Tab | What it shows | Graphics concept |
| --- | --- | --- |
| Level 0 | One 2×2×2 cube | Model, view, projection matrices; pinhole camera |
| Level 1 | Grid of cubes (10 to 400 wide) with random heights and random bottom/top colors, orbiting camera | Translation, scaling, color interpolation, `lookAt` camera path |
| Level 2 | Color + height sampled from `wave2.png`, cropped to a square (50 to 400 cubes wide) | `getImageData`, box-filter sampling, height mapping |
| Level 3 | Sea = `wave2.png` heights/colors + a rolling wave made of two cubic Bézier curves; clouds on 3D Bézier paths | Bézier curves, rotation, hierarchical transforms |
| Level 4 | Lighting, skybox, fog, boat, seagulls, storm, day/night | Blinn-Phong lighting, fog, skybox |

## Files

- `index.html`: page layout, header and controls
- `style.css`: page styling
- `index.js`: all WebGL code (sections are numbered at the top of the file)
- `*.png`: color images and grayscale height maps
