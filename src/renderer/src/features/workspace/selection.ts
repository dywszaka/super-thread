export interface SelectableItem {
  id: string;
}

export function resolveSelectionId(
  selectedId: string,
  preferredId: string | null,
  items: readonly SelectableItem[]
): string {
  if (items.some((item) => item.id === selectedId)) return selectedId;
  if (preferredId && items.some((item) => item.id === preferredId)) return preferredId;
  return items[0]?.id ?? "";
}
