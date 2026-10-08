# Sakura frame asset

- File: `sakura-frame.png` (1536 x 1024 RGBA PNG)
- Created: 2026-09-25 with the built-in `image_gen` tool.
- Reference: the Sakura CanvasTTY concept image supplied by the user in this
  conversation. No third-party theme files were copied.
- Initial generation prompt: "Create a production-ready transparent PNG
  pixel-art NINE-SLICE BORDER ASSET for a resizable terminal window, inspired
  by the attached Sakura CanvasTTY reference. Artwork only, no UI mockup, no
  words, no logos, no cursor, no terminal text. A precise rectangular frame
  viewed straight-on, 3:2 ratio, outer edges all visible, with a completely
  transparent large central opening occupying at least 78% width and 72%
  height. Dark charcoal and plum pixel-metal rails 22-28px thick, luminous
  pale pink highlights, detailed cherry blossom branches growing from upper
  left and upper right corners but confined to the border zone, a few petals
  and a small hanging lantern confined to the outer right border. Bottom
  border has dark pixel-stone sill and tiny blossom clusters. Crisp hard-edged
  pixels, meticulous layered shading, absolutely no anti-aliased painted
  look, no gradients, no shadows outside frame. This must work as CSS
  border-image with preserved corners and stretched middle edge strips.
  Center must remain fully alpha transparent so real terminal text can be
  read. Asset, not a poster. Output transparent background."
- Final edit prompt: "Edit this existing pixel-art terminal border asset ONLY
  to remove its background. Preserve the cherry blossom branches, lantern,
  rails, pixel shapes, colors, and exact outer geometry. Make every pixel
  INSIDE the frame opening fully transparent alpha, and every pixel OUTSIDE
  the outermost frame fully transparent alpha. Do not fill either region with
  black, purple, checkerboard, glow, or gradient. Keep only the frame rails
  and their attached blossoms/lantern/petals as opaque or naturally
  semi-transparent pixel art. The frame must remain a complete rectangle and
  be suitable as a CSS nine-slice border image. No text or UI. Export actual
  RGBA PNG with transparency."

The P0 Canvas 2D renderer draws only the corner and edge regions of this
asset. It does not draw the center over the terminal. Pixel-level alpha quality
still needs visual acceptance in the separate dev application.
