import assert from "node:assert/strict";
import test from "node:test";
import type { WorkThread } from "../src/shared/domain";
import { markdownSearchText, normalizeSearchText, WorkThreadSearch, type SearchSegment } from "../src/renderer/src/features/workspace/work-thread-search";

const thread = (id: string, overrides: Partial<WorkThread> = {}): WorkThread => ({
  id, name: id, status: "active", pinned: false, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...overrides
});
const text = (segments: readonly SearchSegment[]): string => segments.map((segment) => segment.text).join("");
const highlighted = (segments: readonly SearchSegment[]): string[] => segments.filter((segment) => segment.highlight).map((segment) => segment.text);

test("search matches names or saved documents across active and archived threads in document order", () => {
  const threads = [
    thread("name", { name: "API rollout", documentUpdatedAt: "2026-11-02T00:00:00Z", pinned: true }),
    thread("document", { document: "Update the api contract", documentUpdatedAt: "2026-11-04T00:00:00Z" }),
    thread("archived", { status: "archived", document: "API history" }),
    thread("todo", { todos: [{ id: "todo", title: "API todo", date: "2026-11-06", createdAt: "now", updatedAt: "now" }] }),
    thread("empty"),
    thread("both", { name: "API upgrade", document: "API API" })
  ];
  const result = new WorkThreadSearch().search(threads, " api ");
  assert.equal(result.query, "api");
  assert.deepEqual(result.active.map((item) => item.thread.id), ["document", "name", "both"]);
  assert.deepEqual(result.archived.map((item) => item.thread.id), ["archived"]);
  assert.deepEqual(highlighted(result.active[1]!.name), ["API"]);
  assert.equal(result.active[1]!.excerpt, null);
  assert.deepEqual(highlighted(result.active[2]!.excerpt!), ["API", "API"]);
  assert.deepEqual(threads.map((item) => item.id), ["name", "document", "archived", "todo", "empty", "both"]);
});

test("empty and whitespace queries restore all results without parsing documents", () => {
  const search = new WorkThreadSearch(() => { throw new Error("Empty searches do not need document text"); });
  const threads = [thread("active"), thread("archived", { status: "archived" })];
  for (const query of ["", " \n\t "]) {
    const result = search.search(threads, query);
    assert.equal(result.query, "");
    assert.equal(result.active.length, 1);
    assert.equal(result.archived.length, 1);
    assert.deepEqual(result.active[0]!.name, [{ text: "active", highlight: false }]);
    assert.equal(result.active[0]!.excerpt, null);
  }
});

test("Markdown extraction keeps visible formatted text, table cells, code, and link labels", () => {
  const markdown = [
    "# Release **notes**", "", "A *formatted* [link label](https://hidden.example) and `inline()`.", "",
    "> Quoted content", "", "- First item", "- Second item", "",
    "| Name | Value |", "| --- | --- |", "| Table | Cell |", "",
    "```typescript", "const result = 42;", "```", "",
    "    indented code", "", "Line one  ", "line two", "",
    "![Diagram alt](https://image.example)", "", "Fish &amp; chips"
  ].join("\n");
  assert.equal(markdownSearchText(markdown), "Release notes A formatted link label and inline(). Quoted content First item Second item Name Value Table Cell const result = 42; indented code Line one line two Diagram alt Fish & chips");
  const search = new WorkThreadSearch();
  for (const query of ["Release notes", "formatted link label", "Table Cell", "const result", "line one line two", "Fish & chips"]) {
    assert.equal(search.search([thread("doc", { document: markdown })], query).active.length, 1, query);
  }
  assert.equal(search.search([thread("doc", { document: markdown })], "hidden.example").active.length, 0);
});

test("matching normalizes whitespace, handles Chinese and Unicode casing, and treats punctuation literally", () => {
  const search = new WorkThreadSearch();
  const threads = [thread("doc", { name: "中文 搜索", document: "Mixed CASE\n\tcontent. C++ [x] .* (a|b) $5 \\path 𐐀 ΟΣ" })];
  assert.equal(normalizeSearchText("  中文\n\t搜索  "), "中文 搜索");
  for (const query of ["中文", "中文\t搜索", "mixed case content", "C++", "[x]", ".*", "(a|b)", "$5", "\\path", "𐐨", "ος"]) {
    const result = search.search(threads, query);
    assert.equal(result.active.length, 1, query);
    assert.ok(highlighted(query.startsWith("中文") ? result.active[0]!.name : result.active[0]!.excerpt!).length > 0, query);
  }
  for (const query of ["c+", "Mixed content", "a|c", "absent"]) {
    // A literal substring such as c+ is still allowed inside C++.
    assert.equal(search.search(threads, query).active.length, query === "c+" ? 1 : 0, query);
  }
});

test("excerpts surround the first match, bound context, highlight repeats, and preserve Unicode", () => {
  const search = new WorkThreadSearch();
  const document = `${"😀".repeat(80)}needle then NEEDLE${"尾".repeat(300)}`;
  const result = search.search([thread("doc", { document })], "needle").active[0]!;
  const excerpt = text(result.excerpt!);
  assert.ok(excerpt.startsWith("…"));
  assert.ok(excerpt.endsWith("…"));
  assert.ok(excerpt.length <= 184);
  assert.deepEqual(highlighted(result.excerpt!), ["needle", "NEEDLE"]);
  assert.equal(excerpt.isWellFormed(), true);
  assert.equal(text(search.search([thread("doc", { document: "needle" })], "needle").active[0]!.excerpt!), "needle");
  const longQuery = "字".repeat(250);
  const longResult = search.search([thread("doc", { document: longQuery })], longQuery).active[0]!;
  assert.equal(text(longResult.excerpt!).length, 181);
  assert.equal(highlighted(longResult.excerpt!)[0], "字".repeat(180));
});

test("cache reuses unchanged documents and refreshes after saves, removal, and status changes", () => {
  let extractions = 0;
  const search = new WorkThreadSearch((content) => { extractions++; return markdownSearchText(content); });
  const original = thread("doc", { document: "Old needle" });
  assert.equal(search.search([original], "old").active.length, 1);
  assert.equal(search.search([{ ...original, name: "Renamed" }], "needle").active.length, 1);
  assert.equal(extractions, 1);
  const saved = { ...original, document: "New needle", status: "archived" as const };
  assert.equal(search.search([saved], "old").archived.length, 0);
  assert.equal(search.search([saved], "new").archived.length, 1);
  assert.equal(extractions, 2);
  search.search([], "new");
  search.search([saved], "new");
  assert.equal(extractions, 3);
});

test("HTML-like document text stays plain text in excerpts", () => {
  const result = new WorkThreadSearch().search([thread("doc", { document: '<script>alert("hello")</script>' })], "<script>").active[0]!;
  assert.equal(text(result.excerpt!), '<script>alert("hello")</script>');
  assert.deepEqual(highlighted(result.excerpt!), ["<script>"]);
});
