# Houseki Design Studio

**A gem cut designer and renderer for lapidary enthusiasts.**

Open a faceting design (`.gcs`, `.gem`, `.asc` or `.obj`) and see the stone
path-traced, with dispersion, beside its cutting instructions: every tier's angle, index-gear
teeth and notes, pavilion first, then crown, in the order you cut them. Click a tier to find its
facets on the stone.

It runs entirely in your web browser, with nothing to install.

Supports ([documentation](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs.html)):
- Fast as balls rendering
    - [Deterministic whitted-style real time raytracing](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/deterministic-renderer.html) simulating Snell's law, TIR, BL absorption and the full Fresnel equations. Models dispersion as three fixed wavelengths instead of a distribution.
    - [Monte carlo path tracing](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/monte-carlo-renderer.html) that simulates Snell's law, TIR, BL absorption and the full Fresnel equations. Models dispersion by randomly sampling wavelengths across the visible spectrum instead of using three fixed ones. Supports frosted facets, modelled as rough dielectric surfaces with single scattering.
- Freer than beer
    - Github's free tier is bonkers and we worked hard optimizing this website to be tiny. Hosting this costs me nothing so you dont pay either.
    - Even with a gun to my head I get physically cannot rugpull - everything runs on your computer and you can [save the entire website](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/save-offline.html) at any time.
    - [Send links](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/save-export.html#share-your-designs) with the gem cutting instructions saved entirely in the url, nothing gets sent to our servers (we don't run servers)
- Standard gem editing features
    - [Editing facets by tier](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/editing-tiers.html)
    - [Import/export](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/save-export.html) of all standard filetypes: .gem, .asc, .gcs, .obj, .stl, .pdf (gemcad style cutting instructions)
    - [Rotation by index](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/rotation-by-index.html) (wip)
    - [Girdle resizing](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/girdle-resizing.html)
    - [Crown/pavilion flipping](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/crown-pavilion-flipping.html) (wip)
    - [Tangent ratio height scaling](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/tangent-ratio-scaling.html)
    - [Manual optimizer](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/manual-optimizer.html) (wip)
    - [Tilt performance analyzer](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/tilt-performance.html) (wip)
    - [Size/yield calculator](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/size-yield-calculator.html) (wip)
    - [Cutting assistant](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/cutting-assistant.html)
    - [Rendering recording](https://0xdecafc0ffee.github.io/HousekiDesignStudio/docs/render-recording.html) (wip)

Houseki is named after the manga *Houseki no Kuni* (land of the lustrous). Houseki Design Studio is written by Lucas Tong, based in Seattle.

## Screenshots

The startup stone, a hexagonal cut, in the quick deterministic preview, with its cutting
instructions on the left and the material, tracing and lighting settings on the right:

![Houseki Design Studio showing the hexagonal startup stone beside its cutting instructions](src/resources/demo_screenshots/1_base.png)

Editing a tier: the tier's cutting plane is drawn through the stone, and its angle and depth are
set by dragging the scales:

![Editing tier C4, with its cutting plane shown through the stone](src/resources/demo_screenshots/2_cutting.png)

The same stone in the Monte Carlo path tracer, with the fire turned up and the samples
accumulated until the image converges:

![The hexagonal stone rendered with the Monte Carlo path tracer, showing dispersion](src/resources/demo_screenshots/3_monte_carlo.png)

Licensed Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
