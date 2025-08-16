/*
 * ai.ts
 *
 * GPT integration for the transport log PWA. This module exposes
 * helper functions to parse natural language input into structured
 * log data and to generate summaries of recorded logs. The
 * implementation uses the OpenAI API. All functions gracefully
 * handle the absence of an API key: if no key is provided in
 * config.json, the returned promises reject with a descriptive error.
 */

export interface AppConfig {
  SHEETS_WEBAPP_URL?: string;
  OPENAI_API_KEY?: string;
}

/**
 * Load configuration from `/config.json`. This file is ignored by Git
 * and must be created by the end user. If the file does not exist
 * or cannot be parsed, an empty object is returned.
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch('/config.json');
    if (!res.ok) throw new Error('Config not found');
    const data = await res.json();
    return data as AppConfig;
  } catch (err) {
    // Return empty config if not found or parse error
    return {};
  }
}

/**
 * Invoke OpenAI to parse a Japanese natural language description of a
 * transport log. The API returns a structured object with the
 * extracted fields. The prompt instructs the model to output JSON
 * conforming to the expected schema.
 */
export async function parseNaturalLog(input: string): Promise<any> {
  const config = await loadConfig();
  const apiKey = config.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key is not configured');
  }
  const systemPrompt =
    'あなたは大型トラック運込手の運行記録を構造化データに変換するアシスタントです。入力は日本語の文章で、出発地/\u5230\u7740地、\u51fa\u767a\u6642\u523b/\u5230\u7740\u6642\u523b、\u4f11\u61a9\u6642\u9593、\u8d70\u884c\u8ddd\u96e2、\u7d66\u6cb9\u91cf\u3068\u8cbb\u7528\u306aど\u304c含まれ\u307e\u3059。\u6b21のJSON\u5f62\u5f0f\u3067\u5fdc\u7b54\u3057\u3066\u304f\u3060\u3055\u3044: {"departureName":"\u6587\u5b57\u5217","arrivalName":"\u6587\u5b57\u5217","departureTime":"ISO\u65e5\u6642","arrivalTime":"ISO\u65e5\u6642","drivingMinutes":\u6570\u5024,"breakMinutes":\u6570\u5024,"distanceKm":\u6570\u5024,"fuelLitres":\u6570\u5024,"fuelCost":\u6570\u5024,"note":"\u6587\u5b57\u5217"}\u3002\u5165\u529b\u306b\u542b\u307e\u308c\u306a\u3044\u9805\u76ee\u306fnull\u307e\u305f\u306f0\u306b\u3057\u3066\u304f\u3060\u3055\u3044\u3002';
  const body = {
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input }
    ],
    temperature: 0.0
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  const text = json.choices[0].message.content;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Failed to parse OpenAI response');
  }
}

/**
 * Generate a summary of a list of log records. The summary describes
 * total distance, total driving time, total break time and other
 * aggregate statistics in Japanese. If the API key is not available,
 * the returned promise rejects.
 */
export async function summarizeLogs(logs: any[]): Promise<string> {
  const config = await loadConfig();
  const apiKey = config.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key is not configured');
  }
  const summaryPrompt =
    '以下の運行ログのリストを\u8aad\u307f\u53d6\u308a\u3001\u5408\u8a08\u8d70\u884c\u8ddd\u96e2\u3001\u5408\u8a08\u904b\u8f38\u6642\u9593\u3001\u5408\u8a08\u4f11\u61a9\u6642\u9593\u3001\u7d66\u6cb9\u56de\u6570\u3068\u5408\u8a08\u71c3\u6599\u6d88\u8cbb\u3001\u6700\u957f\u904b\u884c\u8ddd\u96e2\u306e\u65e5\u3092\u65e5\u672c\u8a9e\u3067\u307e\u3068\u3081\u3066\u304f\u3060\u3055\u3044\u3002\u30ed\u30b0\u306fJSON\u914d\u5217\u3067\u3059。';
  const logsString = JSON.stringify(logs);
  const body = {
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'system', content: summaryPrompt },
      { role: 'user', content: logsString }
    ],
    temperature: 0.0
  };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  const text = json.choices[0].message.content;
  return text;
}
