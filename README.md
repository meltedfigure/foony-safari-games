# Foony Safari games check

Plays every game on [foony.com](https://foony.com) in real Safari, on GitHub's Mac machines. It checks
Mac Safari and Safari in Apple's iPhone and iPad simulators.

For each game it opens the game page, starts a game against bots in a private room, taps around the
board like a player, and saves screenshots. In 8 Ball Pool, 9 Ball Pool and Snooker it also takes one
real shot. It reports a game as broken when Safari crashes, the page shows the crash screen, the page
scrolls sideways, the game never opens a room, the player loses their seat before the first tap, or
the server does not answer the shot. Page errors are listed too.

The table also shows **First ping**: how long after the room opened the page first told the server
it is there. The server holds a new player's seat for a short time only, so a late first ping is how
a slow phone loses its seat.

## Run it

1. Open the **Actions** tab, pick **Safari games check**, and press **Run workflow**.
2. Fill in the two boxes, or keep the defaults:
   - **targets**: `mac` for Mac Safari, or simulator names such as `iPhone SE`, `iPhone 16`,
     `iPad mini`. A name uses the newest iOS on the machine. Add a version to pick an older one, such
     as `iPhone 16 @ 18`. Each target runs on its own Mac machine at the same time.
   - **Old iOS**: the machines have iOS 18.5 and newer. A target with an exact older version and an
     exact device name, such as `iPhone 8 @ 15.5` or `iPhone SE (3rd generation) @ 17.5`, downloads
     that iOS Simulator from Apple first. That adds about 10 minutes. Apple offers iOS 15.0 to 17.5.
     Nothing older than iOS 15 runs on these machines.
   - **Newer machine**: add ` on macos-26` to a target to use GitHub's macOS 26 image, which has
     newer iOS versions, such as `iPhone 17 @ 26.5 on macos-26`.
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

Apple's automation sends broken touch input into the simulator: a press arrives without its release,
and leftover presses can look like a swipe to Safari. So in the simulator the script sends no
automation input at all. It presses buttons with a JavaScript click, and a tap is a clean set of
touch, pointer and mouse events sent from JavaScript at that point. Mac Safari gets real WebDriver
input.

## Run it on your own Mac

```bash
safaridriver --enable   # once, asks for your password
safaridriver -p 4444 &
GAMES=chess,ludo node sweep.mjs
```

Results go to `safari-results/`. Set `SIMULATOR_UDID` (from `xcrun simctl list devices`) to use a
booted iOS Simulator instead of Mac Safari.
