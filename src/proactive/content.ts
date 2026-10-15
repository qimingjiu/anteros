// These phrases belong to the internal interval picker, never to a greeting.
// Apply the same filter to old bot messages so the model cannot copy a retired suffix.
const internalLine = /(?:第\s*[\d一二三四五六七八九十百]+\s*轮\s*(?:开赛|比赛|开始)|五位选手|谁管我的作息|急急星人到幽灵船员|(?:急急星人|碎碎念|摸鱼怪|按月考勤|幽灵船员)\s*[（(]|(?:这|本)(?:一)?轮.{0,60}(?:赢了|胜出|获胜)|权重\s*[:：]?\s*[\d０-９]|连胜减半|最高点平手|全员重摇|(?:下次|下一次).{0,16}[\d０-９]+\s*分钟后.{0,12}(?:开口|发送|问候)|(?:转盘|骰池).{0,30}(?:结果|过程|选手|权重|抽取|轮次)|碰上静默时间，等到下一个开放时段)/u;

export function stripProactiveSchedulingDetails(text: string): string {
  return text.replace(/\r\n?/gu, "\n").split("\n").map(line => {
    // A copied block can be joined onto a greeting without a newline. Sentence boundaries
    // let us retain that greeting while still removing the internal explanation.
    return line.split(/(?<=[。！？!?])/u).filter(sentence => !internalLine.test(sentence)).join("");
  }).filter(line => line.trim()).join("\n").trim();
}
