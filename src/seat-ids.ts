/** Excel-style ids, reserving Z for the built-in chair. */
export function seatId(index: number): string {
  let n = index + 1 + (index >= 25 ? 1 : 0);
  let id = '';
  while (n > 0) { n--; id = String.fromCharCode(65 + n % 26) + id; n = Math.floor(n / 26); }
  return id;
}
