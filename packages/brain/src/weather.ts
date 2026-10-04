/**
 * Weather from Open-Meteo (open-meteo.com): free, no key, callable from the browser and the robot alike. A place
 * name is looked up with their geocoding API, then the forecast is fetched; the answer is a short report the model
 * can talk from.
 */
export interface Place {
  readonly name: string;
  readonly region: string;
  readonly country: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface WeatherOptions {
  readonly fetch?: typeof fetch;
  /** Where to report when no place is named ("London", "Pune, India"), or null to ask. */
  readonly home?: string | null;
}

/** WMO weather codes, as Open-Meteo reports them. */
const CONDITIONS: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'freezing fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  56: 'freezing drizzle',
  57: 'heavy freezing drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'heavy freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'light showers',
  81: 'showers',
  82: 'violent showers',
  85: 'snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorms',
  96: 'thunderstorms with hail',
  99: 'thunderstorms with heavy hail',
};

export function describeWeatherCode(code: number): string {
  return CONDITIONS[code] ?? 'unsettled weather';
}

const celsiusAndFahrenheit = (c: number) => `${Math.round(c)}°C (${Math.round((c * 9) / 5 + 32)}°F)`;

export class Weather {
  readonly #fetch: typeof fetch;
  home: string | null;
  readonly #places = new Map<string, Place | null>();

  constructor(options: WeatherOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.home = options.home?.trim() || null;
  }

  /** Finds a place by name (the best match), or null if there is none. Cached. */
  async find(name: string, signal?: AbortSignal): Promise<Place | null> {
    const key = name.trim().toLowerCase();
    if (this.#places.has(key)) return this.#places.get(key)!;
    // "Pune, India": search the town, prefer a result in the named country or region.
    const [town, ...rest] = name.split(',').map((s) => s.trim());
    const hint = rest.join(' ').toLowerCase();
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(town ?? name)}&count=5&language=en&format=json`;
    const data = (await this.#get(url, signal)) as { results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[] };
    const results = data.results ?? [];
    const best = (hint ? results.find((r) => `${r.admin1 ?? ''} ${r.country ?? ''}`.toLowerCase().includes(hint)) : undefined) ?? results[0];
    const place = best ? { name: best.name, region: best.admin1 ?? '', country: best.country ?? '', latitude: best.latitude, longitude: best.longitude } : null;
    this.#places.set(key, place);
    return place;
  }

  /** A short report: now, and the next two days. */
  async report(where: string | null, signal?: AbortSignal): Promise<string> {
    const name = where?.trim() || this.home;
    if (!name) return 'error: no place was named; ask where they are';
    const place = await this.find(name, signal);
    if (!place) return `error: could not find a place called "${name.slice(0, 60)}"`;
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3';
    const f = (await this.#get(url, signal)) as {
      current: { temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number };
      daily: { weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] };
    };
    const c = f.current;
    const day = (i: number, label: string) =>
      `${label}: ${describeWeatherCode(f.daily.weather_code[i]!)}, high ${celsiusAndFahrenheit(f.daily.temperature_2m_max[i]!)}, low ${celsiusAndFahrenheit(
        f.daily.temperature_2m_min[i]!,
      )}, ${f.daily.precipitation_probability_max[i] ?? 0}% chance of rain or snow.`;
    const placeName = [place.name, place.region, place.country].filter((s, i, all) => s && all.indexOf(s) === i).join(', ');
    return [
      `${placeName}. Now: ${describeWeatherCode(c.weather_code)}, ${celsiusAndFahrenheit(c.temperature_2m)}, feels like ${celsiusAndFahrenheit(c.apparent_temperature)}, wind ${Math.round(c.wind_speed_10m)} km/h.`,
      day(0, 'Today'),
      day(1, 'Tomorrow'),
      day(2, 'The day after'),
    ].join(' ');
  }

  async #get(url: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(8000);
    const response = await this.#fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`The weather service answered ${response.status}`);
    return response.json();
  }
}
