import {
  clipDraftLayer,
  clipOverlayLayer,
  clipSelectionLayer,
} from "@/components/editor/clip-layers";
import { backgroundLayer, type CanvasLayer } from "@/components/editor/layers";

/**
 * The room canvas: the guide grid and the clips at the playhead, with no
 * venue shapes. Phones are fitted to the crowd (`lib/crowd.ts`), so the whole
 * square is the room. The crowd itself is drawn over it by `CrowdCanvas`.
 */
export const ROOM_LAYERS: CanvasLayer[] = [
  backgroundLayer,
  clipOverlayLayer,
  clipSelectionLayer,
  clipDraftLayer,
];
