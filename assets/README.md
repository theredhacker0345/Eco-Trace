# assets/

This directory contains static assets for EcoTrace.

## demo.gif

> **Status: missing.** `assets/demo.gif` does not exist in this repository yet — this
> directory currently contains only this `README.md`. Until a recording is added, the
> `![EcoTrace Demo](assets/demo.gif)` image in the top-level `README.md` renders as a
> broken image. Recording the demo below (or removing the image line) fixes it.

Record a short demo of EcoTrace analyzing an Android project and place it here as `demo.gif`.

The README references it as:
```markdown
![EcoTrace Demo](assets/demo.gif)
```

### What to record:
1. Open EcoTrace
2. Click **Open Project** → select a real Android project (e.g. Signal Android)
3. Click **Analyze** — show the Intelligence Feed streaming findings in real-time
4. Click a Critical finding — show the causal chain tree in Fix Station
5. Click **Copy** on the generated fix
6. Click **⚙ Settings** — show ADB path + API key fields
7. (Optional) Click **Export Report** — show the `.html` file opening in a browser

### Recommended tools:
- [ScreenToGif](https://www.screentogif.com/) (Windows) — capture at 15fps, optimize to < 5MB
- Crop to 1400×900 matching the app window size
