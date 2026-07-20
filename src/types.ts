export interface ZoneTrack {
  fps: number;
  ref: [number, number];
  // [t, dx, dy] — dx/dy are the green-screen centroid's drift at time t relative
  // to the zone's first tracked frame (so the first point is always [t0, 0, 0]).
  points: [number, number, number][];
}

export interface TemplateZone {
  x: number;
  y: number;
  w: number;
  h: number;
  tStart?: number;
  tEnd?: number;
  track?: ZoneTrack;
}

export interface Template {
  id: string;
  name: string;
  video: string;
  width: number;
  height: number;
  fps: number;
  fpsRate?: string;
  duration: number;
  keyColor: string;
  similarity: number;
  blend: number;
  // Server always normalizes legacy single-`zone` templates into a one-element
  // zones array (full-duration window) before sending to the client.
  zones: TemplateZone[];
  defaultAudio: AudioMode;
}

export type AudioMode = "template" | "user" | "mix";

export type EndBehavior = "freeze" | "loop";

export interface Placement {
  x: number;
  y: number;
  w: number;
}

export interface RenderParams {
  uploadId: string;
  templateId: string;
  placements: Placement[];
  trimStart: number;
  delay: number;
  audioMode: AudioMode;
  endBehavior: EndBehavior;
  templateVolume?: number;
  // Screen tracking: move the user's clip with the camera pan via ffmpeg sendcmd,
  // using zones[i].track data. Default true; only has an effect on zones that
  // actually have track data.
  tracking?: boolean;
  name?: string;
}

export interface RenderResultData {
  url: string;
  name: string;
  slug: string;
}

export interface MemeParams {
  // New renders always store `placements` (one entry per template zone).
  placements?: Placement[];
  // Legacy flat single-zone fields, kept for memes rendered before round 6.
  x?: number;
  y?: number;
  w?: number;
  trimStart: number;
  delay: number;
  audioMode: AudioMode;
  endBehavior?: EndBehavior;
  // Crowd/template audio volume (0..2, 1 = original). Absent on older memes.
  templateVolume?: number;
  // Uploaded-clip audio volume (0..2, 1 = original). Absent on older memes.
  userVolume?: number;
  // Absent on memes rendered before round 7 — treat as true (tracking was the
  // default behaviour once track data existed).
  tracking?: boolean;
}

export interface Meme {
  name: string;
  slug: string;
  templateId: string;
  params: MemeParams;
  createdAt: string;
  sourceFile: string;
}

export type UserSource =
  | { kind: "local"; file: File }
  | { kind: "server"; uploadId: string; fileName: string };
