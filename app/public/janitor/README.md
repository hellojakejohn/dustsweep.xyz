# Janitor frames

Drop the SVGs here. Naming matters more than the count -- predictable
names mean the animation code can just loop over them.

```
walk-1.svg   walk-2.svg   walk-3.svg   walk-4.svg
sweep-1.svg  sweep-2.svg  sweep-3.svg
turn-1.svg   turn-2.svg
idle.svg
```

Fewer is fine. Two walk frames and two sweep frames already animate. Add
more later and the code picks them up.

## The one rule that matters

**Every frame must be the same canvas size with the janitor's feet on the
same line.** Same viewBox, same width and height, feet at the same Y.

If the canvas shifts between frames he jitters and bobs when the frames
swap, and no amount of code fixes it. In Figma or Illustrator: draw every
frame inside one identical artboard, do not crop to content on export.

Only his legs, arms and broom should move between frames. Everything else
stays put.

## Direction

Draw him facing **one** direction only, whichever is natural. The code
flips him with `scaleX(-1)` when he turns around, so a mirrored set is
wasted work.

## Export settings

- SVG, not PNG. Scales cleanly and is a fraction of the size.
- No background rectangle. Transparent.
- Outline the text if any frame has any. There is no font here to load.
- Keep the existing palette: teal coveralls, warm orange skin, brown
  broom handle. Sampled from the original art and already in `index.css`.

## What happens once they land

A `steps()` animation cycles the frames while a transform slides him
along the bottom, `scaleX(-1)` flips him at each end, and the coin
animation in `docs/reference/janitor-loop.html` already handles the pile.
Roughly fifteen lines of CSS. Nothing needs a library.
