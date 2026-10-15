import type { ToolDef } from "../types.js";

export interface WeatherConfig {
  defaultLocation?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  countryCode?: string;
  requestTimeoutMs?: number;
  cacheTtlMs?: number;
}
export interface WeatherLocation {
  name: string; latitude: number; longitude: number; timezone: string;
  countryCode?: string; admin1?: string;
}
export interface WeatherDay {
  date: string; tempMaxC: number; tempMinC: number; precipProbabilityPct: number | null;
  precipitationMm: number; weatherCode: number; condition: string; sunrise: string | null; sunset: string | null;
}
export interface WeatherHour {
  time: string; tempC: number; feelsLikeC: number; precipProbabilityPct: number | null;
  precipitationMm: number; weatherCode: number; condition: string; windKph: number;
}
export interface WeatherMinute { time: string; precipitationMm: number; rainMm: number | null }
export interface WeatherAlerts {
  rainInNext2Hours: boolean; rainStartAt?: string; rainStartMinutes?: number;
  rainTotalMm: number; rainProbabilityPct?: number; temperatureDropC?: number; texts: string[];
}
export interface WeatherSnapshot {
  location: WeatherLocation;
  fetchedAt: string;
  current: { time: string; tempC: number; feelsLikeC: number; weatherCode: number; condition: string;
    precipitationMm: number; rainMm: number; windKph: number };
  daily: WeatherDay[];
  hourly: WeatherHour[];
  minutely15: WeatherMinute[];
  alerts: WeatherAlerts;
  clothingAdvice: string[];
  precision: string;
  attribution: string;
  source: { name: string; url: string; model: string; currentDataKind: string;
    gridLatitude: number; gridLongitude: number; licenseUrl: string };
}
export interface WeatherOptions { fetch?: typeof fetch; now?: () => number }

const GEOCODING = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";
const HOUR = 3600_000;
const QUARTER = 15 * 60_000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const round = (value: number) => Math.round(value * 10) / 10;
const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

class WeatherError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
function number(value: unknown, label: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new WeatherError(`天气数据不完整：${label}`);
  }
  return value;
}
function code(value: unknown): number {
  const result = number(value, "天气代码", 0, 99);
  if (!Number.isInteger(result)) throw new WeatherError("天气数据不完整：天气代码");
  return result;
}
function unix(value: unknown): string {
  return new Date(number(value, "时间戳", 0, 253402300799) * 1000).toISOString();
}
function zone(value: unknown): string {
  if (typeof value !== "string" || !value) throw new WeatherError("天气数据不完整：时区");
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); }
  catch { throw new WeatherError("天气时区无效"); }
  return value;
}
function dayKey(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function localTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}
function series(section: Record<string, unknown>, key: string, length: number, optional = false): unknown[] {
  if (optional && section[key] === undefined) return Array.from({ length }, () => null);
  const values = section[key];
  if (!Array.isArray(values) || values.length !== length) throw new WeatherError(`天气数据不完整：${key} 长度不匹配`);
  return values;
}
function times(section: Record<string, unknown>, label: string): string[] {
  const values = section.time;
  if (!Array.isArray(values) || !values.length || values.length > 1000) throw new WeatherError(`天气数据不完整：${label} 时间序列`);
  const result = values.map(unix);
  for (let i = 1; i < result.length; i++) {
    if (Date.parse(result[i]!) <= Date.parse(result[i - 1]!)) throw new WeatherError(`天气数据不完整：${label} 时间未递增`);
  }
  return result;
}
function probability(value: unknown): number | null { return value === null ? null : number(value, "降水概率", 0, 100); }
function normalizePlace(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase()
    .replace(/(?:特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|省|市)$/u, "");
}

export function weatherCondition(weatherCode: number): string {
  const names: Record<number, string> = {
    0: "晴", 1: "大部晴朗", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇",
    51: "小毛毛雨", 53: "毛毛雨", 55: "较强毛毛雨", 56: "轻微冻毛毛雨", 57: "较强冻毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "轻微冻雨", 67: "较强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒", 80: "小阵雨", 81: "阵雨", 82: "强阵雨",
    85: "小阵雪", 86: "强阵雪", 95: "雷暴", 96: "雷暴伴小冰雹", 97: "强雷暴", 99: "雷暴伴大冰雹",
  };
  return names[weatherCode] ?? `天气代码 ${weatherCode}`;
}

/** Rain/probability belong to the preceding interval, rather than the instant.
 * Partial boundary intervals are weighted; this is a model-derived signal. */
export function deriveWeatherAlerts(snapshot: WeatherSnapshot): WeatherAlerts {
  const now = Date.parse(snapshot.fetchedAt);
  const end = now + 2 * HOUR;
  const amounts = snapshot.minutely15.length
    ? snapshot.minutely15.map(p => ({ time: p.time, amount: p.precipitationMm, interval: QUARTER }))
    : snapshot.hourly.map(p => ({ time: p.time, amount: p.precipitationMm, interval: HOUR }));
  let total = 0;
  let first: number | undefined;
  for (const point of amounts) {
    const at = Date.parse(point.time);
    const overlap = Math.max(0, Math.min(at, end) - Math.max(at - point.interval, now));
    if (!overlap) continue;
    total += point.amount * overlap / point.interval;
    if (point.amount >= 0.1 && first === undefined) first = Math.max(now, at - point.interval);
  }
  const probabilityHours = snapshot.hourly.filter(p => Date.parse(p.time) > now && Date.parse(p.time) - HOUR < end);
  const probabilities = probabilityHours.map(p => p.precipProbabilityPct).filter((p): p is number => p !== null);
  const maximum = probabilities.length ? Math.max(...probabilities) : undefined;
  const rain = total >= 0.1 || (maximum !== undefined && maximum >= 50);
  if (rain && first === undefined) {
    const probable = probabilityHours.find(p => p.precipProbabilityPct !== null && p.precipProbabilityPct >= 50);
    if (probable) first = Math.max(now, Date.parse(probable.time) - HOUR);
  }
  const texts: string[] = [];
  if (rain) texts.push(`未来2小时有降水信号${maximum === undefined ? "" : `，逐小时降水概率最高 ${maximum}%`}；出门带伞。`);
  const today = snapshot.daily.find(day => day.date === dayKey(snapshot.fetchedAt, snapshot.location.timezone));
  const tomorrow = snapshot.daily.find(day => day.date > (today?.date ?? ""));
  const dayDrop = today && tomorrow ? Math.max(0, today.tempMaxC - tomorrow.tempMaxC) : 0;
  const comingTemps = snapshot.hourly.filter(p => Date.parse(p.time) > now && Date.parse(p.time) <= now + 6 * HOUR).map(p => p.tempC);
  const soonDrop = comingTemps.length ? Math.max(0, snapshot.current.tempC - Math.min(...comingTemps)) : 0;
  if (dayDrop >= 5) texts.push(`明日最高温比今天下降约 ${round(dayDrop)}°C，记得添一层。`);
  if (soonDrop >= 5) texts.push(`未来6小时气温可能下降约 ${round(soonDrop)}°C，外出多带一层。`);
  const drop = Math.max(dayDrop, soonDrop);
  return { rainInNext2Hours: rain, rainStartAt: rain && first !== undefined ? new Date(first).toISOString() : undefined,
    rainStartMinutes: rain && first !== undefined ? Math.max(0, Math.ceil((first - now) / 60_000)) : undefined,
    rainTotalMm: round(total), rainProbabilityPct: maximum, temperatureDropC: drop >= 5 ? round(drop) : undefined, texts };
}

export class OpenMeteoWeather {
  private readonly cfg: WeatherConfig;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly timeout: number;
  private locations = new Map<string, { value: WeatherLocation; expires: number }>();
  private snapshots = new Map<string, { value: WeatherSnapshot; expires: number }>();
  private pending = new Map<string, Promise<WeatherSnapshot>>();

  constructor(cfg: WeatherConfig = {}, options: WeatherOptions = {}) {
    this.cfg = { ...cfg };
    if ((cfg.latitude === undefined) !== (cfg.longitude === undefined)) throw new WeatherError("天气坐标必须同时配置纬度和经度");
    if (cfg.latitude !== undefined) { number(cfg.latitude, "纬度", -90, 90); number(cfg.longitude, "经度", -180, 180); }
    if (cfg.timezone && cfg.timezone !== "auto") zone(cfg.timezone);
    if (cfg.countryCode && !/^[A-Za-z]{2}$/.test(cfg.countryCode)) throw new WeatherError("天气国家代码必须是两个字母");
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.ttl = bounded(cfg.cacheTtlMs, 600_000, 0, 600_000);
    this.timeout = bounded(cfg.requestTimeoutMs, 8000, 100, 30_000);
  }

  private async json(url: URL): Promise<unknown> {
    const controller = new AbortController();
    let timer!: NodeJS.Timeout;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new WeatherError("天气服务请求超时，请稍后再试")); }, this.timeout);
    });
    const request = (async () => {
      const response = await this.fetcher(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) {
        await response.body?.cancel();
        throw new WeatherError(`天气服务暂时不可用（HTTP ${response.status}）`, response.status);
      }
      const raw = await response.text();
      if (raw.length > 2_000_000) throw new WeatherError("天气响应过大");
      const value: unknown = JSON.parse(raw);
      if (!object(value) || value.error) throw new WeatherError("天气服务未返回有效数据");
      return value;
    })();
    try { return await Promise.race([request, timeout]); }
    catch (error) { if (error instanceof WeatherError) throw error; throw new WeatherError("天气服务连接或数据解析失败，请稍后再试"); }
    finally { clearTimeout(timer); }
  }

  private async resolve(location?: string): Promise<WeatherLocation> {
    const query = (location?.trim() || this.cfg.defaultLocation?.trim() || "").replace(/，/g, ",");
    if (query.length > 100 || /[\r\n]/.test(query)) throw new WeatherError("请提供简短的城市名称");
    if (this.cfg.latitude !== undefined && (!location?.trim() || normalizePlace(query) === normalizePlace(this.cfg.defaultLocation ?? ""))) {
      return { name: this.cfg.defaultLocation?.trim() || "已配置地点", latitude: this.cfg.latitude,
        longitude: this.cfg.longitude!, timezone: this.cfg.timezone ?? "auto", countryCode: this.cfg.countryCode?.toUpperCase() };
    }
    if (!query) throw new WeatherError("请提供城市，或配置默认天气地点");
    const key = `${normalizePlace(query)}:${this.cfg.countryCode ?? ""}`;
    const saved = this.locations.get(key);
    if (saved && saved.expires > this.now()) return { ...saved.value };
    const [city, qualifier] = query.split(",").map(part => part.trim());
    const variants = [query];
    if (/^[\p{Script=Han}]{2,4}$/u.test(city!) && !city!.endsWith("市")) variants.push(`${city}市${qualifier ? `,${qualifier}` : ""}`);
    if (normalizePlace(city!) === "长沙") variants.push(`Changsha${qualifier ? `,${qualifier}` : ""}`);
    let ambiguous = false;
    for (const variant of [...new Set(variants)]) {
      for (const language of ["zh", "en"]) {
        const url = new URL(GEOCODING);
        url.search = new URLSearchParams({ name: variant, count: "20", language, format: "json",
          ...(this.cfg.countryCode ? { countryCode: this.cfg.countryCode.toUpperCase() } : {}) }).toString();
        const raw = await this.json(url) as Record<string, unknown>;
        if (raw.results === undefined) continue;
        if (!Array.isArray(raw.results)) throw new WeatherError("地点查询数据格式异常");
        const wanted = normalizePlace(variant.split(",")[0]!);
        const matching = raw.results.filter((value): value is Record<string, unknown> => object(value) && typeof value.name === "string"
          && normalizePlace(value.name) === wanted && (!qualifier || [value.admin1, value.country, value.country_code]
            .some(part => typeof part === "string" && normalizePlace(part) === normalizePlace(qualifier))));
        const preferred = matching.filter(value => value.country_code === (this.cfg.countryCode?.toUpperCase() ?? "CN"));
        const choices = preferred.length ? preferred : matching;
        const unique = new Map(choices.map(value => [`${value.latitude},${value.longitude}`, value]));
        if (unique.size > 1) { ambiguous = true; continue; }
        const selected = [...unique.values()][0];
        if (!selected) continue;
        const result: WeatherLocation = { name: String(selected.name), latitude: number(selected.latitude, "地点纬度", -90, 90),
          longitude: number(selected.longitude, "地点经度", -180, 180), timezone: this.cfg.timezone && this.cfg.timezone !== "auto"
            ? this.cfg.timezone : zone(selected.timezone), countryCode: typeof selected.country_code === "string" ? selected.country_code : undefined,
          admin1: typeof selected.admin1 === "string" ? selected.admin1 : undefined };
        this.locations.set(key, { value: result, expires: this.now() + this.ttl });
        return { ...result };
      }
    }
    throw new WeatherError(ambiguous ? "地点有多个匹配，请补充省份或国家，例如“城市,省份”" : "没有找到准确匹配的城市，请补充省份或使用城市全名");
  }

  async getForecast(location?: string): Promise<WeatherSnapshot> {
    const resolved = await this.resolve(location);
    const key = `${resolved.latitude.toFixed(5)},${resolved.longitude.toFixed(5)},${resolved.timezone}`;
    const saved = this.snapshots.get(key);
    if (saved && saved.expires > this.now()) return structuredClone(saved.value);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.load(resolved).then(value => {
        this.snapshots.set(key, { value, expires: this.now() + this.ttl });
        return value;
      }).finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return structuredClone(await pending);
  }

  private async load(location: WeatherLocation): Promise<WeatherSnapshot> {
    const url = new URL(FORECAST);
    url.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude),
      timezone: location.timezone, timeformat: "unixtime", temperature_unit: "celsius", wind_speed_unit: "kmh", precipitation_unit: "mm",
      current: "temperature_2m,apparent_temperature,weather_code,precipitation,rain,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset",
      hourly: "temperature_2m,apparent_temperature,weather_code,precipitation_probability,precipitation,wind_speed_10m",
      minutely_15: "precipitation,rain", forecast_days: "3", forecast_minutely_15: "10" }).toString();
    let raw: unknown;
    try { raw = await this.json(url); }
    catch (error) {
      if (!(error instanceof WeatherError) || error.status !== 400) throw error;
      url.searchParams.delete("minutely_15");
      url.searchParams.delete("forecast_minutely_15");
      raw = await this.json(url);
    }
    if (!object(raw) || !object(raw.current) || !object(raw.hourly) || !object(raw.daily)) throw new WeatherError("天气响应缺少当前、逐小时或每日数据");
    const fetchedAt = new Date(this.now()).toISOString();
    const now = this.now();
    const timezone = zone(raw.timezone);
    const current = raw.current;
    const weatherCode = code(current.weather_code);
    const snapshot: WeatherSnapshot = {
      location: { ...location, timezone }, fetchedAt,
      current: { time: unix(current.time), tempC: number(current.temperature_2m, "当前温度", -100, 70),
        feelsLikeC: number(current.apparent_temperature, "体感温度", -150, 100), weatherCode, condition: weatherCondition(weatherCode),
        precipitationMm: number(current.precipitation, "当前降水", 0), rainMm: number(current.rain, "当前雨量", 0),
        windKph: number(current.wind_speed_10m, "当前风速", 0) },
      daily: [], hourly: [], minutely15: [],
      alerts: { rainInNext2Hours: false, rainTotalMm: 0, texts: [] }, clothingAdvice: [], precision: "",
      attribution: "天气数据：Open-Meteo https://open-meteo.com/（CC BY 4.0）；地名：GeoNames。提醒和穿衣建议为程序派生。",
      source: { name: "Open-Meteo", url: "https://open-meteo.com/", model: "best_match（自动选择；API未返回具体模型名）",
        currentDataKind: "数值模式预报，非气象站或雷达实时观测", gridLatitude: number(raw.latitude, "预报网格纬度", -90, 90),
        gridLongitude: number(raw.longitude, "预报网格经度", -180, 180), licenseUrl: "https://creativecommons.org/licenses/by/4.0/" },
    };
    const currentAt = Date.parse(snapshot.current.time);
    if (currentAt < now - 2 * HOUR || currentAt > now + 30 * 60_000) throw new WeatherError("当前天气数据时间过期或异常");
    const hourlyTimes = times(raw.hourly, "逐小时");
    if (hourlyTimes.some((time, i) => i > 0 && Date.parse(time) - Date.parse(hourlyTimes[i - 1]!) !== HOUR)) {
      throw new WeatherError("逐小时预报时间间隔异常");
    }
    const hourFields = Object.fromEntries(["temperature_2m", "apparent_temperature", "weather_code", "precipitation", "wind_speed_10m"]
      .map(key => [key, series(raw.hourly as Record<string, unknown>, key, hourlyTimes.length)]));
    const probs = series(raw.hourly, "precipitation_probability", hourlyTimes.length, true);
    const allHours = hourlyTimes.map((time, i): WeatherHour => {
      const weather = code(hourFields.weather_code![i]);
      return { time, tempC: number(hourFields.temperature_2m![i], "逐小时温度", -100, 70),
        feelsLikeC: number(hourFields.apparent_temperature![i], "逐小时体感温度", -150, 100),
        precipitationMm: number(hourFields.precipitation![i], "逐小时降水", 0), precipProbabilityPct: probability(probs[i]),
        windKph: number(hourFields.wind_speed_10m![i], "逐小时风速", 0), weatherCode: weather, condition: weatherCondition(weather) };
    });
    snapshot.hourly = allHours.filter(p => Date.parse(p.time) > now && Date.parse(p.time) <= now + 24 * HOUR).slice(0, 24);
    if (snapshot.hourly.length !== 24) throw new WeatherError("逐小时预报未覆盖接下来24小时");
    const dailyTimes = times(raw.daily, "每日");
    const dayFields = Object.fromEntries(["temperature_2m_max", "temperature_2m_min", "weather_code", "precipitation_sum", "sunrise", "sunset"]
      .map(key => [key, series(raw.daily as Record<string, unknown>, key, dailyTimes.length)]));
    const dailyProbs = series(raw.daily, "precipitation_probability_max", dailyTimes.length, true);
    snapshot.daily = dailyTimes.map((time, i): WeatherDay => {
      const weather = code(dayFields.weather_code![i]);
      const min = number(dayFields.temperature_2m_min![i], "每日最低温", -100, 70);
      const max = number(dayFields.temperature_2m_max![i], "每日最高温", -100, 70);
      if (min > max) throw new WeatherError("每日温度范围无效");
      return { date: dayKey(time, timezone), tempMaxC: max, tempMinC: min,
        precipProbabilityPct: probability(dailyProbs[i]), precipitationMm: number(dayFields.precipitation_sum![i], "每日降水", 0),
        weatherCode: weather, condition: weatherCondition(weather), sunrise: dayFields.sunrise![i] === null ? null : unix(dayFields.sunrise![i]),
        sunset: dayFields.sunset![i] === null ? null : unix(dayFields.sunset![i]) };
    });
    const today = dayKey(fetchedAt, timezone);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 24 * HOUR).toISOString().slice(0, 10);
    snapshot.daily = snapshot.daily.filter(day => day.date >= today).slice(0, 3);
    if (snapshot.daily.length < 2 || snapshot.daily[0]!.date !== today || snapshot.daily[1]!.date !== tomorrow) {
      throw new WeatherError("每日预报未覆盖今天和明天");
    }
    if (object(raw.minutely_15)) {
      try {
        const minuteTimes = times(raw.minutely_15, "15分钟");
        if (minuteTimes.some((time, i) => i > 0 && Date.parse(time) - Date.parse(minuteTimes[i - 1]!) !== QUARTER)) {
          throw new WeatherError("15分钟预报时间间隔异常");
        }
        const amounts = series(raw.minutely_15, "precipitation", minuteTimes.length);
        const rains = series(raw.minutely_15, "rain", minuteTimes.length, true);
        snapshot.minutely15 = minuteTimes.map((time, i) => ({ time, precipitationMm: number(amounts[i], "15分钟降水", 0),
          rainMm: rains[i] === null ? null : number(rains[i], "15分钟雨量", 0) }))
          .filter(point => Date.parse(point.time) > now && Date.parse(point.time) - QUARTER < now + 2 * HOUR);
        if (!snapshot.minutely15.length || Date.parse(snapshot.minutely15[0]!.time) - QUARTER > now
          || Date.parse(snapshot.minutely15.at(-1)!.time) < now + 2 * HOUR) snapshot.minutely15 = [];
      } catch { snapshot.minutely15 = []; }
    }
    snapshot.precision = snapshot.minutely15.length
      ? "15分钟降水序列在中国等欧洲/北美原生区域以外由逐小时预报插值，不是分钟级雷达实况，不能保证准确起止分钟。"
      : "15分钟数据缺失或不完整；近期降水仅参考逐小时模式预报，不能确定分钟级起止。";
    snapshot.alerts = deriveWeatherAlerts(snapshot);
    const feel = snapshot.current.feelsLikeC;
    snapshot.clothingAdvice = [feel < 10 ? "体感偏冷，穿厚外套，按活动量增减。" : feel < 18 ? "体感偏凉，长袖加薄外套更方便。"
      : feel < 27 ? "薄长袖或轻薄衣服，早晚按体感增减。" : "轻薄透气衣服，户外留意防晒。"];
    if (snapshot.alerts.temperatureDropC !== undefined) snapshot.clothingAdvice.push("有降温趋势，多带一层可穿脱的外套。");
    if (snapshot.current.windKph >= 25) snapshot.clothingAdvice.push("风比较明显，外层选挡风的衣服。");
    if (snapshot.alerts.rainInNext2Hours) snapshot.clothingAdvice.push("有降水信号，带伞，鞋子优先防滑。");
    return snapshot;
  }
}

export function formatWeatherSummary(snapshot: WeatherSnapshot): string {
  const fmt = (day: WeatherDay, label: string) => `${label} ${day.condition}，${round(day.tempMinC)}～${round(day.tempMaxC)}°C` +
    `，降水 ${round(day.precipitationMm)}mm${day.precipProbabilityPct === null ? "（概率暂无）" : `，概率最高 ${day.precipProbabilityPct}%`}。`;
  const lines = [`${snapshot.location.name}天气（更新 ${localTime(snapshot.fetchedAt, snapshot.location.timezone)}）`,
    `现在 ${snapshot.current.condition}，${round(snapshot.current.tempC)}°C，体感 ${round(snapshot.current.feelsLikeC)}°C，风速 ${round(snapshot.current.windKph)}km/h。`,
    ...snapshot.daily.slice(0, 2).map((day, i) => fmt(day, i ? "明天" : "今天")),
    ...snapshot.alerts.texts,
    ...(snapshot.alerts.rainInNext2Hours ? [] : ["未来2小时模式暂未显示明显降水信号。"]),
    `穿衣：${snapshot.clothingAdvice.join("")}`, snapshot.precision, snapshot.attribution];
  const today = snapshot.daily[0];
  if (today?.sunrise && today.sunset) lines.splice(4, 0, `日出 ${localTime(today.sunrise, snapshot.location.timezone)}，日落 ${localTime(today.sunset, snapshot.location.timezone)}。`);
  return lines.join("\n");
}

/** The caller applies its owner/group permissions before advertising this tool. */
export function createWeatherTool(weather: OpenMeteoWeather): ToolDef {
  return { name: "weather_forecast", description: "查询城市当前、今天明天与未来24小时天气、近期降水信号和穿衣建议。中国15分钟降水为插值模式预报，不是雷达实况。",
    inputSchema: { type: "object", properties: { location: { type: "string", maxLength: 100, description: "城市名称，可带省份，如长沙市,湖南；省略使用已配置地点" } } },
    execute: async args => {
      if (args.location !== undefined && typeof args.location !== "string") throw new WeatherError("地点必须是城市名称");
      return JSON.stringify(await weather.getForecast(args.location as string | undefined));
    } };
}
