import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { OpenMeteoWeather, createWeatherTool, formatWeatherSummary, weatherCondition, type WeatherConfig } from "../src/tools/weather.js";

const START = Date.parse("2026-10-13T00:05:00Z");
const HOUR = 3600_000;
const QUARTER = 15 * 60_000;
const CITY = { name: "长沙市", latitude: 28.19874, longitude: 112.97087, country_code: "CN", admin1: "湖南", timezone: "Asia/Shanghai" };

function payload(now = START): any {
  const day = Date.parse(new Date(now + 8 * HOUR).toISOString().slice(0, 10) + "T00:00:00Z") - 8 * HOUR;
  const quarter = Math.floor(now / QUARTER) * QUARTER;
  const hours = Array.from({ length: 72 }, (_, i) => (day + i * HOUR) / 1000);
  const days = Array.from({ length: 3 }, (_, i) => (day + i * 24 * HOUR) / 1000);
  return {
    latitude: 28.224955, longitude: 112.93318, timezone: "Asia/Shanghai", utc_offset_seconds: 28800,
    current: { time: quarter / 1000, temperature_2m: 24, apparent_temperature: 23, weather_code: 2, precipitation: 0, rain: 0, wind_speed_10m: 12 },
    hourly: { time: hours, temperature_2m: hours.map(() => 24), apparent_temperature: hours.map(() => 23), weather_code: hours.map(() => 2),
      precipitation_probability: hours.map(() => 0), precipitation: hours.map(() => 0), wind_speed_10m: hours.map(() => 12) },
    daily: { time: days, temperature_2m_max: [28, 27, 29], temperature_2m_min: [20, 21, 22], weather_code: [2, 3, 2],
      precipitation_probability_max: [10, 20, 10], precipitation_sum: [0, 0.5, 0],
      sunrise: days.map(time => time + 6 * 3600), sunset: days.map(time => time + 18 * 3600) },
    minutely_15: { time: Array.from({ length: 10 }, (_, i) => (quarter + i * QUARTER) / 1000), precipitation: Array(10).fill(0), rain: Array(10).fill(0) },
  };
}

function fixture(config: WeatherConfig = {}) {
  const clock = { now: START };
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const state = {
    geo: { results: [CITY] } as any,
    change: (_data: any) => {},
    fetch: undefined as ((url: URL, init?: RequestInit) => Promise<Response> | Response) | undefined,
  };
  const weather = new OpenMeteoWeather({ defaultLocation: "长沙市", timezone: "Asia/Shanghai", countryCode: "CN", ...config }, {
    now: () => clock.now,
    fetch: (async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (state.fetch) return state.fetch(url, init);
      if (url.hostname.startsWith("geocoding")) return new Response(JSON.stringify(state.geo));
      const data = payload(clock.now);
      state.change(data);
      return new Response(JSON.stringify(data));
    }) as typeof fetch,
  });
  return { weather, clock, requests, state };
}

test("天气：长沙市原样定位、正确单位与时区，完整保留当前/每日/逐小时/15分钟数据", async () => {
  const f = fixture();
  const snapshot = await f.weather.getForecast();
  assert.equal(f.requests[0]!.url.searchParams.get("name"), "长沙市", "不能去掉市后误选重庆长沙镇");
  assert.equal(f.requests[0]!.url.searchParams.get("countryCode"), "CN");
  assert.equal(snapshot.location.latitude, CITY.latitude);
  assert.equal(snapshot.location.longitude, CITY.longitude);
  assert.equal(snapshot.source.gridLatitude, 28.224955, "天气网格与城市坐标分别保留");
  assert.equal(snapshot.current.condition, "多云");
  assert.equal(snapshot.daily[0]!.date, "2026-10-13");
  assert.equal(snapshot.daily[1]!.date, "2026-10-14");
  assert.equal(snapshot.daily[0]!.sunrise, "2026-10-12T22:00:00.000Z");
  assert.equal(snapshot.hourly.length, 24);
  assert.equal(snapshot.minutely15.length, 9);
  assert.match(snapshot.precision, /中国.*逐小时.*插值/);
  assert.match(snapshot.source.currentDataKind, /非气象站|模式/);
  const forecast = f.requests[1]!.url;
  assert.equal(forecast.searchParams.get("timeformat"), "unixtime");
  assert.equal(forecast.searchParams.get("timezone"), "Asia/Shanghai");
  assert.equal(forecast.searchParams.get("wind_speed_unit"), "kmh");
  assert.equal(forecast.searchParams.get("forecast_minutely_15"), "10");
  const text = formatWeatherSummary(snapshot);
  assert.match(text, /今天|明天/);
  assert.match(text, /日出 06:00/);
  assert.match(text, /穿衣/);
  assert.match(text, /https:\/\/open-meteo.com\//);
  assert.match(text, /不是分钟级雷达实况/);
});

test("天气：同地点快照最多缓存10分钟，并隔离调用方对结果的修改", async () => {
  const f = fixture({ latitude: CITY.latitude, longitude: CITY.longitude, cacheTtlMs: 9_999_999 });
  const first = await f.weather.getForecast();
  first.current.tempC = -99;
  first.alerts.texts.push("polluted");
  f.clock.now += 599_999;
  const cached = await f.weather.getForecast("长沙市");
  assert.equal(cached.current.tempC, 24);
  assert.ok(!cached.alerts.texts.includes("polluted"));
  assert.equal(f.requests.length, 1);
  f.clock.now++;
  const refreshed = await f.weather.getForecast();
  assert.equal(f.requests.length, 2);
  assert.notEqual(refreshed.fetchedAt, first.fetchedAt);
});

test("天气：同坐标的并发请求共享一次天气访问，不影响独立返回对象", async () => {
  const f = fixture({ latitude: CITY.latitude, longitude: CITY.longitude });
  const [a, b] = await Promise.all([f.weather.getForecast(), f.weather.getForecast("长沙")]);
  assert.equal(f.requests.length, 1);
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
});

test("天气：15分钟降水按前置时段计算，排除过去并按两小时边界加权", async () => {
  const f = fixture();
  f.state.change = data => {
    data.minutely_15.precipitation[0] = 10;
    data.minutely_15.precipitation[1] = 0.3;
    data.minutely_15.precipitation[9] = 0.6;
  };
  const snapshot = await f.weather.getForecast();
  assert.equal(snapshot.alerts.rainInNext2Hours, true);
  assert.equal(snapshot.alerts.rainTotalMm, 0.4, "0.3的后10分钟+0.6的前5分钟，不计过去10mm");
  assert.equal(snapshot.alerts.rainStartMinutes, 0);
  assert.equal(snapshot.alerts.rainStartAt, new Date(START).toISOString());
  assert.match(snapshot.alerts.texts.join(""), /降水信号/);
});

test("天气：没有15分钟数据时使用逐小时量和概率，未知概率不当成零", async () => {
  const f = fixture();
  f.state.change = data => {
    delete data.minutely_15;
    data.hourly.precipitation_probability.fill(null);
    const first = data.hourly.time.findIndex((time: number) => time * 1000 > START);
    data.hourly.precipitation[first] = 1;
    data.daily.precipitation_probability_max.fill(null);
  };
  const snapshot = await f.weather.getForecast();
  assert.equal(snapshot.minutely15.length, 0);
  assert.match(snapshot.precision, /逐小时/);
  assert.equal(snapshot.alerts.rainInNext2Hours, true);
  assert.equal(snapshot.alerts.rainTotalMm, 0.9);
  assert.equal(snapshot.alerts.rainProbabilityPct, undefined);
  assert.equal(snapshot.daily[0]!.precipProbabilityPct, null);
  assert.match(formatWeatherSummary(snapshot), /概率暂无/);
});

test("天气：15分钟字段损坏或时段覆盖不足时降级，保留有效核心天气", async () => {
  for (const mutate of [
    (data: any) => { data.minutely_15.rain.pop(); },
    (data: any) => { data.minutely_15.precipitation[1] = null; },
    (data: any) => { data.minutely_15.time[3] += 1; },
    (data: any) => { for (const key of Object.keys(data.minutely_15)) data.minutely_15[key] = data.minutely_15[key].slice(0, 3); },
  ]) {
    const f = fixture();
    f.state.change = mutate;
    const snapshot = await f.weather.getForecast();
    assert.equal(snapshot.current.tempC, 24);
    assert.equal(snapshot.minutely15.length, 0);
    assert.match(snapshot.precision, /缺失或不完整/);
  }
});

test("天气：最高温下降与近六小时降温产生可复现的添衣建议", async () => {
  const f = fixture();
  f.state.change = data => {
    data.daily.temperature_2m_max[1] = 21;
    data.current.wind_speed_10m = 30;
    data.current.weather_code = 97;
    for (let i = 0; i < data.hourly.time.length; i++) {
      if (data.hourly.time[i] * 1000 > START && data.hourly.time[i] * 1000 <= START + 6 * HOUR) data.hourly.temperature_2m[i] = 16;
    }
  };
  const snapshot = await f.weather.getForecast();
  assert.equal(snapshot.current.condition, "强雷暴");
  assert.equal(snapshot.alerts.temperatureDropC, 8);
  assert.match(snapshot.alerts.texts.join(""), /明日最高温.*7°C/);
  assert.match(snapshot.alerts.texts.join(""), /未来6小时.*8°C/);
  assert.match(snapshot.clothingAdvice.join(""), /多带一层/);
  assert.match(snapshot.clothingAdvice.join(""), /挡风/);
  assert.equal(weatherCondition(95), "雷暴");
  assert.match(weatherCondition(42), /天气代码 42/);
});

test("天气：核心缺失、数组错位、非有限值、错误时段均拒绝而不编造", async () => {
  const mutations = [
    (data: any) => { delete data.current; },
    (data: any) => { data.current.temperature_2m = null; },
    (data: any) => { data.hourly.temperature_2m[0] = Infinity; },
    (data: any) => { data.hourly.wind_speed_10m.pop(); },
    (data: any) => { data.hourly.precipitation_probability[0] = 101; },
    (data: any) => { data.hourly.time[3] += 1; },
    (data: any) => { data.current.time -= 4 * 3600; },
    (data: any) => { data.daily.time[1] += 24 * 3600; data.daily.time[2] += 24 * 3600; },
    (data: any) => { data.daily.temperature_2m_min[0] = 40; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    f.state.change = mutate;
    await assert.rejects(f.weather.getForecast(), /天气|预报|温度|数据/);
  }
});

test("天气：地点严格匹配城市和地区，优先中国并拒绝含混或前缀误匹配", async () => {
  const f = fixture({ countryCode: undefined });
  f.state.geo.results = [{ ...CITY, country_code: "US", latitude: 40, longitude: -90 }, CITY];
  assert.equal((await f.weather.getForecast()).location.countryCode, "CN");
  const qualified = fixture();
  qualified.state.geo.results = [CITY, { ...CITY, admin1: "其他省", latitude: 40 }];
  assert.equal((await qualified.weather.getForecast("长沙市,湖南")).location.admin1, "湖南");
  const ambiguous = fixture();
  ambiguous.state.geo.results = [CITY, { ...CITY, admin1: "其他省", latitude: 40 }];
  await assert.rejects(ambiguous.weather.getForecast(), /多个匹配/);
  const prefix = fixture();
  prefix.state.geo.results = [{ ...CITY, name: "长沙镇" }];
  await assert.rejects(prefix.weather.getForecast(), /准确匹配/);
});

test("天气：可选15分钟参数HTTP400时仅降级重试一次", async () => {
  const f = fixture({ latitude: CITY.latitude, longitude: CITY.longitude });
  f.state.fetch = url => {
    if (url.searchParams.has("minutely_15")) return new Response("unsupported optional minutely", { status: 400 });
    const data = payload();
    delete data.minutely_15;
    return new Response(JSON.stringify(data));
  };
  assert.equal((await f.weather.getForecast()).minutely15.length, 0);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1]!.url.searchParams.has("minutely_15"), false);
});

test("天气：传输忽略AbortSignal时仍在配置期限结束，错误不泄露上游正文", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ latitude: CITY.latitude, longitude: CITY.longitude, requestTimeoutMs: 100 });
  f.state.fetch = async () => new Promise<Response>(() => {});
  const pending = f.weather.getForecast();
  await Promise.resolve();
  t.mock.timers.tick(100);
  await assert.rejects(pending, /超时/);
  assert.equal(f.requests[0]!.init!.signal!.aborted, true);
  const bad = fixture({ latitude: CITY.latitude, longitude: CITY.longitude });
  bad.state.fetch = async () => { throw new Error("private-upstream-response-and-key"); };
  await assert.rejects(bad.weather.getForecast(), error => String(error).includes("连接或数据解析失败") && !String(error).includes("private-upstream"));
});

test("天气：正文不结束时总请求超时也生效", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ latitude: CITY.latitude, longitude: CITY.longitude, requestTimeoutMs: 100 });
  f.state.fetch = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
  const pending = f.weather.getForecast();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  t.mock.timers.tick(100);
  await assert.rejects(pending, /超时/);
});

test("天气：无默认城市不猜测位置；工具非法参数不访问天气接口", async () => {
  const weather = new OpenMeteoWeather();
  await assert.rejects(weather.getForecast(), /提供城市/);
  assert.throws(() => new OpenMeteoWeather({ latitude: 90 }), /同时配置/);
  assert.throws(() => new OpenMeteoWeather({ latitude: 100, longitude: 200 }), /纬度/);
  const f = fixture();
  const tool = createWeatherTool(f.weather);
  await assert.rejects(tool.execute({ location: 42 }, { accountId: "test", isPrivate: true }), /地点必须/);
  assert.equal(f.requests.length, 0);
  const result = JSON.parse(await tool.execute({}, { accountId: "test", isPrivate: true }));
  assert.equal(result.location.name, "长沙市");
  assert.ok(result.attribution.includes("Open-Meteo"));
});
