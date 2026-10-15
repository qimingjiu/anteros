const contestants = [
  { id: "impatient", name: "急急星人", intervalMinutes: 5, weight: 3 },
  { id: "chatterbox", name: "碎碎念", intervalMinutes: 15, weight: 3 },
  { id: "slacker", name: "摸鱼怪", intervalMinutes: 30, weight: 2 },
  { id: "monthly", name: "按月考勤", intervalMinutes: 60, weight: 2 },
  { id: "ghost", name: "幽灵船员", intervalMinutes: 240, weight: 1 },
] as const;

export type IntervalContestantId = typeof contestants[number]["id"];
export const INTERVAL_CONTESTANTS = Object.freeze(contestants.map(contestant => Object.freeze(contestant)));
export const MAX_DRAW_ATTEMPTS = 50;

export interface IntervalPoolState {
  /** 成功选出赢家的次数；平手重摇不增加轮数。 */
  round: number;
  lastWinnerId: IntervalContestantId | null;
  consecutiveWins: 0 | 1 | 2;
}

export interface IntervalRoll {
  id: IntervalContestantId;
  name: string;
  intervalMinutes: number;
  baseWeight: number;
  effectiveWeight: number;
  /** RNG 原始值，范围 [0, 1)。 */
  rawDice: number;
  /** 最终点数 = rawDice * effectiveWeight；以此比较，始终使用完整精度。 */
  score: number;
}

export interface IntervalDraw {
  round: number;
  attempts: number;
  contestants: IntervalRoll[];
  winner: IntervalRoll;
  nextIntervalMinutes: number;
  nextState: IntervalPoolState;
}

export interface IntervalWinProbability {
  id: IntervalContestantId;
  name: string;
  intervalMinutes: number;
  effectiveWeight: number;
  probability: number;
}

export function normalizePoolState(value?: unknown): IntervalPoolState {
  if (value === undefined || value === null) return { round: 0, lastWinnerId: null, consecutiveWins: 0 };
  if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid interval pool state");
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state);
  const validId = state.lastWinnerId === null || contestants.some(contestant => contestant.id === state.lastWinnerId);
  const validStreak = state.consecutiveWins === 0 || state.consecutiveWins === 1 || state.consecutiveWins === 2;
  if (keys.length !== 3 || !keys.every(key => ["round", "lastWinnerId", "consecutiveWins"].includes(key))
    || typeof state.round !== "number" || !Number.isSafeInteger(state.round) || state.round < 0
    || !validId || !validStreak || (state.consecutiveWins === 0) !== (state.lastWinnerId === null)
    || state.round < Number(state.consecutiveWins)) throw new TypeError("Invalid interval pool state");
  return {
    round: state.round,
    lastWinnerId: state.lastWinnerId as IntervalContestantId | null,
    consecutiveWins: state.consecutiveWins as 0 | 1 | 2,
  };
}

function effectiveWeights(state: IntervalPoolState): number[] {
  return contestants.map(contestant => contestant.weight *
    (state.consecutiveWins === 2 && state.lastWinnerId === contestant.id ? 0.5 : 1));
}

/** 五名选手各自同时摇一次 U[0,1) * 本轮权重，最高点获胜。
 * 真实平手时全员重摇；无权重抽签或隐含的额外随机步骤。
 * 输入状态不变，下一状态交给调度器在持久化时保存。 */
export function drawInterval(state?: IntervalPoolState, rng: () => number = Math.random): IntervalDraw {
  const previous = normalizePoolState(state);
  if (typeof rng !== "function") throw new TypeError("Interval RNG must be a function");
  if (previous.round === Number.MAX_SAFE_INTEGER) throw new RangeError("Interval pool round limit reached");
  const weights = effectiveWeights(previous);
  for (let attempt = 1; attempt <= MAX_DRAW_ATTEMPTS; attempt++) {
    const rolls = contestants.map((contestant, index): IntervalRoll => {
      const rawDice = rng();
      if (typeof rawDice !== "number" || !Number.isFinite(rawDice) || rawDice < 0 || rawDice >= 1) {
        throw new RangeError("Interval RNG must return a finite number in [0, 1)");
      }
      const effectiveWeight = weights[index]!;
      return { id: contestant.id, name: contestant.name, intervalMinutes: contestant.intervalMinutes,
        baseWeight: contestant.weight, effectiveWeight, rawDice, score: rawDice * effectiveWeight };
    });
    const highest = Math.max(...rolls.map(roll => roll.score));
    const winners = rolls.filter(roll => roll.score === highest);
    if (winners.length !== 1) continue;
    const winner = winners[0]!;
    const penalizedWin = previous.consecutiveWins === 2 && previous.lastWinnerId === winner.id;
    const nextState: IntervalPoolState = penalizedWin
      ? { round: previous.round + 1, lastWinnerId: null, consecutiveWins: 0 }
      : { round: previous.round + 1, lastWinnerId: winner.id,
        consecutiveWins: previous.lastWinnerId === winner.id ? 2 : 1 };
    return { round: nextState.round, attempts: attempt, contestants: rolls, winner,
      nextIntervalMinutes: winner.intervalMinutes, nextState };
  }
  throw new Error(`Interval pool remained tied after ${MAX_DRAW_ATTEMPTS} attempts`);
}

/** 精确积分，不抽样也不消耗骰子的 RNG：
 * P(i 最高) = integral(0..w_i) [1/w_i * product(j!=i, min(x/w_j,1))] dx。
 * 各权重点将积分拆成幂函数区间；理想连续均匀分布的平手概率为零。 */
export function exactWinningProbabilities(state?: IntervalPoolState): IntervalWinProbability[] {
  const weights = effectiveWeights(normalizePoolState(state));
  return contestants.map((contestant, index) => {
    const weight = weights[index]!;
    const others = weights.filter((_, other) => other !== index);
    const boundaries = [...new Set([0, weight, ...others.filter(other => other < weight)])].sort((a, b) => a - b);
    let probability = 0;
    for (let piece = 1; piece < boundaries.length; piece++) {
      const from = boundaries[piece - 1]!;
      const to = boundaries[piece]!;
      const midpoint = (from + to) / 2;
      const active = others.filter(other => other > midpoint);
      const power = active.length + 1;
      const denominator = power * weight * active.reduce((product, other) => product * other, 1);
      probability += (to ** power - from ** power) / denominator;
    }
    return { id: contestant.id, name: contestant.name, intervalMinutes: contestant.intervalMinutes,
      effectiveWeight: weight, probability };
  });
}

/** 公告模板只由轮数/显式 variant 选择，不再调用 RNG。
 * 所有者私聊等发送位置与附加文案由调度器决定。 */
export function renderDraw(draw: IntervalDraw, variant?: number): string {
  const openings = [
    `第 ${draw.round} 轮，五位选手同时摇点。`,
    `第 ${draw.round} 轮开赛，看看这次谁管我的作息。`,
    `第 ${draw.round} 轮，急急星人到幽灵船员都到齐了。`,
  ];
  const selected = variant !== undefined && Number.isSafeInteger(variant)
    ? Math.abs(variant) % openings.length : (draw.round - 1) % openings.length;
  // 平时两位小数；只有最高点看起来相同时才提高显示精度。
  const topLooksTied = (precision: number) => draw.contestants.some(roll => roll.id !== draw.winner.id
    && roll.score.toFixed(precision) === draw.winner.score.toFixed(precision));
  let precision = 2;
  while (precision < 17 && topLooksTied(precision)) precision++;
  const exactDisplay = topLooksTied(precision);
  const scores = draw.contestants.map(roll => {
    const weight = roll.effectiveWeight === roll.baseWeight ? String(roll.baseWeight)
      : `${roll.baseWeight} → ${roll.effectiveWeight}，连胜减半`;
    const points = exactDisplay ? String(roll.score) : roll.score.toFixed(precision);
    return `${roll.name}（${roll.intervalMinutes} 分钟，权重 ${weight}）：${points}`;
  });
  const retry = draw.attempts > 1 ? `最高点平手，已经全员重摇 ${draw.attempts - 1} 次。` : "";
  return [openings[selected]!, ...scores, retry,
    `这轮 ${draw.winner.name} 赢了，下次 ${draw.nextIntervalMinutes} 分钟后开口。`].filter(Boolean).join("\n");
}
