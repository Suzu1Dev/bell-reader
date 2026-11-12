export type BlockKind = "heading" | "paragraph" | "code" | "quote" | "list" | "image";

export interface ReaderBlock {
  id: string;
  kind: BlockKind;
  text: string;
  level?: 1 | 2 | 3;
  language?: string;
  imageUrl?: string;
  alt?: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface SavedPage extends SavedPageSummary {
  blocks: ReaderBlock[];
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

export type AIProviderKind = "claude" | "codex" | "api";

export interface ProviderSettings {
  provider: AIProviderKind;
  model: string;
  autoFolder: boolean;
}
