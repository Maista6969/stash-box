# Built-in crop templates

One `.psd` per Crop type, named for its image type key, embedded in the binary
so the feature needs no setup.

`CROP_FACE.psd` is the only template carrying a shape outline rather than
lines alone; it is why the shape path exists at all.

| File                          | Notes                                              |
| ----------------------------- | -------------------------------------------------- |
| `CROP_FACE.psd`               | 853x1280, and the only one with a shape            |
| `CROP_BUST.psd`               |                                                    |
| `CROP_TORSO.psd`              | same geometry as Three-quarter, different meanings |
| `CROP_THREE_QUARTER.psd`      |                                                    |
| `CROP_THREE_QUARTER_PLUS.psd` |                                                    |
| `CROP_FULL_BODY.psd`          | margins only; no thirds                            |
| `CROP_WIDE.psd`               | the only 16:9 template                             |

Torso and Three-quarter share their geometry -- the same lines at the same
places -- and are separate files because those lines mean different things. The
files differ only in their labels.

## Labels

Each file carries an XMP packet naming its guides -- "bisects the eyes",
"where the thighs meet" -- so one file is the whole template and a downloaded
copy cannot arrive separated from its annotations.

stash-box only **reads** that packet; authoring it is out of scope for this
application. Labels are optional -- a template with guides and no XMP is a
working overlay, just an unlabelled one.

## Changing one

Drop the replacement in under the same name. Nothing in the code knows where a
line is meant to sit, so there is nothing else to update -- the tests check
that whatever ships parses and is usable, not that it matches a table someone
typed.

If the replacement brings its own XMP, it is already annotated. If not, it
still works, just without the label text.
