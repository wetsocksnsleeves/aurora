# Real-device test

How to measure sync on real phones (SPEC 6.4, DEVELOPMENT.md chunk 16). Line up 5 to 10 phones, play the built-in "Device test (1 Hz flashes)" show, film the phones at 240 fps, and count the frames between the first and the last phone to turn white.

Status: the kit is ready. No measurements yet. Fill in [Results](#results) after a run.

## The show

"Device test (1 Hz flashes)" is a built-in show (`lib/device-test-show.ts`). It appears in the show list under "Built-in test shows" and is hosted with its Host button, like the wave test show.

- One second of black after Start, then 60 flashes, one per second. The show lasts 61 s.
- Each flash is hard white (`#ffffff`) for 500 ms, then hard black, with no fades. Both edges can be measured, but use the black-to-white edge. It is the one the analysis script finds.
- Every seat in the venue gets the same flashes, so seat positions do not matter.
- The show has no audio file. The host page turns on the click track for this show by default (see [Tuning the audio offset](#tuning-the-audio-offset)).

## Equipment

- 5 to 10 phones, mixed iOS and Android. Note each one's model, OS version and browser.
- A camera phone that films 240 fps slow motion. An iPhone does this in the Camera app's Slo-mo mode, set to 1080p at 240 fps. Some Android phones film 120 fps and interpolate to 240. Check the real capture rate in the phone's spec before trusting the frame counts.
- The host laptop, with the speaker you will use at the venue if you want to tune the audio offset.
- Venue-like wifi: a router with many other devices on it, or a busy public network. The test runs twice, once with every phone on wifi and once on mobile data.

## Setup

### Server and tunnel

The phones need HTTPS. Without it the wake lock fails and the screens sleep (SPEC 4.9). Run the production build behind a cloudflared tunnel.

For 5 to 10 phones a quick tunnel is enough:

```sh
npm run build
cloudflared tunnel --url http://localhost:3000
# copy the https://<random>.trycloudflare.com URL it prints, then in another terminal:
PORT=3000 PUBLIC_URL=https://<random>.trycloudflare.com npm start
```

Quick tunnels cap a tunnel at 200 in-flight requests. That is fine for 10 phones but not for a large run. For more phones, use a named tunnel on your own domain, or run the server on a VM with a public HTTPS address:

```sh
cloudflared tunnel login
cloudflared tunnel create lightshow
cloudflared tunnel route dns lightshow lightshow.example.com
cloudflared tunnel run --url http://localhost:3000 lightshow
PORT=3000 PUBLIC_URL=https://lightshow.example.com ALLOWED_HOSTS=lightshow.example.com npm start
```

Environment variables (see `.env.example`):

- `PUBLIC_URL` is the base URL in the QR code. Set it to the tunnel URL with no trailing slash. The API also accepts requests for its host.
- `ALLOWED_HOSTS` is a comma-separated list of extra hostnames the API answers to, for example a VM's other DNS name or a LAN address such as `192.168.1.20`. `localhost` and the `PUBLIC_URL` host are always allowed.
- `START_LEAD_MS` (default 900) is the delay from Start to the first show frame. Raise it to 2000 if phones on mobile data miss the start.

### Phones

On every phone:

1. Turn brightness to full and turn off auto-brightness.
2. Turn off Low Power Mode on iPhones and battery saver on Android. iOS caps animation at 30 fps in Low Power Mode, which adds up to 33 ms (SPEC 4.9). If a phone has to stay in a power-saving mode, write that in the notes column.
3. Close other apps and tabs.
4. Scan the QR code on the host page, tap any seat on the map, and tap Ready. Wait for the screen to turn green (standby). On the host map the phone's dot turns green too.

### Camera

1. Put the phones in one horizontal row, screens facing the camera, all at the same height in the picture. A camera sensor reads the frame from top to bottom over several milliseconds (rolling shutter). Phones at the same height are read at the same moment.
2. Mount the camera on a stand or lean it on something. Frame all the screens with a margin, and do not move or zoom during the run.
3. Dim the room lights so that white and black screens are easy to tell apart.

## Running the test

1. On the host laptop, open the start page, find "Device test (1 Hz flashes)" under "Built-in test shows" and click Host.
2. Join every phone (see [Phones](#phones)) and wait until the counts on the host page show every phone in standby.
3. Start recording slow motion.
4. Click Start on the host page. Record at least 10 flashes. You do not need all 60, since slow-motion files get large.
5. Stop recording, then Stop the show on the host page.
6. Repeat with every phone on mobile data (wifi off). Each phone rejoins when its socket reconnects. If one does not, reload its page.

Copy the original video file to the laptop. AirDrop keeps the 240 fps original. Messaging apps re-encode to 30 fps, which makes the file useless for this.

## Counting frames

At 240 fps one frame is 1000 / 240 = 4.17 ms.

For each flash, find the first frame in which each phone's screen is white. Take the earliest phone in that flash as frame 0. Every other phone is late by its frame number minus that. The spread of a flash is the last phone's lateness. Count several flashes, not just one, because display latency differs from frame to frame.

Look at the middle of each screen. A phone screen also refreshes from top to bottom, so the top of one screen and the middle of another are not comparable.

### By hand

Step through the video one frame at a time. In `mpv`, press `.` to step forward and `,` to step back. Or extract a stretch of frames as numbered images:

```sh
mkdir frames
ffmpeg -ss 5 -t 1.2 -i video.mov -fps_mode passthrough frames/%04d.png
```

### With `scripts/flash-frames.ts`

The script finds the flash edges for you. It needs `ffmpeg` and `ffprobe` on the PATH (`brew install ffmpeg`).

1. Grab one frame to measure the screen positions:

   ```sh
   ffmpeg -ss 2 -i video.mov -frames:v 1 frame.png
   ```

2. For each phone, write a box in the middle of its screen as `x,y,w,h`, in fractions of the frame width and height, measured from the top left. A box of about 5% by 5% is plenty. Keep every box at the same `y`.
3. Run it:

   ```sh
   npx tsx scripts/flash-frames.ts video.mov \
     --rois "0.10,0.45,0.05,0.05;0.30,0.45,0.05,0.05;0.50,0.45,0.05,0.05" \
     --names "Pixel 8,iPhone 13,Galaxy A54" \
     --from 3 --to 20
   ```

   `--from` and `--to` (seconds) cut the video to the flashes. `--fps` overrides the frame rate that `ffprobe` reports. The script warns if the file is under 200 fps.

It prints one row per flash with each phone's lateness in frames and ms, then a summary per phone: in how many flashes it was seen, its median and maximum lateness, and how often it was last. It ends with rows to paste into the results table.

The script measures each box's brightness relative to that box's own darkest and brightest frames, so a dim screen still works. If a phone shows "seen in" fewer flashes than the rest, its box may be off the screen, or the screen may have dimmed or locked. Move the box or check the video at that time.

## Tuning the audio offset

The host plays audio through the laptop and the venue speakers (SPEC 4.8). It schedules the audio against the same clock as the phones and subtracts the latency the browser reports. Bluetooth speakers add 100 to 300 ms that browsers often do not report. The host page has an offset slider (±500 ms) for this.

The click track makes this measurable. With it on, the host plays a short 1 kHz beep at the start of every clip, which for the device test show is every flash. The beeps are scheduled with the same maths as a show's audio (`clickContextTimes` in `lib/audio-schedule.ts`). The checkbox is in the Audio panel on the host page. It starts on for the device test show and off for other shows. Changing it, or moving the slider, reschedules the audio within a fraction of a second.

1. Use the host laptop and the speaker you will use at the venue. The slider value is saved in the browser on that laptop, so tune there.
2. Host the device test show, join a few phones and click Start. If the Audio panel shows "Enable audio", click it.
3. By ear: watch the phones and listen to the beeps. If the beep comes after the flash, move the slider negative. If it comes before, move it positive. Adjust in 10 ms steps until the beep and the flash land together.
4. On camera: film the phones and the speaker at normal speed (60 fps) with sound. In a video editor, or with `ffmpeg -i video.mov -vn clicks.wav` and an audio editor, compare the frame where the phones turn white with the start of the beep. One frame at 60 fps is 16.7 ms. A camera's own audio and video may be a frame apart, so treat this as accurate to about ±1 frame. If the beep is late by `d` ms, lower the offset by `d`.

Phones also differ by 1 to 3 display frames (16 to 50 ms), which cannot be corrected (SPEC 4.9). Line the beeps up with the middle of the phones, not with the first one.

Write the final offset, and the speaker it applies to, in the notes below the results table.

## Results

One row per phone per network. "Frames late vs first phone" is the median over the flashes counted, with the maximum in brackets. "ms" is that median in milliseconds.

| Device | OS  | Browser | Network | Frames late vs first phone | ms  | Notes |
| ------ | --- | ------- | ------- | -------------------------- | --- | ----- |
|        |     |         |         |                            |     |       |

Spread per flash (last phone minus first):

| Network | Flashes counted | Median spread (frames) | Median (ms) | Max spread (frames) | Max (ms) |
| ------- | --------------- | ---------------------- | ----------- | ------------------- | -------- |
|         |                 |                        |             |                     |          |

Consistently late devices:

Audio offset (speaker and value):
