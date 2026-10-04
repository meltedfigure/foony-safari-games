# Foony Safari games check

Plays every game on [foony.com](https://foony.com) in real Safari, on GitHub's Mac machines. It checks
Mac Safari and Safari in Apple's iPhone and iPad simulators.

For each game it opens the game page, starts a game against bots in a private room, taps around the
board like a player, and saves screenshots. It reports a game as broken when Safari crashes, the page
shows the crash screen, the page scrolls sideways, or the game never opens a room. Page errors are
listed too.

## Run it

1. Open the **Actions** tab, pick **Safari games check**, and press **Run workflow**.
2. Fill in the two boxes, or keep the defaults:
   - **targets**: `mac` for Mac Safari, or simulator names such as `iPhone SE`, `iPhone 16`,
     `iPad mini`. A name uses the newest iOS on the machine. Add a version to pick an older one, such
     as `iPhone 16 @ 18`. Each target runs on its own Mac machine at the same time.
   - **games**: `all` for every game linked from foony.com/games, or slugs such as `chess,ludo`.
3. All games take about 30 minutes per target.

When it ends, the run page shows a table for each target. The screenshots and `results.jsonl` are
under **Artifacts** at the bottom of the run page.

This repo is public, so the Mac machines are free. If it ever goes private, every Mac minute is billed.

## Safety

Safari loads real ads on foony.com, and a test tap on an ad counts as an invalid ad click. Before each
tap, the script checks what is under that point and skips frames, ad slots and links that leave the
site. Buttons are only pressed by their text.

## iOS Simulator input

Apple's automation sends broken touch input into the simulator: a press arrives without its release.
So in the simulator the script presses buttons with a JavaScript click and taps the game area with
mouse input. Mac Safari gets real WebDriver clicks. Touch-only controls (like on-screen joysticks)
are not exercised in the simulator.

## Run it on your own Mac

```bash
safaridriver --enable   # once, asks for your password
safaridriver -p 4444 &
GAMES=chess,ludo node sweep.mjs
```

Results go to `safari-results/`. Set `SIMULATOR_UDID` (from `xcrun simctl list devices`) to use a
booted iOS Simulator instead of Mac Safari.
