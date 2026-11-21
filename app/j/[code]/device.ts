/**
 * Browser device APIs for the Ready tap (SPEC 2.3, 4.9). Requests must start
 * synchronously inside a tap handler: browsers only allow them as part of a
 * user gesture.
 */

/**
 * Whether this browser has element fullscreen. Android Chrome does; iPhone
 * Safari does not, and the page is already a black full-viewport layout there.
 */
export function fullscreenSupported(): boolean {
  return (
    typeof document !== "undefined" &&
    document.fullscreenEnabled === true &&
    typeof document.documentElement.requestFullscreen === "function"
  );
}

export function isFullscreen(): boolean {
  return typeof document !== "undefined" && document.fullscreenElement != null;
}

/** Enter fullscreen where supported. Call from a tap handler. */
export function enterFullscreen(): void {
  if (!fullscreenSupported() || isFullscreen()) return;
  try {
    document.documentElement
      .requestFullscreen({ navigationUI: "hide" })
      .catch(() => {});
  } catch {
    // Some browsers throw synchronously when not allowed.
  }
}

export function wakeLockSupported(): boolean {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

/**
 * Request a screen wake lock. Resolves to the sentinel, or null when the API
 * is missing (no HTTPS, old browser) or the request is refused. The browser
 * releases the lock when the tab is hidden; call again on return to visible.
 */
export function requestWakeLock(): Promise<WakeLockSentinel | null> {
  if (!wakeLockSupported()) return Promise.resolve(null);
  try {
    return navigator.wakeLock.request("screen").catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

/**
 * Keep-awake fallback for when the Wake Lock API is missing or refused, such
 * as a LAN join link over plain HTTP: a tiny silent video playing on loop.
 * iOS Safari and Android Chrome keep the screen on while a video plays. Muted
 * and inline, so it neither takes over the phone's audio nor opens a player.
 *
 * `play()` must first be called from a tap; after that the browser allows it
 * again on return to visible.
 */
export class KeepAwakeVideo {
  private video: HTMLVideoElement | null = null;

  constructor(private readonly onChange: (playing: boolean) => void) {}

  get playing(): boolean {
    return this.video !== null && !this.video.paused;
  }

  play(): void {
    const video = this.video ?? this.create();
    if (!video.paused) return;
    try {
      void video.play().catch(() => this.onChange(false));
    } catch {
      this.onChange(false);
    }
  }

  dispose(): void {
    this.video?.pause();
    this.video?.remove();
    this.video = null;
  }

  private create(): HTMLVideoElement {
    const video = document.createElement("video");
    video.src = "/keep-awake.mp4";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-hidden", "true");
    video.disableRemotePlayback = true;
    // iOS only treats it as playing media while it is in the document. Keep
    // it off screen.
    Object.assign(video.style, {
      position: "fixed",
      left: "-100px",
      top: "-100px",
      width: "1px",
      height: "1px",
      pointerEvents: "none",
    });
    video.addEventListener("playing", () => this.onChange(true));
    video.addEventListener("pause", () => this.onChange(false));
    document.body.append(video);
    this.video = video;
    return video;
  }
}
