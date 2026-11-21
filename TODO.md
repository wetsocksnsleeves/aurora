- [ ] pitch deck
- [ ] full 3d mock end to end
  - three.js page: fixed mock arena (raked floor, tiers, stage, orbit camera). 2D venue x → width, y → depth + rake height, so any saved show renders.
  - One glowing phone panel per seat, coloured each frame by that mock client's actual displayed colour.
  - Each mock client is the real `ParticipantClient` over its own WebSocket, with its own clock offset/drift and the sim harness network faults: join → seat → Ready → sync → standby → play from T0.
  - Host and Start as normal; the page can play the show audio.
  - Up to ~200 clients run in the page (browser WebSocket cap). For 500+, `scripts/sim.ts` runs the clients and streams their colours to the page.

host:

- [ ] auto build lightshows by analysing audio waveform (etao)
- [ ] import/export
- [ ] UI refinement, complete redesign
- [ ] better venue drawing (willy)
  - Import an image as background
  - Single pen tool for drawing, remove redundant shapes
  - Consider minimising the drawing tools, making light shows easier to create

client:

- [x] auto positioning
- [x] brightness enforcement: not possible, browsers cannot set or read brightness (etao)
- [x] fullscreen enforcement: any tap re-enters fullscreen (Android only; iPhone has no fullscreen)
- [x] sleep prevention fallback: muted looping video where wake lock is unavailable
- [x] better UI / call to actions (willy)
