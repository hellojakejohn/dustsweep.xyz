# Janitor frames

PNG, transparent, one character per file. List them in `WALK_FRAMES` and
`SWEEP_FRAMES` at the top of `src/components/JanitorStage.tsx`. With one
walk frame he glides with a CSS bob; with two or more he walks.

```
walk-1.png  walk-2.png  walk-3.png  walk-4.png     (left foot, pass, right foot, pass)
sweep-1.png sweep-2.png sweep-3.png                 (broom back, mid, through)
```

Four walk frames and three sweep frames is plenty. Two of each already
reads as motion.

## The one rule that matters

**Every frame is the same canvas size with his feet on the same line.**
If the canvas or the foot line shifts between frames he jitters when the
frames swap and no code fixes it. Generate each frame on the same
background, then crop them all to one identical box.

`docs/reference/frames.py` does the crop: point it at a folder of
generated PNGs, it removes the background, finds the lowest opaque pixel
in each, aligns every frame to that foot line, pads to one shared canvas,
and writes them here. Run it after every batch.

## Direction

Draw him facing **one** direction, the same one as `janitor-solo.png`
(broom on the viewer's left). The code flips him with `scaleX(-1)`.

## Generation prompt that has worked

Same character as the reference image, flat vector illustration, plain
solid background (#00ff00 works for keying), full body, feet on the
ground, deadpan face, teal coveralls, dark cap, straw broom with brown
handle. Then per frame: "mid-stride, left foot forward, broom held
upright at his side" / "right foot forward" / "broom swept back behind
him, about to sweep" / "broom swung forward through the floor".

Keep the palette. Keep the face. If the model gives him a smile or
motion lines, regenerate.
