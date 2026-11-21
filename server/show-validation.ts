import {
  PATTERN_KINDS,
  type Blink,
  type Clip,
  type Direction,
  type PatternKind,
  type PatternShape,
  type Point,
  type Show,
  type Venue,
} from "@/lib/types";
import { MAX_TAG_TEXT } from "@/lib/audio-tags";
import { isAudioFileId } from "./audio-store";

/** The parts of a show a client may write. The server owns id and timestamps. */
export type ShowInput = Pick<Show, "name" | "venue" | "audio" | "clips">;

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

export const DEFAULT_SHOW_NAME = "Untitled show";
export const DEFAULT_SHOW_MS = 30_000;
/** Size caps, so one request cannot store or later compile an unbounded show. */
export const MAX_CLIPS = 2000;
export const MAX_VENUE_SHAPES = 200;
export const MAX_POLYGON_POINTS = 500;
const MAX_NAME_LENGTH = 200;

class InvalidInput extends Error {}

function fail(message: string): never {
  throw new InvalidInput(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${at} must be a finite number`);
  }
  return value;
}

function nonNegative(value: unknown, at: string): number {
  const n = finite(value, at);
  if (n < 0) fail(`${at} must be >= 0`);
  return n;
}

function nonEmptyString(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${at} must be a non-empty string`);
  }
  return value;
}

function parsePoint(value: unknown, at: string, normalised: boolean): Point {
  if (!isRecord(value)) fail(`${at} must be an object`);
  const x = finite(value.x, `${at}.x`);
  const y = finite(value.y, `${at}.y`);
  if (normalised && (x < 0 || x > 1 || y < 0 || y > 1)) {
    fail(`${at} must lie within 0..1`);
  }
  return { x, y };
}

function parsePolygon(
  value: unknown,
  at: string,
  normalised: boolean,
): Point[] {
  if (!Array.isArray(value)) fail(`${at} must be an array`);
  if (value.length < 3) fail(`${at} needs at least 3 points`);
  if (value.length > MAX_POLYGON_POINTS) {
    fail(`${at} has more than ${MAX_POLYGON_POINTS} points`);
  }
  return value.map((p, i) => parsePoint(p, `${at}[${i}]`, normalised));
}

function parseName(value: unknown): string {
  if (typeof value !== "string") fail("name must be a string");
  const name = value.trim();
  if (name.length === 0) fail("name must not be empty");
  if (name.length > MAX_NAME_LENGTH) {
    fail(`name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

function parseVenue(value: unknown): Venue {
  if (!isRecord(value)) fail("venue must be an object");
  if (!Array.isArray(value.shapes)) fail("venue.shapes must be an array");
  if (value.shapes.length > MAX_VENUE_SHAPES) {
    fail(`venue has more than ${MAX_VENUE_SHAPES} shapes`);
  }
  const ids = new Set<string>();
  const shapes = value.shapes.map((shape, i) => {
    const at = `venue.shapes[${i}]`;
    if (!isRecord(shape)) fail(`${at} must be an object`);
    const id = nonEmptyString(shape.id, `${at}.id`);
    if (ids.has(id)) fail(`${at}.id is a duplicate`);
    ids.add(id);
    return { id, points: parsePolygon(shape.points, `${at}.points`, true) };
  });
  return { shapes };
}

function parseAudio(value: unknown): Show["audio"] {
  if (!isRecord(value)) fail("audio must be an object");
  if (typeof value.fileId !== "string") fail("audio.fileId must be a string");
  // An empty fileId means the show has no audio yet.
  if (value.fileId !== "" && !isAudioFileId(value.fileId)) {
    fail("audio.fileId is not a known audio file id");
  }
  const audio: Show["audio"] = {
    fileId: value.fileId,
    durationMs: nonNegative(value.durationMs, "audio.durationMs"),
  };
  const title = optionalLabel(value.title, "audio.title");
  const artist = optionalLabel(value.artist, "audio.artist");
  if (title) audio.title = title;
  if (artist) audio.artist = artist;
  return audio;
}

const MAX_AUDIO_LABEL = MAX_TAG_TEXT;

/** An optional track title or artist: trimmed, empty treated as absent. */
function optionalLabel(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`${at} must be a string`);
  const text = value.trim();
  if (text.length > MAX_AUDIO_LABEL) {
    fail(`${at} must be at most ${MAX_AUDIO_LABEL} characters`);
  }
  return text === "" ? undefined : text;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

function parseClip(value: unknown, at: string): Clip {
  if (!isRecord(value)) fail(`${at} must be an object`);
  const startMs = nonNegative(value.startMs, `${at}.startMs`);
  const endMs = finite(value.endMs, `${at}.endMs`);
  if (endMs <= startMs) fail(`${at}.endMs must be after startMs`);
  if (typeof value.color !== "string" || !COLOR.test(value.color)) {
    fail(`${at}.color must look like #rrggbb`);
  }
  const shape = value.shape;
  if (!isRecord(shape)) fail(`${at}.shape must be an object`);
  let parsedShape: Clip["shape"];
  if (shape.kind === "fill") {
    parsedShape = { kind: "fill" };
  } else if (shape.kind === "polygon") {
    // Clip shapes may extend past the venue (a sweep that starts off-stage),
    // so their points are only required to be finite.
    const points = parsePolygon(shape.points, `${at}.shape.points`, false);
    parsedShape =
      shape.moveTo === undefined
        ? { kind: "polygon", points }
        : {
            kind: "polygon",
            points,
            moveTo: parsePoint(shape.moveTo, `${at}.shape.moveTo`, false),
          };
  } else if (shape.kind === "pattern") {
    parsedShape = parsePattern(shape, `${at}.shape`);
  } else {
    fail(`${at}.shape.kind must be "fill", "polygon" or "pattern"`);
  }
  const clip: Clip = {
    id: nonEmptyString(value.id, `${at}.id`),
    layer: finite(value.layer, `${at}.layer`),
    startMs,
    endMs,
    color: value.color,
    fadeInMs: nonNegative(value.fadeInMs, `${at}.fadeInMs`),
    fadeOutMs: nonNegative(value.fadeOutMs, `${at}.fadeOutMs`),
    shape: parsedShape,
  };
  if (value.blink !== undefined) {
    clip.blink = parseBlink(value.blink, `${at}.blink`);
  }
  if (value.label !== undefined) {
    if (typeof value.label !== "string" || value.label.length > MAX_LABEL) {
      fail(`${at}.label must be a string of at most ${MAX_LABEL} characters`);
    }
    clip.label = value.label;
  }
  return clip;
}

const MAX_LABEL = 40;
const DIRECTIONS: readonly Direction[] = ["left", "right", "up", "down"];

function parsePattern(
  shape: Record<string, unknown>,
  at: string,
): PatternShape {
  const pattern = shape.pattern;
  if (!PATTERN_KINDS.includes(pattern as PatternKind)) {
    fail(`${at}.pattern must be one of ${PATTERN_KINDS.join(", ")}`);
  }
  if (!DIRECTIONS.includes(shape.direction as Direction)) {
    fail(`${at}.direction must be one of ${DIRECTIONS.join(", ")}`);
  }
  const size = finite(shape.size, `${at}.size`);
  if (size <= 0 || size > 1) fail(`${at}.size must be in (0, 1]`);
  const stepMs = finite(shape.stepMs, `${at}.stepMs`);
  if (stepMs < 20) fail(`${at}.stepMs must be at least 20`);
  const from = finite(shape.from, `${at}.from`);
  const to = finite(shape.to, `${at}.to`);
  if (from < 0 || from > 1 || to < 0 || to > 1) {
    fail(`${at}.from and .to must lie within 0..1`);
  }
  return {
    kind: "pattern",
    pattern: pattern as PatternKind,
    direction: shape.direction as Direction,
    size,
    stepMs,
    from,
    to,
  };
}

function parseBlink(value: unknown, at: string): Blink {
  if (!isRecord(value)) fail(`${at} must be an object`);
  const periodMs = finite(value.periodMs, `${at}.periodMs`);
  if (periodMs < 40) fail(`${at}.periodMs must be at least 40`);
  const duty = finite(value.duty, `${at}.duty`);
  if (duty <= 0 || duty >= 1) fail(`${at}.duty must be between 0 and 1`);
  if (typeof value.soft !== "boolean") fail(`${at}.soft must be a boolean`);
  return { periodMs, duty, soft: value.soft };
}

function parseClips(value: unknown): Clip[] {
  if (!Array.isArray(value)) fail("clips must be an array");
  if (value.length > MAX_CLIPS) fail(`show has more than ${MAX_CLIPS} clips`);
  return value.map((clip, i) => parseClip(clip, `clips[${i}]`));
}

function wrap<T>(parse: () => T): ParseResult<T> {
  try {
    return { ok: true, value: parse() };
  } catch (err) {
    if (err instanceof InvalidInput) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Validate a partial show from a request body. Only fields that are present
 * are returned, so the result works for both create (with defaults filled in
 * by the caller) and update (merged over the stored show).
 */
export function parseShowPatch(body: unknown): ParseResult<Partial<ShowInput>> {
  return wrap(() => {
    if (!isRecord(body)) fail("body must be a JSON object");
    const patch: Partial<ShowInput> = {};
    if (body.name !== undefined) patch.name = parseName(body.name);
    if (body.venue !== undefined) patch.venue = parseVenue(body.venue);
    if (body.audio !== undefined) patch.audio = parseAudio(body.audio);
    if (body.clips !== undefined) patch.clips = parseClips(body.clips);
    return patch;
  });
}

export function emptyShowInput(): ShowInput {
  return {
    name: DEFAULT_SHOW_NAME,
    venue: { shapes: [] },
    // A show without music still has a length to put clips in.
    audio: { fileId: "", durationMs: DEFAULT_SHOW_MS },
    clips: [],
  };
}
