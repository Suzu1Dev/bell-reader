export type BlockKind = "heading" | "paragraph" | "code" | "quote" | "list" | "image" | "table";

export interface ReaderBlock {
  id: string;
  kind: BlockKind;
  text: string;
  level?: 1 | 2 | 3;
  language?: string;
  imageUrl?: string;
  alt?: string;
  tableRows?: string[][];
}

export const INK_STYLES = ["highlight", "underline", "box", "bracket"] as const;
export type InkStyle = (typeof INK_STYLES)[number];

export const INK_COLORS = ["amber", "mint", "violet", "coral", "sky"] as const;
export type InkColor = (typeof INK_COLORS)[number];

export interface PageAnnotation {
  id: string;
  pageId: string;
  blockId: string;
  quote: string;
  translatedQuote?: string;
  startOffset: number;
  endOffset: number;
  style: InkStyle;
  color: InkColor;
  label?: string;
  note: string;
  topic?: string;
  anchorX?: number;
  anchorY?: number;
  source: "ai" | "user";
  createdAt: string;
}

export interface Folder {
  id: string;
  name: string;
  color: InkColor;
  pageCount: number;
  createdAt: string;
}

export interface SavedPageSummary {
  id: string;
  sourceKind: "url" | "paste";
  url?: string;
  siteName?: string;
  title: string;
  excerpt: string;
  topic: string;
  tags: string[];
  summary?: string;
  folderId: string | null;
  annotationCount: number;
  annotatedAt?: string;
  translatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedPage extends SavedPageSummary {
  blocks: ReaderBlock[];
  translatedTitle?: string;
  translatedBlocks?: ReaderBlock[];
  annotations: PageAnnotation[];
}

export interface ExplainTopicMatch {
  id: string;
  title: string;
  category?: string;
  tags: string[];
  href: string;
  reason: string;
}

export interface ExplainBridgeStatus {
  status: "ready" | "stale" | "unavailable" | "unconfigured";
  browserOrigin?: string;
  matches: ExplainTopicMatch[];
}

export const AI_PROVIDERS = ["codex", "claude", "antigravity", "api"] as const;
export type AIProviderKind = (typeof AI_PROVIDERS)[number];

export const ANNOTATION_DENSITIES = ["sparse", "balanced", "thorough"] as const;
export type AnnotationDensity = (typeof ANNOTATION_DENSITIES)[number];

export interface ProviderSettings {
  provider: AIProviderKind;
  model: string;
  autoFolder: boolean;
  annotationDensity?: AnnotationDensity;
}
