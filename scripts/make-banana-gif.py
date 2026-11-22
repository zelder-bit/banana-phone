#!/usr/bin/env python3
"""Build renderer/banana-typing.gif (the typing banana in the top bar) from its source video.

    python3 scripts/make-banana-gif.py banana-phone.mp4 [renderer/banana-typing.gif]

Needs Pillow and gst-launch-1.0 (GStreamer) to decode the video.

The source is a 1280x720 Gemini video of four stacked pixel-art strips on a pink
background; the video itself is not in the repo. Every number below (BOX, SEAM, the
pose frames, the pink hue range) was tuned by eye for that one video.
shortcut: a different video needs those constants re-tuned, make them arguments if this is ever reused.
"""
import subprocess, sys, tempfile
from pathlib import Path
from PIL import Image, ImageChops, ImageFilter, ImageStat

video = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else str(Path(__file__).parent.parent / 'renderer' / 'banana-typing.gif')

BOX = (282, 27, 998, 201)  # the top strip of the four
H = 64                     # twice the 32px slot in the header, so it stays sharp
SEAM = 151                 # x in the strip: the banana is left of it, desk and terminal right

tmp = tempfile.TemporaryDirectory()
subprocess.run(['gst-launch-1.0', '-q', 'filesrc', f'location={video}', '!', 'decodebin', '!', 'videoconvert',
                '!', 'pngenc', '!', 'multifilesink', f'location={tmp.name}/%04d.png'], check=True)
count = len(list(Path(tmp.name).glob('*.png')))
assert count >= 160, f'expected the 240-frame source video, got {count} frames'
load = lambda i: Image.open(f'{tmp.name}/{i:04d}.png').convert('RGB').crop(BOX)


def key(im):
    """Make the pink background transparent. The dark purple-grey phone is too dark to match."""
    h, s, v = im.convert('HSV').split()
    hm = h.point(lambda x: 255 if 191 <= x <= 245 else 0)  # hue 270..345 degrees
    vm = v.point(lambda x: 255 if x > 110 else 0)
    sm = s.point(lambda x: 255 if x > 25 else 0)
    bg = ImageChops.multiply(ImageChops.multiply(hm, vm), sm)
    bg = bg.filter(ImageFilter.MaxFilter(3))  # grow by a pixel to eat the pink fringe
    rgba = im.convert('RGBA')
    rgba.putalpha(ImageChops.invert(bg))
    return rgba


# Loop back where the strip looks most like frame 0.
first = load(0)
diff = lambda i: sum(ImageStat.Stat(ImageChops.difference(first, load(i))).mean)
end = min(range(150, count), key=diff)

# In the video the banana only reaches for the keyboard in frames 0..5. Re-time just the
# banana: play those back and forth for ~5s, then one hand-lift, while the desk and
# terminal play through in order.
TYPE = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1]
pose = TYPE * 6 + [0, 1, 2, 3, 4, 5] + [6, 7, 8, 10, 12, 12, 12, 12, 12, 10, 8, 7, 6, 5]

W = round(H * (BOX[2] - BOX[0]) / (BOX[3] - BOX[1]))
frames = []
for n, i in enumerate(range(0, end, 2)):
    fr = load(i)
    fr.paste(load(pose[n % len(pose)]).crop((0, 0, SEAM, fr.height)), (0, 0))
    # RGBa (premultiplied) so the removed pink does not bleed into the edges when scaling
    im = key(fr).convert('RGBa').resize((W, H), Image.LANCZOS).convert('RGBA')
    alpha = im.getchannel('A').point(lambda x: 255 if x > 128 else 0)  # GIF transparency is on/off
    p = im.convert('RGB').quantize(255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    p.paste(255, mask=ImageChops.invert(alpha))  # palette index 255 = transparent
    frames.append(p)

frames[0].save(out, save_all=True, append_images=frames[1:], duration=80, loop=0, transparency=255, disposal=2)
print(f'{out}: {len(frames)} frames, {W}x{H}, loops at source frame {end}')
