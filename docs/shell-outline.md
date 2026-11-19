# Conservative Shell Outlines with Analytic Offset Clipping

Nov 19, 2026 · @Joseph Eagar

## Summary

Variable-width outlines can be made exact and temporally stable by treating an inverted-hull shell as conservative proxy geometry and trimming it per fragment against an analytic, variable-radius offset of the smooth surface. Rasterization provides visibility, topology and frame-to-frame stability; the fragment test provides exact width.

An offline solver writes a correction map that guarantees the shell always covers the goal line. Artists author width through a line variance map and a view-angle weight, the same kind of data they already paint for shell systems.

## Problem

Anime-style rendering needs outlines whose width varies deliberately across the surface and with view, and the two standard approaches each fail half of that.

| Approach | Good at | Weak at |
| --- | --- | --- |
| Inverted-hull shell | Visibility, inner contours, temporal stability, real-time cost | Width control is indirect: projected width depends on curvature, faceting and view angle, so thickness tuning is fiddly |
| Extracted vector strokes | Exact width, tapers, joins, editable output | Smooth-contour extraction, visibility topology, and above all temporal coherence (strokes split, merge and pop between frames) |

The goal is shell-level robustness with stroke-level width accuracy, without paying for stroke chaining.

## Authoring inputs

Artists paint two quantities on the surface; everything else is derived.

- **Line variance map** — target line width per surface point, in screen-space units (pixels at a reference resolution). Painted per vertex or as a texture, like a shell thickness map.
- **View-angle weight** — how width responds to viewing direction, e.g. thicker in profile, thinner head-on, or heavier on the shadow side. Can be a scalar curve per region or a small lookup over view direction in the object's local frame.

The effective target width at a point is the map value times the view weight, converted to world units at the fragment's depth. Because a contour slides across the surface as the view changes, the line's width follows whatever region it currently passes over; painting tools should preview this live.

## Offline solver: the correction map

The solver's only job is to make the shell conservative: wherever the true line could appear, the shell must rasterize a fragment. Overshoot is cheap (discarded fragments); undershoot is a visible gap.

At a contour the normal is perpendicular to the view ray, so normal extrusion projects at nearly full length. The base extrusion is therefore just the maximum target width, scaled by depth in the vertex shader as inverted hulls already do. The correction map adds a per-vertex margin for the two errors that remain:

1. **Faceting** — the mesh contour lies away from the smooth-surface contour; the shell must reach the smooth one.
2. **Curvature** — in tightly curved regions the projected shell width shrinks below the extrusion length.

A practical solve samples view directions over the expected range (or the full sphere), measures the coverage deficit along each smooth contour, and takes the per-vertex maximum, plus a small safety band. The map is static per asset and pose-independent if computed in rest space with a curvature-based bound; deforming characters may need the bound recomputed or a conservative curvature budget.
