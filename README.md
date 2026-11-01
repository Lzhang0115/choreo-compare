# Choreo Compare

Compare your dance practice with the official choreography, side by side, with
the two videos lined up automatically by the music.

Everything runs in your browser: videos are never uploaded anywhere.

## How to use

1. Open the site and load **your practice video** and the **official video**
   (e.g. the fixed-camera "dance practice" upload, downloaded as an MP4).
2. The app reads the audio from both and lines them up by the music (a few
   seconds for a full song).
3. Play, scrub, slow down, loop, and step frame by frame. Both videos stay in
   sync.

| Control | What it does |
| --- | --- |
| <kbd>Space</kbd> | Play / pause |
| <kbd>←</kbd> <kbd>→</kbd> | Back / forward 5 s (hold <kbd>Shift</kbd> for 1 s) |
| <kbd>,</kbd> <kbd>.</kbd> | Previous / next frame |
| <kbd>A</kbd> <kbd>B</kbd> <kbd>L</kbd> | Set loop start / end, clear loop |
| <kbd>M</kbd> <kbd>N</kbd> | Mirror practice / official video |
| <kbd>[</kbd> <kbd>]</kbd> | Nudge the sync by one frame |
| <kbd>F</kbd> | Fullscreen |
| Scroll / pinch, drag, double-click | Zoom into a member, move around, reset |

**If the sync looks wrong:**

- **Try next match**: songs repeat their chorus, so a short clip can match
  more than one place. This cycles through the next-best matches.
- **Re-sync from here**: for recordings with several runs that restart the
  music from different points. Go to a later run and press this.
- **Manual sync**: line up the same moment on both videos yourself, then
  press **Lock sync here**.
- **Fine-tune** buttons shift the official video by one frame or 10 ms.

Your sync and mirror settings are remembered for each pair of videos on that
device.

## Video formats

Works in current Chrome, Edge, Safari, and Firefox. If a video won't play,
it's usually an iPhone HEVC `.mov` in a browser without HEVC support: open it
in Safari, or set iPhone **Settings → Camera → Formats → Most Compatible** for
future recordings.

## How the auto-sync works

`js/sync.js` turns each audio track into ~36 feature signals: for each 1/3-octave
frequency band, *when new sounds start* (onsets) and *how loud the band is over
time*. Cross-correlating these between the two recordings finds the time shift
where they match. This approach handles the differences between a clean studio
track and a phone recording in a dance studio (echo, volume, EQ, talking).

1. A whitened (GCC-PHAT-style) cross-correlation proposes candidate offsets.
   Whitening stops the drum pattern, which repeats every bar, from dominating,
   and gives sharp, precise peaks.
2. Each candidate is re-checked by directly correlating the overlapping audio,
   and the best one wins. Accuracy in tests is about ±5 ms (one video frame is
   33 ms).

The analysis runs in a Web Worker (`js/sync-worker.js`), so the page stays
responsive.

## Development

No build step: it's plain HTML, CSS, and ES modules. Serve the folder with
any static server:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

Run the sync tests. They use a synthetic song and a simulated phone recording,
so no copyrighted audio is needed:

```bash
node tests/sync.test.mjs
```

## Roadmap

- [x] Step 1: synced side-by-side player with auto music sync, mirror, zoom, loops
- [ ] Step 2: member closeups. Tap a member in your video and the matching idol
  in the official video, and get auto-following closeups of both side by side
- [ ] Step 3: stick-figure pose overlay, saved sync per song, "how close" timeline
