/* Line-diff helper used by the memory editor. */

export type DiffLine = { k: 'ctx' | 'add' | 'rem'; t: string };

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n');
  const B = b.split('\n');
  const m = A.length;
  const n = B.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ k: 'ctx', t: A[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ k: 'rem', t: A[i++]! });
    } else {
      out.push({ k: 'add', t: B[j++]! });
    }
  }
  while (i < m) out.push({ k: 'rem', t: A[i++]! });
  while (j < n) out.push({ k: 'add', t: B[j++]! });
  return out;
}
