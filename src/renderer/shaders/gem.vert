#version 300 es

// Full-screen pass for the ray tracer.
//
// The stone is never rasterised, so there is no geometry to transform here. This
// emits a single triangle large enough to cover the viewport, generated purely from
// gl_VertexID so no vertex buffer or attribute state is needed at all.
//
// A triangle rather than a quad: covering the screen with one primitive avoids the
// diagonal seam where two triangles meet, which some drivers shade twice.

out vec2 vNdc;

void main() {
    // Vertices (-1,-1), (3,-1), (-1,3). The triangle extends past the viewport on
    // two sides; the part that lands on screen is exactly the full [-1,1] square.
    vec2 position = vec2(
        gl_VertexID == 1 ? 3.0 : -1.0,
        gl_VertexID == 2 ? 3.0 : -1.0
    );

    vNdc = position;

    gl_Position = vec4(position, 0.0, 1.0);
}
