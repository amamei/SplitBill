/** True when a scroll container is within `threshold` px of its bottom (or cannot scroll at all). */
export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 48): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}
