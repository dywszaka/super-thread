import MarkdownIt from "markdown-it";
import type { WorkThread } from "@/shared/domain";
import { workThreadsByDocumentUpdate } from "./selection";

const markdown = new MarkdownIt({ html: false });

export const normalizeSearchText = (text: string): string => text.replace(/\s+/gu, " ").trim();

export function markdownSearchText(content: string): string {
  const parts: string[] = [];
  const collect = (tokens: ReturnType<typeof markdown.parse>): void => {
    for (const token of tokens) {
      if (token.children) collect(token.children);
      else if (["text", "code_inline", "code_block", "fence"].includes(token.type)) parts.push(token.content);
      if (token.block || ["softbreak", "hardbreak", "td_close", "th_close"].includes(token.type)) parts.push(" ");
    }
  };
  collect(markdown.parse(content, {}));
  return normalizeSearchText(parts.join(""));
}

export interface SearchSegment {
  text: string;
  highlight: boolean;
}

export interface WorkThreadSearchResult {
  thread: WorkThread;
  name: SearchSegment[];
  excerpt: SearchSegment[] | null;
}

export interface WorkThreadSearchResults {
  query: string;
  active: WorkThreadSearchResult[];
  archived: WorkThreadSearchResult[];
}

function segments(text: string, matcher: RegExp, start = 0, end = text.length): SearchSegment[] {
  const result: SearchSegment[] = [];
  let cursor = start;
  matcher.lastIndex = start;
  for (let match = matcher.exec(text); match && match.index < end; match = matcher.exec(text)) {
    if (match.index > cursor) result.push({ text: text.slice(cursor, match.index), highlight: false });
    cursor = Math.min(end, match.index + match[0].length);
    result.push({ text: text.slice(match.index, cursor), highlight: true });
    if (cursor === end) break;
  }
  if (cursor < end) result.push({ text: text.slice(cursor, end), highlight: false });
  return result;
}

function excerpt(text: string, matcher: RegExp, index: number): SearchSegment[] {
  let start = Math.max(0, index - 60);
  let end = Math.min(text.length, start + 180);
  // Keep UTF-16 boundaries outside surrogate pairs when clipping context.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]!)) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end]!)) end++;
  return [
    ...(start ? [{ text: "…", highlight: false }] : []),
    ...segments(text, matcher, start, end),
    ...(end < text.length ? [{ text: "…", highlight: false }] : [])
  ];
}

export class WorkThreadSearch {
  private readonly documents = new Map<string, { content: string; text: string }>();

  constructor(private readonly extractDocument = markdownSearchText) {}

  search(threads: readonly WorkThread[], input: string): WorkThreadSearchResults {
    const query = normalizeSearchText(input);
    const results: WorkThreadSearchResults = { query, active: [], archived: [] };
    const ids = new Set(threads.map((thread) => thread.id));
    for (const id of this.documents.keys()) if (!ids.has(id)) this.documents.delete(id);
    // Escape user input so punctuation is literal, with Unicode-aware case matching.
    const matcher = query ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu") : null;
    for (const thread of workThreadsByDocumentUpdate(threads)) {
      const name = normalizeSearchText(thread.name);
      if (!matcher) {
        results[thread.status].push({ thread, name: [{ text: name, highlight: false }], excerpt: null });
        continue;
      }
      const content = thread.document ?? "";
      let document = this.documents.get(thread.id);
      if (!document || document.content !== content) {
        document = { content, text: this.extractDocument(content) };
        this.documents.set(thread.id, document);
      }
      const nameIndex = name.search(matcher);
      const documentIndex = document.text.search(matcher);
      if (nameIndex < 0 && documentIndex < 0) continue;
      results[thread.status].push({
        thread,
        name: segments(name, matcher),
        excerpt: documentIndex < 0 ? null : excerpt(document.text, matcher, documentIndex)
      });
    }
    return results;
  }
}
